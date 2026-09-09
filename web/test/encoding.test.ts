import { describe, expect, it } from "vitest";
import { NodeKindSchema, type NodeKind } from "@waterslide/core";
import {
  BROKEN_RED,
  GROUP_HUE,
  KIND_GROUP,
  changeStateOf,
  confidenceDash,
  moreSignificant,
  nodeStyle,
  type ChangeState,
} from "../src/browser/encoding.js";

const kinds = NodeKindSchema.options;
const states: ChangeState[] = ["unchanged", "modified", "new", "removed"];

describe("visual encoding (UI §3)", () => {
  it("places every node kind in exactly one of the seven hue groups (§3.1)", () => {
    for (const k of kinds) expect(KIND_GROUP[k]).toBeDefined();
    expect(new Set(Object.values(KIND_GROUP)).size).toBe(7);
    expect(KIND_GROUP.tombstone).toBe("absence");
    expect(KIND_GROUP.unknown).toBe("absence");
    expect(GROUP_HUE.absence).toBeNull();
  });

  it("keeps red for is_broken: no kind group sits on the red hue", () => {
    for (const h of Object.values(GROUP_HUE))
      if (h !== null) expect(Math.min(h, 360 - h)).toBeGreaterThan(20);
    expect(BROKEN_RED).toMatch(/^hsl\(0 /);
  });

  it("hue is kind: kinds in one group share fill at every state; groups differ", () => {
    for (const state of states) {
      const byGroup = new Map<string, string>();
      for (const k of kinds) {
        const s = nodeStyle(k, state);
        // Removed has no fill (§3.2), so its hue lives in the outline.
        const hue = state === "removed" ? s.stroke : s.fill;
        const seen = byGroup.get(s.group);
        if (seen === undefined) byGroup.set(s.group, hue);
        else expect(hue).toBe(seen);
      }
      const fills = [...byGroup.values()];
      expect(new Set(fills).size).toBe(fills.length);
    }
  });

  it("saturation is change state: pastel unchanged, vivid modified and new (§3.2)", () => {
    for (const k of kinds) {
      const unchanged = nodeStyle(k, "unchanged");
      const modified = nodeStyle(k, "modified");
      const fresh = nodeStyle(k, "new");
      expect(modified.fill).not.toBe(unchanged.fill);
      expect(fresh.fill).toBe(modified.fill);
    }
    // Pastel takes dark text, vivid takes white: legible in either state.
    expect(nodeStyle("endpoint", "unchanged").text).toBe("#1d1d1f");
    expect(nodeStyle("endpoint", "modified").text).toBe("#ffffff");
  });

  it("outline: double for new and only new; dashed only for the Absence group", () => {
    for (const k of kinds)
      for (const state of states) {
        const s = nodeStyle(k, state);
        expect(s.doubleOutline).toBe(state === "new");
        expect(s.strokeDash !== "").toBe(KIND_GROUP[k] === "absence");
      }
  });

  it("removed is a ghosted outline with no fill", () => {
    for (const k of kinds) expect(nodeStyle(k, "removed").fill).toBe("none");
  });

  it("line style is confidence and nothing else (§3.3)", () => {
    expect(confidenceDash("certain")).toBe("");
    expect(confidenceDash("inferred")).not.toBe("");
    expect(confidenceDash("annotated")).not.toBe("");
    expect(confidenceDash("inferred")).not.toBe(confidenceDash("annotated"));
  });

  it("an absent change-state entry is unchanged (persisted-files §1.5)", () => {
    expect(changeStateOf({}, "x")).toBe("unchanged");
    expect(changeStateOf({ x: "new" }, "x")).toBe("new");
  });

  it("inherits the most significant state: new > modified > unchanged (§4)", () => {
    expect(moreSignificant("unchanged", "modified")).toBe("modified");
    expect(moreSignificant("modified", "new")).toBe("new");
    expect(moreSignificant("new", "modified")).toBe("new");
    expect(moreSignificant("unchanged", "unchanged")).toBe("unchanged");
  });

  it("styles every kind the schema knows", () => {
    const k: NodeKind = "unknown";
    expect(nodeStyle(k, "unchanged").group).toBe("absence");
  });
});
