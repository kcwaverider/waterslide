import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { canonicalize, serializeCanonical } from "../canonical.js";
import type { RefKind } from "../model/enums.js";
import {
  GRAPH_SCHEMA_VERSION,
  type CanonicalGraph,
  type GraphArtifact,
} from "../model/graph.js";
import type { Diagnostic, LanguagePack } from "../model/pack.js";
import { validate, type ValidationError } from "../validate.js";
import type { ParseCache } from "./cache.js";
import type { WaterslideConfig } from "./config.js";
import { collapseEdges, finalizeEdges } from "./derive-edges.js";
import type { RepoInput } from "./discover.js";
import { parseSources, type Corpus } from "./index.js";
import { resolve, type ResolveStats } from "./resolve.js";
import type { Stage3Stats } from "./stage3.js";

/**
 * Stage 6 — emit. Parser §0: writes `graph.json` and nothing else. It never
 * touches `baseline.json` (persisted-files §1.6); capturing a baseline is a
 * separate command that does not exist yet.
 */

export interface RunInput {
  readonly repos: readonly RepoInput[];
  readonly packs: readonly LanguagePack[];
  readonly config?: WaterslideConfig;
  readonly cache?: ParseCache;
  /** Injected for tests; defaults to now. */
  readonly now?: () => Date;
}

export interface RunOutput {
  readonly artifact: GraphArtifact;
  readonly corpus: Corpus;
  readonly diagnostics: readonly Diagnostic[];
  readonly stage3: Stage3Stats;
  readonly resolution: ResolveStats;
}

/** Stages 1–5, assembled into the artifact shape. Pure apart from reading sources and the cache. */
export async function runPipeline(input: RunInput): Promise<RunOutput> {
  const corpus = await parseSources(input);
  const resolved = resolve(corpus);
  const byId = new Map(resolved.nodes.map((n) => [n.id, n]));
  const edges = finalizeEdges(collapseEdges(resolved.edges), byId);
  const diagnostics = [...corpus.diagnostics, ...resolved.diagnostics];
  const canonical: CanonicalGraph = canonicalize({
    schema_version: GRAPH_SCHEMA_VERSION,
    tier_config_hash: corpus.tier_config_hash,
    repos: corpus.repos.map((r) => ({ name: r.name, commit: r.commit })),
    nodes: resolved.nodes,
    edges,
    schemas: corpus.schemas.slice(),
  });
  const now = input.now ?? ((): Date => new Date());
  const artifact: GraphArtifact = {
    schema_version: GRAPH_SCHEMA_VERSION,
    parsed_at: now().toISOString(),
    tier_config_hash: canonical.tier_config_hash,
    repos: [...corpus.repos]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((r) => ({
        name: r.name,
        path: r.path,
        commit: r.commit,
        dirty: r.dirty,
      })),
    nodes: canonical.nodes,
    edges: canonical.edges,
    schemas: canonical.schemas,
    stats: buildStats(canonical, corpus.stats, resolved.stats, diagnostics),
  };
  return {
    artifact,
    corpus,
    diagnostics,
    stage3: corpus.stats,
    resolution: resolved.stats,
  };
}

/** Graph model §7: counts, including a breakdown by confidence. Artifact-only, so its shape is free to grow. */
export function buildStats(
  graph: CanonicalGraph,
  stage3: Stage3Stats,
  resolution: ResolveStats,
  diagnostics: readonly Diagnostic[],
): Record<string, unknown> {
  const count = <T extends string>(
    xs: readonly T[],
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of [...xs].sort()) out[x] = (out[x] ?? 0) + 1;
    return out;
  };
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    schemas: graph.schemas.length,
    nodes_by_kind: count(graph.nodes.map((n) => n.kind)),
    nodes_by_confidence: count(graph.nodes.map((n) => n.confidence)),
    edges_by_kind: count(graph.edges.map((e) => e.kind)),
    edges_by_confidence: count(graph.edges.map((e) => e.confidence)),
    entry_points: graph.nodes.filter((n) => n.is_entry_point).length,
    band_skipping_edges: graph.edges.filter((e) => e.skips_tiers.length > 0)
      .length,
    unresolved_by_kind: resolution.unresolved_by_kind,
    resolution: {
      resolved: resolution.resolved,
      ambiguous: resolution.ambiguous,
      dangling: resolution.dangling,
      via_factory: resolution.via_factory,
    },
    parse: stage3,
    diagnostics_by_code: count(diagnostics.map((d) => d.code)),
  };
}

/**
 * The artifact bytes: canonical content plus the volatile fields, in the
 * field-table key order graph model §7 gives. Two-space indent, `\n`,
 * trailing newline, same escaping rules as the canonical serializer.
 */
export function serializeArtifact(artifact: GraphArtifact): string {
  const canonical = canonicalize(artifact);
  const ordered = {
    schema_version: artifact.schema_version,
    parsed_at: artifact.parsed_at,
    tier_config_hash: canonical.tier_config_hash,
    repos: artifact.repos
      .map((r) => ({
        name: r.name,
        path: r.path,
        commit: r.commit,
        dirty: r.dirty,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    nodes: canonical.nodes,
    edges: canonical.edges,
    schemas: canonical.schemas,
    ...(artifact.stats === undefined ? {} : { stats: artifact.stats }),
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

export interface EmitOptions {
  /** Directory holding `graph.json`; created if absent. */
  readonly stateDir: string;
  /** Write the canonical shape instead of the artifact (graph model §7.2's `--canonical`). */
  readonly canonical?: boolean;
}

export type EmitResult =
  | { readonly ok: true; readonly path: string; readonly bytes: string }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

/**
 * Validates, then writes `{stateDir}/graph.json` atomically. Nothing else is
 * written. A graph that fails the validator is not written at all: a thin or
 * malformed map on disk would look like a working one.
 */
export async function emitGraph(
  artifact: GraphArtifact,
  options: EmitOptions,
): Promise<EmitResult> {
  const bytes =
    options.canonical === true
      ? serializeCanonical(artifact)
      : serializeArtifact(artifact);
  const result = validate(JSON.parse(bytes), {
    shape: options.canonical === true ? "canonical" : "artifact",
  });
  if (!result.ok) return { ok: false, errors: result.errors };
  await fs.mkdir(options.stateDir, { recursive: true });
  const target = nodePath.join(options.stateDir, "graph.json");
  const tmp = `${target}.${String(process.pid)}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, "utf8");
    await fs.rename(tmp, target);
  } catch (error) {
    // graph.json and nothing else: never leave a half-written temp file behind.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ok: true, path: target, bytes };
}

/** Handoff §6 item 6: the per-run summary of what did not resolve, grouped by ref_kind, then diagnostics by code. */
export function summarize(run: RunOutput): string {
  const lines: string[] = [];
  const g = run.artifact;
  lines.push(
    `graph: ${String(g.nodes.length)} nodes, ${String(g.edges.length)} edges, ${String(g.schemas.length)} schemas, ${String(g.repos.length)} repo(s)`,
  );
  lines.push(
    `parse: ${String(run.stage3.files)} files, ${String(run.stage3.parsed)} parsed, ${String(run.stage3.cache_hits)} from cache (${String(run.stage3.repathed)} re-pathed, ${String(run.stage3.repath_fallbacks)} re-parsed after a rejected rePath)`,
  );
  const r = run.resolution;
  lines.push(
    `resolution: ${String(r.resolved)} resolved (${String(r.via_factory)} via factory), ${String(r.ambiguous)} ambiguous, ${String(r.dangling)} dangling`,
  );
  lines.push("unresolved references by ref_kind:");
  for (const kind of Object.keys(r.unresolved_by_kind).sort() as RefKind[]) {
    lines.push(`  ${kind.padEnd(10)} ${String(r.unresolved_by_kind[kind])}`);
  }
  const byCode = new Map<string, number>();
  for (const d of run.diagnostics)
    byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  if (byCode.size > 0) {
    lines.push("diagnostics by code:");
    for (const [code, n] of [...byCode].sort(([a], [b]) => (a < b ? -1 : 1)))
      lines.push(`  ${code.padEnd(32)} ${String(n)}`);
  } else {
    lines.push("diagnostics: none");
  }
  return lines.join("\n");
}
