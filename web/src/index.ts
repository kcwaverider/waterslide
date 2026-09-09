import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import type { ChangeStateMap } from "./browser/encoding.js";

/**
 * Node-side half of the viewer: builds one self-contained HTML page with D3,
 * the layout and renderer, and the graph inlined. No server, no bundler. The
 * page works from a file:// URL and also accepts a dropped graph.json.
 */

export {
  BAND_ORDER,
  LAYOUT,
  MAX_LINE_CHARS,
  layoutGraph,
  nodeSize,
  wrapLabel,
} from "./layout.js";
export type { Layout, LayoutBand, LayoutEdge, LayoutNode } from "./layout.js";
export {
  KIND_GROUP,
  GROUP_HUE,
  changeStateOf,
  confidenceDash,
  moreSignificant,
  nodeStyle,
} from "./browser/encoding.js";
export type {
  ChangeState,
  ChangeStateMap,
  KindGroup,
  NodeStyle,
} from "./browser/encoding.js";
export {
  describeEdge,
  describeNode,
  expandSchema,
  formatLocation,
} from "./browser/panel.js";
export { zoomExtent, ZOOM, LEVEL_TRIGGER } from "./browser/zoom.js";
export type {
  PanelField,
  PanelModel,
  PanelSchema,
  PanelSchemaField,
} from "./browser/panel.js";
export {
  inheritedStates,
  offscreenIndicators,
  sideOf,
} from "./browser/offscreen.js";
export type {
  Box,
  OffscreenIndicator,
  Side,
  Viewport,
} from "./browser/offscreen.js";
export {
  ENTRY_POINT_KIND_ORDER,
  HOP_DURATION,
  blastRadius,
  chosenAlternatives,
  defaultAlternative,
  entryPointGroups,
  isActiveBranch,
  planPlayback,
} from "./browser/flow.js";
export type {
  BlastRadius,
  EntryPointGroup,
  Generation,
  Hop,
} from "./browser/flow.js";
export {
  aggregateGraph,
  depthOf,
  hideUnresolved,
  levelsOf,
} from "./browser/aggregate.js";
export type {
  AggregatedGraph,
  FilteredGraph,
  Level,
} from "./browser/aggregate.js";

const require = createRequire(import.meta.url);

/**
 * The browser modules are compiled as ES modules but inlined as one classic
 * script, so their module syntax is removed: `import` statements vanish (types
 * and the sibling modules, all satisfied by inlining) and the `export` keyword
 * is stripped from declarations. The files are written to make that
 * transformation safe: no runtime imports besides sibling browser modules, no
 * default exports, no re-exports. An import statement may span lines, so it
 * is matched as a statement — nothing inside one contains a semicolon.
 */
export function stripModuleSyntax(source: string): string {
  return source
    .replace(/^import\b[^;]*;[ \t]*\n?/gm, "")
    .replace(/^export \{[^;]*;[ \t]*\n?/gm, "")
    .replace(/^export (const|function|interface|type|class|let) /gm, "$1 ");
}

/**
 * The compiled browser modules live beside this file in dist/. When this file
 * itself runs from src/ (vitest), fall back to the package's dist/, which
 * `npm test` has built.
 */
function readBrowserModule(rel: string): string {
  const candidates = [
    new URL(rel, import.meta.url),
    new URL(`../dist/src/${rel}`, import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) return stripModuleSyntax(readFileSync(url, "utf8"));
  }
  throw new Error(
    `viewer module ${rel} not built; run \`tsc -b\` (looked in ${candidates.map((u) => u.pathname).join(", ")})`,
  );
}

export interface ViewerOptions {
  readonly title?: string;
  /**
   * Node id → change state, the M3 seam. `graph.json` never carries change
   * state (graph model §9); it is computed against `baseline.json` and handed
   * to the viewer here. Omitted, or missing an id, means `unchanged`
   * (persisted-files §1.5, the no-baseline rule).
   */
  readonly changeState?: ChangeStateMap;
}

/** Builds the viewer page around `graphJson` (may be empty: the page then waits for a dropped file). */
export function buildViewerHtml(
  graphJson: string,
  options: ViewerOptions = {},
): string {
  // d3's exports map hides dist/ behind a "umd" condition, so walk from the
  // resolved entry (src/index.js) to the package root instead.
  const d3Root = nodePath.dirname(nodePath.dirname(require.resolve("d3")));
  const d3 = readFileSync(nodePath.join(d3Root, "dist", "d3.min.js"), "utf8");
  // Inlined in dependency order: each module may use only what precedes it.
  const modules = [
    "./layout.js",
    "./browser/encoding.js",
    "./browser/panel.js",
    "./browser/offscreen.js",
    "./browser/flow.js",
    "./browser/animation.js",
    "./browser/aggregate.js",
    "./browser/zoom.js",
    "./browser/render.js",
  ].map(readBrowserModule);
  const title = options.title ?? "waterslide";
  // The HTML parser ends a script element at `</script` and honours `<!--`
  // inside script data; `\u003c` is a valid JSON escape, so neutralise every `<`.
  const safeJson = graphJson.replace(/</g, "\\u003c");
  const safeChangeState = JSON.stringify(options.changeState ?? {}).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; font: 13px system-ui, sans-serif; background: #fff; color: #222; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  #main { flex: 1; position: relative; display: flex; min-height: 0; }
  #bar { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #eee; }
  #bar2 { display: flex; gap: 16px; align-items: center; padding: 5px 12px; border-bottom: 1px solid #ddd; background: #fafafa; flex-wrap: wrap; }
  #bar h1 { font-size: 14px; margin: 0; }
  #status { color: #555; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sidebar { flex: 0 0 232px; overflow: auto; border-right: 1px solid #ddd; background: #fafafa; padding: 8px; box-sizing: border-box; }
  #sidebar h3 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: #777; margin: 12px 4px 4px; }
  #sidebar .entry { display: block; width: 100%; text-align: left; border: none; background: none; padding: 6px 8px; border-radius: 6px; font: inherit; cursor: pointer; color: #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sidebar .entry::before { content: "▶ "; color: #999; }
  #sidebar .entry.whole::before { content: "▦ "; }
  #sidebar .entry:hover { background: #eee; }
  #sidebar .entry.active { background: #1d1d1f; color: #fff; }
  #sidebar .entry.active::before { color: #ccc; }
  #sidebar .sidebar-empty { padding: 8px; }
  #controls { display: flex; gap: 6px; align-items: center; }
  #controls button, #controls select { font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
  #controls button:disabled { color: #aaa; cursor: default; }
  #controls label { font-size: 12px; color: #555; display: flex; align-items: center; gap: 3px; }
  #hide-unresolved-label { font-weight: 600; color: #333; }
  #stage { flex: 1; position: relative; min-width: 0; }
  /* Flow mode (§5.2): outside the blast radius dims; nothing is hidden. */
  svg.flow .node.dim, svg.flow .edge.dim, svg.flow .badge-holder.dim { opacity: .18; }
  /* §7.5: the untravelled side of a fork is drawn, dimmed. */
  .edge.inactive-branch, .badge-holder.inactive-branch { opacity: .3; }
  .edge.dim.inactive-branch { opacity: .12; }
  /* §0: while objects travel, the edges they travel stand out. */
  .edge.travelled > path:first-of-type { stroke-width: 2.6; stroke: #1d1d1f; }
  .edge.travelled.broken > path:first-of-type { stroke: hsl(0 72% 42%); }
  .node.visited > rect:first-of-type { stroke-width: 2.4; stroke: #1d1d1f; }
  .object { transition: opacity .2s; }
  #zoom-label { position: absolute; left: 50%; top: 24px; transform: translateX(-50%); background: rgba(29,29,31,.88); color: #fff; padding: 6px 14px; border-radius: 16px; font-size: 13px; pointer-events: none; opacity: 0; }
  #zoom-label.show { animation: zoom-label 1.6s ease-out forwards; }
  @keyframes zoom-label { 0% { opacity: 0; transform: translate(-50%, -6px); } 15% { opacity: 1; transform: translate(-50%, 0); } 80% { opacity: 1; } 100% { opacity: 0; } }
  #stage svg { display: block; width: 100%; height: 100%; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: #555; align-items: center; flex-wrap: wrap; }
  .legend .line::before { content: ""; display: inline-block; width: 22px; border-top: 2px solid #666; margin-right: 4px; vertical-align: middle; }
  .legend .inferred::before { border-top-style: dashed; }
  .legend .annotated::before { border-top-style: dotted; }
  .legend .sep { color: #bbb; }
  .legend .swatch::before { content: ""; display: inline-block; width: 14px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; box-sizing: border-box; }
  .legend .unchanged::before { background: hsl(212 55% 91%); border: 1px solid hsl(212 40% 58%); }
  .legend .modified::before { background: hsl(212 62% 44%); border: 1px solid hsl(212 65% 26%); }
  .legend .new::before { background: hsl(212 62% 44%); border: 1px solid hsl(212 65% 26%); box-shadow: inset 0 0 0 1.5px hsl(212 62% 44%), inset 0 0 0 2.5px #fff; }
  .legend .absent::before { background: #f1f1f1; border: 1px dashed #8a8a8a; }
  .legend .broken-mark { color: hsl(0 72% 42%); font-weight: 700; }
  .legend .skips-mark { background: #f2c14e; color: #3a2a00; border-radius: 8px; padding: 0 6px; font-size: 10px; font-weight: 600; }
  .node.selected > rect:first-of-type { stroke: #111; stroke-width: 3; }
  .edge.selected > path:first-of-type { stroke-width: 3.5; }
  #panel { position: absolute; top: 12px; right: 12px; bottom: 12px; width: 360px; overflow: auto; background: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.12); padding: 12px 14px; box-sizing: border-box; }
  .panel-head { display: flex; align-items: flex-start; gap: 8px; }
  .panel-title { font-size: 15px; margin: 0; flex: 1; overflow-wrap: anywhere; }
  .panel-close { border: none; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #666; padding: 0 2px; }
  .panel-subtitle { color: #666; margin: 2px 0 10px; }
  .panel-fields { display: grid; grid-template-columns: max-content 1fr; gap: 5px 10px; margin: 0; }
  .panel-fields dt { color: #666; }
  .panel-fields dd { margin: 0; overflow-wrap: anywhere; }
  .panel-fields dd.reason, .panel-schema .reason { background: #fff7d6; border-left: 3px solid #e0b323; padding: 4px 8px; font-style: italic; }
  .panel-fields dd.broken { color: hsl(0 72% 42%); font-weight: 600; }
  .panel-fields dd.broken::before { content: "⚠ "; }
  .muted { color: #777; font-size: 12px; }
  .panel-schema { margin-top: 12px; padding-top: 8px; border-top: 1px solid #e5e5e5; }
  .panel-schema.nested { margin: 4px 0 4px 12px; padding: 4px 0 0 8px; border-top: none; border-left: 2px solid #e5e5e5; }
  .schema-head { display: flex; gap: 8px; align-items: baseline; }
  .schema-role { text-transform: uppercase; font-size: 10px; letter-spacing: .05em; color: #666; }
  .schema-name { font-weight: 600; }
  .schema-fields { list-style: none; margin: 6px 0 0; padding: 0; }
  .schema-fields li { padding: 2px 0; }
  .field-name { font-weight: 500; }
  .field-type { color: #555; margin-left: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
  .field-class { margin-left: 6px; font-size: 10.5px; background: #eef; color: #335; border-radius: 4px; padding: 0 5px; }
  .panel-address { margin-top: 14px; padding-top: 8px; border-top: 1px solid #e5e5e5; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #888; overflow-wrap: anywhere; }
</style>
</head>
<body>
<div id="bar">
  <h1>waterslide</h1>
  <div id="status"></div>
  <label>open <input id="file" type="file" accept=".json,application/json"></label>
</div>
<div id="bar2">
  <div id="controls">
    <button id="play" type="button" disabled>▶ play</button>
    <button id="step" type="button" disabled title="advance one hop">step ⏵</button>
    <button id="replay" type="button" disabled title="play again from the entry point">↺</button>
    <label><input id="loop" type="checkbox"> loop</label>
    <label>speed <select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
    <span class="sep">|</span>
    <label title="Semantic level. Scrolling changes it too; this is the same control by hand.">detail <select id="zoom-level"></select></label>
    <label title="Magnification: base text and node size. A preference, remembered; it does not change the level on its own.">size <select id="magnification"><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
    <span class="sep">|</span>
    <label id="hide-unresolved-label" title="Unresolved references stay in the graph; this only leaves them off the map."><input id="hide-unresolved" type="checkbox" checked> <span id="hide-unresolved-count">unresolved hidden</span></label>
  </div>
  <div class="legend" title="Hue is the node's kind. Saturation is change state since your last baseline. Line style is confidence. Red with a warning icon is a broken edge.">
    <span class="line">certain</span><span class="line inferred">inferred</span><span class="line annotated">annotated</span>
    <span class="sep">|</span>
    <span class="swatch unchanged">unchanged</span><span class="swatch modified">modified</span><span class="swatch new">new</span><span class="swatch absent">missing</span>
    <span class="sep">|</span>
    <span><span class="broken-mark">▲!</span> broken</span><span><span class="skips-mark">skips N</span> bands bypassed</span>
  </div>
</div>
<div id="main">
<nav id="sidebar"></nav>
<div id="stage"></div>
<div id="zoom-label" hidden></div>
<aside id="panel" hidden></aside>
</div>
<script id="graph" type="application/json">${safeJson}</script>
<script id="change-state" type="application/json">${safeChangeState}</script>
<script>${d3}</script>
<script>
${modules.join("\n")}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
