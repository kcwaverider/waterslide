import type { Node, PayloadSchema } from "../model/graph.js";
import {
  stripEdgePackData,
  type CorePartialEdge,
  type Diagnostic,
  type LanguagePack,
  type Provide,
} from "../model/pack.js";
import { NullParseCache, type ParseCache } from "./cache.js";
import {
  EMPTY_CONFIG,
  tierConfigHash,
  type WaterslideConfig,
} from "./config.js";
import { assignTiers, fillParents } from "./derive.js";
import {
  captureRepoState,
  discover,
  type RepoInput,
  type RepoState,
} from "./discover.js";
import {
  PackRegistry,
  composePacks,
  mergeNodes,
  mergeSchemas,
  parseFiles,
  type Stage3Stats,
} from "./stage3.js";

/** An edge with the file it was emitted from, which stage 4 needs for file-scoped matching (parser §3.4). Null origin for compose additions without a call site. */
export interface EdgeOrigin {
  readonly edge: CorePartialEdge;
  readonly repo: string | null;
  readonly path: string | null;
}

/** A provide with the file that declared it. Null origin for compose additions. */
export interface ProvideOrigin {
  readonly provide: Provide;
  readonly repo: string | null;
  readonly path: string | null;
}

/**
 * Everything stages 4–6 consume, fully in memory. No cache reference reaches
 * this shape: resolution and derivation cannot read or write one. No
 * `pack_data` reaches it either: compose has run, and the key is deleted from
 * every node and edge on the way in (parser §3.3).
 */
export interface Corpus {
  readonly repos: readonly RepoState[];
  readonly tier_config_hash: string;
  /** Tiers and parents derived, duplicates merged, sorted by id. */
  readonly nodes: readonly Node[];
  readonly edges: readonly EdgeOrigin[];
  readonly schemas: readonly PayloadSchema[];
  readonly provides: readonly ProvideOrigin[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: Stage3Stats;
}

export interface ParseSourcesInput {
  readonly repos: readonly RepoInput[];
  readonly packs: readonly LanguagePack[];
  readonly config?: WaterslideConfig;
  /** Defaults to a cache that never hits. */
  readonly cache?: ParseCache;
}

/** Stages 1–3, compose, and the node half of stage 5. */
export async function parseSources(input: ParseSourcesInput): Promise<Corpus> {
  const config = input.config ?? EMPTY_CONFIG;
  const registry = new PackRegistry(input.packs);
  const cache = input.cache ?? new NullParseCache();

  const files = await discover(input.repos, {
    extensions: registry.extensions,
    ...(config.include_tests === undefined
      ? {}
      : { includeTests: config.include_tests }),
  });
  const repos: RepoState[] = [];
  for (const repo of input.repos) repos.push(await captureRepoState(repo));
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const stage3 = await parseFiles(files, registry, { cache, config });
  const composed = composePacks(stage3, registry, config);
  const merged = mergeNodes(composed.files, composed.additions);
  const schemasMerged = mergeSchemas(composed.files, composed.additions);

  const nodes = fillParents(assignTiers(merged.nodes, config));
  const edges: EdgeOrigin[] = [];
  const provides: ProvideOrigin[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const f of composed.files) {
    for (const edge of f.result.edges)
      edges.push({ edge: stripEdgePackData(edge), repo: f.repo, path: f.path });
    for (const provide of f.result.provides)
      provides.push({ provide, repo: f.repo, path: f.path });
    diagnostics.push(...f.result.diagnostics);
  }
  for (const a of composed.additions) {
    for (const edge of a.edges) {
      edges.push({
        edge: stripEdgePackData(edge),
        repo: edge.source?.repo ?? null,
        path: edge.source?.path ?? null,
      });
    }
    for (const provide of a.provides)
      provides.push({ provide, repo: null, path: null });
  }
  diagnostics.push(
    ...stage3.diagnostics,
    ...composed.diagnostics,
    ...merged.diagnostics,
    ...schemasMerged.diagnostics,
  );

  return {
    repos,
    tier_config_hash: tierConfigHash(config),
    nodes,
    edges,
    schemas: schemasMerged.schemas,
    provides,
    diagnostics,
    stats: stage3.stats,
  };
}

export * from "./cache.js";
export * from "./config.js";
export * from "./derive.js";
export * from "./discover.js";
export * from "./hash.js";
export * from "./repath.js";
export * from "./stage3.js";
export * from "./resolve.js";
export * from "./derive-edges.js";
export * from "./vendors.js";
