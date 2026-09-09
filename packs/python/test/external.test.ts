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
      hints: { direction: "publish", sdk_symbol: "boto3.sqs.send_message" },
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
  it("infers collection from the attribute, read/write from the method, never mints a node", async () => {
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
      ref(e).hints?.["operation"] ?? null,
      ref(e).hints?.["store"],
      ref(e).hints?.["namespace"],
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
        "NoteRepository.touch",
        "read",
        "rename",
        "notes",
        null,
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
    expect(mongo[4]?.confidence_reason).toMatch(/named like a database handle/);
    expect(repo?.nodes.some((n) => n.id.startsWith("mongo:"))).toBe(false);
    const unknown = repo?.diagnostics.find(
      (d) => d.code === "unsupported_construct",
    );
    expect(unknown?.message).toMatch(
      /Mongo method rename .* not in the read\/write table/,
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
      to: "mongo:db.notes",
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
