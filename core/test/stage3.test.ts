import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSchema } from "../src/model/graph.js";
import { MemoryParseCache } from "../src/pipeline/cache.js";
import { discover } from "../src/pipeline/discover.js";
import { parseSources, type Corpus } from "../src/pipeline/index.js";
import {
  PackRegistry,
  composePacks,
  mergeNodes,
  mergeSchemas,
  parseFiles,
} from "../src/pipeline/stage3.js";
import { TmpTree } from "./helpers/tmp-tree.js";
import { makeToyPack, type ToyPackOptions } from "./helpers/toy-pack.js";

const API =
  "def create\n  call store.save\n  route POST /notes\ndef list\n  call store.find_all\n";
const STORE = "def save\ndef find_all\n";
const CLIENT =
  "import save from api.store\ndef sync\n  call save\n  call api.notes.create\n";

let tree: TmpTree;
beforeEach(() => {
  tree = new TmpTree();
  tree.write("server/api/notes.toy", API);
  tree.write("server/api/store.toy", STORE);
  tree.write("client/App/Sync.toy", CLIENT);
});
afterEach(() => tree.dispose());

const repos = (): { name: string; path: string }[] => [
  { name: "server", path: `${tree.root}/server` },
  { name: "client", path: `${tree.root}/client` },
];

/** The corpus minus run statistics and diagnostics: what determinism is judged on. */
function canonical(c: Corpus): string {
  const { stats: _s, repos: _r, diagnostics: _d, ...rest } = c;
  return JSON.stringify(rest);
}

async function run(
  cache: MemoryParseCache,
  packOpts: ToyPackOptions = {},
  config = {},
): Promise<{ corpus: Corpus; pack: ReturnType<typeof makeToyPack> }> {
  const pack = makeToyPack(packOpts);
  const corpus = await parseSources({
    repos: repos(),
    packs: [pack],
    cache,
    config,
  });
  return { corpus, pack };
}

describe("stages 1–3 end to end", () => {
  it("parses a two-repo tree into a corpus of valid nodes with tiers and parents", async () => {
    const { corpus } = await run(new MemoryParseCache());
    expect(corpus.stats).toEqual({
      files: 3,
      parsed: 3,
      cache_hits: 0,
      repathed: 0,
      repath_fallbacks: 0,
    });
    for (const n of corpus.nodes)
      expect(NodeSchema.safeParse(n).success).toBe(true);
    expect(corpus.nodes.map((n) => n.id)).toEqual([
      "client:App/Sync.toy",
      "client:App/Sync.toy#sync",
      "server:api/notes.toy",
      "server:api/notes.toy#create",
      "server:api/notes.toy#list",
      "server:api/store.toy",
      "server:api/store.toy#find_all",
      "server:api/store.toy#save",
    ]);
    // fillParents: functions hang off their module.
    expect(corpus.nodes.find((n) => n.id.endsWith("#sync"))?.parent).toBe(
      "client:App/Sync.toy",
    );
    // A route provide and an alias provide came through with their origin file.
    expect(
      corpus.provides.find((p) => p.provide.ref_kind === "http")?.provide.name,
    ).toBe("POST /notes");
    const alias = corpus.provides.find((p) => p.provide.alias_of !== null);
    expect(alias?.provide).toMatchObject({
      name: "save",
      alias_of: "api.store.save",
      scope: "file",
      scope_path: "App/Sync.toy",
    });
    expect(alias?.repo).toBe("client");
    expect(corpus.edges).toHaveLength(4);
    expect(corpus.edges.every((e) => e.repo !== null && e.path !== null)).toBe(
      true,
    );
    expect(corpus.tier_config_hash).toBe("sha256:e3b0c44298fc1c14");
    expect(corpus.repos.map((r) => r.name)).toEqual(["client", "server"]);
  });

  it("warm parse: every file hits the cache and the corpus is byte-identical", async () => {
    const cache = new MemoryParseCache();
    const cold = await run(cache);
    const warm = await run(cache);
    expect(warm.corpus.stats).toMatchObject({
      files: 3,
      parsed: 0,
      cache_hits: 3,
    });
    expect(warm.pack.parseCalls).toBe(0);
    expect(canonical(warm.corpus)).toBe(canonical(cold.corpus));
  });

  it("touching one file re-parses only that file and changes only its nodes", async () => {
    const cache = new MemoryParseCache();
    const before = await run(cache);
    tree.write("server/api/store.toy", STORE + "def delete\n");
    const after = await run(cache);
    expect(after.corpus.stats).toMatchObject({ parsed: 1, cache_hits: 2 });
    const byId = (c: Corpus): Map<string, string> =>
      new Map(c.nodes.map((n) => [n.id, JSON.stringify(n)]));
    const a = byId(before.corpus);
    const b = byId(after.corpus);
    for (const [id, json] of a) {
      if (id.startsWith("server:api/store.toy")) continue;
      expect(b.get(id), id).toBe(json);
    }
    expect(b.has("server:api/store.toy#delete")).toBe(true);
    expect(b.get("server:api/store.toy")).not.toBe(
      a.get("server:api/store.toy"),
    );
  });

  it("a moved file hits the cache through rePath and equals a fresh parse", async () => {
    const cache = new MemoryParseCache();
    await run(cache);
    tree.remove("server/api/store.toy");
    tree.write("server/api/data/store.toy", STORE);
    const moved = await run(cache);
    expect(moved.corpus.stats).toMatchObject({
      parsed: 0,
      cache_hits: 3,
      repathed: 1,
      repath_fallbacks: 0,
    });
    const fresh = await run(new MemoryParseCache());
    expect(canonical(moved.corpus)).toBe(canonical(fresh.corpus));
    expect(
      moved.corpus.provides.some(
        (p) => p.provide.name === "api.data.store.save",
      ),
    ).toBe(true);
    expect(
      moved.corpus.provides.some((p) => p.provide.name === "api.store.save"),
    ).toBe(false);
  });

  it("a buggy rePath is caught by the guard, re-parsed, and named in a diagnostic", async () => {
    const cache = new MemoryParseCache();
    await run(cache, { rePath: "buggy" });
    tree.remove("server/api/store.toy");
    tree.write("server/api/data/store.toy", STORE);
    const moved = await run(cache, { rePath: "buggy" });
    expect(moved.corpus.stats).toMatchObject({
      parsed: 1,
      cache_hits: 2,
      repathed: 0,
      repath_fallbacks: 1,
    });
    const d = moved.corpus.diagnostics.find(
      (x) => x.code === "repath_rejected",
    );
    expect(d?.pack).toBe("toy");
    expect(d?.message).toContain("server:api/store.toy");
    expect(d?.message).toContain("server:api/data/store.toy");
    expect(d?.message).toContain('pack "toy"');
    const fresh = await run(new MemoryParseCache());
    expect(canonical(moved.corpus)).toBe(canonical(fresh.corpus));
  });

  it("a pack without rePath treats a moved file as a miss", async () => {
    const cache = new MemoryParseCache();
    await run(cache, { rePath: "none" });
    tree.remove("server/api/store.toy");
    tree.write("server/api/data/store.toy", STORE);
    const moved = await run(cache, { rePath: "none" });
    expect(moved.corpus.stats).toMatchObject({
      parsed: 1,
      cache_hits: 2,
      repathed: 0,
    });
    expect(
      moved.corpus.diagnostics.filter((d) => d.code === "repath_rejected"),
    ).toEqual([]);
  });

  it("identical content at two paths is one cache entry, re-pathed per location", async () => {
    tree.write("server/api/other/store.toy", STORE);
    const cache = new MemoryParseCache();
    const { corpus, pack } = await run(cache);
    expect(corpus.stats).toMatchObject({
      files: 4,
      parsed: 3,
      cache_hits: 1,
      repathed: 1,
    });
    expect(pack.parseCalls).toBe(3);
    expect(cache.size).toBe(3);
    expect(
      corpus.nodes.some((n) => n.id === "server:api/other/store.toy#save"),
    ).toBe(true);
  });

  it("changing pack options, pack version or the graph model misses the cache", async () => {
    const cache = new MemoryParseCache();
    await run(cache);
    const opts = await run(
      cache,
      {},
      { packs: { toy: { source_roots: ["api"] } } },
    );
    expect(opts.corpus.stats).toMatchObject({ parsed: 3, cache_hits: 0 });
    expect(
      opts.corpus.provides.some((p) => p.provide.name === "store.save"),
    ).toBe(true);
    const version = await run(cache, { version: "2.0.0" });
    expect(version.corpus.stats).toMatchObject({ parsed: 3, cache_hits: 0 });
  });

  it("survives a pack that throws or returns garbage, with a diagnostic naming the file", async () => {
    tree.write("server/api/boom.toy", "def x\n!!throw\n");
    tree.write("server/api/bad.toy", "!!bad\n");
    const { corpus } = await run(new MemoryParseCache());
    const codes = corpus.diagnostics.map((d) => `${d.code}@${d.path ?? ""}`);
    expect(codes).toContain("pack_exception@api/boom.toy");
    expect(codes).toContain("invalid_pack_result@api/bad.toy");
    expect(
      corpus.nodes.some((n) => n.id === "server:api/notes.toy#create"),
    ).toBe(true);
    expect(corpus.nodes.some((n) => n.id.includes("boom"))).toBe(false);
  });

  it("surfaces pack diagnostics from cached files on warm runs too", async () => {
    tree.write("server/api/odd.toy", "? what is this\ndef y\n");
    const cache = new MemoryParseCache();
    const cold = await run(cache);
    const warm = await run(cache);
    const odd = (c: Corpus): number =>
      c.diagnostics.filter((d) => d.code === "unsupported_construct").length;
    expect(odd(cold.corpus)).toBe(1);
    expect(odd(warm.corpus)).toBe(1);
  });
});

describe("shuffled discovery order", () => {
  it("does not change the merged nodes, edges or provides", async () => {
    const pack = makeToyPack({ compose: true });
    const registry = new PackRegistry([pack]);
    const files = await discover(repos(), { extensions: registry.extensions });
    const forward = await parseFiles(files, registry, {
      cache: new MemoryParseCache(),
      config: {},
    });
    const reversed = await parseFiles([...files].reverse(), registry, {
      cache: new MemoryParseCache(),
      config: {},
    });
    const cf = composePacks(forward, registry, {});
    const cr = composePacks(reversed, registry, {});
    expect(mergeNodes(cf.files, cf.additions).nodes).toEqual(
      mergeNodes(cr.files, cr.additions).nodes,
    );
    const key = (x: unknown): string => JSON.stringify(x);
    const sortedJson = (xs: readonly unknown[]): string[] => xs.map(key).sort();
    expect(sortedJson(cr.files.flatMap((f) => f.result.edges))).toEqual(
      sortedJson(cf.files.flatMap((f) => f.result.edges)),
    );
    // Compose received its files sorted both times, whatever order parseFiles saw.
    expect(pack.lastComposeOrder).toEqual([
      "client:App/Sync.toy",
      "server:api/notes.toy",
      "server:api/store.toy",
    ]);
  });
});

describe("compose (parser §3.3)", () => {
  it("runs once per pack over sorted files, and its patch is applied", async () => {
    const { corpus, pack } = await run(new MemoryParseCache(), {
      compose: true,
    });
    expect(pack.composeCalls).toBe(1);
    expect(pack.lastComposeOrder).toEqual([
      "client:App/Sync.toy",
      "server:api/notes.toy",
      "server:api/store.toy",
    ]);
    expect(corpus.nodes.map((n) => n.id)).toContain("svc:toy-server");
    expect(
      corpus.nodes.find((n) => n.id === "server:api/notes.toy")?.parent,
    ).toBe("svc:toy-server");
  });

  it("is never cached: a warm parse still runs compose", async () => {
    const cache = new MemoryParseCache();
    await run(cache, { compose: true });
    const { corpus, pack } = await run(cache, { compose: true });
    expect(corpus.stats).toMatchObject({ parsed: 0, cache_hits: 3 });
    expect(pack.composeCalls).toBe(1);
    expect(corpus.nodes.some((n) => n.id === "svc:toy-client")).toBe(true);
  });

  it("sees pack_data on cold and warm runs alike, because cached parse output keeps it", async () => {
    const cache = new MemoryParseCache();
    const cold = await run(cache, { compose: true });
    const warm = await run(cache, { compose: true });
    const tagOf = (c: Corpus): string[] | undefined =>
      c.nodes.find((n) => n.id === "server:api/notes.toy#create")?.tags;
    expect(tagOf(cold.corpus)).toEqual(["method:POST"]);
    expect(warm.corpus.stats).toMatchObject({ parsed: 0, cache_hits: 3 });
    expect(tagOf(warm.corpus)).toEqual(["method:POST"]);
  });

  it("passes file-level pack_data to compose, and the cache keeps it for warm runs", async () => {
    const cache = new MemoryParseCache();
    const cold = await run(cache, { compose: true });
    const warm = await run(cache, { compose: true });
    const tagsOf = (c: Corpus): string[] | undefined =>
      c.nodes.find((n) => n.id === "server:api/notes.toy")?.tags;
    expect(tagsOf(cold.corpus)).toEqual(["defs:2"]);
    expect(warm.corpus.stats).toMatchObject({ parsed: 0, cache_hits: 3 });
    expect(tagsOf(warm.corpus)).toEqual(["defs:2"]);
    const entry = [
      ...(
        cache as unknown as { entries: Map<string, { pack_data: unknown }> }
      ).entries.values(),
    ][0];
    expect(entry?.pack_data).toMatchObject({
      defs: expect.any(Array) as unknown,
    });
  });

  it("flags file-level pack_data returned unchanged across a move as info, and still uses the result", async () => {
    const cache = new MemoryParseCache();
    await run(cache, { rePath: "stale-file-data" });
    tree.remove("server/api/store.toy");
    tree.write("server/api/data/store.toy", STORE);
    const moved = await run(cache, { rePath: "stale-file-data" });
    expect(moved.corpus.stats).toMatchObject({
      parsed: 0,
      repathed: 1,
      repath_fallbacks: 0,
    });
    const d = moved.corpus.diagnostics.find(
      (x) => x.code === "repath_pack_data_unchanged",
    );
    expect(d?.severity).toBe("info");
    expect(d?.message).toContain("server:api/store.toy");
    expect(d?.message).toContain("server:api/data/store.toy");
  });

  it("strips pack_data after compose: no key of that name survives anywhere in the corpus", async () => {
    const { corpus } = await run(new MemoryParseCache(), { compose: true });
    // On the serialized string, not the object, so a nested occurrence cannot pass.
    expect(JSON.stringify(corpus)).not.toContain("pack_data");
    const noCompose = await run(new MemoryParseCache());
    expect(JSON.stringify(noCompose.corpus)).not.toContain("pack_data");
  });

  it("rejects a patch that replaces a node or sets a missing parent, keeping the rest", async () => {
    tree.write("server/api/notes.toy", API + "? !!patch-replace\n");
    tree.write("server/api/store.toy", STORE + "? !!patch-badparent\n");
    const { corpus } = await run(new MemoryParseCache(), { compose: true });
    const rejected = corpus.diagnostics.filter(
      (d) => d.code === "rejected_pack_patch",
    );
    expect(rejected.map((d) => d.message)).toEqual([
      expect.stringContaining(
        'adds node "server:api/notes.toy", which already exists',
      ),
      expect.stringContaining('sets parent to "svc:does-not-exist"'),
    ]);
    expect(
      rejected.every((d) => d.pack === "toy" && d.severity === "error"),
    ).toBe(true);
    // The good updates in the same patch still landed.
    expect(
      corpus.nodes.find((n) => n.id === "server:api/store.toy")?.parent,
    ).toBe("svc:toy-server");
    expect(
      corpus.nodes.filter((n) => n.id === "server:api/notes.toy"),
    ).toHaveLength(1);
    // The refused replacement left the original node intact: its label and
    // span are the per-file parse's, and no id appears twice.
    const survivor = corpus.nodes.find((n) => n.id === "server:api/notes.toy");
    expect(survivor?.label).toBe("notes.toy");
    expect(survivor?.sources.map((s) => s.path)).toEqual(["api/notes.toy"]);
    expect(new Set(corpus.nodes.map((n) => n.id)).size).toBe(
      corpus.nodes.length,
    );
  });
});

describe("mergeNodes", () => {
  it("unions spans for one id emitted by two files and reports differing fields once", () => {
    const base = {
      kind: "class" as const,
      label: "Note",
      tier: "ui_logic" as const,
      parent: null,
      confidence: "certain" as const,
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    };
    const span = (path: string, line_start: number) => ({
      repo: "ios",
      path,
      line_start,
      line_end: null,
      hash: "sha256:0000000000000000",
    });
    const file = (path: string, label: string) => ({
      repo: "ios",
      path,
      result: {
        nodes: [
          { ...base, id: "ios:A.swift#Note", label, sources: [span(path, 1)] },
        ],
        edges: [],
        schemas: [],
        provides: [],
        diagnostics: [],
      },
      pack_data: null,
    });
    const same = mergeNodes(
      [file("A.swift", "Note"), file("B.swift", "Note")],
      [],
    );
    expect(same.nodes).toHaveLength(1);
    expect(same.nodes[0]?.sources.map((s) => s.path)).toEqual([
      "A.swift",
      "B.swift",
    ]);
    expect(same.diagnostics).toEqual([]);
    const differ = mergeNodes(
      [file("A.swift", "Note"), file("B.swift", "Note+JSON")],
      [],
    );
    expect(differ.nodes[0]?.label).toBe("Note");
    expect(differ.diagnostics.map((d) => d.code)).toEqual([
      "node_definition_conflict",
    ]);
    expect(differ.diagnostics[0]?.message).toContain("ios:A.swift");
    expect(differ.diagnostics[0]?.message).toContain("ios:B.swift");
  });
});

describe("PackRegistry", () => {
  it("refuses two packs on one extension and an incompatible graph model version", () => {
    expect(
      () => new PackRegistry([makeToyPack(), makeToyPack({ id: "toy2" })]),
    ).toThrow(/claimed by both/);
    const stale = makeToyPack();
    (stale.manifest as { graph_schema_version: number }).graph_schema_version =
      99;
    expect(() => new PackRegistry([stale])).toThrow(/Refusing to run/);
  });

  it("maps extensions to packs and ignores unclaimed files", () => {
    const pack = makeToyPack();
    const registry = new PackRegistry([pack]);
    expect(registry.packFor("a/b.toy")).toBe(pack);
    expect(registry.packFor("a/b.py")).toBeNull();
    expect(registry.packFor("a.toy/README")).toBeNull();
  });
});

describe("mergeSchemas", () => {
  const schema = (id: string, type = "str") => ({
    id,
    name: id,
    source: null,
    confidence: "certain" as const,
    confidence_reason: null,
    fields: [
      {
        name: "x",
        type,
        optional: false,
        classification: [],
        ref_schema_id: null,
      },
    ],
  });
  const file = (path: string, ...schemas: ReturnType<typeof schema>[]) => ({
    repo: "r",
    path,
    result: { nodes: [], edges: [], schemas, provides: [], diagnostics: [] },
    pack_data: null,
  });

  it("keeps one copy of identical schemas, reports a conflicting redefinition once, and sorts by id", () => {
    const same = mergeSchemas(
      [file("a.py", schema("s2"), schema("s1")), file("b.py", schema("s1"))],
      [],
    );
    expect(same.schemas.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(same.diagnostics).toEqual([]);
    const differ = mergeSchemas(
      [file("a.py", schema("s1", "str")), file("b.py", schema("s1", "int"))],
      [],
    );
    expect(differ.schemas).toHaveLength(1);
    expect(differ.schemas[0]?.fields[0]?.type).toBe("str");
    expect(differ.diagnostics.map((d) => d.code)).toEqual([
      "schema_definition_conflict",
    ]);
    expect(differ.diagnostics[0]?.message).toContain("r:a.py");
    expect(differ.diagnostics[0]?.message).toContain("r:b.py");
  });
});
