import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph } from "@waterslide/core";
import { BAND_ORDER, layoutGraph } from "../src/layout.js";
import { buildViewerHtml, stripModuleSyntax } from "../src/index.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const fixtures = readdirSync(validDir).filter((f) => f.endsWith(".json"));
const load = (f: string): CanonicalGraph =>
  JSON.parse(readFileSync(new URL(f, validDir), "utf8")) as CanonicalGraph;

describe("layered layout (UI §1)", () => {
  for (const f of fixtures) {
    it(`${f}: bands top to bottom, external in a column, every node and edge placed`, () => {
      const g = load(f);
      const layout = layoutGraph(g);
      expect(layout.bands.map((b) => b.tier)).toEqual([...BAND_ORDER]);
      for (let i = 1; i < layout.bands.length; i++) {
        expect((layout.bands[i] as { y: number }).y).toBeGreaterThan(
          (layout.bands[i - 1] as { y: number }).y,
        );
      }
      expect(layout.nodes).toHaveLength(g.nodes.length);
      expect(layout.edges).toHaveLength(g.edges.length);
      for (const ln of layout.nodes) {
        if (ln.node.tier === "external") {
          expect(ln.external).toBe(true);
          expect(ln.x).toBeGreaterThanOrEqual(layout.externalX);
        } else {
          expect(ln.external).toBe(false);
          const band = layout.bands[BAND_ORDER.indexOf(ln.node.tier)];
          expect(band).toBeDefined();
          if (band !== undefined) {
            expect(ln.y).toBeGreaterThanOrEqual(band.y);
            expect(ln.y + ln.h).toBeLessThanOrEqual(band.y + band.h);
          }
        }
      }
      // No two nodes overlap.
      for (const a of layout.nodes)
        for (const b of layout.nodes) {
          if (a === b) continue;
          const apart =
            a.x + a.w <= b.x ||
            b.x + b.w <= a.x ||
            a.y + a.h <= b.y ||
            b.y + b.h <= a.y;
          expect(apart, `${a.node.id} overlaps ${b.node.id}`).toBe(true);
        }
    });
  }

  it("is deterministic under shuffled input order", () => {
    const g = load("derived-ids.json");
    const a = JSON.stringify(layoutGraph(g));
    const b = JSON.stringify(
      layoutGraph({
        nodes: [...g.nodes].reverse(),
        edges: [...g.edges].reverse(),
      }),
    );
    expect(b).toBe(a);
  });

  it("orders a band by barycenter: a node's children sit under it", () => {
    const g = load("derived-ids.json");
    const layout = layoutGraph(g);
    const x = (id: string): number =>
      layout.nodes.find((n) => n.node.id === id)?.x ?? Number.NaN;
    // The endpoint calls NoteService.update, which calls NoteRepository.save: a vertical chain.
    const route = x("tapistree:api/routers/notes.py#update_note");
    const svc = x("tapistree:api/services/note_service.py#NoteService.update");
    expect(Math.abs(route - svc)).toBeLessThan(400);
  });
});

describe("viewer page", () => {
  it("inlines d3, the layout, the renderer and the graph, with no module syntax left", () => {
    const html = buildViewerHtml(
      readFileSync(new URL("derived-ids.json", validDir), "utf8"),
    );
    expect(html).toContain('<script id="graph" type="application/json">');
    expect(html).toContain("tapistree:api/routers/notes.py#update_note");
    expect(html).toContain("function layoutGraph(");
    expect(html).toContain("function renderGraph(");
    expect(html).toContain("mountViewer();");
    expect(html).toMatch(/d3.*v7/);
    expect(html).not.toMatch(/^import\s/m);
    expect(html).not.toMatch(/^export\s/m);
    expect(html).not.toContain("</script>\n</script>");
  });

  it("escapes every '<' in the embedded JSON, so no label can end the script element", () => {
    const html = buildViewerHtml(
      JSON.stringify({ nodes: [], edges: [], repos: [], label: "<!-- <b>" }),
    );
    const embedded = html.slice(
      html.indexOf('<script id="graph"'),
      html.indexOf("</script>", html.indexOf('<script id="graph"')),
    );
    expect(embedded.slice(embedded.indexOf(">") + 1)).not.toContain("<");
    expect(JSON.parse(embedded.slice(embedded.indexOf(">") + 1))).toMatchObject(
      {
        label: "<!-- <b>",
      },
    );
  });

  it("escapes a closing script tag inside the graph JSON", () => {
    const html = buildViewerHtml(
      JSON.stringify({
        nodes: [],
        edges: [],
        repos: [],
        label: "</script><b>",
      }),
    );
    expect(html).not.toContain("</script><b>");
  });

  it("stripModuleSyntax removes only module syntax", () => {
    expect(
      stripModuleSyntax(
        'import type { A } from "x";\nexport function f() {}\nexport const k = 1;\nconst z = "import x";\n',
      ),
    ).toBe('function f() {}\nconst k = 1;\nconst z = "import x";\n');
  });
});
