import type * as D3 from "d3";
import type { Edge, Node } from "@waterslide/core";
import { layoutGraph, type Layout } from "../layout.js";

/**
 * The crude renderer — handoff §6 item 8 and the M1 brief. Runs in the
 * browser as an inline script: `d3` is a global from the inlined UMD build and
 * `layoutGraph` is inlined ahead of this file. The graph is drawn once and
 * stays put (UI §0); pan and zoom are the only interaction.
 *
 * Encoding is deliberately minimal: hue by kind group (UI §3.1), line style by
 * confidence (§3.3), red plus a marker for broken edges (§3.4), a badge count
 * on band-skipping edges (§1.5). Stage 4 makes it good.
 */
declare const d3: typeof D3;

interface GraphLike {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly repos: readonly { name: string }[];
  readonly parsed_at?: string;
}

const HUE: Record<string, string> = {
  ui_view: "#c65d9a",
  ui_handler: "#c65d9a",
  client_service: "#8a63c9",
  endpoint: "#3b7dd8",
  middleware: "#3b7dd8",
  function: "#3f9a6e",
  class: "#3f9a6e",
  service: "#3f9a6e",
  module: "#3f9a6e",
  repository: "#d0862b",
  collection: "#d0862b",
  table: "#d0862b",
  topic: "#d0862b",
  external_service: "#b04a3b",
  tombstone: "#8a8a8a",
  unknown: "#8a8a8a",
};

function dash(confidence: string): string {
  return confidence === "inferred"
    ? "7 5"
    : confidence === "annotated"
      ? "2 4"
      : "";
}

function shortLabel(n: Node): string {
  const max = 24;
  return n.label.length > max ? `${n.label.slice(0, max - 1)}…` : n.label;
}

function tooltip(n: Node): string {
  const lines = [n.id, `${n.kind} · ${n.tier} · ${n.confidence}`];
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

export function renderGraph(root: HTMLElement, graph: GraphLike): Layout {
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
    .attr("fill", "#fbf1ef");
  bands
    .append("text")
    .attr("x", layout.externalX + 12)
    .attr("y", 14)
    .attr("fill", "#7a3a30")
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
      .attr("stroke-dasharray", dash(e.confidence))
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

  // Nodes.
  const nodes = g.append("g").attr("class", "nodes");
  for (const ln of layout.nodes) {
    const n = ln.node;
    const absent = n.kind === "unknown" || n.kind === "tombstone";
    const box = nodes
      .append("g")
      .attr("transform", `translate(${String(ln.x)},${String(ln.y)})`);
    box
      .append("rect")
      .attr("width", ln.w)
      .attr("height", ln.h)
      .attr("rx", 6)
      .attr("fill", absent ? "#f4f4f4" : (HUE[n.kind] ?? "#999"))
      .attr("fill-opacity", absent ? 1 : 0.9)
      .attr("stroke", absent ? "#8a8a8a" : "#333")
      .attr("stroke-dasharray", absent ? "4 3" : "")
      .attr("stroke-width", n.is_entry_point ? 2.5 : 1);
    box
      .append("text")
      .attr("x", ln.w / 2)
      .attr("y", ln.h / 2 + 4)
      .attr("text-anchor", "middle")
      .attr("fill", absent ? "#555" : "#fff")
      .attr("font-weight", n.is_entry_point ? 700 : 400)
      .text(`${n.is_entry_point ? "▶ " : ""}${shortLabel(n)}`);
    box.append("title").text(tooltip(n));
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

/** Wires the page: draws the embedded graph and accepts a dropped or picked graph.json. */
export function mountViewer(): void {
  const stage = document.getElementById("stage");
  const status = document.getElementById("status");
  const input = document.getElementById("file") as HTMLInputElement | null;
  if (stage === null || status === null) return;

  const draw = (text: string, source: string): void => {
    try {
      const graph = JSON.parse(text) as GraphLike;
      const layout = renderGraph(stage, graph);
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
