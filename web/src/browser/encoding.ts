import type { Confidence, NodeKind } from "@waterslide/core";

/**
 * Visual encoding — UI spec §3. One property per channel, and the channels
 * never collide:
 *
 *   hue         node `kind`, by the seven groups of §3.1
 *   saturation  change state (§3.2): pastel unchanged, vivid modified
 *   outline     double outline for `new`; dashed only for the Absence group
 *   line style  edge confidence (§3.3) and nothing else
 *
 * Pure: no DOM, no D3, so it is unit-testable and it is inlined into the
 * viewer page ahead of the renderer. No runtime imports.
 */

/** Persisted-files §1.5. Derived against `baseline.json`, never stored in the graph. */
export type ChangeState = "unchanged" | "modified" | "new" | "removed";

/**
 * Node id → change state. The renderer's seam for M3: `graph.json` cannot
 * carry change state (graph model §9), so the viewer takes it alongside the
 * graph. Absent ids are `unchanged`, which is also the whole-graph rule when
 * no baseline exists.
 */
export type ChangeStateMap = Readonly<Record<string, ChangeState>>;

export function changeStateOf(map: ChangeStateMap, id: string): ChangeState {
  return map[id] ?? "unchanged";
}

/** §4: the most significant state wins when a state is inherited. */
export const CHANGE_STATE_RANK: Readonly<Record<ChangeState, number>> = {
  unchanged: 0,
  removed: 1,
  modified: 2,
  new: 3,
};

export function moreSignificant(a: ChangeState, b: ChangeState): ChangeState {
  return CHANGE_STATE_RANK[b] > CHANGE_STATE_RANK[a] ? b : a;
}

export type KindGroup =
  | "presentation"
  | "client_logic"
  | "interface"
  | "logic"
  | "data"
  | "boundary"
  | "absence";

/** §3.1 — every kind in exactly one group. */
export const KIND_GROUP: Readonly<Record<NodeKind, KindGroup>> = {
  ui_view: "presentation",
  ui_handler: "presentation",
  client_service: "client_logic",
  endpoint: "interface",
  middleware: "interface",
  function: "logic",
  class: "logic",
  service: "logic",
  module: "logic",
  repository: "data",
  collection: "data",
  table: "data",
  topic: "data",
  external_service: "boundary",
  tombstone: "absence",
  unknown: "absence",
};

export const GROUP_LABEL: Readonly<Record<KindGroup, string>> = {
  presentation: "Presentation",
  client_logic: "Client logic",
  interface: "Interface",
  logic: "Logic",
  data: "Data",
  boundary: "Boundary",
  absence: "Absence",
};

/**
 * Hue angle per group. Red is deliberately absent: red belongs to `is_broken`
 * (§3.4) and no kind may borrow it. Absence has no hue at all.
 */
export const GROUP_HUE: Readonly<Record<KindGroup, number | null>> = {
  presentation: 330,
  client_logic: 268,
  interface: 212,
  logic: 148,
  data: 36,
  boundary: 184,
  absence: null,
};

/** The one red on the map. */
export const BROKEN_RED = "hsl(0 72% 42%)";

export interface NodeStyle {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  /** Non-empty only for the Absence group (§3.1). Never used for anything else on a node. */
  readonly strokeDash: string;
  /** §3.2: `new` draws a second outline inside the first. */
  readonly doubleOutline: boolean;
  readonly text: string;
  readonly group: KindGroup;
  readonly state: ChangeState;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${String(h)} ${String(s)}% ${String(l)}%)`;
}

/**
 * §3.1 + §3.2 combined. Saturation and lightness move together so vivid and
 * pastel remain distinguishable in a greyscale screenshot, even though change
 * state is accepted as a colour-only channel (D2).
 */
export function nodeStyle(kind: NodeKind, state: ChangeState): NodeStyle {
  const group = KIND_GROUP[kind];
  const h = GROUP_HUE[group];
  const vivid = state === "modified" || state === "new";
  const base = {
    group,
    state,
    doubleOutline: state === "new",
    strokeDash: group === "absence" ? "4 3" : "",
    strokeWidth: 1.2,
  };
  if (h === null) {
    if (state === "removed")
      return { ...base, fill: "none", stroke: "#a3a3a3", text: "#8a8a8a" };
    return vivid
      ? { ...base, fill: "#8d8d8d", stroke: "#4a4a4a", text: "#ffffff" }
      : { ...base, fill: "#f1f1f1", stroke: "#8a8a8a", text: "#4a4a4a" };
  }
  if (state === "removed")
    return {
      ...base,
      fill: "none",
      stroke: hsl(h, 40, 62),
      text: hsl(h, 30, 45),
    };
  return vivid
    ? {
        ...base,
        fill: hsl(h, 62, 44),
        stroke: hsl(h, 65, 26),
        text: "#ffffff",
      }
    : {
        ...base,
        fill: hsl(h, 55, 91),
        stroke: hsl(h, 40, 58),
        text: "#1d1d1f",
      };
}

/** §3.3 — line style is confidence and nothing else. */
export function confidenceDash(confidence: Confidence): string {
  switch (confidence) {
    case "certain":
      return "";
    case "inferred":
      return "7 5";
    case "annotated":
      return "2 4";
  }
}
