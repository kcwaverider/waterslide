/**
 * Zoom and the semantic-level trigger — UI spec §2. Pure numbers, no DOM, so
 * they can be tested and inlined ahead of the renderer. Zoom here is the
 * scroll-wheel variable; magnification is a separate one (§2.1) and only
 * enters as a factor of the fitted node width.
 */

/**
 * §2: the zoom range as a function of how big the map is on this stage.
 * Minimum is fit-to-viewport — zooming out past the whole map buys nothing.
 * Maximum is whatever brings the mean node to a readable width, so however
 * large the graph, scrolling in always reaches the width where the level
 * trigger fires. Small maps keep a floor so they can still be inspected.
 */
export const ZOOM = {
  /** The mean node's on-screen width at maximum zoom. Above the finer trigger, with margin. */
  readableNodePx: 420,
  minMaxZoom: 8,
} as const;

export function zoomExtent(fitNodePx: number): [number, number] {
  if (!(fitNodePx > 0)) return [1, ZOOM.minMaxZoom];
  return [1, Math.max(ZOOM.minMaxZoom, ZOOM.readableNodePx / fitNodePx)];
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
