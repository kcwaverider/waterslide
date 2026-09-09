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

export function renderGraph(
  root: HTMLElement,
  graph: GraphLike,
  changeState: ChangeStateMap = {},
  onSelect: (selection: Selection) => void = () => undefined,
): Layout {
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
      .attr("transform", `translate(${String(cx)},${String(cy)}) rotate(45)`);
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
      .style("cursor", "pointer")
      .on("click", (ev: MouseEvent) => {
        ev.stopPropagation();
        onSelect({ type: "edge", id: e.id });
      });
    drawEdgeBadges(holder, le);
  }

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

  return layout;
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

/** Wires the page: draws the embedded graph and accepts a dropped or picked graph.json. */
export function mountViewer(): void {
  const stage = document.getElementById("stage");
  const status = document.getElementById("status");
  const input = document.getElementById("file") as HTMLInputElement | null;
  if (stage === null || status === null) return;

  const changeState = readChangeState();
  const panel = document.getElementById("panel");
  const draw = (text: string, source: string): void => {
    try {
      const graph = JSON.parse(text) as GraphLike;
      if (panel !== null) renderPanel(panel, null);
      const layout = renderGraph(stage, graph, changeState, (selection) => {
        if (panel !== null) select(stage, panel, graph, changeState, selection);
      });
      const legend = `${String(graph.nodes.length)} nodes · ${String(graph.edges.length)} edges · ${String(layout.bands.filter((b) => b.count > 0).length)} bands used · ${String(layout.nodes.filter((n) => n.external).length)} external`;
      status.textContent = `${source} — ${legend}${graph.parsed_at === undefined ? "" : ` — parsed ${graph.parsed_at}`}`;
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

mountViewer();
