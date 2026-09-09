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
  #bar { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #ddd; }
  #bar h1 { font-size: 14px; margin: 0; }
  #status { color: #555; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #stage { position: absolute; top: 37px; bottom: 0; left: 0; right: 0; }
  #stage svg { display: block; width: 100%; height: 100%; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: #555; }
  .legend span::before { content: ""; display: inline-block; width: 26px; border-top: 2px solid #666; margin-right: 4px; vertical-align: middle; }
  .legend .inferred::before { border-top-style: dashed; }
  .legend .annotated::before { border-top-style: dotted; }
  .node.selected > rect:first-of-type { stroke: #111; stroke-width: 3; }
  .edge.selected > path:first-of-type { stroke-width: 3.5; }
  #panel { position: absolute; top: 49px; right: 12px; bottom: 12px; width: 360px; overflow: auto; background: #fff; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.12); padding: 12px 14px; box-sizing: border-box; }
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
  <div class="legend"><span>certain</span><span class="inferred">inferred</span><span class="annotated">annotated</span></div>
  <label>open <input id="file" type="file" accept=".json,application/json"></label>
</div>
<div id="stage"></div>
<aside id="panel" hidden></aside>
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
