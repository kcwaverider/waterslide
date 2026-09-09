import type * as D3 from "d3";
import type { Edge, Node } from "@waterslide/core";
import { layoutGraph, LAYOUT, type Layout } from "../layout.js";
import {
  changeStateOf,
  confidenceDash,
  nodeStyle,
  type ChangeStateMap,
} from "./encoding.js";

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

export function renderGraph(
  root: HTMLElement,
  graph: GraphLike,
  changeState: ChangeStateMap = {},
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
  defs
    .append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 9)
    .attr("refY", 5)
    .attr("markerWidth", 7)
    .attr("markerHeight", 7)
    .attr("orient", "auto-start-reverse")
    .append("path")
    .attr("d", "M 0 0 L 10 5 L 0 10 z")
    .attr("fill", "#666");

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

  // Edges under nodes.
  const edges = g.append("g").attr("class", "edges");
  for (const le of layout.edges) {
    const e = le.edge;
    edges
      .append("path")
      .attr("d", le.d)
      .attr("fill", "none")
      .attr("stroke", e.is_broken ? "#c62828" : "#666")
      .attr("stroke-width", e.is_broken ? 2 : 1.4)
      .attr("stroke-dasharray", confidenceDash(e.confidence))
      .attr("marker-end", "url(#arrow)")
      .append("title")
      .text(edgeTooltip(e));
    if (e.skips_tiers.length > 0 || e.is_broken) {
      const badge = edges
        .append("g")
        .attr("transform", `translate(${String(le.mx)},${String(le.my)})`);
      badge
        .append("circle")
        .attr("r", 8)
        .attr("fill", e.is_broken ? "#c62828" : "#f0b429")
        .attr("stroke", "#fff");
      badge
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", 4)
        .attr("font-size", 10)
        .attr("fill", "#fff")
        .text(e.is_broken ? "!" : String(e.skips_tiers.length));
      badge.append("title").text(edgeTooltip(e));
    }
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
      .attr("transform", `translate(${String(ln.x)},${String(ln.y)})`);
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

  // Pan and zoom. Zoom here is magnification of the drawn picture only; the
  // semantic zoom of UI §2 is Stage 4's.
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 6])
    .on("zoom", (event: D3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      g.attr("transform", event.transform.toString());
    });
  svg.call(zoom);

  return layout;
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
  const draw = (text: string, source: string): void => {
    try {
      const graph = JSON.parse(text) as GraphLike;
      const layout = renderGraph(stage, graph, changeState);
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
