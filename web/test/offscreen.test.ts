import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph } from "@waterslide/core";
import { layoutGraph } from "../src/layout.js";
import {
  inheritedStates,
  offscreenIndicators,
  sideOf,
  type Box,
} from "../src/browser/offscreen.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const load = (f: string): CanonicalGraph =>
  JSON.parse(readFileSync(new URL(f, validDir), "utf8")) as CanonicalGraph;

const view = { x0: 0, y0: 0, x1: 100, y1: 100 };
const box = (id: string, x: number, y: number): Box => ({
  id,
  x,
  y,
  w: 10,
  h: 10,
});

describe("offscreen indicators (UI §4)", () => {
  it("classifies wholly offscreen boxes by side; a partly visible box counts as visible", () => {
    expect(sideOf(box("a", -50, 40), view)).toBe("left");
    expect(sideOf(box("b", 150, 40), view)).toBe("right");
    expect(sideOf(box("c", 40, -50), view)).toBe("top");
    expect(sideOf(box("d", 40, 150), view)).toBe("bottom");
    expect(sideOf(box("e", 95, 95), view)).toBeNull();
    expect(sideOf(box("f", 40, 40), view)).toBeNull();
    // Off both axes: the horizontal side wins, so the arrow points where panning helps most.
    expect(sideOf(box("g", -50, -50), view)).toBe("left");
  });

  it("counts shallow and colours deep: count per side, most significant state wins", () => {
    const inherited = new Map([
      ["a", "unchanged" as const],
      ["b", "new" as const],
      ["c", "modified" as const],
    ]);
    const out = offscreenIndicators(
      [
        box("a", -50, 10),
        box("b", -50, 60),
        box("c", 200, 10),
        box("v", 10, 10),
      ],
      view,
      inherited,
    );
    expect(out).toEqual([
      { side: "right", count: 1, state: "modified" },
      { side: "left", count: 2, state: "new" },
    ]);
  });

  it("nothing offscreen, no indicators", () => {
    expect(offscreenIndicators([box("v", 10, 10)], view, new Map())).toEqual(
      [],
    );
  });

  it("inherits change state up the parent chain with new > modified > unchanged", () => {
    const g = load("single-repo-minimal.json");
    const fn = "ledger:app/routes.py#list_entries";
    const module = "ledger:app/routes.py";
    const service = "svc:ledger-api";
    const states = inheritedStates(g.nodes, { [fn]: "new" });
    expect(states.get(fn)).toBe("new");
    expect(states.get(module)).toBe("new");
    expect(states.get(service)).toBe("new");
    expect(states.get("ledger:app/queries.py")).toBe("unchanged");
    const mixed = inheritedStates(g.nodes, {
      [fn]: "modified",
      "ledger:app/queries.py#load_entries": "new",
    });
    expect(mixed.get(module)).toBe("modified");
    expect(mixed.get(service)).toBe("new");
  });

  it("does not hang on a malformed parent cycle", () => {
    const states = inheritedStates(
      [
        { id: "a", parent: "b" },
        { id: "b", parent: "a" },
      ],
      { a: "new" },
    );
    expect(states.get("b")).toBe("new");
  });

  it("every node is offscreen when the viewport is elsewhere; none when it covers the layout", () => {
    const layout = layoutGraph(load("band-skip.json"));
    const boxes = layout.nodes.map((ln) => ({
      id: ln.node.id,
      x: ln.x,
      y: ln.y,
      w: ln.w,
      h: ln.h,
    }));
    const whole = { x0: 0, y0: 0, x1: layout.width, y1: layout.height };
    expect(offscreenIndicators(boxes, whole, new Map())).toEqual([]);
    const far = { x0: -2000, y0: -2000, x1: -1900, y1: -1900 };
    const out = offscreenIndicators(boxes, far, new Map());
    expect(out.reduce((s, i) => s + i.count, 0)).toBe(boxes.length);
  });
});
