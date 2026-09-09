import { describe, expect, it } from "vitest";
import { LEVEL_TRIGGER, ZOOM, zoomExtent } from "../src/browser/zoom.js";

describe("zoom extent (UI §2)", () => {
  it("minimum is fit-to-viewport when there is nothing coarser to reach", () => {
    for (const fit of [0.5, 5, 50, 500]) expect(zoomExtent(fit)[0]).toBe(1);
    for (const fit of [0.5, 5, 50, 500])
      expect(zoomExtent(fit, false)[0]).toBe(1);
  });

  it("with a coarser level, the minimum drops just far enough for the coarser trigger to fire, and no further", () => {
    for (const fit of [133, 144, 300]) {
      const [kMin] = zoomExtent(fit, true);
      expect(kMin).toBeLessThan(1);
      expect(fit * kMin).toBeLessThan(LEVEL_TRIGGER.coarserBelowPx);
      expect(fit * kMin).toBeGreaterThan(LEVEL_TRIGGER.coarserBelowPx * 0.8);
    }
    // A big map already sits under the trigger at fit: nothing to gain below fit.
    expect(zoomExtent(5.8, true)[0]).toBe(1);
    expect(zoomExtent(50, true)[0]).toBe(1);
  });

  it("maximum always brings the mean node to a readable width, however big the graph", () => {
    for (const fit of [0.4, 1.7, 5.3, 43, 136]) {
      const [, kMax] = zoomExtent(fit);
      expect(fit * kMax).toBeGreaterThanOrEqual(ZOOM.readableNodePx);
      // Readable is past the finer trigger, so scrolling in can always step a level.
      expect(fit * kMax).toBeGreaterThan(LEVEL_TRIGGER.finerAbovePx);
    }
  });

  it("keeps a floor for small maps so they can still be inspected", () => {
    expect(zoomExtent(136)[1]).toBe(ZOOM.minMaxZoom);
    expect(zoomExtent(0)).toEqual([1, ZOOM.minMaxZoom]);
  });

  it("settles a level change inside the hysteresis band", () => {
    expect(LEVEL_TRIGGER.settlePx).toBeGreaterThan(
      LEVEL_TRIGGER.coarserBelowPx,
    );
    expect(LEVEL_TRIGGER.settlePx).toBeLessThan(LEVEL_TRIGGER.finerAbovePx);
  });
});
