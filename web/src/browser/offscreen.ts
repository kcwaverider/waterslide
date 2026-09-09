import type { Node } from "@waterslide/core";
import {
  changeStateOf,
  moreSignificant,
  type ChangeState,
  type ChangeStateMap,
} from "./encoding.js";

/**
 * Offscreen indicators — UI spec §4. When panning or magnification puts nodes
 * off screen, an arrow at that edge of the viewport says how many, and its
 * colour carries the most significant change state among them.
 *
 * The asymmetry is deliberate: the count is shallow, nodes at the current
 * semantic level only, while the colour is deep, inherited from every nested
 * descendant. Without semantic zoom (M4) there is one level, so the count is
 * every offscreen node; the inheritance is real today, because the parent
 * tree is in the graph.
 *
 * Pure, no DOM, inlined ahead of the renderer. No runtime imports beyond the
 * encoding module.
 */

export type Side = "top" | "right" | "bottom" | "left";

export interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The visible region, in layout coordinates. */
export interface Viewport {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface OffscreenIndicator {
  readonly side: Side;
  /** Shallow: offscreen nodes on this side. */
  readonly count: number;
  /** Deep: the most significant inherited change state among them, new > modified > unchanged. */
  readonly state: ChangeState;
}

/**
 * Each node's change state inherited from its descendants through `parent`
 * (graph model §2.3): the most significant of its own and every descendant's.
 * The parent chain is a tree by invariant, so a single pass up each chain
 * suffices; a malformed cycle is cut by a visited set rather than hanging.
 */
export function inheritedStates(
  nodes: readonly Pick<Node, "id" | "parent">[],
  changeState: ChangeStateMap,
): ReadonlyMap<string, ChangeState> {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent] as const));
  const result = new Map<string, ChangeState>();
  for (const n of nodes) result.set(n.id, changeStateOf(changeState, n.id));
  for (const n of nodes) {
    const own = changeStateOf(changeState, n.id);
    const seen = new Set<string>([n.id]);
    let up = parentOf.get(n.id) ?? null;
    while (up !== null && !seen.has(up)) {
      seen.add(up);
      result.set(up, moreSignificant(result.get(up) ?? "unchanged", own));
      up = parentOf.get(up) ?? null;
    }
  }
  return result;
}

/** Which side of the viewport a wholly offscreen box has left by; null when any part is visible. */
export function sideOf(box: Box, view: Viewport): Side | null {
  const visible =
    box.x < view.x1 &&
    box.x + box.w > view.x0 &&
    box.y < view.y1 &&
    box.y + box.h > view.y0;
  if (visible) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (cx < view.x0) return "left";
  if (cx > view.x1) return "right";
  return cy < view.y0 ? "top" : "bottom";
}

export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/** One indicator per viewport side with nodes beyond it: the count, and the most significant inherited change state among them. */
export function offscreenIndicators(
  boxes: readonly Box[],
  view: Viewport,
  inherited: ReadonlyMap<string, ChangeState>,
): OffscreenIndicator[] {
  const tally = new Map<Side, { count: number; state: ChangeState }>();
  for (const box of boxes) {
    const side = sideOf(box, view);
    if (side === null) continue;
    const state = inherited.get(box.id) ?? "unchanged";
    const t = tally.get(side);
    if (t === undefined) tally.set(side, { count: 1, state });
    else {
      t.count += 1;
      t.state = moreSignificant(t.state, state);
    }
  }
  return SIDES.flatMap((side) => {
    const t = tally.get(side);
    return t === undefined ? [] : [{ side, count: t.count, state: t.state }];
  });
}
