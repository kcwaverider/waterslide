import type { Edge, EntryPointKind, Node } from "@waterslide/core";

/**
 * Flow mode and playback planning — UI spec §5, §6, §7.5; graph model §3.2.
 *
 * Pure: no DOM, no D3, no timing. This module decides *what* happens —
 * which nodes are in an entry point's blast radius, which branch of a fork is
 * travelled by default, and which edges fire together at each hop — and the
 * animation module decides *when*. The graph is never discovered here: every
 * node and edge is already drawn, and a plan only names edges that exist.
 *
 * Inlined into the viewer page ahead of the renderer. No runtime imports.
 */

export interface GraphView {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

/** §6: sidebar groups, in the order the spec lists them. */
export const ENTRY_POINT_KIND_ORDER: readonly EntryPointKind[] = [
  "ui_handler",
  "http_route",
  "webhook",
  "queue_subscriber",
  "cron",
  "app_launch",
];

export const ENTRY_POINT_KIND_LABEL: Readonly<Record<EntryPointKind, string>> =
  {
    ui_handler: "UI handlers",
    http_route: "HTTP routes",
    webhook: "Webhooks",
    queue_subscriber: "Queue subscribers",
    cron: "Cron",
    app_launch: "App launch",
  };

export interface EntryPointGroup {
  readonly kind: EntryPointKind | null;
  readonly label: string;
  readonly nodes: readonly Node[];
}

/** Byte-order comparison, the tie-break everywhere ordering must be deterministic. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Entry points grouped by `entry_point_kind`, nodes by label then id. An entry point with a null kind lands in "Other". */
export function entryPointGroups(nodes: readonly Node[]): EntryPointGroup[] {
  const entries = nodes
    .filter((n) => n.is_entry_point)
    .sort((a, b) => byteCompare(a.label, b.label) || byteCompare(a.id, b.id));
  const groups: EntryPointGroup[] = [];
  for (const kind of ENTRY_POINT_KIND_ORDER) {
    const list = entries.filter((n) => n.entry_point_kind === kind);
    if (list.length > 0)
      groups.push({ kind, label: ENTRY_POINT_KIND_LABEL[kind], nodes: list });
  }
  const other = entries.filter((n) => n.entry_point_kind === null);
  if (other.length > 0)
    groups.push({ kind: null, label: "Other", nodes: other });
  return groups;
}

export interface BlastRadius {
  /** Nodes reachable from the entry point, the entry point included. */
  readonly nodes: ReadonlySet<string>;
  /** Edges leaving a reachable node: everything a run from the entry point could travel. */
  readonly edges: ReadonlySet<string>;
}

/** §5.2: reachability over directed edges. Every branch is included — a blast radius is what *could* happen. */
export function blastRadius(graph: GraphView, entryId: string): BlastRadius {
  const out = outgoing(graph.edges);
  const nodes = new Set<string>([entryId]);
  const edges = new Set<string>();
  const queue = [entryId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const e of out.get(id) ?? []) {
      edges.add(e.id);
      if (!nodes.has(e.to)) {
        nodes.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return { nodes, edges };
}

/** Outgoing edges per node, in edge-id order, so every traversal here is deterministic. */
function outgoing(edges: readonly Edge[]): Map<string, Edge[]> {
  const out = new Map<string, Edge[]>();
  for (const e of [...edges].sort((a, b) => byteCompare(a.id, b.id))) {
    const list = out.get(e.from);
    if (list === undefined) out.set(e.from, [e]);
    else list.push(e);
  }
  return out;
}

/**
 * Graph model §3.2: the default alternative in an `exclusive_group`, under
 * the four-step total ordering. An alternative is every edge sharing a
 * `branch_ordinal`; its key is computed over those edges.
 *
 *   1. not all error-path before all error-path
 *   2. ascending minimum `source.line_start`
 *   3. ascending minimum `source.path`
 *   4. ascending `branch_ordinal`
 *
 * Total, so the same graph always picks the same branch (§7.5).
 */
export function defaultAlternative(groupEdges: readonly Edge[]): number | null {
  const byOrdinal = new Map<number, Edge[]>();
  for (const e of groupEdges) {
    if (e.branch_ordinal === null) continue;
    const list = byOrdinal.get(e.branch_ordinal);
    if (list === undefined) byOrdinal.set(e.branch_ordinal, [e]);
    else list.push(e);
  }
  const keys = [...byOrdinal.entries()].map(([ordinal, edges]) => ({
    ordinal,
    allError: edges.every((e) => e.is_error_path) ? 1 : 0,
    line: Math.min(
      ...edges.map((e) => e.source?.line_start ?? Number.POSITIVE_INFINITY),
    ),
    path: edges.map((e) => e.source?.path ?? "").sort(byteCompare)[0] as string,
  }));
  keys.sort(
    (a, b) =>
      a.allError - b.allError ||
      a.line - b.line ||
      byteCompare(a.path, b.path) ||
      a.ordinal - b.ordinal,
  );
  return keys[0]?.ordinal ?? null;
}

/** The chosen alternative for every `exclusive_group` in the graph: the default, unless the reader has flipped it (§7.5). */
export function chosenAlternatives(
  graph: GraphView,
  overrides: ReadonlyMap<string, number>,
): Map<string, number> {
  const groups = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    if (e.exclusive_group === null) continue;
    const list = groups.get(e.exclusive_group);
    if (list === undefined) groups.set(e.exclusive_group, [e]);
    else list.push(e);
  }
  const chosen = new Map<string, number>();
  for (const [group, edges] of groups) {
    const override = overrides.get(group);
    const valid =
      override !== undefined &&
      edges.some((e) => e.branch_ordinal === override);
    const pick = valid ? override : defaultAlternative(edges);
    if (pick !== null) chosen.set(group, pick);
  }
  return chosen;
}

/** True when the edge is on the travelled side of its fork, or is not a fork edge at all. */
export function isActiveBranch(
  edge: Edge,
  chosen: ReadonlyMap<string, number>,
): boolean {
  if (edge.exclusive_group === null) return true;
  return chosen.get(edge.exclusive_group) === edge.branch_ordinal;
}

export interface Hop {
  readonly edge: Edge;
  /**
   * §7.2 timing, as a multiple of the base hop. `external_call` is slow and
   * metered, so it takes longer; a hop into an `is_infrastructure` node is
   * the middleware the animation glides past (§7.4), so it is quick.
   */
  readonly duration: number;
}

/** One generation of the playback: hops that fire together (§7.2, parallel edges fire simultaneously). */
export type Generation = readonly Hop[];

export const HOP_DURATION = {
  base: 1,
  externalCall: 1.8,
  infrastructure: 0.45,
} as const;

/**
 * §7 + §0: the playback plan from a start node. Objects leave a node along
 * every outgoing edge at once, except at a fork, where only the chosen
 * alternative fires. An edge is travelled at most once per play, so a cycle
 * is shown as one lap and every play ends; whether the animation should
 * then loop is an open question in UI §10 and is left to the player.
 *
 * The plan is a list of generations; the animation runs them in order. Each
 * generation's hops are in edge-id order, so the plan is deterministic.
 */
export function planPlayback(
  graph: GraphView,
  startId: string,
  chosen: ReadonlyMap<string, number>,
): Generation[] {
  const out = outgoing(graph.edges);
  const infra = new Set(
    graph.nodes.filter((n) => n.is_infrastructure).map((n) => n.id),
  );
  const travelled = new Set<string>();
  let frontier: string[] = [startId];
  const plan: Generation[] = [];
  while (frontier.length > 0) {
    const hops: Hop[] = [];
    const next = new Set<string>();
    for (const id of frontier) {
      for (const e of out.get(id) ?? []) {
        if (travelled.has(e.id) || !isActiveBranch(e, chosen)) continue;
        travelled.add(e.id);
        hops.push({
          edge: e,
          duration: infra.has(e.to)
            ? HOP_DURATION.infrastructure
            : e.kind === "external_call"
              ? HOP_DURATION.externalCall
              : HOP_DURATION.base,
        });
        next.add(e.to);
      }
    }
    if (hops.length === 0) break;
    hops.sort((a, b) => byteCompare(a.edge.id, b.edge.id));
    plan.push(hops);
    frontier = [...next].sort(byteCompare);
  }
  return plan;
}
