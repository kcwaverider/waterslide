import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";

/**
 * Node-side half of the viewer: builds one self-contained HTML page with D3,
 * the layout and renderer, and the graph inlined. No server, no bundler. The
 * page works from a file:// URL and also accepts a dropped graph.json.
 */

export { BAND_ORDER, LAYOUT, layoutGraph } from "./layout.js";
export type { Layout, LayoutBand, LayoutEdge, LayoutNode } from "./layout.js";

const require = createRequire(import.meta.url);

/**
 * The two browser modules are compiled as ES modules but inlined as one
 * classic script, so their module syntax is removed: `import` lines vanish
 * (types and the layout import, both satisfied by inlining) and the `export`
 * keyword is stripped from declarations. Both files are written to make that
 * transformation safe: no runtime imports besides `./layout.js`, no default
 * exports, no re-exports.
 */
export function stripModuleSyntax(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^import\s/.test(line) && !/^export \{/.test(line))
    .map((line) =>
      line.replace(/^export (const|function|interface|type|class|let) /, "$1 "),
    )
    .join("\n");
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
  const layout = readBrowserModule("./layout.js");
  const render = readBrowserModule("./browser/render.js");
  const title = options.title ?? "waterslide";
  // `</script` inside JSON would end the element early; escape the slash.
  const safeJson = graphJson.replace(/<\//g, "<\\/");
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
<script id="graph" type="application/json">${safeJson}</script>
<script>${d3}</script>
<script>
${layout}
${render}
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
