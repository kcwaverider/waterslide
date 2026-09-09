import type { Confidence, Edge, Node } from "@waterslide/core";

/**
 * Semantic zoom aggregation — UI spec §2.2, graph model §2.3 and §9.
 *
 * `parent` is the sole aggregation mechanism: service → module → function.
 * This module collapses a graph to a chosen depth of that tree, BEFORE
 * layout, so the layout stays a pure function of what it is given. Nodes
 * deeper than the level fold into their ancestor at the level; edges between
 * folded nodes merge into one weighted edge, so forty calls to Mongo become
 * one thick line and the animation shows one object (§2.2).
 *
 * Pure, deterministic, no runtime imports. Inlined ahead of the renderer.
 */

export interface GraphView {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

export interface Level {
  readonly depth: number;
  /** "services", "modules", "functions" — from the predominant kind at that depth. */
  readonly name: string;
}

/**
 * Regional focus: the level-`level` nodes the reader is looking at. Nodes
 * whose level representative is near stay unfolded; everything else folds up
 * to the branch point where it leaves the focus, so an edge from a near
 * function to a far file lands on the far file's directory box, and fifty
 * calls into one directory draw as one weighted edge.
 */
export interface Focus {
  readonly near: ReadonlySet<string>;
  /**
   * The most far siblings one ancestor may show as separate boxes. Folding to
   * the branch point makes every far sibling of the focus its own box, and a
   * directory of sixty files would put sixty boxes in the row; past this
   * many, the far siblings fold into the ancestor's residual box instead.
   * Default 12.
   */
  readonly maxBranchBoxes?: number;
}

export interface AggregatedGraph extends GraphView {
  readonly level: number;
  /** Merged-edge id → how many original edges it stands for. Absent means 1. */
  readonly weights: ReadonlyMap<string, number>;
  /** Original node id → the id drawn for it at this level (itself when not folded). */
  readonly representative: ReadonlyMap<string, string>;
  /** Drawn node id → the original ids folded into it, itself included. */
  readonly members: ReadonlyMap<string, readonly string[]>;
  /** Drawn node id → how many boxes at the level folded into it beyond itself. Non-zero only for boxes folded below the level by a focus. */
  readonly folded: ReadonlyMap<string, number>;
}

function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FilteredGraph extends GraphView {
  /** Unknown nodes left out of the view. They are still in the graph. */
  readonly hiddenNodes: number;
  /** Edges left out because an end of theirs is a hidden node. */
  readonly hiddenEdges: number;
}

/**
 * A view-level filter, not a graph change: the `unknown` nodes stay in
 * graph.json and in the model — a client still calling a deleted endpoint IS
 * an unknown node — but the reader may switch them off to see the resolved
 * graph. Runs before aggregation and layout, so a hidden node never enters the
 * DOM and never widens a band. Only the unknown node and the edges touching
 * it go; a node left with no edges because of that still renders. No cascade.
 */
export function hideUnresolved(graph: GraphView, hide: boolean): FilteredGraph {
  if (!hide) return { ...graph, hiddenNodes: 0, hiddenEdges: 0 };
  const hidden = new Set(
    graph.nodes.filter((n) => n.kind === "unknown").map((n) => n.id),
  );
  const nodes = graph.nodes.filter((n) => !hidden.has(n.id));
  const edges = graph.edges.filter(
    (e) => !hidden.has(e.to) && !hidden.has(e.from),
  );
  return {
    nodes,
    edges,
    hiddenNodes: hidden.size,
    hiddenEdges: graph.edges.length - edges.length,
  };
}

/** Depth of every node in the parent tree: a root is 0. A missing or cyclic parent chain stops where it breaks. */
export function depthOf(
  nodes: readonly Pick<Node, "id" | "parent">[],
): ReadonlyMap<string, number> {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent] as const));
  const depth = new Map<string, number>();
  for (const n of nodes) {
    let d = 0;
    const seen = new Set<string>([n.id]);
    let up = n.parent;
    while (up !== null && parentOf.has(up) && !seen.has(up)) {
      seen.add(up);
      d += 1;
      up = parentOf.get(up) ?? null;
    }
    depth.set(n.id, d);
  }
  return depth;
}

/**
 * What a node IS in the hierarchy, from its position in the parent chain
 * rather than from its kind alone. `module` is both a directory and a file,
 * and `function` is a top-level function, a method and an inner function;
 * the chain tells them apart where the kind cannot.
 */
export type LevelRole =
  | "services"
  | "directories"
  | "modules"
  | "classes"
  | "views"
  | "functions"
  | "methods"
  | "inner functions";

export function roleOf(
  node: Node,
  kindOf: (id: string) => Node["kind"] | undefined,
  hasModuleChild: boolean,
): LevelRole {
  switch (node.kind) {
    case "service":
      return "services";
    case "module":
      return hasModuleChild ? "directories" : "modules";
    case "class":
      return "classes";
    case "ui_view":
      return "views";
    default: {
      const parent = node.parent === null ? undefined : kindOf(node.parent);
      if (parent === "class" || parent === "ui_view") return "methods";
      if (parent === "module" || parent === "service" || parent === undefined)
        return "functions";
      return "inner functions";
    }
  }
}

/**
 * The levels a graph can be shown at, coarsest first. A level is named by
 * the predominant ROLE of the nodes at that depth — what
 * they are in the hierarchy, not merely their kind — so the transition label
 * (§2.2) reads "now showing modules" and a directory level never masquerades
 * as a file level. Two adjacent levels can still share a role, as nested
 * directories do; the later one is numbered, because a transition label that
 * says the same thing twice describes no transition. Synthetic roots with no
 * children — collections, externals — only name the root level when nothing
 * else sits there.
 */
export function levelsOf(nodes: readonly Node[]): Level[] {
  const depth = depthOf(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const kindOf = (id: string): Node["kind"] | undefined => byId.get(id)?.kind;
  const moduleChild = new Set<string>();
  const hasChildren = new Set<string>();
  for (const n of nodes) {
    if (n.parent === null) continue;
    hasChildren.add(n.parent);
    if (n.kind === "module") moduleChild.add(n.parent);
  }
  const max = Math.max(0, ...depth.values());
  const levels: Level[] = [];
  let previous: string | null = null;
  let run = 1;
  for (let d = 0; d <= max; d++) {
    const at = nodes.filter((n) => depth.get(n.id) === d);
    // At the root, synthetic leaves — collections, externals, topics — sit
    // beside the repo and would outnumber it; only nodes with children name
    // that level. Deeper, every node counts, so a level of methods is called
    // methods even when a few nested classes are the only ones with children.
    const naming = d === 0 ? at.filter((n) => hasChildren.has(n.id)) : at;
    const pool = naming.length > 0 ? naming : at;
    const counts = new Map<LevelRole, number>();
    for (const n of pool) {
      const role = roleOf(n, kindOf, moduleChild.has(n.id));
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || byteCompare(a[0], b[0]),
    )[0];
    const role: string = top === undefined ? "nodes" : top[0];
    run = role === previous ? run + 1 : 1;
    previous = role;
    levels.push({
      depth: d,
      name: run === 1 ? role : `${role} (${String(run)})`,
    });
  }
  return levels;
}

function worse(a: Confidence, b: Confidence): Confidence {
  if (a === "certain") return b;
  if (b === "certain") return a;
  return a === "inferred" || b === "inferred" ? "inferred" : "annotated";
}

/**
 * The graph as drawn at `level`. At the deepest level every node stands for
 * itself and every edge is its own; the result is then the input graph with
 * identity maps. Edges that fold into one node are internal and vanish —
 * they are the aggregate's own business. Merged edges are keyed by
 * (from, to, kind) like real edges (graph model §3.3); forks do not survive
 * aggregation, because a branch point inside a module is not a branch point
 * of the module.
 */
/**
 * Which drawn node stands for each original node. Without a focus, the
 * ancestor at `level` (or the node itself when shallower): one granularity
 * everywhere. With a focus, the near part of the tree is unfolded to `level`
 * and the far part folds to the child of its deepest ancestor that contains
 * something near — the branch point off the focus — or, when that child
 * would be the far node's own level box, to that ancestor itself as a
 * residual box ("the rest of this directory"). A far subtree with no near
 * ancestor below the root folds to its top-level box.
 */
export function representativesFor(
  graph: GraphView,
  level: number,
  focus?: Focus,
): Map<string, string> {
  const depth = depthOf(graph.nodes);
  const parentOf = new Map(graph.nodes.map((n) => [n.id, n.parent] as const));
  const chainOf = (id: string): string[] => {
    // Root first, the node itself last.
    const chain = [id];
    const seen = new Set<string>([id]);
    let up = parentOf.get(id) ?? null;
    while (up !== null && parentOf.has(up) && !seen.has(up)) {
      seen.add(up);
      chain.unshift(up);
      up = parentOf.get(up) ?? null;
    }
    return chain;
  };
  const levelRep = (chain: string[]): string =>
    chain[Math.min(level, chain.length - 1)] as string;
  const representative = new Map<string, string>();
  if (focus === undefined) {
    for (const n of graph.nodes)
      representative.set(n.id, levelRep(chainOf(n.id)));
    return representative;
  }
  // Ancestors (and selves) of near level boxes: where the focus lives.
  const containsNear = new Set<string>();
  for (const n of graph.nodes) {
    const chain = chainOf(n.id);
    if (focus.near.has(levelRep(chain)))
      for (const a of chain) containsNear.add(a);
  }
  // The branch point of every far node: the child of its deepest ancestor
  // that contains something near. Counted per ancestor first, so an ancestor
  // with too many far branches can fold them all into its residual box.
  const branchOf = new Map<string, { j: number; chain: string[] }>();
  const branchesUnder = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    const chain = chainOf(n.id);
    if (focus.near.has(levelRep(chain))) continue;
    let j = -1;
    for (let i = 0; i < chain.length; i++)
      if (containsNear.has(chain[i] as string)) j = i;
    branchOf.set(n.id, { j, chain });
    if (j >= 0 && j + 1 < chain.length) {
      const set = branchesUnder.get(chain[j] as string) ?? new Set<string>();
      set.add(chain[j + 1] as string);
      branchesUnder.set(chain[j] as string, set);
    }
  }
  const maxBranches = focus.maxBranchBoxes ?? 12;
  for (const n of graph.nodes) {
    const chain = chainOf(n.id);
    const rep = levelRep(chain);
    if (focus.near.has(rep)) {
      representative.set(n.id, rep);
      continue;
    }
    const j = branchOf.get(n.id)?.j ?? -1;
    const own = chain.length - 1;
    const crowded =
      j >= 0 &&
      (branchesUnder.get(chain[j] as string)?.size ?? 0) > maxBranches;
    let target: number;
    if (j < 0) target = 0;
    else if (crowded)
      // Too many far siblings to show one by one: the residual box of the
      // shared ancestor, unless this node IS that ancestor or above it.
      target = Math.min(j, own);
    else if (own < level)
      // A box shallower than the level — a directory — is the branch point
      // for its own subtree, so it stands for itself, never below itself.
      target = Math.min(j + 1, own);
    // A level box, or deeper: the branch point off the focus, or the residual
    // box of the ancestor it shares with the focus when the branch point
    // would be its own level box.
    else target = j + 1 < level ? j + 1 : j;
    representative.set(n.id, chain[target] as string);
  }
  // A far box earns its place by touching the focus. One with no edge to a
  // near box, or to an ancestor of the focus, folds on into the residual box
  // of the ancestor it shares with the focus: fifty far files across three
  // directories still draw three boxes when the focus calls into them, and
  // the directories nothing near touches do not.
  const drawnNear = new Set<string>();
  for (const r of representative.values())
    if (focus.near.has(r) || containsNear.has(r)) drawnNear.add(r);
  const touched = new Set<string>();
  for (const e of graph.edges) {
    const a = representative.get(e.from);
    const b = representative.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (drawnNear.has(a)) touched.add(b);
    if (drawnNear.has(b)) touched.add(a);
  }
  for (const n of graph.nodes) {
    const r = representative.get(n.id) as string;
    if (drawnNear.has(r) || touched.has(r)) continue;
    const info = branchOf.get(n.id);
    if (info === undefined || info.j < 0) continue;
    const own = info.chain.length - 1;
    representative.set(n.id, info.chain[Math.min(info.j, own)] as string);
  }
  void depth;
  return representative;
}

export function aggregateGraph(
  graph: GraphView,
  level: number,
  focus?: Focus,
): AggregatedGraph {
  const representative = representativesFor(graph, level, focus);
  const levelOnly = representativesFor(graph, level);
  const members = new Map<string, string[]>();
  for (const [id, rep] of representative) {
    const list = members.get(rep);
    if (list === undefined) members.set(rep, [id]);
    else list.push(id);
  }
  for (const list of members.values()) list.sort(byteCompare);
  // Level boxes folded below the level by the focus, per drawn box: the
  // boxes AT the level (or leaves above it), so "+19" at functions level
  // counts functions, not the files around them as well.
  const depth = depthOf(graph.nodes);
  const hasChild = new Set(
    graph.nodes.map((n) => n.parent).filter((p): p is string => p !== null),
  );
  const folded = new Map<string, number>();
  for (const [id, rep] of representative) {
    const box = levelOnly.get(id) ?? id;
    const atLevel = (depth.get(id) ?? 0) >= level || !hasChild.has(id);
    if (box === id && box !== rep && atLevel)
      folded.set(rep, (folded.get(rep) ?? 0) + 1);
  }
  const nodes = graph.nodes
    .filter((n) => members.has(n.id))
    .map((n) => {
      const inside = (members.get(n.id) ?? []).filter((m) => m !== n.id);
      const foldedHere = folded.get(n.id) ?? 0;
      if (inside.length === 0) return n;
      const inner = graph.nodes.filter((x) => inside.includes(x.id));
      // An aggregate is an entry point if anything inside it is. A box folded
      // below the level says how many level boxes it stands for, so a reader
      // can tell one file from forty.
      const entry = inner.find((x) => x.is_entry_point);
      return {
        ...n,
        label: foldedHere > 0 ? `${n.label} +${String(foldedHere)}` : n.label,
        is_entry_point: n.is_entry_point || entry !== undefined,
        entry_point_kind: n.entry_point_kind ?? entry?.entry_point_kind ?? null,
      };
    });

  const merged = new Map<
    string,
    { edge: Edge; count: number; parts: Edge[] }
  >();
  for (const e of [...graph.edges].sort((a, b) => byteCompare(a.id, b.id))) {
    const from = representative.get(e.from) ?? e.from;
    const to = representative.get(e.to) ?? e.to;
    if (from === to && e.from !== e.to) continue; // internal to one aggregate
    const folded = from !== e.from || to !== e.to;
    const key = folded ? `${from} ${to} ${e.kind}` : e.id;
    const existing = merged.get(key);
    if (existing === undefined)
      merged.set(key, {
        edge: folded ? { ...e, from, to } : e,
        count: 1,
        parts: [e],
      });
    else {
      existing.count += 1;
      existing.parts.push(e);
    }
  }
  const weights = new Map<string, number>();
  const edges: Edge[] = [];
  for (const [key, m] of [...merged.entries()].sort(([a], [b]) =>
    byteCompare(a, b),
  )) {
    if (m.count === 1 && m.edge === m.parts[0]) {
      edges.push(m.edge);
      continue;
    }
    const parts = m.parts;
    const confidence = parts
      .map((p) => p.confidence)
      .reduce<Confidence>(worse, "certain");
    const uncertain = parts.filter((p) => p.confidence !== "certain").length;
    const id = `agg:${key.replace(/ /g, "|")}`;
    const sources = parts
      .map((p) => p.source)
      .filter((s): s is NonNullable<Edge["source"]> => s !== null)
      .sort(
        (a, b) => a.line_start - b.line_start || byteCompare(a.path, b.path),
      );
    const skips = [...new Set(parts.flatMap((p) => p.skips_tiers))].sort(
      byteCompare,
    );
    const broken = parts.filter((p) => p.is_broken);
    const first = m.edge;
    edges.push({
      ...first,
      id,
      label:
        m.count === 1
          ? first.label
          : `${String(m.count)} × ${first.kind.replace("_", " ")}`,
      schema_id: parts.find((p) => p.schema_id !== null)?.schema_id ?? null,
      response_schema_id:
        parts.find((p) => p.response_schema_id !== null)?.response_schema_id ??
        null,
      confidence,
      confidence_reason:
        confidence === "certain"
          ? null
          : `${String(m.count)} edge${m.count === 1 ? "" : "s"} folded into this one at this zoom level; ${String(uncertain)} not certain: ${parts
              .filter((p) => p.confidence_reason !== null)
              .map((p) => p.confidence_reason)
              .join(" | ")}`,
      condition: null,
      exclusive_group: null,
      branch_ordinal: null,
      is_error_path: parts.every((p) => p.is_error_path),
      source: sources[0] ?? null,
      source_count: parts.reduce((s, p) => s + p.source_count, 0),
      is_broken: broken.length > 0,
      broken_reason:
        broken.length === 0
          ? null
          : broken.map((p) => p.broken_reason ?? "").join(" | "),
      skips_tiers: skips,
    });
    weights.set(id, m.count);
  }
  return { level, nodes, edges, weights, representative, members, folded };
}
