import type * as D3 from "d3";
import type { Edge, Node, PayloadSchema } from "@waterslide/core";
import {
  bezierPoint,
  bezierTangent,
  forkPoints,
  layoutGraph,
  LAYOUT,
  type Layout,
  type LayoutEdge,
} from "../layout.js";
import {
  BROKEN_RED,
  changeStateOf,
  confidenceDash,
  nodeStyle,
  type ChangeStateMap,
} from "./encoding.js";
import {
  describeEdge,
  describeNode,
  type PanelModel,
  type PanelSchema,
} from "./panel.js";
import {
  inheritedStates,
  offscreenIndicators,
  type OffscreenIndicator,
  type Viewport,
} from "./offscreen.js";
import {
  blastRadius,
  chosenAlternatives,
  entryPointGroups,
  isActiveBranch,
  planPlayback,
  type BlastRadius,
} from "./flow.js";
import { createPlayer, type Player, type PlayerState } from "./animation.js";
import { LEVEL_TRIGGER, zoomExtent } from "./zoom.js";
import {
  aggregateGraph,
  hideUnresolved,
  levelsOf,
  representativesFor,
  type AggregatedGraph,
  type Level,
} from "./aggregate.js";

/**
 * The renderer — UI spec §1, §3, §4 and §8. Runs in the browser as an inline
 * script: `d3` is a global from the inlined UMD build; `layoutGraph` and the
 * encoding module are inlined ahead of this file. The graph is drawn once and
 * stays put (UI §0); pan and zoom move the picture, never the graph.
 *
 * Every drawing block reads the layout, never the graph directly.
 */
declare const d3: typeof D3;

interface GraphLike {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly schemas?: readonly PayloadSchema[];
  readonly repos: readonly { name: string }[];
  readonly parsed_at?: string;
}

/** Hover text for a node: label first, never the id. */
function tooltip(n: Node, state: string): string {
  const lines = [n.label, `${n.kind} · ${n.tier} · ${n.confidence} · ${state}`];
  if (n.confidence_reason !== null) lines.push(n.confidence_reason);
  if (n.is_entry_point) lines.push(`entry point: ${n.entry_point_kind ?? ""}`);
  return lines.join("\n");
}

/** Hover text for an edge. */
function edgeTooltip(e: Edge): string {
  const lines = [
    `${e.kind}: ${e.from} → ${e.to}`,
    `${e.confidence}${e.source_count > 1 ? ` · ${String(e.source_count)} call sites` : ""}`,
  ];
  if (e.confidence_reason !== null) lines.push(e.confidence_reason);
  if (e.skips_tiers.length > 0)
    lines.push(`skips: ${e.skips_tiers.join(", ")}`);
  if (e.is_broken) lines.push(`BROKEN: ${e.broken_reason ?? ""}`);
  return lines.join("\n");
}

/**
 * Text on an edge. `label` sits beside the curve; a conditional edge also
 * shows `condition.expr` verbatim (§3.3) nearer its start, in italics, so a
 * reader sees when the edge fires without hovering. Neither uses line style.
 */
function drawEdgeText(
  layer: D3.Selection<SVGGElement, unknown, null, undefined>,
  le: LayoutEdge,
): void {
  const e = le.edge;
  if (e.label !== null && e.label.length > 0) {
    const t = e.condition === null ? 0.5 : 0.62;
    // At the midpoint the label must clear whatever badges sit there.
    const clear = e.condition === null ? badgeWidth(e) / 2 : 0;
    placeText(layer, le, t, e.label, clear)
      .attr("class", "edge-label")
      .attr("font-size", 11)
      .attr("fill", "#444");
  }
  if (e.condition !== null) {
    placeText(layer, le, 0.3, e.condition.expr, 0)
      .attr("class", "edge-condition")
      .attr("font-size", 10.5)
      .attr("font-style", "italic")
      .attr("fill", "#333");
  }
}

/**
 * Sets text beside the curve at t, offset along the curve's normal: to the
 * right of a steep edge, above a shallow one, so it clears the line and any
 * badge sitting on it. A white halo keeps it legible over other edges.
 */
function placeText(
  layer: D3.Selection<SVGGElement, unknown, null, undefined>,
  le: LayoutEdge,
  t: number,
  text: string,
  clear: number,
): D3.Selection<SVGTextElement, unknown, null, undefined> {
  const at = bezierPoint(le, t);
  const tan = bezierTangent(le, t);
  const steep = Math.abs(tan.y) > Math.abs(tan.x);
  const self = le.edge.from === le.edge.to;
  const offset = 9 + (steep ? clear : clear > 0 ? 8 : 0);
  let x = at.x;
  let y = at.y;
  let anchor = "middle";
  if (self) {
    // A self-loop hangs off the node's right side; its text goes above the loop.
    y = le.p[1].y - 6;
    x = le.mx;
  } else if (steep) {
    x += offset;
    y += 4;
    anchor = "start";
  } else if (tan.x < 0) {
    // Travelling left: a same-band edge arcs under its nodes, so the text
    // goes below the curve, on the side away from the node row.
    y += offset + 4;
  } else {
    y -= offset;
  }
  return layer
    .append("text")
    .attr("x", x)
    .attr("y", y)
    .attr("text-anchor", anchor)
    .attr("paint-order", "stroke")
    .attr("stroke", "#fff")
    .attr("stroke-width", 3)
    .attr("stroke-linejoin", "round")
    .text(text);
}

/**
 * Badges at the edge midpoint. §3.4: a broken edge gets a warning icon —
 * icon, not colour alone — and §1.5: a band-skipping edge gets a badge naming
 * how many bands it bypassed. An edge can carry both, so they sit side by
 * side rather than sharing a slot. Both are text or shape first, colour second.
 */
function badgeWidth(e: Edge): number {
  const skips = e.skips_tiers.length;
  const pillW = skips > 0 ? `skips ${String(skips)}`.length * 6.2 + 12 : 0;
  const iconW = e.is_broken ? 18 : 0;
  return iconW + (e.is_broken && skips > 0 ? 6 : 0) + pillW;
}

function drawEdgeBadges(
  layer: D3.Selection<SVGGElement, unknown, null, undefined>,
  le: LayoutEdge,
): void {
  const e = le.edge;
  const skips = e.skips_tiers.length;
  const skipText = skips > 0 ? `skips ${String(skips)}` : "";
  const pillW = skips > 0 ? skipText.length * 6.2 + 12 : 0;
  const iconW = e.is_broken ? 18 : 0;
  const gap = e.is_broken && skips > 0 ? 6 : 0;
  let x = le.mx - badgeWidth(e) / 2;
  if (e.is_broken) {
    const icon = layer
      .append("g")
      .attr("class", "badge broken")
      .attr("transform", `translate(${String(x + 9)},${String(le.my)})`);
    icon
      .append("path")
      .attr("d", "M 0 -9 L 9 7 L -9 7 Z")
      .attr("fill", BROKEN_RED)
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .attr("stroke-linejoin", "round");
    icon
      .append("text")
      .attr("text-anchor", "middle")
      .attr("y", 5.5)
      .attr("font-size", 10)
      .attr("font-weight", 700)
      .attr("fill", "#fff")
      .text("!");
    icon.append("title").text(`broken: ${e.broken_reason ?? ""}`);
    x += iconW + gap;
  }
  if (skips > 0) {
    const pill = layer
      .append("g")
      .attr("class", "badge skips")
      .attr("transform", `translate(${String(x)},${String(le.my)})`);
    pill
      .append("rect")
      .attr("x", 0)
      .attr("y", -8)
      .attr("width", pillW)
      .attr("height", 16)
      .attr("rx", 8)
      .attr("fill", "#f2c14e")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);
    pill
      .append("text")
      .attr("x", pillW / 2)
      .attr("y", 3.5)
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .attr("font-weight", 600)
      .attr("fill", "#3a2a00")
      .text(skipText);
    pill.append("title").text(`skips ${e.skips_tiers.join(", ")} (UI §1.5)`);
  }
}

/** Hover text for a fork marker: the branches rooted there and their conditions. */
function forkTooltip(edges: readonly LayoutEdge[]): string {
  const group = edges[0]?.edge.exclusive_group ?? "";
  const lines = [
    `fork: ${String(edges.length)} branch${edges.length === 1 ? "" : "es"} drawn here (${group})`,
  ];
  for (const le of edges) {
    const e = le.edge;
    lines.push(
      `  ${String(e.branch_ordinal ?? "")}: ${e.condition?.expr ?? "(no condition)"}${e.is_error_path ? " — error path" : ""}`,
    );
  }
  return lines.join("\n");
}

/** What the reader clicked. The inspection panel (§8) consumes it. */
export type Selection =
  | { readonly type: "node"; readonly id: string }
  | { readonly type: "edge"; readonly id: string }
  | { readonly type: "none" };

export interface RenderOptions {
  readonly changeState?: ChangeStateMap;
  readonly onSelect?: (selection: Selection) => void;
  /** A fork marker was clicked: the edges rooted at that marker (§7.5). */
  readonly onFork?: (edges: readonly LayoutEdge[]) => void;
  /** §2.2: how many original edges a drawn edge stands for; thicker when more. */
  readonly weights?: ReadonlyMap<string, number>;
  /** §2.1: the base-size multiplier. Persistent, and never the same variable as zoom. */
  readonly magnification?: number;
  /** The pan/zoom to start from, so a re-render at another level keeps the reader's place. */
  readonly initialTransform?: D3.ZoomTransform;
  /** §2.2: after every zoom, the average on-screen node width in CSS pixels. Drives the level trigger. */
  readonly onZoom?: (avgNodePx: number, zoom: number) => void;
  /** Whether a coarser semantic level exists, so scrolling out below fit can reach it. */
  readonly hasCoarserLevel?: boolean;
}

/**
 * The drawn map plus the few things that change on it after drawing. None of
 * these add or remove anything: flow mode dims, branch choice dims, travel
 * emphasises. The graph itself stays put (§0).
 */
export interface ViewerHandle {
  readonly layout: Layout;
  readonly edgeById: ReadonlyMap<string, LayoutEdge>;
  /** §5.2: dim everything outside the blast radius; null leaves flow mode. */
  setFlow(radius: BlastRadius | null): void;
  /** §7.5: the untravelled side of every fork is drawn, dimmed. */
  setBranches(chosen: ReadonlyMap<string, number>): void;
  markTravelled(edgeId: string): void;
  markVisited(nodeId: string): void;
  clearTravel(): void;
  /** Where travelling objects are drawn, above everything else. */
  readonly objects: D3.Selection<SVGGElement, unknown, null, undefined>;
  /** The current pan/zoom, to carry across a re-render. */
  readonly transform: () => D3.ZoomTransform;
  /** Zoom so the mean node is `nodePx` wide, centred on a point given as fractions of the layout. */
  focus(fx: number, fy: number, nodePx: number): void;
  /** The layout point under the centre of the stage, as fractions of the layout. */
  centre(): { fx: number; fy: number };
  /** The visible region in layout coordinates. */
  viewport(): Viewport;
  /** Where a drawn node's centre sits on the stage, in CSS pixels from the stage's top-left; null when not drawn. */
  nodeScreenCentre(id: string): { x: number; y: number } | null;
  /** Zoom so the mean node is `nodePx` wide and put this node's centre at a stage point. */
  placeNodeAt(id: string, at: { x: number; y: number }, nodePx: number): void;
  /** The mean node's on-screen width right now. */
  nodePx(): number;
  /** §2.1: change the base size without touching zoom. */
  setMagnification(magnification: number): void;
  /** Detach everything this draw registered outside its own DOM: the resize listener. */
  destroy(): void;
}

/** Draws the graph once (§0) into `root` and returns the handle for what may change on it afterwards. */
export function renderGraph(
  root: HTMLElement,
  graph: GraphLike,
  options: RenderOptions = {},
): ViewerHandle {
  const changeState = options.changeState ?? {};
  const onSelect = options.onSelect ?? ((): void => undefined);
  const onFork = options.onFork ?? ((): void => undefined);
  const onZoom = options.onZoom ?? ((): void => undefined);
  const weights = options.weights ?? new Map<string, number>();
  let magnification = options.magnification ?? 1;
  const layout = layoutGraph(graph);
  root.replaceChildren();

  const svg = d3
    .select(root)
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${String(layout.width)} ${String(layout.height)}`)
    .style("font", "12px system-ui, sans-serif");

  const defs = svg.append("defs");
  for (const [id, fill] of [
    ["arrow", "#666"],
    ["arrow-broken", BROKEN_RED],
  ] as const) {
    defs
      .append("marker")
      .attr("id", id)
      .attr("viewBox", "0 0 10 10")
      .attr("refX", 9)
      .attr("refY", 5)
      .attr("markerWidth", 7)
      .attr("markerHeight", 7)
      .attr("orient", "auto-start-reverse")
      .append("path")
      .attr("d", "M 0 0 L 10 5 L 0 10 z")
      .attr("fill", fill);
  }

  const g = svg.append("g");

  // Bands.
  const bands = g.append("g").attr("class", "bands");
  for (const [i, band] of layout.bands.entries()) {
    bands
      .append("rect")
      .attr("x", 0)
      .attr("y", band.y)
      .attr("width", layout.externalX - 20)
      .attr("height", band.h)
      .attr("fill", i % 2 === 0 ? "#f5f5f7" : "#ececf0");
    bands
      .append("text")
      .attr("x", 12)
      .attr("y", band.y + 18)
      .attr("fill", "#555")
      .attr("font-weight", 600)
      .text(`${band.tier} (${String(band.count)})`);
  }
  bands
    .append("rect")
    .attr("x", layout.externalX)
    .attr("y", 0)
    .attr("width", layout.width - layout.externalX)
    .attr("height", layout.height)
    .attr("fill", "hsl(184 25% 95%)");
  bands
    .append("text")
    .attr("x", layout.externalX + 12)
    .attr("y", 14)
    .attr("fill", "hsl(184 40% 28%)")
    .attr("font-weight", 600)
    .text("external");

  // Edges under nodes. Line style is confidence and nothing else (§3.3);
  // red is is_broken and nothing else (§3.4).
  const edges = g.append("g").attr("class", "edges");
  for (const le of layout.edges) {
    const e = le.edge;
    const edge = edges
      .append("g")
      .attr(
        "class",
        `edge${e.is_broken ? " broken" : ""}${le.sameBand ? " same-band" : ""}`,
      )
      .attr("data-id", e.id)
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onSelect({ type: "edge", id: e.id });
      });
    // §2.2: an aggregated edge is one thick line, not forty thin ones.
    const weight = weights.get(e.id) ?? 1;
    const width = (e.is_broken ? 2 : 1.4) + 1.3 * Math.log2(weight);
    edge
      .append("path")
      .attr("d", le.d)
      .attr("fill", "none")
      .attr("stroke", e.is_broken ? BROKEN_RED : "#666")
      .attr("stroke-width", width)
      .attr("stroke-dasharray", confidenceDash(e.confidence))
      .attr("marker-end", e.is_broken ? "url(#arrow-broken)" : "url(#arrow)");
    // A wide invisible stroke so a thin line is clickable.
    edge
      .append("path")
      .attr("d", le.d)
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12)
      .append("title")
      .text(edgeTooltip(e));
    drawEdgeText(edge, le);
  }

  // Fork markers (§3.3): one where each branch point splits, whether or not
  // any branch is active. Shape, not colour, so it survives greyscale.
  const forks = g.append("g").attr("class", "forks");
  for (const fp of forkPoints(layout.edges)) {
    const [first] = fp.edges;
    if (first === undefined) continue;
    const toward = bezierPoint(first, 0.08);
    const dx = toward.x - fp.x;
    const dy = toward.y - fp.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = fp.x + (dx / len) * 7;
    const cy = fp.y + (dy / len) * 7;
    const marker = forks
      .append("g")
      .attr("class", "fork")
      .attr("data-group", first.edge.exclusive_group ?? "")
      .attr("transform", `translate(${String(cx)},${String(cy)}) rotate(45)`)
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onFork(fp.edges);
      });
    marker
      .append("rect")
      .attr("x", -4.5)
      .attr("y", -4.5)
      .attr("width", 9)
      .attr("height", 9)
      .attr("fill", "#333")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);
    marker.append("title").text(forkTooltip(fp.edges));
  }

  // Nodes — §3.1 hue, §3.2 saturation and outline. The full label, wrapped,
  // never the id: the map has to be legible without hovering.
  const nodes = g.append("g").attr("class", "nodes");
  for (const ln of layout.nodes) {
    const n = ln.node;
    const state = changeStateOf(changeState, n.id);
    const style = nodeStyle(n.kind, state);
    const box = nodes
      .append("g")
      .attr("class", `node kind-${n.kind} state-${state}`)
      .attr("data-id", n.id)
      .attr("transform", `translate(${String(ln.x)},${String(ln.y)})`)
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onSelect({ type: "node", id: n.id });
      });
    box
      .append("rect")
      .attr("width", ln.w)
      .attr("height", ln.h)
      .attr("rx", 6)
      .attr("fill", style.fill)
      .attr("stroke", style.stroke)
      .attr("stroke-dasharray", style.strokeDash)
      .attr("stroke-width", style.strokeWidth);
    if (style.doubleOutline) {
      // §3.2: `new` is a second outline inside the first. Not dashed, ever.
      box
        .append("rect")
        .attr("x", 3)
        .attr("y", 3)
        .attr("width", ln.w - 6)
        .attr("height", ln.h - 6)
        .attr("rx", 4)
        .attr("fill", "none")
        .attr("stroke", style.text)
        .attr("stroke-width", 1);
    }
    const text = box
      .append("text")
      .attr("x", ln.w / 2)
      .attr("text-anchor", "middle")
      .attr("fill", style.text)
      .attr("font-weight", n.is_entry_point ? 600 : 400);
    const top = ln.h / 2 - ((ln.lines.length - 1) * LAYOUT.lineH) / 2 + 4;
    ln.lines.forEach((line, i) => {
      text
        .append("tspan")
        .attr("x", ln.w / 2)
        .attr("y", top + i * LAYOUT.lineH)
        .text(i === 0 && n.is_entry_point ? `▶ ${line}` : line);
    });
    box.append("title").text(tooltip(n, state));
  }

  // Badges above the nodes: a warning icon or skip pill is the finding, and
  // must stay visible where an edge passes behind a node.
  const badges = g.append("g").attr("class", "badges");
  for (const le of layout.edges) {
    const e = le.edge;
    if (!e.is_broken && e.skips_tiers.length === 0) continue;
    const holder = badges
      .append("g")
      .attr("class", "badge-holder")
      .attr("data-id", e.id)
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onSelect({ type: "edge", id: e.id });
      });
    drawEdgeBadges(holder, le);
  }

  // Travelling objects (§7) go above nodes and badges, inside the zoom transform.
  const objects = g.append("g").attr("class", "objects");

  // Offscreen indicators (§4) live outside the zoom transform, at the edges
  // of what is visible, and are recomputed on every pan or zoom.
  const overlay = svg.append("g").attr("class", "offscreen");
  const inherited = inheritedStates(graph.nodes, changeState);
  const boxes = layout.nodes.map((ln) => ({
    id: ln.node.id,
    x: ln.x,
    y: ln.y,
    w: ln.w,
    h: ln.h,
  }));
  let lastTransform: D3.ZoomTransform =
    options.initialTransform ?? d3.zoomIdentity;
  const updateOffscreen = (): void => {
    const view = visibleRegion(root, layout, lastTransform, magnification);
    drawOffscreen(
      overlay,
      offscreenIndicators(boxes, view.layout, inherited),
      view.viewBox,
    );
  };
  // §2: zoom (scroll wheel, per session) and magnification (a preference,
  // persistent) are two variables. Both scale the picture; only zoom changes
  // what is rendered, through the level trigger below. They are composed
  // here and nowhere else.
  const applyTransform = (): void => {
    g.attr(
      "transform",
      `${lastTransform.toString()} scale(${String(magnification)})`,
    );
  };
  const meanNodeW =
    layout.nodes.length === 0
      ? 0
      : layout.nodes.reduce((sum, n) => sum + n.w, 0) / layout.nodes.length;
  /** CSS pixels per layout unit at k = 1, i.e. with the whole map fitted to the stage. */
  const fitScale = (): number => {
    const rect = root.getBoundingClientRect();
    return Math.min(rect.width / layout.width, rect.height / layout.height);
  };
  /** The mean node's on-screen width at k = 1. */
  const fitNodePx = (): number => meanNodeW * magnification * fitScale();
  const reportZoom = (): void => {
    onZoom(fitNodePx() * lastTransform.k, lastTransform.k);
  };

  // A transform the code applies — carrying the reader's place across a
  // re-draw, or settling a level change — is not the reader zooming, and the
  // level trigger must not act on it: the layout it lands on may be a very
  // different size from the one the transform came from.
  let programmatic = false;
  const setTransform = (t: D3.ZoomTransform): void => {
    programmatic = true;
    try {
      svg.call(zoom.transform, t);
    } finally {
      programmatic = false;
    }
  };
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .on("zoom", (event: D3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      lastTransform = event.transform;
      applyTransform();
      updateOffscreen();
      if (!programmatic) reportZoom();
    });
  // The extent depends on how big the map is relative to the stage, so it is
  // recomputed whenever that changes: at draw, on resize, on magnification.
  const hasCoarser = options.hasCoarserLevel ?? false;
  const applyExtent = (): void => {
    zoom.scaleExtent(zoomExtent(fitNodePx(), hasCoarser));
  };
  applyExtent();
  svg.call(zoom);
  if (options.initialTransform !== undefined)
    setTransform(options.initialTransform);
  svg.on("click", () => onSelect({ type: "none" }));
  const onResize = (): void => {
    applyExtent();
    updateOffscreen();
  };
  window.addEventListener("resize", onResize);
  applyTransform();
  updateOffscreen();

  const edgeById = new Map(layout.edges.map((le) => [le.edge.id, le] as const));
  const byId = (id: string): NodeListOf<Element> =>
    root.querySelectorAll(`[data-id="${cssEscape(id)}"]`);
  const setClass = (
    selector: string,
    className: string,
    on: (id: string) => boolean,
  ): void => {
    for (const el of root.querySelectorAll(selector)) {
      const id = el.getAttribute("data-id");
      if (id !== null) el.classList.toggle(className, on(id));
    }
  };
  return {
    layout,
    edgeById,
    objects,
    setFlow(radius) {
      svg.classed("flow", radius !== null);
      setClass(
        ".node",
        "dim",
        (id) => radius !== null && !radius.nodes.has(id),
      );
      setClass(
        ".edge, .badge-holder",
        "dim",
        (id) => radius !== null && !radius.edges.has(id),
      );
    },
    setBranches(chosen) {
      setClass(".edge, .badge-holder", "inactive-branch", (id) => {
        const le = edgeById.get(id);
        return le !== undefined && !isActiveBranch(le.edge, chosen);
      });
    },
    markTravelled(edgeId) {
      for (const el of byId(edgeId)) el.classList.add("travelled");
    },
    markVisited(nodeId) {
      for (const el of byId(nodeId)) el.classList.add("visited");
    },
    clearTravel() {
      for (const el of root.querySelectorAll(".travelled, .visited"))
        el.classList.remove("travelled", "visited");
    },
    transform: () => lastTransform,
    focus(fx, fy, nodePx) {
      const fit = fitNodePx();
      const [kMin, kMax] = zoomExtent(fit, hasCoarser);
      const k = Math.max(kMin, Math.min(kMax, fit > 0 ? nodePx / fit : 1));
      // Put the layout point at these fractions under the centre of the stage.
      const t = d3.zoomIdentity
        .translate(
          layout.width / 2 - k * magnification * fx * layout.width,
          layout.height / 2 - k * magnification * fy * layout.height,
        )
        .scale(k);
      setTransform(t);
    },
    centre() {
      const view = visibleRegion(root, layout, lastTransform, magnification);
      return {
        fx: (view.layout.x0 + view.layout.x1) / 2 / layout.width,
        fy: (view.layout.y0 + view.layout.y1) / 2 / layout.height,
      };
    },
    viewport() {
      return visibleRegion(root, layout, lastTransform, magnification).layout;
    },
    nodeScreenCentre(id) {
      const ln = layout.nodes.find((n) => n.node.id === id);
      if (ln === undefined) return null;
      const s = fitScale();
      const rect = root.getBoundingClientRect();
      const vb = lastTransform.apply([
        magnification * (ln.x + ln.w / 2),
        magnification * (ln.y + ln.h / 2),
      ]);
      // viewBox → stage pixels: the viewBox is centred in the stage (xMidYMid meet).
      return {
        x: (vb[0] - layout.width / 2) * s + rect.width / 2,
        y: (vb[1] - layout.height / 2) * s + rect.height / 2,
      };
    },
    placeNodeAt(id, at, nodePx) {
      const ln = layout.nodes.find((n) => n.node.id === id);
      if (ln === undefined) return;
      const fit = fitNodePx();
      const [kMin, kMax] = zoomExtent(fit, hasCoarser);
      const k = Math.max(kMin, Math.min(kMax, fit > 0 ? nodePx / fit : 1));
      const s = fitScale();
      const rect = root.getBoundingClientRect();
      const vbx = (at.x - rect.width / 2) / s + layout.width / 2;
      const vby = (at.y - rect.height / 2) / s + layout.height / 2;
      const t = d3.zoomIdentity
        .translate(
          vbx - k * magnification * (ln.x + ln.w / 2),
          vby - k * magnification * (ln.y + ln.h / 2),
        )
        .scale(k);
      setTransform(t);
    },
    nodePx: () => fitNodePx() * lastTransform.k,
    destroy() {
      window.removeEventListener("resize", onResize);
    },
    setMagnification(next) {
      // §2.2: magnification re-renders the same level at a different size. It
      // shifts where in the zoom range the next level change falls — the
      // extent and the fitted node width both move — but it never reports a
      // zoom, so it cannot change level on its own.
      magnification = next > 0 ? next : 1;
      applyExtent();
      applyTransform();
      updateOffscreen();
    },
  };
}

/**
 * The visible region, both in viewBox units (where the overlay draws) and in
 * layout coordinates (what the indicators count against). The svg keeps its
 * aspect ratio (`xMidYMid meet`), so the visible viewBox region can be wider
 * or taller than the viewBox itself.
 */
function visibleRegion(
  root: HTMLElement,
  layout: Layout,
  t: D3.ZoomTransform,
  magnification: number,
): { viewBox: Viewport; layout: Viewport } {
  const rect = root.getBoundingClientRect();
  const cw = Math.max(1, rect.width);
  const ch = Math.max(1, rect.height);
  const scale = Math.min(cw / layout.width, ch / layout.height);
  const visW = cw / scale;
  const visH = ch / scale;
  const viewBox: Viewport = {
    x0: layout.width / 2 - visW / 2,
    y0: layout.height / 2 - visH / 2,
    x1: layout.width / 2 + visW / 2,
    y1: layout.height / 2 + visH / 2,
  };
  return {
    viewBox,
    layout: {
      x0: t.invertX(viewBox.x0) / magnification,
      y0: t.invertY(viewBox.y0) / magnification,
      x1: t.invertX(viewBox.x1) / magnification,
      y1: t.invertY(viewBox.y1) / magnification,
    },
  };
}

/**
 * §4: one arrow per side with nodes beyond it. The count is text; the change
 * state is the fill — pastel for unchanged, dark for modified, dark with a
 * double outline for new — so the outline vocabulary of §3.2 holds here too.
 */
function drawOffscreen(
  overlay: D3.Selection<SVGGElement, unknown, null, undefined>,
  indicators: readonly OffscreenIndicator[],
  view: Viewport,
): void {
  overlay.selectAll("*").remove();
  const inset = 30;
  const cx = (view.x0 + view.x1) / 2;
  const cy = (view.y0 + view.y1) / 2;
  for (const ind of indicators) {
    const glyph =
      ind.side === "top"
        ? "▲"
        : ind.side === "bottom"
          ? "▼"
          : ind.side === "left"
            ? "◀"
            : "▶";
    const text =
      ind.side === "right" || ind.side === "bottom"
        ? `${String(ind.count)} ${glyph}`
        : `${glyph} ${String(ind.count)}`;
    const w = text.length * 7.5 + 16;
    const h = 24;
    const x =
      ind.side === "left"
        ? view.x0 + inset
        : ind.side === "right"
          ? view.x1 - inset
          : cx;
    const y =
      ind.side === "top"
        ? view.y0 + inset
        : ind.side === "bottom"
          ? view.y1 - inset
          : cy;
    const vivid = ind.state === "modified" || ind.state === "new";
    const el = overlay
      .append("g")
      .attr("class", `offscreen-${ind.side} state-${ind.state}`)
      .attr("transform", `translate(${String(x)},${String(y)})`);
    el.append("title").text(
      `${String(ind.count)} node${ind.count === 1 ? "" : "s"} off screen ${ind.side === "left" || ind.side === "right" ? "to the " : ""}${ind.side}` +
        (ind.state === "unchanged" ? "" : `; includes something ${ind.state}`),
    );
    el.append("rect")
      .attr("x", -w / 2)
      .attr("y", -h / 2)
      .attr("width", w)
      .attr("height", h)
      .attr("rx", 12)
      .attr("fill", vivid ? "#3b3b3b" : "#ececec")
      .attr("stroke", vivid ? "#111" : "#777")
      .attr("stroke-width", 1.2);
    if (ind.state === "new")
      el.append("rect")
        .attr("x", -w / 2 + 3)
        .attr("y", -h / 2 + 3)
        .attr("width", w - 6)
        .attr("height", h - 6)
        .attr("rx", 9)
        .attr("fill", "none")
        .attr("stroke", "#fff")
        .attr("stroke-width", 1);
    el.append("text")
      .attr("text-anchor", "middle")
      .attr("y", 4.5)
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("fill", vivid ? "#fff" : "#222")
      .text(text);
  }
}

/**
 * §8: click a node or edge and the panel describes it. The model comes from
 * the pure panel module; this only builds DOM, with text nodes throughout so
 * a label can never inject markup.
 */
export function renderPanel(el: HTMLElement, model: PanelModel | null): void {
  el.replaceChildren();
  if (model === null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const add = <K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const child = document.createElement(tag);
    if (className.length > 0) child.className = className;
    if (text !== undefined) child.textContent = text;
    parent.appendChild(child);
    return child;
  };
  const head = add(el, "div", "panel-head");
  add(head, "h2", "panel-title", model.title);
  const close = add(head, "button", "panel-close", "×");
  close.type = "button";
  close.title = "close";
  close.addEventListener("click", () => renderPanel(el, null));
  add(el, "div", "panel-subtitle", model.subtitle);
  const dl = add(el, "dl", "panel-fields");
  for (const f of model.fields) {
    add(dl, "dt", "", f.label);
    add(dl, "dd", f.tone ?? "", f.value);
  }
  for (const schema of model.schemas)
    renderSchema(add(el, "section", "panel-schema"), schema, add);
  add(el, "div", "panel-address", model.address);
}

type Add = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className: string,
  text?: string,
) => HTMLElementTagNameMap[K];

/** One schema section of the panel, nested for `ref_schema_id` fields. */
function renderSchema(el: HTMLElement, schema: PanelSchema, add: Add): void {
  const head = add(el, "div", "schema-head");
  add(head, "span", "schema-role", schema.role);
  add(head, "span", "schema-name", schema.name);
  if (schema.missing) {
    add(el, "div", "muted", "no schema with this id in the graph");
    return;
  }
  const meta: string[] = [schema.confidence];
  if (schema.source !== null) meta.push(schema.source);
  add(el, "div", "schema-meta muted", meta.join(" · "));
  if (schema.confidence !== "certain")
    add(el, "div", "reason", schema.confidence_reason ?? "");
  if (schema.fields.length === 0) {
    add(el, "div", "muted", "opaque payload — no fields");
    return;
  }
  const list = add(el, "ul", "schema-fields");
  for (const f of schema.fields) {
    const li = add(list, "li", "");
    add(li, "span", "field-name", f.name);
    add(li, "span", "field-type", `${f.optional ? "?" : ""}${f.type}`);
    for (const c of f.classification) add(li, "span", "field-class", c);
    if (f.nested === "cycle")
      add(li, "span", "muted", "(already expanded above)");
    else if (f.nested !== null)
      renderSchema(add(li, "div", "panel-schema nested"), f.nested, add);
  }
}

/** Marks the selected node or edge on the map and fills the panel. */
function select(
  stage: HTMLElement,
  panel: HTMLElement,
  graph: GraphLike,
  changeState: ChangeStateMap,
  selection: Selection,
): void {
  for (const el of stage.querySelectorAll(".selected"))
    el.classList.remove("selected");
  if (selection.type === "none") {
    renderPanel(panel, null);
    return;
  }
  const model =
    selection.type === "node"
      ? describeNodeById(graph, changeState, selection.id)
      : describeEdgeById(graph, selection.id);
  renderPanel(panel, model);
  for (const el of stage.querySelectorAll(
    `[data-id="${cssEscape(selection.id)}"]`,
  ))
    el.classList.add("selected");
}

/** The panel model for a node id, or null when it is not drawn. */
function describeNodeById(
  graph: GraphLike,
  changeState: ChangeStateMap,
  id: string,
): PanelModel | null {
  const node = graph.nodes.find((n) => n.id === id);
  return node === undefined ? null : describeNode(node, graph, changeState);
}

/** The panel model for an edge id, or null when it is not drawn. */
function describeEdgeById(graph: GraphLike, id: string): PanelModel | null {
  const edge = graph.edges.find((e) => e.id === id);
  return edge === undefined ? null : describeEdge(edge, graph);
}

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * The change-state seam (M3). The page carries an optional JSON map of node id
 * to change state beside the graph; an empty or missing map is every node
 * `unchanged`, which is persisted-files §1.5's no-baseline rule.
 */
function readChangeState(): ChangeStateMap {
  const el = document.getElementById("change-state");
  if (el === null || el.textContent === null) return {};
  const text = el.textContent.trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ChangeStateMap)
      : {};
  } catch {
    return {};
  }
}

/** Wires the page: draws the embedded graph, the sidebar and the player, and accepts a dropped or picked graph.json. */
export function mountViewer(): void {
  const stage = document.getElementById("stage");
  const status = document.getElementById("status");
  const input = document.getElementById("file") as HTMLInputElement | null;
  if (stage === null || status === null) return;

  const changeState = readChangeState();
  const panel = document.getElementById("panel");
  const sidebar = document.getElementById("sidebar");
  const controls = {
    play: document.getElementById("play") as HTMLButtonElement | null,
    step: document.getElementById("step") as HTMLButtonElement | null,
    replay: document.getElementById("replay") as HTMLButtonElement | null,
    loop: document.getElementById("loop") as HTMLInputElement | null,
    speed: document.getElementById("speed") as HTMLSelectElement | null,
    level: document.getElementById("zoom-level") as HTMLSelectElement | null,
    magnification: document.getElementById(
      "magnification",
    ) as HTMLSelectElement | null,
    zoomLabel: document.getElementById("zoom-label"),
    hideUnresolved: document.getElementById(
      "hide-unresolved",
    ) as HTMLInputElement | null,
    hideUnresolvedCount: document.getElementById("hide-unresolved-count"),
  };

  let current: Session | null = null;
  const draw = (text: string, source: string): void => {
    try {
      const graph = JSON.parse(text) as GraphLike;
      if (panel !== null) renderPanel(panel, null);
      // A dropped graph replaces the session; the old one must stop touching the shared stage and controls.
      current?.dispose();
      const session = new Session(stage, graph, changeState, panel, controls);
      current = session;
      // For harnesses and debugging: the live session, never used by the page itself.
      (window as unknown as { waterslide?: unknown }).waterslide = session;
      const layout = session.handle.layout;
      if (sidebar !== null) session.mountSidebar(sidebar);
      const legend = `${String(graph.nodes.length)} nodes · ${String(graph.edges.length)} edges · ${String(layout.bands.filter((b) => b.count > 0).length)} bands used · ${String(layout.nodes.filter((n) => n.external).length)} external`;
      status.textContent = `${source} — ${legend}${graph.parsed_at === undefined ? "" : ` — parsed ${graph.parsed_at}`}`;
      session.onStatus = (line) => {
        status.textContent = line === null ? `${source} — ${legend}` : line;
      };
    } catch (e) {
      status.textContent = `could not render ${source}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const embedded = document.getElementById("graph");
  if (
    embedded !== null &&
    embedded.textContent !== null &&
    embedded.textContent.trim().length > 0
  ) {
    draw(embedded.textContent, "embedded graph.json");
  } else {
    status.textContent = "drop a graph.json here, or choose one";
  }

  const load = (file: File): void => {
    file.text().then(
      (t) => draw(t, file.name),
      (e: unknown) => {
        status.textContent = `could not read ${file.name}: ${String(e)}`;
      },
    );
  };
  document.body.addEventListener("dragover", (ev) => ev.preventDefault());
  document.body.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files[0];
    if (f !== undefined) load(f);
  });
  input?.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f !== undefined) load(f);
  });
}

interface Controls {
  readonly play: HTMLButtonElement | null;
  readonly step: HTMLButtonElement | null;
  readonly replay: HTMLButtonElement | null;
  readonly loop: HTMLInputElement | null;
  readonly speed: HTMLSelectElement | null;
  readonly level: HTMLSelectElement | null;
  readonly magnification: HTMLSelectElement | null;
  readonly zoomLabel: HTMLElement | null;
  readonly hideUnresolved: HTMLInputElement | null;
  readonly hideUnresolvedCount: HTMLElement | null;
}

/** Whether unresolved-reference nodes start hidden. A view default; flip it here. */
export const HIDE_UNRESOLVED_DEFAULT = true;

const SPEED_KEY = "waterslide.speed";
const MAGNIFICATION_KEY = "waterslide.magnification";

/**
 * One graph and everything that happens on it: selection, flow mode, branch
 * choice, playback, and the semantic level it is drawn at. The map is drawn
 * once per level (§0) — only a level change, which is a different graph,
 * re-draws it — and the reader's pan/zoom survives that.
 */
class Session {
  handle: ViewerHandle;
  private player: Player;
  private view: AggregatedGraph;
  private readonly levels: Level[];
  private level: number;
  /** §2.1: a persistent preference. Never the same variable as zoom. */
  private magnification = 1;
  /** View filter: unknown nodes and their edges left out before aggregation and layout. */
  private hideUnresolvedNodes = HIDE_UNRESOLVED_DEFAULT;
  /**
   * Regional focus: the level boxes the reader is looking at. Everything else
   * folds to the branch point off the focus, so the row on screen stays short
   * at readable zoom and far edges land on folded boxes. Null means no focus
   * yet — every box near — which is what a coarse level with everything on
   * screen amounts to anyway.
   */
  private near: Set<string> | null = null;
  /** Level boxes that stay near regardless of the viewport: the selected story's. */
  private readonly pinned = new Set<string>();
  /** Every original node's box at the current level, without any focus. */
  private levelRep = new Map<string, string>();
  /**
   * The centre x of every level box in the GLOBAL level layout — the one with
   * everything unfolded. The near set is a window over that layout, so it
   * depends on the reader's position and nothing else: a folded layout's own
   * positions never feed back into what folds, which is what keeps a refold
   * from undoing itself.
   */
  private globalX = new Map<string, number>();
  private globalMeanW: number = LAYOUT.minNodeW;
  private globalKey = "";
  /** Centre of the current near window in global-layout x; null before the first refold at a level. */
  private windowCentre: number | null = null;
  private refoldTimer = 0;
  private lastRefoldAt = Number.NEGATIVE_INFINITY;
  private lastNodePx: number = LEVEL_TRIGGER.settlePx;
  /** Half-width of the near window, in mean node widths of the global layout: about three viewports at readable zoom. */
  private static readonly WINDOW_RADIUS_NODES = 10;
  /** When the level last changed; the trigger holds off briefly afterwards. Starts in the past so the first zoom counts. */
  private levelChangedAt = Number.NEGATIVE_INFINITY;
  private entry: string | null = null;
  /** Where the current play starts: the entry point, or the fork just flipped (§7.5). */
  private playStart: string | null = null;
  private readonly overrides = new Map<string, number>();
  onStatus: (line: string | null) => void = () => undefined;

  constructor(
    private readonly stage: HTMLElement,
    private readonly graph: GraphLike,
    private readonly changeState: ChangeStateMap,
    private readonly panel: HTMLElement | null,
    private readonly controls: Controls,
  ) {
    this.levels = levelsOf(graph.nodes);
    this.level = this.levels.length - 1;
    this.magnification = this.readMagnification();
    this.view = this.aggregate(this.level);
    this.handle = this.draw(undefined);
    this.player = this.makePlayer();
    this.wireControls();
    this.reflect("idle");
    // The opening level folds around the reader too, once the first frame is up.
    this.scheduleRefold();
  }

  /** The graph as viewed: the filter first, then aggregation to the level under the regional focus, then layout inside renderGraph. */
  private aggregate(level: number): AggregatedGraph {
    const filtered = hideUnresolved(this.graph, this.hideUnresolvedNodes);
    this.reflectFilter(filtered.hiddenNodes, filtered.hiddenEdges);
    this.levelRep = representativesFor(filtered, level);
    const near =
      this.near === null
        ? null
        : new Set(
            [...this.near, ...this.pinned].map(
              (id) => this.levelRep.get(id) ?? id,
            ),
          );
    return aggregateGraph(
      filtered,
      level,
      near === null ? undefined : { near },
    );
  }

  /** The global level layout's positions, built once per level and filter state. */
  private ensureGlobal(): void {
    const key = `${String(this.level)}:${String(this.hideUnresolvedNodes)}`;
    if (key === this.globalKey) return;
    this.globalKey = key;
    const filtered = hideUnresolved(this.graph, this.hideUnresolvedNodes);
    const layout = layoutGraph(aggregateGraph(filtered, this.level));
    this.globalX = new Map();
    let sum = 0;
    let count = 0;
    for (const ln of layout.nodes) {
      if (ln.external) continue;
      this.globalX.set(ln.node.id, ln.x + ln.w / 2);
      sum += ln.w;
      count += 1;
    }
    this.globalMeanW = count === 0 ? LAYOUT.minNodeW : sum / count;
  }

  /** Half-width of the near window in global-layout units. */
  private windowRadius(): number {
    return Session.WINDOW_RADIUS_NODES * this.globalMeanW;
  }

  /** Where the reader is, in global-layout x: the drawn node nearest the centre of the stage, or the mean of a folded box's members. */
  private anchorGlobalX(): number | null {
    const view = this.handle.viewport();
    const cx = (view.x0 + view.x1) / 2;
    let anchor: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const ln of this.handle.layout.nodes) {
      if (ln.external) continue;
      const d = Math.abs(ln.x + ln.w / 2 - cx);
      if (d < best) {
        best = d;
        anchor = ln.node.id;
      }
    }
    return anchor === null ? null : this.globalXOf(anchor);
  }

  /** A drawn node's position in the global layout: its own, or the mean of a folded box's members. */
  private globalXOf(id: string): number | null {
    const own = this.globalX.get(id);
    if (own !== undefined) return own;
    const xs = (this.view.members.get(id) ?? [])
      .map((m) => this.globalX.get(this.levelRep.get(m) ?? m))
      .filter((x): x is number => x !== undefined);
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  /** The near set for a window centre: every level box within the radius in the global layout, plus the pinned. */
  private nearFor(centre: number): Set<string> {
    const r = this.windowRadius();
    const next = new Set<string>();
    for (const [id, x] of this.globalX)
      if (Math.abs(x - centre) <= r) next.add(id);
    for (const id of this.pinned) next.add(this.levelRep.get(id) ?? id);
    return next;
  }

  /** Whether two near sets are the same set. */
  private sameNear(a: Set<string> | null, b: Set<string>): boolean {
    if (a === null || a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  }

  /** Schedules a refold once the zoom or pan has settled. */
  private scheduleRefold(): void {
    if (this.refoldTimer !== 0) window.clearTimeout(this.refoldTimer);
    this.refoldTimer = window.setTimeout(() => {
      this.refoldTimer = 0;
      this.refold();
    }, 250);
  }

  /**
   * Re-draws around where the reader is, once they have moved more than half
   * a window from the last centre, holding the node nearest the centre of the
   * stage where it is, at the size it is, so the eye keeps its place.
   */
  private refold(): void {
    if (this.disposed) return;
    if (performance.now() - this.lastRefoldAt < 400) {
      this.scheduleRefold();
      return;
    }
    this.ensureGlobal();
    const ax = this.anchorGlobalX();
    if (ax === null) return;
    if (
      this.windowCentre !== null &&
      Math.abs(ax - this.windowCentre) < this.windowRadius() / 2
    )
      return;
    const next = this.nearFor(ax);
    if (this.sameNear(this.near, next)) {
      this.windowCentre = ax;
      return;
    }
    this.lastRefoldAt = performance.now();
    this.windowCentre = ax;
    // Anchor: the drawn node nearest the centre that survives the refold.
    const view = this.handle.viewport();
    const cx = (view.x0 + view.x1) / 2;
    let anchor: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const ln of this.handle.layout.nodes) {
      if (ln.external) continue;
      const rep = this.levelRep.get(ln.node.id) ?? ln.node.id;
      if (!next.has(rep) && !next.has(ln.node.id)) continue;
      const d = Math.abs(ln.x + ln.w / 2 - cx);
      if (d < best) {
        best = d;
        anchor = ln.node.id;
      }
    }
    const at = anchor === null ? null : this.handle.nodeScreenCentre(anchor);
    const nodePx = this.handle.nodePx();
    this.near = next;
    this.redraw(false);
    if (anchor !== null && at !== null)
      this.handle.placeNodeAt(anchor, at, nodePx);
  }

  /** The toggle always says what is left out, so a map never quietly drops a quarter of itself. */
  private reflectFilter(hiddenNodes: number, hiddenEdges: number): void {
    const c = this.controls;
    const total = this.graph.nodes.filter((n) => n.kind === "unknown").length;
    if (c.hideUnresolved !== null) {
      c.hideUnresolved.checked = this.hideUnresolvedNodes;
      c.hideUnresolved.disabled = total === 0;
    }
    if (c.hideUnresolvedCount !== null)
      c.hideUnresolvedCount.textContent =
        total === 0
          ? "no unresolved references"
          : this.hideUnresolvedNodes
            ? `${String(hiddenNodes)} unresolved hidden (${String(hiddenEdges)} edges)`
            : `${String(total)} unresolved shown`;
  }

  /** Re-draws with the filter flipped; the same path as a level change. */
  setHideUnresolved(hide: boolean): void {
    if (hide === this.hideUnresolvedNodes) return;
    this.hideUnresolvedNodes = hide;
    this.redraw(false);
  }

  /**
   * Re-draws the current level. A level change also re-scales: the new layout
   * has a different size, so the old transform would jump the picture; the
   * map is refocused on the same point with the mean node at the settle width.
   */
  private redraw(settle: boolean): void {
    const transform = this.handle.transform();
    const centre = this.handle.centre();
    this.player.stop();
    this.handle.destroy();
    // A new level starts with everything near; the refold scheduled below narrows it to a window around the reader.
    if (settle) {
      this.near = null;
      this.windowCentre = null;
    }
    this.view = this.aggregate(this.level);
    this.handle = this.draw(settle ? undefined : transform);
    if (settle) this.handle.focus(centre.fx, centre.fy, LEVEL_TRIGGER.settlePx);
    this.player = this.makePlayer();
    this.player.setLoop(this.controls.loop?.checked ?? false);
    this.player.setSpeed(Number(this.controls.speed?.value) || 1);
    if (this.entry !== null) this.playFlow(this.entry);
    else this.reflect("idle");
    if (settle) this.scheduleRefold();
  }

  /** Draws the current view into the stage and wires selection, forks and the zoom trigger back to this session. */
  private draw(initialTransform: D3.ZoomTransform | undefined): ViewerHandle {
    const { stage, panel, changeState } = this;
    const view = this.view;
    return renderGraph(
      stage,
      { ...this.graph, ...view },
      {
        changeState,
        weights: view.weights,
        magnification: this.magnification,
        ...(initialTransform === undefined ? {} : { initialTransform }),
        onSelect: (selection) => {
          if (panel !== null)
            select(
              stage,
              panel,
              { ...this.graph, ...view },
              changeState,
              selection,
            );
        },
        onFork: (edges) => this.flipFork(edges),
        onZoom: (avgNodePx) => {
          this.lastNodePx = avgNodePx;
          this.considerLevel(avgNodePx);
          this.scheduleRefold();
        },
        hasCoarserLevel: this.level > 0,
      },
    );
  }

  /** A player bound to the current handle's objects layer and edges. */
  private makePlayer(): Player {
    const { stage, panel, changeState } = this;
    return createPlayer(this.handle.objects, this.handle.edgeById, {
      onTravel: (id) => this.handle.markTravelled(id),
      onArrive: (id) => this.handle.markVisited(id),
      onRestart: () => {
        this.handle.clearTravel();
        if (this.playStart !== null) this.handle.markVisited(this.playStart);
      },
      onObjectClick: (id) => {
        if (panel !== null)
          select(stage, panel, { ...this.graph, ...this.view }, changeState, {
            type: "edge",
            id,
          });
      },
      onState: (state) => this.reflect(state),
    });
  }

  /** §2.2: the level trigger, with hysteresis and a short guard after a change. */
  private considerLevel(avgNodePx: number): void {
    if (performance.now() - this.levelChangedAt < 500) return;
    if (
      avgNodePx > LEVEL_TRIGGER.finerAbovePx &&
      this.level < this.levels.length - 1
    )
      this.setLevel(this.level + 1);
    else if (avgNodePx < LEVEL_TRIGGER.coarserBelowPx && this.level > 0)
      this.setLevel(this.level - 1);
  }

  /** Re-draws at another level. The only thing that re-draws the map, and it keeps the reader's place. */
  setLevel(level: number): void {
    const target = Math.max(0, Math.min(this.levels.length - 1, level));
    if (target === this.level) return;
    this.level = target;
    this.levelChangedAt = performance.now();
    if (this.controls.level !== null)
      this.controls.level.value = String(target);
    this.announce(`now showing ${this.levels[target]?.name ?? "nodes"}`);
    this.redraw(true);
  }

  /** §2.2: a brief transition label, so a level change is never surprising. */
  private announce(text: string): void {
    const el = this.controls.zoomLabel;
    if (el === null) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    window.setTimeout(() => {
      el.hidden = true;
    }, 1600);
  }

  /** The persisted magnification preference, or 1. */
  private readMagnification(): number {
    try {
      const saved = Number(localStorage.getItem(MAGNIFICATION_KEY));
      return saved > 0 ? saved : 1;
    } catch {
      return 1;
    }
  }

  setMagnification(m: number): void {
    this.magnification = m > 0 ? m : 1;
    this.handle.setMagnification(this.magnification);
    try {
      localStorage.setItem(MAGNIFICATION_KEY, String(this.magnification));
    } catch {
      // A preference that did not persist still applies to this page.
    }
  }

  /** Listeners this session put on the shared controls, so dispose() can take them off again. */
  private readonly listeners: {
    el: HTMLElement;
    type: string;
    fn: EventListener;
  }[] = [];

  /** Adds a control listener and remembers it for dispose(). */
  private listen(
    el: HTMLElement | null,
    type: string,
    fn: EventListener,
  ): void {
    if (el === null) return;
    el.addEventListener(type, fn);
    this.listeners.push({ el, type, fn });
  }

  /**
   * Stops everything this session owns outside its own DOM: playback, the
   * refold timer, its control listeners and the handle's resize listener. A
   * replaced session must not keep redrawing the shared stage.
   */
  dispose(): void {
    this.player.stop();
    if (this.refoldTimer !== 0) window.clearTimeout(this.refoldTimer);
    this.refoldTimer = 0;
    for (const { el, type, fn } of this.listeners)
      el.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.handle.destroy();
    this.disposed = true;
  }
  private disposed = false;

  /** Binds the playback, level, magnification and filter controls to this session. */
  private wireControls(): void {
    const c = this.controls;
    this.listen(c.play, "click", () => this.player.toggle());
    this.listen(c.step, "click", () => this.player.step());
    this.listen(c.replay, "click", () => this.player.replay());
    this.listen(c.loop, "change", () =>
      this.player.setLoop(c.loop?.checked ?? false),
    );
    if (c.level !== null) {
      c.level.replaceChildren();
      for (const l of this.levels) {
        const o = document.createElement("option");
        o.value = String(l.depth);
        o.textContent = l.name;
        c.level.appendChild(o);
      }
      c.level.value = String(this.level);
      this.listen(c.level, "change", () => {
        if (c.level !== null) this.setLevel(Number(c.level.value));
      });
    }
    this.listen(c.hideUnresolved, "change", () =>
      this.setHideUnresolved(c.hideUnresolved?.checked ?? false),
    );
    if (c.magnification !== null) {
      c.magnification.value = String(this.magnification);
      if (c.magnification.value !== String(this.magnification))
        c.magnification.value = "1";
      this.listen(c.magnification, "change", () => {
        if (c.magnification !== null)
          this.setMagnification(Number(c.magnification.value) || 1);
      });
    }
    if (c.speed !== null) {
      // §7.1: speed is adjustable and persisted.
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(SPEED_KEY);
      } catch {
        saved = null;
      }
      if (saved !== null) c.speed.value = saved;
      this.player.setSpeed(Number(c.speed.value) || 1);
      this.listen(c.speed, "change", () => {
        if (c.speed === null) return;
        this.player.setSpeed(Number(c.speed.value) || 1);
        try {
          localStorage.setItem(SPEED_KEY, c.speed.value);
        } catch {
          // Persistence is a convenience; the page works without it.
        }
      });
    }
  }

  /** Mirrors player state onto the controls: enabled states and the play/pause label. */
  private reflect(state: PlayerState): void {
    const c = this.controls;
    const active = this.entry !== null;
    for (const b of [c.play, c.step, c.replay])
      if (b !== null) b.disabled = !active;
    if (c.play !== null)
      c.play.textContent = state === "playing" ? "❚❚ pause" : "▶ play";
    document.body.classList.toggle("playing", state === "playing");
  }

  /** A snapshot for harnesses: what is folded and why. */
  debug(): {
    level: number;
    near: number | null;
    windowCentre: number | null;
    drawn: number;
    foldedBoxes: number;
    byRole: Record<string, number>;
  } {
    const byRole: Record<string, number> = {};
    for (const n of this.view.nodes) {
      const isFolded = (this.view.folded.get(n.id) ?? 0) > 0;
      const isLevelBox = (this.levelRep.get(n.id) ?? n.id) === n.id;
      const key = isFolded ? "folded box" : isLevelBox ? "level box" : "other";
      byRole[key] = (byRole[key] ?? 0) + 1;
    }
    return {
      level: this.level,
      near: this.near === null ? null : this.near.size,
      windowCentre: this.windowCentre,
      drawn: this.view.nodes.length,
      foldedBoxes: [...this.view.folded.values()].filter((v) => v > 0).length,
      byRole,
    };
  }

  /** §6: the sidebar is the list of things a user or system can do. */
  mountSidebar(el: HTMLElement): void {
    el.replaceChildren();
    const whole = document.createElement("button");
    whole.type = "button";
    whole.className = "entry whole active";
    whole.textContent = "Whole system";
    whole.addEventListener("click", () => this.leaveFlow());
    el.appendChild(whole);
    const groups = entryPointGroups(this.graph.nodes);
    if (groups.length === 0) {
      const none = document.createElement("div");
      none.className = "muted sidebar-empty";
      none.textContent = "no entry points in this graph";
      el.appendChild(none);
    }
    for (const group of groups) {
      const h = document.createElement("h3");
      h.textContent = group.label;
      el.appendChild(h);
      for (const n of group.nodes) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "entry";
        b.dataset["id"] = n.id;
        b.textContent = n.label;
        b.title = n.label;
        b.addEventListener("click", () => this.selectEntry(n.id));
        el.appendChild(b);
      }
    }
  }

  /** Highlights the selected story in the sidebar, or "Whole system" when none. */
  private markSidebar(): void {
    const sidebar = document.getElementById("sidebar");
    if (sidebar === null) return;
    for (const b of sidebar.querySelectorAll(".entry")) {
      const id = (b as HTMLElement).dataset["id"];
      b.classList.toggle(
        "active",
        id === undefined ? this.entry === null : id === this.entry,
      );
    }
  }

  /** §6 + §5.2 + §7.1: selecting an entry point enters flow mode and plays it. Its box is pinned near and, if it was folded away, brought to the centre. */
  selectEntry(id: string): void {
    const node = this.graph.nodes.find((n) => n.id === id);
    if (node === undefined) return;
    this.entry = id;
    this.pinned.clear();
    this.pinned.add(id);
    const box = this.levelRep.get(id) ?? id;
    const drawn = this.view.representative.get(id) ?? id;
    if (drawn !== box) {
      // The story's box was folded away: move the window onto it and bring it to the centre.
      this.ensureGlobal();
      const x = this.globalX.get(box);
      if (x !== undefined) {
        this.windowCentre = x;
        this.near = this.nearFor(x);
      } else {
        this.near = new Set([...(this.near ?? []), box]);
      }
      this.lastRefoldAt = performance.now();
      this.redraw(false); // plays the flow on the new view
      const rect = this.stage.getBoundingClientRect();
      this.handle.placeNodeAt(
        box,
        { x: rect.width / 2, y: rect.height / 2 },
        Math.max(this.lastNodePx, LEVEL_TRIGGER.settlePx),
      );
      return;
    }
    this.playFlow(id);
  }

  /** Flow mode and playback for the entry, on the view as drawn. */
  private playFlow(id: string): void {
    const node = this.graph.nodes.find((n) => n.id === id);
    if (node === undefined) return;
    // At a coarser level, or folded away, the entry point is drawn as the box holding it.
    const start = this.view.representative.get(id) ?? id;
    const radius = blastRadius(this.view, start);
    this.handle.setFlow(radius);
    this.playStart = start;
    const chosen = chosenAlternatives(this.view, this.overrides);
    this.handle.setBranches(chosen);
    this.markSidebar();
    const levelName = this.levels[this.level]?.name ?? "";
    this.onStatus(
      `flow: ${node.label} — ${String(radius.nodes.size - 1)} reachable node${radius.nodes.size === 2 ? "" : "s"}, ${String(radius.edges.size)} edge${radius.edges.size === 1 ? "" : "s"}${this.level === this.levels.length - 1 ? "" : ` at ${levelName} level`}`,
    );
    this.player.play(planPlayback(this.view, start, chosen));
    this.reflect(this.player.state);
  }

  /** Back to whole-system mode: stops playback, clears dimming, forgets the story. */
  leaveFlow(): void {
    this.entry = null;
    this.playStart = null;
    this.pinned.clear();
    this.player.stop();
    this.handle.setFlow(null);
    this.handle.clearTravel();
    this.handle.setBranches(chosenAlternatives(this.view, this.overrides));
    this.markSidebar();
    this.onStatus(null);
    this.reflect("idle");
  }

  /**
   * §7.5: clicking a fork switches the active branch and replays from that
   * point. A marker rooted on one alternative selects it; a marker shared by
   * several cycles through them.
   */
  private flipFork(edges: readonly LayoutEdge[]): void {
    const first = edges[0];
    if (first === undefined || first.edge.exclusive_group === null) return;
    const group = first.edge.exclusive_group;
    const ordinals = [
      ...new Set(
        edges
          .map((le) => le.edge.branch_ordinal)
          .filter((o): o is number => o !== null),
      ),
    ].sort((a, b) => a - b);
    const current = chosenAlternatives(this.view, this.overrides).get(group);
    const idx = current === undefined ? -1 : ordinals.indexOf(current);
    const next =
      ordinals.length === 1
        ? (ordinals[0] as number)
        : (ordinals[(idx + 1) % ordinals.length] as number);
    this.overrides.set(group, next);
    const chosen = chosenAlternatives(this.view, this.overrides);
    this.handle.setBranches(chosen);
    if (this.entry === null) return;
    // Replay from the fork: objects start at the branching node.
    this.playStart = first.edge.from;
    this.player.play(planPlayback(this.view, first.edge.from, chosen));
  }
}

mountViewer();
