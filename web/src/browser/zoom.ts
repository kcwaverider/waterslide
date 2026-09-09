/**
 * Zoom and the semantic-level trigger — UI spec §2. Pure numbers, no DOM, so
 * they can be tested and inlined ahead of the renderer. Zoom here is the
 * scroll-wheel variable; magnification is a separate one (§2.1) and only
 * enters as a factor of the fitted node width.
 */

/**
 * §2: the zoom range as a function of how big the map is on this stage.
 * Minimum is fit-to-viewport — zooming out past the whole map buys nothing —
 * except when a coarser level exists: then it goes just far enough below fit
 * to bring the mean node under the coarser trigger, so scrolling out can
 * reach the next level on a small graph too, and no further. Zoom is the only
 * control that changes semantic level (§2.2), and it must do so on a graph of
 * any size or the reader learns the wrong thing about it.
 * Maximum is whatever brings the mean node to a readable width, so however
 * large the graph, scrolling in always reaches the width where the finer
 * trigger fires. Small maps keep a floor so they can still be inspected.
 */
export const ZOOM = {
  /** The mean node's on-screen width at maximum zoom. Above the finer trigger, with margin. */
  readableNodePx: 420,
  minMaxZoom: 8,
  /** Below fit, the mean node is brought to this fraction of the coarser trigger: under it, with margin. */
  coarsenMargin: 0.9,
} as const;

export function zoomExtent(
  fitNodePx: number,
  hasCoarserLevel = false,
): [number, number] {
  if (!(fitNodePx > 0)) return [1, ZOOM.minMaxZoom];
  const min = hasCoarserLevel
    ? Math.min(
        1,
        (LEVEL_TRIGGER.coarserBelowPx * ZOOM.coarsenMargin) / fitNodePx,
      )
    : 1;
  return [min, Math.max(ZOOM.minMaxZoom, ZOOM.readableNodePx / fitNodePx)];
}

/**
 * §2.2 trigger: step to the next level when the average on-screen node is
 * wider than this many CSS pixels, back when narrower than the lower bound.
 * Two thresholds, well apart, are the hysteresis that stops flicker.
 */
export const LEVEL_TRIGGER = {
  finerAbovePx: 270,
  coarserBelowPx: 95,
  /**
   * Where a level change lands the mean node: inside the hysteresis band, so
   * the picture settles rather than cascading through every level. Zooming in
   * grows modules to 270px and they break into functions at 160px; zooming
   * out shrinks functions to 95px and they fold into modules at 160px.
   */
  settlePx: 160,
} as const;
