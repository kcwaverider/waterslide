import { describe, expect, it } from "vitest";
import { serializeCanonical } from "../src/canonical.js";
import type { CanonicalGraph } from "../src/model/graph.js";
import { collapseEdges, finalizeEdges } from "../src/pipeline/derive-edges.js";
import { inheritedTier, resolve } from "../src/pipeline/resolve.js";
import { validate } from "../src/validate.js";
import {
  corpus,
  node,
  provide,
  ref,
  shuffled,
  sym,
  type Origin,
} from "./helpers/corpus.js";

const API: Origin = { repo: "api", path: "svc/notes.py" };
const STORE: Origin = { repo: "api", path: "svc/store.py" };
const IOS: Origin = { repo: "ios", path: "App/Sync.swift" };

const caller = node("api:svc/notes.py#update", "function", "domain");
const target = node("api:svc/store.py#save", "function", "data_access");
const iosCaller = node("ios:App/Sync.swift#sync", "client_service", "ui_logic");

/** Assembles a canonical graph and runs the validator over the whole pipeline output. */
function validGraph(c: ReturnType<typeof corpus>): CanonicalGraph {
  const r = resolve(c);
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const edges = finalizeEdges(collapseEdges(r.edges), byId);
  const repos = [
    ...new Set(r.nodes.map((n) => n.id.slice(0, n.id.indexOf(":")))),
  ]
    .filter(
      (s) => !["svc", "mongo", "sql", "topic", "ext", "unknown"].includes(s),
    )
    .sort()
    .map((name) => ({ name, commit: "0".repeat(40) }));
  const graph: CanonicalGraph = {
    schema_version: 1,
    tier_config_hash: c.tier_config_hash,
    repos,
    nodes: r.nodes,
    edges,
    schemas: [],
  };
  const result = validate(JSON.parse(serializeCanonical(graph)), {
    shape: "canonical",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.graph;
}

describe("stage 4: symbol resolution (parser §4.1, §3.4)", () => {
  it("resolves an exact qualified match and keeps the pack's confidence", () => {
    const r = resolve(
      corpus({
        nodes: [caller, target],
        edges: [ref(caller.id, sym("svc.store.save"), API)],
        provides: [provide("svc.store.save", target.id, STORE)],
      }),
    );
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]?.to).toBe(target.id);
    expect(r.edges[0]?.confidence).toBe("certain");
    expect(r.stats).toMatchObject({ resolved: 1, dangling: 0, ambiguous: 0 });
    expect(r.nodes).toHaveLength(2);
  });

  it("matches a qualified global name across repos, but a bare global name only within its repo", () => {
    const apiClientIos = node(
      "ios:Net/APIClient.swift#APIClient",
      "class",
      "ui_logic",
    );
    const apiClientApi = node("api:net/client.py#APIClient", "class", "domain");
    const r = resolve(
      corpus({
        nodes: [iosCaller, caller, apiClientIos, apiClientApi, target],
        edges: [
          ref(iosCaller.id, sym("APIClient"), IOS),
          ref(iosCaller.id, sym("svc.store.save"), IOS),
        ],
        provides: [
          provide("APIClient", apiClientIos.id, {
            repo: "ios",
            path: "Net/APIClient.swift",
          }),
          provide("APIClient", apiClientApi.id, {
            repo: "api",
            path: "net/client.py",
          }),
          provide("svc.store.save", target.id, STORE),
        ],
      }),
    );
    const targets = r.edges.map((e) => e.to).sort();
    expect(targets).toEqual([apiClientIos.id, target.id].sort());
    expect(r.stats.ambiguous).toBe(0);
  });

  it("binds a file-scoped alias in the importing file only", () => {
    const other = node("api:svc/other.py#run");
    const r = resolve(
      corpus({
        nodes: [caller, target, other],
        edges: [
          ref(caller.id, sym("save"), API),
          ref(other.id, sym("save"), { repo: "api", path: "svc/other.py" }),
        ],
        provides: [
          provide("svc.store.save", target.id, STORE),
          provide("save", null, API, {
            alias_of: "svc.store.save",
            scope: "file",
            scope_path: API.path,
            visibility: "private",
          }),
        ],
      }),
    );
    const byFrom = new Map(r.edges.map((e) => [e.from, e.to]));
    expect(byFrom.get(caller.id)).toBe(target.id);
    expect(byFrom.get(other.id)).toBe("unknown:symbol:save");
    expect(r.stats.unresolved_by_kind.symbol).toBe(1);
  });

  it("follows alias chains, drops cycles and over-deep chains with a diagnostic, and dangles through an alias to nothing", () => {
    const chain = Array.from({ length: 10 }, (_, i) =>
      provide(`a${String(i)}`, null, STORE, { alias_of: `a${String(i + 1)}` }),
    );
    const r = resolve(
      corpus({
        nodes: [caller, target],
        edges: [
          ref(caller.id, sym("a0"), API),
          ref(caller.id, sym("loop1"), API),
          ref(caller.id, sym("gone"), API),
          ref(caller.id, sym("two"), API),
        ],
        provides: [
          ...chain,
          provide("loop1", null, STORE, { alias_of: "loop2" }),
          provide("loop2", null, STORE, { alias_of: "loop1" }),
          provide("gone", null, STORE, { alias_of: "svc.missing.thing" }),
          provide("two", null, STORE, { alias_of: "svc.store.save" }),
          provide("svc.store.save", target.id, STORE),
        ],
      }),
    );
    const aliasDiags = r.diagnostics.filter(
      (d) => d.code === "unresolvable_provide_alias",
    );
    // a0 needs 10 hops and a1 needs 9; both exceed the cap. Both halves of the
    // loop are reported, once each.
    expect(aliasDiags.map((d) => d.message)).toEqual([
      expect.stringContaining('"a0"'),
      expect.stringContaining('"a1"'),
      expect.stringContaining("cycle"),
      expect.stringContaining("cycle"),
    ]);
    const byValue = new Map(
      r.edges.map((e) => [
        (e.label ?? "") + JSON.stringify(e.source?.line_start),
        e.to,
      ]),
    );
    void byValue;
    const tos = r.edges.map((e) => e.to);
    expect(tos).toContain(target.id); // `two` -> one hop
    expect(tos).toContain("unknown:symbol:gone");
    const gone = r.diagnostics.find(
      (d) => d.code === "unresolved_ref" && d.message.includes("'gone'"),
    );
    expect(gone?.message).toContain("via alias to 'svc.missing.thing'");
  });

  it("treats duplicate aliases and reconverging alias paths as one target, not a cycle", () => {
    const d = node("api:svc/d.py#d");
    const r = resolve(
      corpus({
        nodes: [caller, d],
        edges: [ref(caller.id, sym("a"), API), ref(caller.id, sym("dup"), API)],
        provides: [
          // Diamond: a -> b, a -> c, b -> d, c -> d.
          provide("a", null, STORE, { alias_of: "b" }),
          provide(
            "a",
            null,
            { repo: "api", path: "svc/other.py" },
            { alias_of: "c" },
          ),
          provide("b", null, STORE, { alias_of: "svc.d.d" }),
          provide("c", null, STORE, { alias_of: "svc.d.d" }),
          // Same-level duplicate: two identical alias entries.
          provide("dup", null, STORE, { alias_of: "svc.d.d" }),
          provide(
            "dup",
            null,
            { repo: "api", path: "svc/other.py" },
            { alias_of: "svc.d.d" },
          ),
          provide("svc.d.d", d.id, { repo: "api", path: "svc/d.py" }),
        ],
      }),
    );
    expect(r.edges.map((e) => e.to)).toEqual([d.id, d.id]);
    expect(
      r.diagnostics.filter((x) => x.code === "unresolvable_provide_alias"),
    ).toEqual([]);
    expect(r.stats).toMatchObject({ resolved: 2, ambiguous: 0, dangling: 0 });
  });

  it("respects visibility: private is same file, module is same repo", () => {
    const priv = node("api:svc/store.py#_hidden");
    const mod = node("api:svc/store.py#internal");
    const r = resolve(
      corpus({
        nodes: [caller, iosCaller, priv, mod, target],
        edges: [
          ref(caller.id, sym("svc.store._hidden"), API),
          ref(caller.id, sym("svc.store.internal"), API),
          ref(iosCaller.id, sym("svc.store.internal"), IOS),
        ],
        provides: [
          provide("svc.store._hidden", priv.id, STORE, {
            visibility: "private",
          }),
          provide("svc.store.internal", mod.id, STORE, {
            visibility: "module",
          }),
        ],
      }),
    );
    const tos = r.edges.map((e) => `${e.from} -> ${e.to}`);
    expect(tos).toContain(`${caller.id} -> unknown:symbol:svc.store._hidden`);
    expect(tos).toContain(`${caller.id} -> ${mod.id}`);
    expect(tos).toContain(
      `${iosCaller.id} -> unknown:symbol:svc.store.internal`,
    );
  });

  it("draws every candidate of an ambiguous reference, all inferred, with a reason naming the ambiguity", () => {
    const a = node("api:svc/a.py#display");
    const b = node("api:svc/b.py#display");
    const r = resolve(
      corpus({
        nodes: [caller, a, b],
        edges: [ref(caller.id, sym("svc.display"), API)],
        provides: [
          provide("svc.display", a.id, { repo: "api", path: "svc/a.py" }),
          provide("svc.display", b.id, { repo: "api", path: "svc/b.py" }),
        ],
      }),
    );
    expect(r.edges.map((e) => e.to).sort()).toEqual([a.id, b.id]);
    for (const e of r.edges) {
      expect(e.confidence).toBe("inferred");
      expect(e.confidence_reason).toContain("ambiguous");
      expect(e.confidence_reason).toContain(a.id);
      expect(e.confidence_reason).toContain(b.id);
    }
    expect(r.stats.ambiguous).toBe(1);
    expect(r.diagnostics.some((d) => d.code === "ambiguous_ref")).toBe(true);
  });
});

describe("stage 4: dangling references and unknown nodes (parser §4.2)", () => {
  it("mints unknown:{ref_kind}:{value} with the caller's tier, inferred, and a reason naming the origin", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [ref(caller.id, sym("memory_service.forget", 70), API)],
      }),
    );
    const unknown = r.nodes.find((n) => n.kind === "unknown");
    expect(unknown).toMatchObject({
      id: "unknown:symbol:memory_service.forget",
      label: "unresolved symbol memory_service.forget",
      tier: "domain",
      sources: [],
      confidence: "inferred",
    });
    expect(unknown?.confidence_reason).toContain("api:svc/notes.py:70");
    expect(r.edges[0]).toMatchObject({
      to: "unknown:symbol:memory_service.forget",
      confidence: "inferred",
    });
    expect(r.edges[0]?.confidence_reason).toContain("synthetic unknown node");
    const d = r.diagnostics.find((x) => x.code === "unresolved_ref");
    expect(d?.message).toMatch(/^symbol: 'memory_service.forget'/);
    expect(r.stats.unresolved_by_kind).toEqual({
      symbol: 1,
      http: 0,
      topic: 0,
      datastore: 0,
      external: 0,
    });
  });

  it("inherits the shallowest caller tier; external never wins unless it is alone", () => {
    expect(inheritedTier(new Set(["domain", "api"]))).toBe("api");
    expect(inheritedTier(new Set(["external", "domain"]))).toBe("domain");
    expect(inheritedTier(new Set(["external"]))).toBe("external");
    expect(inheritedTier(new Set([]))).toBe("external");
    const ext = node("ext:cohere/embed", "external_service", "external");
    const r = resolve(
      corpus({
        nodes: [caller, iosCaller, ext],
        edges: [
          ref(caller.id, sym("x.y", 1), API),
          ref(iosCaller.id, sym("x.y", 2), IOS),
          ref(ext.id, sym("x.y", 3), API),
          ref(ext.id, sym("only.external", 4), API),
        ],
      }),
    );
    expect(r.nodes.find((n) => n.id === "unknown:symbol:x.y")?.tier).toBe(
      "ui_logic",
    );
    expect(
      r.nodes.find((n) => n.id === "unknown:symbol:only.external")?.tier,
    ).toBe("external");
    expect(
      r.nodes.find((n) => n.id === "unknown:symbol:x.y")?.confidence_reason,
    ).toContain("and 2 more");
  });

  it("produces a graph that passes every validator invariant", () => {
    const g = validGraph(
      corpus({
        nodes: [caller, iosCaller],
        edges: [
          ref(caller.id, sym("a.b"), API),
          ref(iosCaller.id, sym("a.b"), IOS),
        ],
      }),
    );
    expect(g.nodes.some((n) => n.kind === "unknown")).toBe(true);
    expect(g.edges.every((e) => e.skips_tiers.length === 0)).toBe(true);
  });
});

describe("stage 4: http references", () => {
  const route = node("api:routers/notes.py#update_note", "endpoint", "api", {
    is_entry_point: true,
    entry_point_kind: "http_route",
  });
  const routeProvide = provide(
    "PUT /notes/{id}",
    route.id,
    { repo: "api", path: "routers/notes.py" },
    {
      ref_kind: "http",
    },
  );

  it("matches '{METHOD} {path}' exactly and downgrades to inferred with a reason", () => {
    const r = resolve(
      corpus({
        nodes: [iosCaller, route],
        edges: [
          ref(
            iosCaller.id,
            {
              ref_kind: "http",
              value: "/notes/{id}",
              hints: { method: "PUT", base_url_expr: null, query: null },
              source_line: 88,
            },
            IOS,
            { kind: "http_request" },
          ),
        ],
        provides: [routeProvide],
      }),
    );
    expect(r.edges[0]).toMatchObject({ to: route.id, confidence: "inferred" });
    expect(r.edges[0]?.confidence_reason).toContain("PUT /notes/{id}");
    expect(r.edges[0]?.confidence_reason).toContain("api:routers/notes.py");
  });

  it("uses '?' for an unknown method, which never matches a route and dangles with a reason", () => {
    const r = resolve(
      corpus({
        nodes: [iosCaller, route],
        edges: [
          ref(
            iosCaller.id,
            { ref_kind: "http", value: "/notes/{id}", source_line: 88 },
            IOS,
            { kind: "http_request" },
          ),
        ],
        provides: [routeProvide],
      }),
    );
    expect(r.edges[0]?.to).toBe("unknown:http:?%20%2Fnotes%2F{id}");
    expect(r.nodes.find((n) => n.kind === "unknown")?.label).toBe(
      "unresolved http ? /notes/{id}",
    );
    expect(r.edges[0]?.confidence_reason).toContain(
      "method was not determinable",
    );
  });

  it("matches positionally-equal templates whose parameter names differ, and says so in the reason", () => {
    const r = resolve(
      corpus({
        nodes: [iosCaller, route],
        edges: [
          ref(
            iosCaller.id,
            {
              ref_kind: "http",
              value: "/notes/{noteId}",
              hints: { method: "PUT", base_url_expr: null, query: null },
              source_line: 1,
            },
            IOS,
            { kind: "http_request" },
          ),
        ],
        provides: [routeProvide],
      }),
    );
    expect(r.edges[0]).toMatchObject({ to: route.id, confidence: "inferred" });
    expect(r.edges[0]?.confidence_reason).toContain("PUT /notes/{noteId}");
    expect(r.edges[0]?.confidence_reason).toContain("PUT /notes/{id}");
    expect(r.edges[0]?.confidence_reason).toContain("spelled differently");
  });

  it("does not normalise parameter count or position, case, or trailing slashes", () => {
    const posts = node("api:routers/posts.py#list_posts", "endpoint", "api");
    const r = resolve(
      corpus({
        nodes: [iosCaller, route, posts],
        edges: [
          "/notes/{id}/extra",
          "/Notes/{id}",
          "/notes/{id}/",
          "/users/{id}/posts/{postId}",
        ].map((value, i) =>
          ref(
            iosCaller.id,
            {
              ref_kind: "http",
              value,
              hints: {
                method: i === 3 ? "GET" : "PUT",
                base_url_expr: null,
                query: null,
              },
              source_line: i + 1,
            },
            IOS,
            { kind: "http_request" },
          ),
        ),
        provides: [
          routeProvide,
          provide(
            "GET /users/{id}/posts",
            posts.id,
            { repo: "api", path: "routers/posts.py" },
            {
              ref_kind: "http",
            },
          ),
        ],
      }),
    );
    expect(r.edges.every((e) => e.to.startsWith("unknown:http:"))).toBe(true);
    expect(r.stats.unresolved_by_kind.http).toBe(4);
  });

  it("keeps GET and POST on one path as distinct unknown nodes", () => {
    const r = resolve(
      corpus({
        nodes: [iosCaller],
        edges: ["GET", "POST"].map((method) =>
          ref(
            iosCaller.id,
            {
              ref_kind: "http",
              value: "/x",
              hints: { method, base_url_expr: null, query: null },
              source_line: 1,
            },
            IOS,
            { kind: "http_request" },
          ),
        ),
      }),
    );
    expect(
      r.nodes.filter((n) => n.kind === "unknown").map((n) => n.id),
    ).toEqual(["unknown:http:GET%20%2Fx", "unknown:http:POST%20%2Fx"]);
  });
});

describe("stage 4: topics, datastores, externals", () => {
  it("mints a topic node in store and downgrades the edge", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [
          ref(
            caller.id,
            {
              ref_kind: "topic",
              value: "note.indexed",
              hints: { direction: "publish" },
              source_line: 3,
            },
            API,
            {
              kind: "publish",
            },
          ),
        ],
      }),
    );
    expect(r.nodes.find((n) => n.id === "topic:note.indexed")).toMatchObject({
      kind: "topic",
      tier: "store",
      label: "note.indexed",
      confidence: "inferred",
    });
    expect(r.edges[0]).toMatchObject({
      to: "topic:note.indexed",
      confidence: "inferred",
    });
  });

  it("mints collections and tables from datastore hints, diagnosing a missing namespace, and dangles without hints", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [
          ref(
            caller.id,
            {
              ref_kind: "datastore",
              value: "notes",
              hints: {
                operation: "write",
                store: "mongo",
                namespace: "tapistree",
              },
              source_line: 1,
            },
            API,
            { kind: "write" },
          ),
          ref(
            caller.id,
            {
              ref_kind: "datastore",
              value: "events",
              hints: { operation: "read", store: "mongo", namespace: null },
              source_line: 2,
            },
            API,
            {
              kind: "read",
              confidence: "inferred",
              confidence_reason:
                "inferred collection 'events' from entity class Event",
            },
          ),
          ref(
            caller.id,
            {
              ref_kind: "datastore",
              value: "orders",
              hints: { operation: "read", store: "sql", namespace: "public" },
              source_line: 3,
            },
            API,
            { kind: "read" },
          ),
          ref(
            caller.id,
            { ref_kind: "datastore", value: "nohints", source_line: 4 },
            API,
            { kind: "read" },
          ),
        ],
      }),
    );
    const ids = r.nodes.map((n) => n.id);
    expect(ids).toContain("mongo:tapistree.notes");
    expect(ids).toContain("mongo:unknown.events");
    expect(ids).toContain("sql:public.orders");
    expect(ids).toContain("unknown:datastore:nohints");
    expect(r.nodes.find((n) => n.id === "sql:public.orders")?.kind).toBe(
      "table",
    );
    expect(r.nodes.find((n) => n.id === "mongo:tapistree.notes")).toMatchObject(
      {
        kind: "collection",
        confidence: "certain",
        confidence_reason: null,
      },
    );
    expect(r.nodes.find((n) => n.id === "mongo:unknown.events")).toMatchObject({
      confidence: "inferred",
      confidence_reason: "inferred collection 'events' from entity class Event",
    });
    const ns = r.diagnostics.find(
      (d) => d.code === "undeclared_datastore_namespace",
    );
    expect(ns?.message).toContain("'events'");
    expect(ns?.message).toContain("api:svc/notes.py");
    expect(r.stats.unresolved_by_kind.datastore).toBe(1);
  });

  it("mints external services from vendor surfaces and known hosts, dangling on unknown hosts", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [
          ref(
            caller.id,
            {
              ref_kind: "external",
              value: "cohere/embed",
              hints: { sdk_symbol: "cohere.Client.embed" },
              source_line: 1,
            },
            API,
            { kind: "external_call" },
          ),
          ref(
            caller.id,
            {
              ref_kind: "external",
              value: "https://api.anthropic.com/v1/messages",
              source_line: 2,
            },
            API,
            { kind: "external_call" },
          ),
          ref(
            caller.id,
            {
              ref_kind: "external",
              value: "https://example.internal/x",
              source_line: 3,
            },
            API,
            { kind: "external_call" },
          ),
        ],
      }),
    );
    expect(r.nodes.find((n) => n.id === "ext:cohere/embed")).toMatchObject({
      kind: "external_service",
      tier: "external",
      label: "Cohere embed",
      confidence: "certain",
    });
    expect(r.nodes.find((n) => n.id === "ext:anthropic/v1")).toMatchObject({
      label: "Anthropic v1",
      confidence: "inferred",
    });
    const byUrl = r.edges.find((e) => e.to === "ext:anthropic/v1");
    expect(byUrl?.confidence).toBe("inferred");
    expect(byUrl?.confidence_reason).toContain("api.anthropic.com");
    expect(r.edges.find((e) => e.to === "ext:cohere/embed")?.confidence).toBe(
      "certain",
    );
    expect(r.nodes.some((n) => n.id.startsWith("unknown:external:https"))).toBe(
      true,
    );
  });

  it("reports pack-emitted endpoints that do not exist and drops those edges", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [
          ref(caller.id, "api:nowhere.py#x", API),
          ref("api:ghost.py#g", sym("a.b"), API),
        ],
        provides: [provide("a.b", "api:missing.py#m", STORE)],
      }),
    );
    expect(r.edges).toEqual([]);
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual([
      "edge_endpoint_missing",
      "edge_endpoint_missing",
      "provide_target_missing",
    ]);
  });
});

describe("stage 4: factory-returned receivers (C9)", () => {
  const s3 = node("api:services/s3_service.py#S3Service", "class");
  const upload = node(
    "api:services/s3_service.py#S3Service.upload_bytes",
    "function",
  );
  const S3: Origin = { repo: "api", path: "services/s3_service.py" };
  const FACTORY: Origin = { repo: "api", path: "services/__init__.py" };
  const provides = [
    provide("services.s3_service.S3Service", s3.id, S3),
    provide("services.s3_service.S3Service.upload_bytes", upload.id, S3),
    provide("services.get_s3_service()", null, FACTORY, {
      alias_of: "services.s3_service.S3Service",
    }),
  ];

  it("joins a call through a factory's return annotation, inferred, naming factory, annotation and file", () => {
    const r = resolve(
      corpus({
        nodes: [caller, s3, upload],
        edges: [
          ref(
            caller.id,
            sym("services.get_s3_service().upload_bytes", 12),
            API,
          ),
        ],
        provides,
      }),
    );
    expect(r.edges[0]).toMatchObject({ to: upload.id, confidence: "inferred" });
    expect(r.edges[0]?.confidence_reason).toContain(
      "services.get_s3_service()",
    );
    expect(r.edges[0]?.confidence_reason).toContain(
      "services.s3_service.S3Service",
    );
    expect(r.edges[0]?.confidence_reason).toContain("api:services/__init__.py");
    expect(r.stats).toMatchObject({ resolved: 1, via_factory: 1, dangling: 0 });
  });

  it("fans out over every return annotation a factory was given", () => {
    const other = node("api:services/other_service.py#OtherService");
    const otherUpload = node(
      "api:services/other_service.py#OtherService.upload_bytes",
    );
    const OTHER: Origin = { repo: "api", path: "services/other_service.py" };
    const r = resolve(
      corpus({
        nodes: [caller, s3, upload, other, otherUpload],
        edges: [
          ref(
            caller.id,
            sym("services.get_s3_service().upload_bytes", 12),
            API,
          ),
        ],
        provides: [
          ...provides,
          provide("services.other_service.OtherService", other.id, OTHER),
          provide(
            "services.other_service.OtherService.upload_bytes",
            otherUpload.id,
            OTHER,
          ),
          provide("services.get_s3_service()", null, OTHER, {
            alias_of: "services.other_service.OtherService",
          }),
        ],
      }),
    );
    expect(r.edges.map((e) => e.to).sort()).toEqual(
      [otherUpload.id, upload.id].sort(),
    );
    expect(r.edges.every((e) => e.confidence === "inferred")).toBe(true);
    expect(r.stats.ambiguous).toBe(1);
  });

  it("only splits at prefixes ending in '()', and makes one pass", () => {
    const r = resolve(
      corpus({
        nodes: [caller, s3, upload],
        edges: [
          // `services.s3_service.S3Service` is provided but is not a factory call: no prefix search.
          ref(caller.id, sym("services.s3_service.S3Service.nope", 1), API),
          // Factory resolves, but the remainder names nothing: dangles, naming the factory.
          ref(caller.id, sym("services.get_s3_service().delete_all", 2), API),
        ],
        provides,
      }),
    );
    const tos = r.edges.map((e) => e.to).sort();
    expect(tos).toEqual(
      [
        "unknown:symbol:services.s3_service.S3Service.nope",
        "unknown:symbol:services.get_s3_service().delete_all",
      ].sort(),
    );
    const d = r.diagnostics.find((x) => x.message.includes("delete_all"));
    expect(d?.message).toContain(
      "matched alias prefix 'services.get_s3_service()'",
    );
    expect(r.stats.via_factory).toBe(0);
  });
});

describe("stage 4: stdlib-rooted alias targets (C19 fix 1)", () => {
  const LOGGER: Origin = { repo: "api", path: "utils/logger.py" };
  const loggerAlias = provide("utils.logger.logger", null, LOGGER, {
    alias_of: "logging.getLogger()",
  });

  it("drops a reference through an alias into the standard library silently: no edge, no node, no diagnostic", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [
          ref(caller.id, sym("utils.logger.logger.info", 5), API),
          ref(caller.id, sym("utils.logger.logger.error", 6), API),
          ref(caller.id, sym("utils.logger.logger", 7), API),
        ],
        provides: [loggerAlias],
      }),
    );
    expect(r.edges).toEqual([]);
    expect(r.nodes).toEqual([caller]);
    expect(r.diagnostics).toEqual([]);
    expect(r.stats).toMatchObject({
      stdlib_dropped: 3,
      dangling: 0,
      resolved: 0,
    });
    expect(r.stats.unresolved_by_kind.symbol).toBe(0);
  });

  it("keeps a fork alternative into the stdlib as a dangling edge, so the group's ordinals stay contiguous", () => {
    const other = node("api:svc/store.py#save");
    const r = resolve(
      corpus({
        nodes: [caller, other],
        edges: [
          ref(caller.id, sym("utils.logger.logger.info", 5), API, {
            exclusive_group: "g",
            branch_ordinal: 0,
            condition: { expr: "if x", source_line: 4 },
          }),
          ref(caller.id, sym("svc.store.save", 7), API, {
            exclusive_group: "g",
            branch_ordinal: 1,
            condition: { expr: "else", source_line: 6 },
          }),
        ],
        provides: [loggerAlias, provide("svc.store.save", other.id, STORE)],
      }),
    );
    expect(
      r.edges
        .map((e) => [e.to, e.branch_ordinal] as const)
        .sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0)),
    ).toEqual([
      ["unknown:symbol:utils.logger.logger.info", 0],
      [other.id, 1],
    ]);
    expect(r.stats).toMatchObject({ stdlib_dropped: 0, stdlib_fork_kept: 1 });
    validGraph(
      corpus({
        nodes: [caller, other],
        edges: [
          ref(caller.id, sym("utils.logger.logger.info", 5), API, {
            exclusive_group: "g",
            branch_ordinal: 0,
          }),
          ref(caller.id, sym("svc.store.save", 7), API, {
            exclusive_group: "g",
            branch_ordinal: 1,
          }),
        ],
        provides: [loggerAlias, provide("svc.store.save", other.id, STORE)],
      }),
    );
  });

  it("treats a file-scoped stdlib import alias the same way", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [ref(caller.id, sym("path"), API)],
        provides: [
          provide("path", null, API, {
            alias_of: "os.path",
            scope: "file",
            scope_path: API.path,
          }),
        ],
      }),
    );
    expect(r.edges).toEqual([]);
    expect(r.stats.stdlib_dropped).toBe(1);
  });

  it("does not drop a third-party alias target: it dangles, named by the terminal", () => {
    const r = resolve(
      corpus({
        nodes: [caller],
        edges: [ref(caller.id, sym("db.database.db.find_one"), API)],
        provides: [
          provide("db.database.db", null, STORE, {
            alias_of: "motor.motor_asyncio.AsyncIOMotorClient()",
          }),
        ],
      }),
    );
    expect(r.edges[0]?.to).toBe("unknown:symbol:db.database.db.find_one");
    expect(r.stats.stdlib_dropped).toBe(0);
    expect(r.diagnostics[0]?.message).toContain(
      "matched alias prefix 'db.database.db'",
    );
  });

  it("with mixed stdlib and in-repo targets, keeps only the in-repo ones", () => {
    const t = node("api:svc/x.py#Thing.run");
    const r = resolve(
      corpus({
        nodes: [caller, t],
        edges: [ref(caller.id, sym("svc.get_thing().run"), API)],
        provides: [
          provide("svc.get_thing()", null, STORE, { alias_of: "svc.x.Thing" }),
          provide(
            "svc.get_thing()",
            null,
            { repo: "api", path: "svc/other.py" },
            { alias_of: "logging.Logger" },
          ),
          provide("svc.x.Thing.run", t.id, { repo: "api", path: "svc/x.py" }),
        ],
      }),
    );
    expect(r.edges.map((e) => e.to)).toEqual([t.id]);
    expect(r.stats.stdlib_dropped).toBe(0);
  });
});

describe("stage 4: alias-provided prefixes beyond '()' (C19 fix 2)", () => {
  const AUTH: Origin = { repo: "api", path: "auth/oauth2.py" };
  const login = node("api:auth/oauth2.py#OAuth2Login", "class");
  const verify = node("api:auth/oauth2.py#OAuth2Login.verify_password");
  const provides = [
    provide("auth.oauth2.OAuth2Login", login.id, AUTH),
    provide("auth.oauth2.OAuth2Login.verify_password", verify.id, AUTH),
    provide("auth.oauth2.oauth2_handler", null, AUTH, {
      alias_of: "auth.oauth2.OAuth2Login",
    }),
  ];

  it("resolves a method on a module-level singleton through its alias, inferred, naming the alias and its file", () => {
    const r = resolve(
      corpus({
        nodes: [caller, login, verify],
        edges: [
          ref(
            caller.id,
            sym("auth.oauth2.oauth2_handler.verify_password", 3),
            API,
          ),
        ],
        provides,
      }),
    );
    expect(r.edges[0]).toMatchObject({ to: verify.id, confidence: "inferred" });
    expect(r.edges[0]?.confidence_reason).toContain(
      "auth.oauth2.oauth2_handler",
    );
    expect(r.edges[0]?.confidence_reason).toContain("auth.oauth2.OAuth2Login");
    expect(r.edges[0]?.confidence_reason).toContain("api:auth/oauth2.py");
    expect(r.stats).toMatchObject({ via_factory: 1, prefix_alias_multi: 0 });
  });

  it("uses only alias-provided prefixes: a prefix that is a real node does not retarget", () => {
    const r = resolve(
      corpus({
        nodes: [caller, login],
        edges: [ref(caller.id, sym("auth.oauth2.OAuth2Login.nope"), API)],
        provides: [provide("auth.oauth2.OAuth2Login", login.id, AUTH)],
      }),
    );
    expect(r.edges[0]?.to).toBe("unknown:symbol:auth.oauth2.OAuth2Login.nope");
    expect(r.stats.via_factory).toBe(0);
  });

  it("takes the longest matching prefix and counts the reference as multi-prefix", () => {
    const short = node("api:a/s.py#Short.c.m");
    const long = node("api:a/l.py#Long.m");
    const r = resolve(
      corpus({
        nodes: [caller, short, long],
        edges: [ref(caller.id, sym("a.b.c.m"), API)],
        provides: [
          provide("a.b", null, STORE, { alias_of: "a.s.Short" }),
          provide("a.b.c", null, STORE, { alias_of: "a.l.Long" }),
          provide("a.s.Short.c.m", short.id, { repo: "api", path: "a/s.py" }),
          provide("a.l.Long.m", long.id, { repo: "api", path: "a/l.py" }),
        ],
      }),
    );
    expect(r.edges.map((e) => e.to)).toEqual([long.id]);
    expect(r.stats).toMatchObject({
      via_factory: 1,
      prefix_alias_multi: 1,
      ambiguous: 0,
    });
  });
});

describe("stage 4: determinism", () => {
  it("is invariant under shuffling of nodes, edges and provides", () => {
    const a = node("api:svc/a.py#display");
    const b = node("api:svc/b.py#display");
    const parts = {
      nodes: [caller, iosCaller, target, a, b],
      edges: [
        ref(caller.id, sym("svc.display"), API),
        ref(caller.id, sym("svc.store.save"), API),
        ref(iosCaller.id, sym("nope.x"), IOS),
        ref(caller.id, sym("nope.x"), API),
        ref(
          caller.id,
          {
            ref_kind: "topic",
            value: "t",
            hints: { direction: "publish" },
            source_line: 9,
          },
          API,
          { kind: "publish" },
        ),
      ],
      provides: [
        provide("svc.display", a.id, { repo: "api", path: "svc/a.py" }),
        provide("svc.display", b.id, { repo: "api", path: "svc/b.py" }),
        provide("svc.store.save", target.id, STORE),
      ],
    };
    const base = JSON.stringify(resolve(corpus(parts)));
    for (const seed of [1, 7, 42]) {
      const mixed = corpus({
        nodes: shuffled(parts.nodes, seed),
        edges: shuffled(parts.edges, seed + 1),
        provides: shuffled(parts.provides, seed + 2),
      });
      expect(JSON.stringify(resolve(mixed))).toBe(base);
    }
    validGraph(corpus(parts));
  });
});
