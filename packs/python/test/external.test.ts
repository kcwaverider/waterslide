import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PartialEdge, UnresolvedRef } from "@waterslide/core";
import { parseTree } from "./support/harness.js";
import { fixture, getPack } from "./support/pack.js";
import { assemble } from "./support/resolver.js";

const SERVER = { source_roots: ["server"] };

const ref = (e: PartialEdge | undefined): UnresolvedRef => {
  if (!e || typeof e.to === "string")
    throw new Error("expected an UnresolvedRef edge");
  return e.to;
};
const owner = (e: PartialEdge): string => e.from.split("#")[1] ?? e.from;
/** Hints are a per-kind union; read a key by name for table-shaped assertions. */
const hintOf = (r: UnresolvedRef, key: string): unknown =>
  (r.hints as Record<string, unknown> | undefined)?.[key] ?? null;

describe("external vendors (decision items 4 and 7)", () => {
  it("traces receivers to SDK constructors in the same file: certain", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "x",
      "clients.py",
      readFileSync(fixture("external", "clients.py"), "utf8"),
    );
    const byOwner = new Map(r.edges.map((e) => [owner(e), e]));

    const summarize = byOwner.get("Summarizer.summarize");
    expect(summarize).toMatchObject({
      kind: "external_call",
      label: "create",
      confidence: "certain",
      confidence_reason: null,
    });
    expect(ref(summarize)).toEqual({
      ref_kind: "external",
      value: "anthropic/messages",
      hints: { sdk_symbol: "anthropic.AsyncAnthropic.messages.create" },
      source_line: 15,
    });

    expect(ref(byOwner.get("Summarizer.embed"))).toMatchObject({
      value: "voyageai/embed",
    });
    expect(ref(byOwner.get("Summarizer.rerank"))).toMatchObject({
      value: "cohere/rerank",
    });
    expect(ref(byOwner.get("Summarizer.upload"))).toEqual({
      ref_kind: "external",
      value: "aws/s3",
      hints: { sdk_symbol: "boto3.s3.put_object" },
      source_line: 24,
    });
    expect(byOwner.get("Summarizer.upload")?.kind).toBe("external_call");
  });

  it("SQS send is a publish edge to a topic, literal queue certain, dynamic queue left unresolved", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "x",
      "clients.py",
      readFileSync(fixture("external", "clients.py"), "utf8"),
    );
    const literal = r.edges.find((e) => owner(e) === "enqueue");
    expect(literal).toMatchObject({ kind: "publish", confidence: "certain" });
    expect(ref(literal)).toEqual({
      ref_kind: "topic",
      value: "https://sqs.example/embed",
      hints: { direction: "publish" },
      source_line: 28,
    });

    const dynamic = r.edges.find((e) => owner(e) === "enqueue_dynamic");
    expect(dynamic).toMatchObject({ kind: "publish", confidence: "inferred" });
    expect(dynamic?.confidence_reason).toMatch(
      /queue name is not a literal: url/,
    );
    expect(ref(dynamic).value).toBe("url");
  });

  it("an injected client is not an external call: it is a symbol reference the pack could not type", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "x",
      "clients.py",
      readFileSync(fixture("external", "clients.py"), "utf8"),
    );
    const run = r.edges.find((e) => owner(e) === "Injected.run");
    expect(run).toMatchObject({ kind: "call", confidence: "inferred" });
    expect(ref(run)).toMatchObject({
      ref_kind: "symbol",
      value: "clients.Injected.client.messages.create",
    });
    expect(run?.confidence_reason).toMatch(
      /self\.client has no annotation or constructor assignment/,
    );
  });
});

describe("Mongo access (parser §8, decision item 6)", () => {
  it("infers collection from the attribute, read/write from the method, never mints a node, and draws nothing for an unrecognised method", async () => {
    const pack = await getPack();
    const results = parseTree(
      pack,
      "fx",
      fixture("fastapi-app"),
      undefined,
      SERVER,
    );
    const repo = results.find(
      (r) => r.path === "server/repositories/note_repo.py",
    )?.result;
    const mongo =
      repo?.edges.filter(
        (e) => typeof e.to !== "string" && e.to.ref_kind === "datastore",
      ) ?? [];
    const summary = mongo.map((e) => [
      owner(e),
      e.kind,
      e.label,
      ref(e).value,
      hintOf(ref(e), "operation"),
      hintOf(ref(e), "store"),
      hintOf(ref(e), "namespace"),
      e.confidence,
    ]);
    expect(summary).toEqual([
      [
        "NoteRepository.save",
        "write",
        "insert_one",
        "notes",
        "write",
        "mongo",
        null,
        "inferred",
      ],
      [
        "NoteRepository.get",
        "read",
        "find_one",
        "notes",
        "read",
        "mongo",
        null,
        "inferred",
      ],
      [
        "NoteRepository.delete",
        "write",
        "delete_one",
        "notes",
        "write",
        "mongo",
        null,
        "inferred",
      ],
      [
        "handle_member_exit",
        "write",
        "update_one",
        "users",
        "write",
        "mongo",
        null,
        "inferred",
      ],
    ]);
    expect(mongo[0]?.confidence_reason).toMatch(
      /inferred collection 'notes' from attribute access on db; receiver resolves to db\.db/,
    );
    expect(mongo[3]?.confidence_reason).toMatch(/named like a database handle/);
    expect(repo?.nodes.some((n) => n.id.startsWith("mongo:"))).toBe(false);
    const unknown = repo?.diagnostics.find(
      (d) => d.code === "unsupported_construct",
    );
    expect(unknown?.message).toMatch(
      /Mongo method rename .* not in the read\/write table; no edge emitted/,
    );
  });

  it("does not claim a bare `db` parameter's unknown methods", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "x",
      "m.py",
      "async def f(db):\n    await db.session.commit()\n",
    );
    expect(r.edges).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["untyped_receiver"]);
  });

  it("round-trips through the test resolver as repository → collection edges", async () => {
    const pack = await getPack();
    const results = parseTree(
      pack,
      "fx",
      fixture("fastapi-app"),
      undefined,
      SERVER,
    );
    const assembled = assemble(pack, results, "fx", SERVER);
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors),
    ).toBe(true);
    const save = assembled.graph.edges.find(
      (e) =>
        e.from === "fx:server/repositories/note_repo.py#NoteRepository.save" &&
        e.kind === "write",
    );
    expect(save).toMatchObject({
      to: "mongo:unknown.notes",
      label: "insert_one",
      confidence: "inferred",
      skips_tiers: [],
    });
    const anthropic = assembled.graph.edges.find(
      (e) => e.kind === "external_call",
    );
    expect(anthropic).toMatchObject({
      from: "fx:server/services/note_service.py#NoteService.create",
      to: "ext:anthropic/messages",
      confidence: "certain",
    });
  });
});

describe("generic HTTP clients (A10 item 2): the vendor is in the URL, never in the library", () => {
  const http = (edges: PartialEdge[]) =>
    edges
      .filter((e) => e.kind === "http_request")
      .map((e) => ({
        from: owner(e),
        value: ref(e).value,
        hints: ref(e).hints,
        confidence: e.confidence,
        reason: e.confidence_reason,
      }));

  it("httpx through a self attribute whose base is a ternary over two module constants", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "notify.py",
      [
        "import httpx",
        'APNS_HOST_PRODUCTION = "https://api.push.apple.com"',
        'APNS_HOST_SANDBOX = "https://api.sandbox.push.apple.com"',
        "class NotificationService:",
        "    def __init__(self, use_sandbox: bool):",
        "        self.host = APNS_HOST_SANDBOX if use_sandbox else APNS_HOST_PRODUCTION",
        "        self._client = None",
        "    def _get_client(self) -> httpx.AsyncClient:",
        "        if self._client is None:",
        "            self._client = httpx.AsyncClient(http2=True)",
        "        return self._client",
        "    async def send(self, token, payload):",
        '        return await self._get_client().post(f"{self.host}/3/device/{token}", json=payload)',
        "",
      ].join("\n"),
    );
    expect(http(r.edges)).toEqual([
      {
        from: "NotificationService.send",
        value: "/3/device/{token}",
        hints: { method: "POST", base_url_expr: "self.host", query: null },
        confidence: "inferred",
        reason:
          "httpx post(): base self.host resolves to one of https://api.sandbox.push.apple.com or https://api.push.apple.com, chosen at runtime; path template shown without a host",
      },
    ]);
    // The client constructor is configuration, not a call surface.
    expect(
      r.edges.some(
        (e) => typeof e.to !== "string" && e.to.value === "httpx.AsyncClient",
      ),
    ).toBe(false);
  });

  it("aiohttp through `async with ... as session` with a literal base URL in __init__", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "linear.py",
      [
        "import aiohttp",
        "class LinearPromptService:",
        "    def __init__(self):",
        '        self.base_url = "https://api.linear.app/graphql"',
        "    async def fetch(self, payload):",
        "        async with aiohttp.ClientSession() as session:",
        "            async with session.post(self.base_url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as response:",
        "                return await response.json()",
        "",
      ].join("\n"),
    );
    expect(http(r.edges)).toEqual([
      {
        from: "LinearPromptService.fetch",
        value: "https://api.linear.app/graphql",
        hints: { method: "POST", base_url_expr: "self.base_url", query: null },
        confidence: "certain",
        reason: null,
      },
    ]);
    expect(r.diagnostics.filter((d) => d.code === "untyped_receiver")).toEqual(
      [],
    );
  });

  it("a value operation on a response is not an HTTP call: response.json().get(...) draws nothing", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "linear.py",
      [
        "import aiohttp",
        "async def fetch(url, payload):",
        "    async with aiohttp.ClientSession() as session:",
        "        async with session.post(url, json=payload) as response:",
        "            data = await response.json()",
        '            document = data.get("data", {}).get("document")',
        '            return document.get("content")',
        "",
      ].join("\n"),
    );
    expect(http(r.edges).map((e) => e.value)).toEqual(["{unresolved}"]);
    expect(r.edges.filter((e) => e.kind === "call")).toEqual([]);
    // An info note on the doubly-chained dict lookup is fine; nothing louder.
    expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("requests with a constructor-parameter base stays unrecoverable and says why; a literal module verb is certain", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "seed.py",
      [
        "import requests",
        "class Api:",
        "    def __init__(self, base_url: str):",
        '        self.base_url = base_url.rstrip("/")',
        "        self.session = requests.Session()",
        "    def request(self, method, path):",
        "        return self.session.request(method, self.base_url + path)",
        "def ping():",
        '    return requests.get("https://example.com/health?deep=1")',
        "",
      ].join("\n"),
    );
    const edges = http(r.edges);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      from: "Api.request",
      value: "{unresolved}",
      hints: { method: null, base_url_expr: "self.base_url", query: null },
      confidence: "inferred",
    });
    expect(edges[0]?.reason).toMatch(
      /base self\.base_url is not a literal or constant this file can see; self\.base_url is assigned from base_url\.rstrip/,
    );
    expect(edges[1]).toEqual({
      from: "ping",
      value: "https://example.com/health",
      hints: { method: "GET", base_url_expr: null, query: "deep=1" },
      confidence: "certain",
      reason: null,
    });
  });

  it("boto3 Lambda is an external service; calls on an SDK response are not further edges", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "bench.py",
      [
        "import boto3",
        "def force_cold(name):",
        '    client = boto3.client("lambda", region_name="us-west-2")',
        "    current = client.get_function_configuration(FunctionName=name)",
        '    env = current.get("Environment", {}).get("Variables", {})',
        '    client.get_waiter("function_updated_v2").wait(FunctionName=name)',
        "    return env",
        "",
      ].join("\n"),
    );
    const ext = r.edges.filter((e) => e.kind === "external_call");
    expect(ext.map((e) => [ref(e).value, e.label])).toEqual([
      ["aws/lambda", "get_function_configuration"],
      ["aws/lambda", "get_waiter"],
    ]);
    expect(r.edges.filter((e) => e.kind === "call")).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
