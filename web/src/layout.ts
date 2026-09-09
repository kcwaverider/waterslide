import type { Edge, Node, Tier } from "@waterslide/core";

/**
 * Layered layout — UI spec §1. Pure: no DOM, no D3, so it is unit-testable
 * and deterministic. Bands top to bottom in graph model §6 order; `external`
 * is a column down the right side, not a band (§1.3). Within a band, nodes
 * are ordered to reduce crossings by a barycenter sweep with id as the
 * tie-break, so an un-nudged map is stable between parses (§1.4).
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

export interface LayoutEdge {
  readonly edge: Edge;
  /** SVG path data. */
  readonly d: string;
  readonly mx: number;
  readonly my: number;
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

function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nodes the viewer places: everything except `external` goes in a band; `external` goes in the column. A tier the bands do not know is treated as `domain`. */
function bandIndex(tier: Tier): number {
  const i = BAND_ORDER.indexOf(tier);
  return i === -1 ? BAND_ORDER.indexOf("domain") : i;
}

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

  // Barycenter ordering, a few alternating sweeps. Positions are ranks, so the
  // result depends only on the graph, never on floating point drift.
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
  rerank();
  const sweep = (band: Node[]): void => {
    const inThisBand = new Set(band.map((n) => n.id));
    const key = new Map<string, number>();
    for (const n of band) {
      const ranks = (neighbours.get(n.id) ?? [])
        .filter((id) => rank.has(id) && !inThisBand.has(id))
        .map((id) => rank.get(id) as number);
      key.set(
        n.id,
        ranks.length === 0
          ? (rank.get(n.id) as number)
          : ranks.reduce((s, r) => s + r, 0) / ranks.length,
      );
    }
    band.sort(
      (a, b) =>
        (key.get(a.id) as number) - (key.get(b.id) as number) ||
        byteCompare(a.id, b.id),
    );
    rerank();
  };
  for (let pass = 0; pass < 4; pass++) {
    for (const band of inBand) sweep(band);
    for (const band of [...inBand].reverse()) sweep(band);
  }
  sweep(external);

  const size = new Map(nodes.map((n) => [n.id, nodeSize(n.label)] as const));
  const sizeOf = (n: Node): ReturnType<typeof nodeSize> =>
    size.get(n.id) as ReturnType<typeof nodeSize>;
  const rowWidth = (band: readonly Node[]): number =>
    band.reduce((s, n) => s + sizeOf(n).w, 0) +
    Math.max(0, band.length - 1) * LAYOUT.gapX;
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
      x += w + LAYOUT.gapX;
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

function edgePath(edge: Edge, a: LayoutNode, b: LayoutNode): LayoutEdge {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  if (a === b) {
    // Self-loop: a small arc off the right edge.
    const x = a.x + a.w;
    const y = a.y + a.h / 2;
    return {
      edge,
      d: `M ${x} ${y - 8} C ${x + 28} ${y - 22}, ${x + 28} ${y + 22}, ${x} ${y + 8}`,
      mx: x + 21,
      my: y,
    };
  }
  if (a.external || b.external) {
    // To or from the column: a horizontal-leaning curve from the node's side.
    const sx = a.external ? a.x : a.x + a.w;
    const sy = a.y + a.h / 2;
    const tx = b.external ? b.x : b.x + b.w;
    const ty = b.y + b.h / 2;
    const c = Math.abs(tx - sx) / 2;
    return {
      edge,
      d: `M ${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`,
      mx: (sx + tx) / 2,
      my: (sy + ty) / 2,
    };
  }
  if (a.y === b.y) {
    // Same band: arc over the top.
    const y = a.y;
    const lift = 26 + Math.min(40, Math.abs(bx - ax) / 8);
    return {
      edge,
      d: `M ${ax} ${y} C ${ax} ${y - lift}, ${bx} ${y - lift}, ${bx} ${y}`,
      mx: (ax + bx) / 2,
      my: y - lift * 0.75,
    };
  }
  const down = b.y > a.y;
  const sy = down ? a.y + a.h : a.y;
  const ty = down ? b.y : b.y + b.h;
  const c = Math.abs(ty - sy) / 2;
  return {
    edge,
    d: `M ${ax} ${sy} C ${ax} ${sy + (down ? c : -c)}, ${bx} ${ty - (down ? c : -c)}, ${bx} ${ty}`,
    mx: (ax + bx) / 2,
    my: (sy + ty) / 2,
  };
}
