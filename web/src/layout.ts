import type { Edge, Node, Tier } from "@waterslide/core";

/**
 * Layered layout — UI spec §1. Pure: no DOM, no D3, so it is unit-testable
 * and deterministic. Bands top to bottom in graph model §6 order; `external`
 * is a column down the right side, not a band (§1.3). Within a band, nodes
 * are ordered alphabetically by label along the parent chain — families, then
 * members — so siblings sit together and the picture only changes when the
 * code does (§1.4, stability before crossings); the external column is
 * ordered by the depth of what it connects to.
 *
 * Inlined into the viewer page verbatim (minus import/export keywords), so it
 * must stay a single self-contained module with no runtime imports.
 */

export const BAND_ORDER: readonly Tier[] = [
  "ui",
  "ui_logic",
  "api",
  "domain",
  "data_access",
  "store",
];

export const LAYOUT = {
  /** Estimated glyph advance at the page's 12px system font; there is no DOM to measure with. */
  charW: 6.6,
  padX: 12,
  minNodeW: 120,
  maxNodeW: 300,
  /** One-line and two-line node heights. */
  nodeH1: 34,
  nodeH2: 48,
  lineH: 15,
  gapX: 22,
  bandH: 120,
  bandPadX: 40,
  bandLabelW: 96,
  externalW: 340,
  externalGapY: 14,
  minBandW: 640,
  /** Room to the right of a node with a self-loop, so the loop and its label clear the neighbour. */
  selfLoopGap: 64,
} as const;

/** Characters that fit on one line at `maxNodeW`. */
export const MAX_LINE_CHARS = Math.floor(
  (LAYOUT.maxNodeW - 2 * LAYOUT.padX) / LAYOUT.charW,
);

/**
 * Scope §"Who reads the map": every node renders its full `label`. A label
 * longer than one line wraps to two at a word or path boundary, and only a
 * label longer than two lines is ever ellipsised. Deterministic, DOM-free.
 */
export function wrapLabel(
  label: string,
  maxChars: number = MAX_LINE_CHARS,
): string[] {
  if (label.length <= maxChars) return [label];
  const first = breakAt(label, maxChars);
  const rest = label.slice(first.length).trimStart();
  if (rest.length <= maxChars) return [first.trimEnd(), rest];
  // An early separator can leave a remainder that does not fit; a hard cut
  // keeps the whole label on two lines, which the scope prefers to an ellipsis.
  const hard = label.slice(0, maxChars);
  const tail = label.slice(maxChars).trimStart();
  if (tail.length <= maxChars) return [hard.trimEnd(), tail];
  return [first.trimEnd(), `${rest.slice(0, maxChars - 1)}…`];
}

/**
 * The longest prefix of at most `maxChars` that ends at a natural break: the
 * last space if there is one, else after the last path or symbol separator,
 * else a hard cut. Spaces win so a path or dotted name stays whole.
 */
function breakAt(text: string, maxChars: number): string {
  let space = -1;
  let separator = -1;
  for (let i = 0; i < maxChars && i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === " ") space = i;
    else if ("/._:-,(".includes(ch)) separator = i + 1;
  }
  const cut = space > 0 ? space : separator > 0 ? separator : maxChars;
  return text.slice(0, cut);
}

/** A node's wrapped lines, width and height from its label alone; no DOM, so deterministic. */
export function nodeSize(label: string): {
  lines: string[];
  w: number;
  h: number;
} {
  const lines = wrapLabel(label);
  const chars = Math.max(...lines.map((l) => l.length));
  const w = Math.min(
    LAYOUT.maxNodeW,
    Math.max(
      LAYOUT.minNodeW,
      Math.ceil(chars * LAYOUT.charW + 2 * LAYOUT.padX),
    ),
  );
  return { lines, w, h: lines.length > 1 ? LAYOUT.nodeH2 : LAYOUT.nodeH1 };
}

export interface LayoutNode {
  readonly node: Node;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  /** The label, wrapped for display. Never the id. */
  readonly lines: readonly string[];
  readonly external: boolean;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface LayoutEdge {
  readonly edge: Edge;
  /** SVG path data: one cubic Bézier, `p[0]` to `p[3]`. */
  readonly d: string;
  /** The curve's control points, so labels and markers can sit on it — see `bezierPoint`. */
  readonly p: readonly [Point, Point, Point, Point];
  /** The point at t = 0.5, where badges sit. */
  readonly mx: number;
  readonly my: number;
  /** Both ends in one band and not a self-loop: the edge arcs over or under its row. */
  readonly sameBand: boolean;
}

/** Unit tangent along a layout edge at t; the direction of travel. */
export function bezierTangent(le: LayoutEdge, t: number): Point {
  const [a, b, c, d] = le.p;
  const u = 1 - t;
  const x =
    3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x);
  const y =
    3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

/** A point along a layout edge, t in [0, 1]. */
export function bezierPoint(le: LayoutEdge, t: number): Point {
  const [a, b, c, d] = le.p;
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x,
    y: w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y,
  };
}

export interface ForkPoint extends Point {
  /** Edges leaving this point that belong to an `exclusive_group`, in id order. */
  readonly edges: readonly LayoutEdge[];
}

/**
 * UI §3.3 / graph model §3.2: a fork marker sits where the branches split.
 * Every edge with an `exclusive_group` leaves its node at a point; edges of
 * one group that share a start point share a marker, and a branch that leaves
 * from another side of the node gets its own, so every branch is marked at
 * its root. Deterministic: markers are ordered by group id, then start point.
 */
export function forkPoints(edges: readonly LayoutEdge[]): ForkPoint[] {
  const byKey = new Map<string, LayoutEdge[]>();
  for (const le of edges) {
    if (le.edge.exclusive_group === null) continue;
    const [start] = le.p;
    const key = `${le.edge.exclusive_group}\u0000${String(start.x)},${String(start.y)}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [le]);
    else list.push(le);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => byteCompare(a, b))
    .map(([, list]) => {
      const [start] = (list[0] as LayoutEdge).p;
      return { x: start.x, y: start.y, edges: list };
    });
}

export interface LayoutBand {
  readonly tier: Tier;
  readonly y: number;
  readonly h: number;
  readonly count: number;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly bands: readonly LayoutBand[];
  readonly externalX: number;
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
}

/** Byte-order comparison, the tie-break everywhere ordering must be deterministic. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nodes the viewer places: everything except `external` goes in a band; `external` goes in the column. A tier the bands do not know is treated as `domain`. */
function bandIndex(tier: Tier): number {
  const i = BAND_ORDER.indexOf(tier);
  return i === -1 ? BAND_ORDER.indexOf("domain") : i;
}

/** The layered layout of a graph: bands in §6 order, the external column, every node placed and every edge routed. */
export function layoutGraph(graph: {
  nodes: readonly Node[];
  edges: readonly Edge[];
}): Layout {
  const nodes = [...graph.nodes].sort((a, b) => byteCompare(a.id, b.id));
  const inBand: Node[][] = BAND_ORDER.map(() => []);
  const external: Node[] = [];
  for (const n of nodes) {
    if (n.tier === "external") external.push(n);
    else (inBand[bandIndex(n.tier)] as Node[]).push(n);
  }

  // §1.4 asks for minimal crossings, then siblings adjacent, and for an
  // ordering that is stable between parses. A barycenter ordering meets the
  // first and fails the third: it orders by where a node's targets sit, so
  // one new call anywhere can move most of a row — measured on the reference
  // codebase, a single added collection write moved 73.6% of the nodes in the
  // methods row, some by the whole width of the map — and a reader cannot
  // tell a re-optimised layout from a code change. That contradicts the change
  // encoding the map exists to carry.
  //
  // So the order within a band is ALPHABETICAL BY LABEL along the parent
  // chain: families in alphabetical order, members alphabetical within each
  // family, id as the tie-break. It never moves unless the code does, keeps
  // siblings adjacent, and lets a reader scan a row for a name. Crossings are
  // a constant tax rather than a growing one (928 among 179 inter-band edges
  // at modules level on the reference codebase, against 416 for a family
  // barycenter), and the diagonals are honest edges. The barycenter survives
  // only for the external column below, which is not a depth and has no
  // alphabet a reader would scan.
  const neighbours = new Map<string, string[]>();
  const addNeighbour = (a: string, b: string): void => {
    const list = neighbours.get(a);
    if (list === undefined) neighbours.set(a, [b]);
    else list.push(b);
  };
  for (const e of graph.edges) {
    addNeighbour(e.from, e.to);
    addNeighbour(e.to, e.from);
  }
  const rank = new Map<string, number>();
  const rerank = (): void => {
    inBand.forEach((band) => band.forEach((n, i) => rank.set(n.id, i)));
    external.forEach((n, i) => rank.set(n.id, i));
  };
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent] as const));
  const labelOf = new Map(nodes.map((n) => [n.id, n.label] as const));
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
  for (const band of inBand) {
    const keys = new Map(
      band.map(
        (n) =>
          [
            n.id,
            // Label first, id second at every level: alphabetical by label,
            // and two ancestors that share a label keep separate families.
            chainOf(n.id).map((id) => `${labelOf.get(id) ?? id}\u0000${id}`),
          ] as const,
      ),
    );
    band.sort((a, b) => {
      const ka = keys.get(a.id) as string[];
      const kb = keys.get(b.id) as string[];
      // Compare the shared prefix; a node sorts with its ancestors and an
      // ancestor drawn in the band comes before its own children.
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const d = byteCompare(ka[i] as string, kb[i] as string);
        if (d !== 0) return d;
      }
      return ka.length - kb.length || byteCompare(a.id, b.id);
    });
  }
  rerank();

  // The column runs top to bottom beside the bands, so an edge into it
  // crosses another when its band-side end is deeper but its column-side end
  // is higher. Ordering the column by the depth of what each node connects
  // to — then by horizontal position within that depth — removes those
  // crossings; a horizontal barycenter (the old rule) ignored them.
  const tierOf = new Map(nodes.map((n) => [n.id, n.tier] as const));
  const depthKey = new Map<string, number>();
  for (const n of external) {
    const keys = (neighbours.get(n.id) ?? [])
      .filter(
        (id) => tierOf.get(id) !== undefined && tierOf.get(id) !== "external",
      )
      .map(
        (id) =>
          bandIndex(tierOf.get(id) as Tier) * 1000 + (rank.get(id) as number),
      );
    depthKey.set(
      n.id,
      keys.length === 0
        ? Number.POSITIVE_INFINITY
        : keys.reduce((a, b) => a + b, 0) / keys.length,
    );
  }
  external.sort(
    (a, b) =>
      (depthKey.get(a.id) as number) - (depthKey.get(b.id) as number) ||
      byteCompare(a.id, b.id),
  );
  rerank();

  const size = new Map(nodes.map((n) => [n.id, nodeSize(n.label)] as const));
  const sizeOf = (n: Node): ReturnType<typeof nodeSize> =>
    size.get(n.id) as ReturnType<typeof nodeSize>;
  const selfLoop = new Set(
    graph.edges.filter((e) => e.from === e.to).map((e) => e.from),
  );
  const gapAfter = (n: Node): number =>
    LAYOUT.gapX + (selfLoop.has(n.id) ? LAYOUT.selfLoopGap : 0);
  const rowWidth = (band: readonly Node[]): number =>
    band.reduce(
      (s, n, i) => s + sizeOf(n).w + (i < band.length - 1 ? gapAfter(n) : 0),
      0,
    );
  const widest = Math.max(
    LAYOUT.minBandW,
    ...inBand.map((b) => rowWidth(b) + LAYOUT.bandPadX * 2),
  );
  const externalX = LAYOUT.bandLabelW + widest + 40;
  const width = externalX + LAYOUT.externalW;
  const externalH = external.reduce(
    (s, n) => s + sizeOf(n).h + LAYOUT.externalGapY,
    0,
  );
  const height = Math.max(BAND_ORDER.length * LAYOUT.bandH, externalH + 40);

  const placed: LayoutNode[] = [];
  const pos = new Map<string, LayoutNode>();
  const bands: LayoutBand[] = BAND_ORDER.map((tier, i) => ({
    tier,
    y: i * LAYOUT.bandH,
    h: LAYOUT.bandH,
    count: (inBand[i] as Node[]).length,
  }));
  inBand.forEach((band, bi) => {
    let x = LAYOUT.bandLabelW + (widest - rowWidth(band)) / 2;
    for (const n of band) {
      const { lines, w, h } = sizeOf(n);
      const ln: LayoutNode = {
        node: n,
        x,
        y: bi * LAYOUT.bandH + (LAYOUT.bandH - h) / 2,
        w,
        h,
        lines,
        external: false,
      };
      placed.push(ln);
      pos.set(n.id, ln);
      x += w + gapAfter(n);
    }
  });
  let ey = 20;
  for (const n of external) {
    const { lines, w, h } = sizeOf(n);
    const ln: LayoutNode = {
      node: n,
      x: externalX + 20,
      y: ey,
      w,
      h,
      lines,
      external: true,
    };
    placed.push(ln);
    pos.set(n.id, ln);
    ey += h + LAYOUT.externalGapY;
  }

  const edges: LayoutEdge[] = [];
  for (const e of [...graph.edges].sort((a, b) => byteCompare(a.id, b.id))) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (a === undefined || b === undefined) continue;
    edges.push(edgePath(e, a, b));
  }
  return { width, height, bands, externalX, nodes: placed, edges };
}

/** The cubic curve for an edge between two placed nodes: down or up between bands, an arc within a band, a hop to the column, or a self-loop. */
function edgePath(edge: Edge, a: LayoutNode, b: LayoutNode): LayoutEdge {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  if (a === b) {
    // Self-loop: a small arc off the right edge.
    const x = a.x + a.w;
    const y = a.y + a.h / 2;
    return cubic(
      edge,
      { x, y: y - 8 },
      { x: x + 28, y: y - 22 },
      { x: x + 28, y: y + 22 },
      { x, y: y + 8 },
    );
  }
  if (a.external || b.external) {
    // To or from the column: a horizontal-leaning curve from the node's side.
    const sx = a.external ? a.x : a.x + a.w;
    const sy = a.y + a.h / 2;
    const tx = b.external ? b.x : b.x + b.w;
    const ty = b.y + b.h / 2;
    const c = Math.abs(tx - sx) / 2;
    return cubic(
      edge,
      { x: sx, y: sy },
      { x: sx + c, y: sy },
      { x: tx - c, y: ty },
      { x: tx, y: ty },
    );
  }
  if (bandOf(a) === bandOf(b)) {
    // Same band: a left-to-right edge arcs over the top, a right-to-left edge
    // under the bottom, so a mutual pair does not overlap and direction reads
    // at a glance. The arc's peak (0.75 × lift) stays inside the band's own
    // headroom, so it never crosses into the band above or below.
    const forward = bx >= ax;
    const headroom = (LAYOUT.bandH - Math.max(a.h, b.h)) / 2 - 8;
    const lift = Math.min(
      headroom / 0.75,
      18 + Math.min(22, Math.abs(bx - ax) / 10),
    );
    const sy = forward ? a.y : a.y + a.h;
    const ty = forward ? b.y : b.y + b.h;
    const dir = forward ? -1 : 1;
    return cubic(
      edge,
      { x: ax, y: sy },
      { x: ax, y: sy + dir * lift },
      { x: bx, y: ty + dir * lift },
      { x: bx, y: ty },
      true,
    );
  }
  const down = b.y > a.y;
  const sy = down ? a.y + a.h : a.y;
  const ty = down ? b.y : b.y + b.h;
  const c = Math.abs(ty - sy) / 2;
  return cubic(
    edge,
    { x: ax, y: sy },
    { x: ax, y: sy + (down ? c : -c) },
    { x: bx, y: ty - (down ? c : -c) },
    { x: bx, y: ty },
  );
}

/** The band a placed node sits in, by its row; nodes of one band share a row. */
function bandOf(n: LayoutNode): number {
  return n.external ? -1 : Math.floor((n.y + n.h / 2) / LAYOUT.bandH);
}

/** A LayoutEdge from four control points, with its path string and midpoint. */
function cubic(
  edge: Edge,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  sameBand = false,
): LayoutEdge {
  const n = (v: number): string => String(v);
  const le = {
    edge,
    d: `M ${n(p0.x)} ${n(p0.y)} C ${n(p1.x)} ${n(p1.y)}, ${n(p2.x)} ${n(p2.y)}, ${n(p3.x)} ${n(p3.y)}`,
    p: [p0, p1, p2, p3] as const,
  };
  const mid = bezierPoint({ ...le, mx: 0, my: 0, sameBand: false }, 0.5);
  return { ...le, mx: mid.x, my: mid.y, sameBand };
}
