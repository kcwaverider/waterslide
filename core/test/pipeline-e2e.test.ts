import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeCanonical } from "../src/canonical.js";
import type { CanonicalGraph } from "../src/model/graph.js";
import { MemoryParseCache } from "../src/pipeline/cache.js";
import { collapseEdges, finalizeEdges } from "../src/pipeline/derive-edges.js";
import { discover } from "../src/pipeline/discover.js";
import { parseSources, type Corpus } from "../src/pipeline/index.js";
import { resolve } from "../src/pipeline/resolve.js";
import {
  PackRegistry,
  composePacks,
  mergeNodes,
  parseFiles,
} from "../src/pipeline/stage3.js";
import { validate } from "../src/validate.js";
import { TmpTree } from "./helpers/tmp-tree.js";
import { makeToyPack } from "./helpers/toy-pack.js";

/**
 * Stages 1–5 end to end over the toy pack, ending in a canonical graph that
 * the validator accepts. The renderer and `graph.json` come next; this is the
 * proof that what they will consume is valid and deterministic.
 */

const API = [
  "def create",
  "  call api.store.save",
  "  route POST /notes",
  "def list",
  "  call api.store.find_all",
  "  call api.store.purge",
  "",
].join("\n");
const STORE = "def save\ndef find_all\n";
const CLIENT = [
  "import save from api.store",
  "def sync",
  "  call save",
  "  call api.notes.create",
  "  call api.notes.create",
  "",
].join("\n");

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

function assemble(corpus: Corpus): CanonicalGraph {
  const r = resolve(corpus);
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  return {
    schema_version: 1,
    tier_config_hash: corpus.tier_config_hash,
    repos: corpus.repos.map((x) => ({ name: x.name, commit: x.commit })),
    nodes: r.nodes,
    edges: finalizeEdges(collapseEdges(r.edges), byId),
    schemas: corpus.schemas.slice(),
  };
}

async function build(
  cache = new MemoryParseCache(),
): Promise<{ graph: CanonicalGraph; bytes: string; corpus: Corpus }> {
  const corpus = await parseSources({
    repos: repos(),
    packs: [makeToyPack({ compose: true })],
    cache,
  });
  const graph = assemble(corpus);
  return { graph, bytes: serializeCanonical(graph), corpus };
}

describe("stages 1–5 end to end", () => {
  it("produces a canonical graph that passes every invariant", async () => {
    const { bytes } = await build();
    const result = validate(JSON.parse(bytes), { shape: "canonical" });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("resolves qualified, aliased and cross-repo references, collapses call sites, and dangles the rest", async () => {
    const { graph } = await build();
    const byPair = new Map(graph.edges.map((e) => [`${e.from} -> ${e.to}`, e]));
    // Qualified global name within a repo.
    expect(
      byPair.get("server:api/notes.toy#create -> server:api/store.toy#save")
        ?.confidence,
    ).toBe("certain");
    // Bare name through a file-scoped alias.
    expect(
      byPair.has("client:App/Sync.toy#sync -> server:api/store.toy#save"),
    ).toBe(true);
    // Qualified global name across repos, two call sites collapsed.
    const cross = byPair.get(
      "client:App/Sync.toy#sync -> server:api/notes.toy#create",
    );
    expect(cross?.source_count).toBe(2);
    expect(cross?.source?.line_start).toBe(4);
    // Dangling reference drawn to an unknown node in the caller's band.
    const dangling = byPair.get(
      "server:api/notes.toy#list -> unknown:symbol:api.store.purge",
    );
    expect(dangling?.confidence).toBe("inferred");
    expect(
      graph.nodes.find((n) => n.id === "unknown:symbol:api.store.purge")?.tier,
    ).toBe("domain");
    // Compose's service nodes and reparenting survived.
    expect(
      graph.nodes.find((n) => n.id === "server:api/notes.toy")?.parent,
    ).toBe("svc:toy-server");
  });

  it("is byte-identical across a warm run and across shuffled discovery order", async () => {
    const cache = new MemoryParseCache();
    const cold = await build(cache);
    const warm = await build(cache);
    expect(warm.corpus.stats.parsed).toBe(0);
    expect(warm.bytes).toBe(cold.bytes);

    const pack = makeToyPack({ compose: true });
    const registry = new PackRegistry([pack]);
    const files = await discover(repos(), { extensions: registry.extensions });
    const reversed = await parseFiles([...files].reverse(), registry, {
      cache: new MemoryParseCache(),
      config: {},
    });
    const composed = composePacks(reversed, registry, {});
    const merged = mergeNodes(composed.files, composed.additions);
    const corpus: Corpus = {
      ...cold.corpus,
      nodes: merged.nodes,
      edges: composed.files.flatMap((f) =>
        f.result.edges.map((edge) => ({ edge, repo: f.repo, path: f.path })),
      ),
      provides: composed.files.flatMap((f) =>
        f.result.provides.map((provide) => ({
          provide,
          repo: f.repo,
          path: f.path,
        })),
      ),
    };
    // Tiers and parents are derived in parseSources; the reversed corpus above
    // skips derivation, so compare resolution output rather than final bytes.
    const a = JSON.stringify(resolve(corpus).edges);
    const b = JSON.stringify(
      resolve({
        ...corpus,
        edges: [...corpus.edges].reverse(),
        provides: [...corpus.provides].reverse(),
      }).edges,
    );
    expect(a).toBe(b);
  });

  it("renaming a symbol in one file breaks the edge from an unchanged file on the next parse", async () => {
    const cache = new MemoryParseCache();
    const before = await build(cache);
    expect(
      before.graph.edges.some(
        (e) =>
          e.to === "server:api/store.toy#save" && e.from.startsWith("client:"),
      ),
    ).toBe(true);

    tree.write("server/api/store.toy", "def persist\ndef find_all\n");
    const after = await build(cache);
    // The client file was cache-fresh...
    expect(after.corpus.stats).toMatchObject({ parsed: 1, cache_hits: 2 });
    // ...and its edge still re-resolved, now dangling, because resolution never caches.
    const clientEdge = after.graph.edges.find(
      (e) => e.from === "client:App/Sync.toy#sync" && e.label === "save",
    );
    expect(clientEdge?.to).toBe("unknown:symbol:save");
    expect(clientEdge?.confidence_reason).toContain(
      "via alias to 'api.store.save'",
    );
    expect(
      after.graph.nodes.some((n) => n.id === "server:api/store.toy#save"),
    ).toBe(false);
    expect(validate(JSON.parse(after.bytes), { shape: "canonical" }).ok).toBe(
      true,
    );
  });

  it("summarises unresolved references by ref_kind on every run", async () => {
    const { corpus } = await build();
    const r = resolve(corpus);
    expect(r.stats.unresolved_by_kind).toEqual({
      symbol: 1,
      http: 0,
      topic: 0,
      datastore: 0,
      external: 0,
    });
    expect(
      r.diagnostics.filter((d) => d.code === "unresolved_ref"),
    ).toHaveLength(1);
  });
});
