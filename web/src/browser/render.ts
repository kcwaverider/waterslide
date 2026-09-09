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

function tooltip(n: Node, state: string): string {
  const lines = [n.label, `${n.kind} · ${n.tier} · ${n.confidence} · ${state}`];
  if (n.confidence_reason !== null) lines.push(n.confidence_reason);
  if (n.is_entry_point) lines.push(`entry point: ${n.entry_point_kind ?? ""}`);
  return lines.join("\n");
}

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
}

export function renderGraph(
  root: HTMLElement,
  graph: GraphLike,
  options: RenderOptions = {},
): ViewerHandle {
  const changeState = options.changeState ?? {};
  const onSelect = options.onSelect ?? ((): void => undefined);
  const onFork = options.onFork ?? ((): void => undefined);
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
      .attr("class", `edge${e.is_broken ? " broken" : ""}`)
      .attr("data-id", e.id)
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onSelect({ type: "edge", id: e.id });
      });
    edge
      .append("path")
      .attr("d", le.d)
      .attr("fill", "none")
      .attr("stroke", e.is_broken ? BROKEN_RED : "#666")
      .attr("stroke-width", e.is_broken ? 2 : 1.4)
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
  let lastTransform: D3.ZoomTransform = d3.zoomIdentity;
  const updateOffscreen = (): void => {
    const view = visibleRegion(root, layout, lastTransform);
    drawOffscreen(
      overlay,
      offscreenIndicators(boxes, view.layout, inherited),
      view.viewBox,
    );
  };

  // Pan and zoom. Zoom here is magnification of the drawn picture only; the
  // semantic zoom of UI §2 is M4's, and the two must never share a variable.
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 6])
    .on("zoom", (event: D3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      lastTransform = event.transform;
      g.attr("transform", event.transform.toString());
      updateOffscreen();
    });
  svg.call(zoom);
  svg.on("click", () => onSelect({ type: "none" }));
  window.addEventListener("resize", updateOffscreen);
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
      x0: t.invertX(viewBox.x0),
      y0: t.invertY(viewBox.y0),
      x1: t.invertX(viewBox.x1),
      y1: t.invertY(viewBox.y1),
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

function describeNodeById(
  graph: GraphLike,
  changeState: ChangeStateMap,
  id: string,
): PanelModel | null {
  const node = graph.nodes.find((n) => n.id === id);
  return node === undefined ? null : describeNode(node, graph, changeState);
}

function describeEdgeById(graph: GraphLike, id: string): PanelModel | null {
  const edge = graph.edges.find((e) => e.id === id);
  return edge === undefined ? null : describeEdge(edge, graph);
}

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
  };

  const draw = (text: string, source: string): void => {
    try {
      const graph = JSON.parse(text) as GraphLike;
      if (panel !== null) renderPanel(panel, null);
      const session = new Session(stage, graph, changeState, panel, controls);
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
}

const SPEED_KEY = "waterslide.speed";

/**
 * One drawn graph and everything that happens on it: selection, flow mode,
 * branch choice and playback. Zoom and magnification live in the renderer;
 * nothing here re-draws the map.
 */
class Session {
  readonly handle: ViewerHandle;
  private readonly player: Player;
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
    this.handle = renderGraph(stage, graph, {
      changeState,
      onSelect: (selection) => {
        if (panel !== null) select(stage, panel, graph, changeState, selection);
      },
      onFork: (edges) => this.flipFork(edges),
    });
    this.player = createPlayer(this.handle.objects, this.handle.edgeById, {
      onTravel: (id) => this.handle.markTravelled(id),
      onArrive: (id) => this.handle.markVisited(id),
      onRestart: () => {
        this.handle.clearTravel();
        if (this.playStart !== null) this.handle.markVisited(this.playStart);
      },
      onObjectClick: (id) => {
        if (panel !== null)
          select(stage, panel, graph, changeState, { type: "edge", id });
      },
      onState: (state) => this.reflect(state),
    });
    this.wireControls();
    this.reflect("idle");
  }

  private wireControls(): void {
    const c = this.controls;
    c.play?.addEventListener("click", () => this.player.toggle());
    c.step?.addEventListener("click", () => this.player.step());
    c.replay?.addEventListener("click", () => this.player.replay());
    c.loop?.addEventListener("change", () =>
      this.player.setLoop(c.loop?.checked ?? false),
    );
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
      c.speed.addEventListener("change", () => {
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

  private reflect(state: PlayerState): void {
    const c = this.controls;
    const active = this.entry !== null;
    for (const b of [c.play, c.step, c.replay])
      if (b !== null) b.disabled = !active;
    if (c.play !== null)
      c.play.textContent = state === "playing" ? "❚❚ pause" : "▶ play";
    document.body.classList.toggle("playing", state === "playing");
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

  /** §6 + §5.2 + §7.1: selecting an entry point enters flow mode and plays it. */
  selectEntry(id: string): void {
    const node = this.graph.nodes.find((n) => n.id === id);
    if (node === undefined) return;
    this.entry = id;
    const radius = blastRadius(this.graph, id);
    this.handle.setFlow(radius);
    this.playStart = id;
    const chosen = chosenAlternatives(this.graph, this.overrides);
    this.handle.setBranches(chosen);
    this.markSidebar();
    this.onStatus(
      `flow: ${node.label} — ${String(radius.nodes.size - 1)} reachable node${radius.nodes.size === 2 ? "" : "s"}, ${String(radius.edges.size)} edge${radius.edges.size === 1 ? "" : "s"}`,
    );
    this.player.play(planPlayback(this.graph, id, chosen));
    this.reflect(this.player.state);
  }

  leaveFlow(): void {
    this.entry = null;
    this.playStart = null;
    this.player.stop();
    this.handle.setFlow(null);
    this.handle.clearTravel();
    this.handle.setBranches(chosenAlternatives(this.graph, this.overrides));
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
    const current = chosenAlternatives(this.graph, this.overrides).get(group);
    const idx = current === undefined ? -1 : ordinals.indexOf(current);
    const next =
      ordinals.length === 1
        ? (ordinals[0] as number)
        : (ordinals[(idx + 1) % ordinals.length] as number);
    this.overrides.set(group, next);
    const chosen = chosenAlternatives(this.graph, this.overrides);
    this.handle.setBranches(chosen);
    if (this.entry === null) return;
    // Replay from the fork: objects start at the branching node.
    this.playStart = first.edge.from;
    this.player.play(planPlayback(this.graph, first.edge.from, chosen));
  }
}

mountViewer();
