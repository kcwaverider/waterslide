import { byteCompare, callSiteCompare } from "../canonical.js";
import { edgeId } from "../edge-id.js";
import {
  ORDERED_TIERS,
  SKIPS_TIERS_EXCLUDED_KINDS,
  type Tier,
} from "../model/enums.js";
import type { Edge, Node, SourceLocation } from "../model/graph.js";
import type { CorePartialEdge } from "../model/pack.js";

/**
 * Stage 5, the edge half: collapse call sites into one edge per relationship
 * (graph model §3.3), derive ids (§3.3.1) and `skips_tiers` (§3.4).
 */

/** A `CorePartialEdge` whose `to` is a node id: what resolution hands over. */
export type ResolvedPartialEdge = Omit<CorePartialEdge, "to"> & {
  readonly to: string;
};

function collapseKey(e: ResolvedPartialEdge): string {
  return JSON.stringify([
    e.from,
    e.to,
    e.kind,
    e.exclusive_group,
    e.branch_ordinal,
  ]);
}

function siteKey(s: SourceLocation): string {
  return JSON.stringify([s.repo, s.path, s.line_start, s.line_end]);
}

/**
 * Graph model §3.3: two call sites from A to B of the same kind are one edge.
 * Fork edges collapse only with edges of the same group and ordinal — the
 * same key `edgeId` uses, so ids stay unique by construction.
 *
 * `source` is the first occurrence under `callSiteCompare`; `source_count` is
 * the number of distinct call sites; `condition` survives only if every
 * occurrence agrees; `confidence` is `inferred` if any occurrence is;
 * `is_error_path` is true only if every occurrence is. Fields the spec does
 * not mention (label, schema ids) come from the first occurrence in call-site
 * order, so the result cannot depend on emission order.
 */
export type CollapsedEdge = ResolvedPartialEdge & {
  readonly source_count: number;
};

export function collapseEdges(
  edges: readonly ResolvedPartialEdge[],
): CollapsedEdge[] {
  const groups = new Map<string, ResolvedPartialEdge[]>();
  for (const e of edges) {
    const k = collapseKey(e);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [e]);
    else g.push(e);
  }
  const out: CollapsedEdge[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(occurrenceCompare);
    const first = ordered[0];
    if (first === undefined) continue;
    const sites = new Set<string>();
    for (const e of ordered)
      if (e.source !== null) sites.add(siteKey(e.source));
    const anyInferred = ordered.some((e) => e.confidence === "inferred");
    const inferredReason =
      ordered.find((e) => e.confidence === "inferred")?.confidence_reason ??
      null;
    const firstCondition = JSON.stringify(first.condition);
    const sameCondition = ordered.every(
      (e) => JSON.stringify(e.condition) === firstCondition,
    );
    // Position-independent: an author's annotation survives wherever it sorts.
    const annotated = ordered.find((e) => e.confidence === "annotated");
    const confidence =
      annotated !== undefined
        ? "annotated"
        : anyInferred
          ? "inferred"
          : "certain";
    out.push({
      ...first,
      confidence,
      confidence_reason:
        confidence === "annotated"
          ? (annotated?.confidence_reason ?? null)
          : confidence === "inferred"
            ? inferredReason
            : first.confidence_reason,
      condition: sameCondition ? first.condition : null,
      is_error_path: ordered.every((e) => e.is_error_path),
      source: first.source,
      source_count: sites.size,
    });
  }
  return out.sort((a, b) => byteCompare(collapseKey(a), collapseKey(b)));
}

/** Call-site order with null sources last; ties among null sources fall back to a stable JSON order. */
function occurrenceCompare(
  a: ResolvedPartialEdge,
  b: ResolvedPartialEdge,
): number {
  if (a.source !== null && b.source !== null)
    return callSiteCompare(a.source, b.source) || stableCompare(a, b);
  if (a.source === null && b.source === null) return stableCompare(a, b);
  return a.source === null ? 1 : -1;
}

function stableCompare(a: ResolvedPartialEdge, b: ResolvedPartialEdge): number {
  return byteCompare(JSON.stringify(a), JSON.stringify(b));
}

/**
 * Graph model §3.4: the bands strictly between the endpoints' tiers, computed
 * only between the six ordered bands, empty when either endpoint is an
 * excluded kind or sits in `external`. Sorted byte-wise (§7.2).
 */
export function skipsTiers(from: Node, to: Node): Tier[] {
  if (
    SKIPS_TIERS_EXCLUDED_KINDS.has(from.kind) ||
    SKIPS_TIERS_EXCLUDED_KINDS.has(to.kind) ||
    from.tier === "external" ||
    to.tier === "external"
  ) {
    return [];
  }
  const a = ORDERED_TIERS.indexOf(from.tier as (typeof ORDERED_TIERS)[number]);
  const b = ORDERED_TIERS.indexOf(to.tier as (typeof ORDERED_TIERS)[number]);
  if (a === -1 || b === -1) return [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return ORDERED_TIERS.slice(lo + 1, hi).sort(byteCompare) as Tier[];
}

/**
 * Finalizes collapsed edges into graph model §3 edges: derived id, source
 * count, `skips_tiers`, and the baseline-dependent fields at their no-baseline
 * values (`is_broken: false`; persisted-files §1.6 makes the baseline M3).
 */
export function finalizeEdges(
  collapsed: readonly CollapsedEdge[],
  nodesById: ReadonlyMap<string, Node>,
): Edge[] {
  const out: Edge[] = [];
  for (const e of collapsed) {
    const from = nodesById.get(e.from);
    const to = nodesById.get(e.to);
    if (from === undefined || to === undefined) continue; // reported upstream
    out.push({
      id: edgeId({
        from: e.from,
        to: e.to,
        kind: e.kind,
        exclusive_group: e.exclusive_group,
        branch_ordinal: e.branch_ordinal,
      }),
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
      schema_id: e.schema_id,
      response_schema_id: e.response_schema_id,
      confidence: e.confidence,
      confidence_reason: e.confidence_reason,
      condition: e.condition,
      exclusive_group: e.exclusive_group,
      is_error_path: e.is_error_path,
      source: e.source,
      source_count: e.source_count,
      branch_ordinal: e.branch_ordinal,
      is_broken: false,
      broken_reason: null,
      skips_tiers: skipsTiers(from, to),
    });
  }
  return out.sort((a, b) => byteCompare(a.id, b.id));
}
