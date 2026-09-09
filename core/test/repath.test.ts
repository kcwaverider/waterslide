import { describe, expect, it } from "vitest";
import {
  assertRePathConsistent,
  checkRePathConsistency,
  rePathFileDataUnchanged,
  rePathViolations,
} from "../src/pipeline/repath.js";
import { toPerFileResult } from "../src/model/pack.js";
import { makeToyPack } from "./helpers/toy-pack.js";

const content =
  "import save from api.store\ndef sync\n  call save\n  route GET /x\n";

describe("rePath consistency helper (the check packs run in their own suites)", () => {
  it("passes for a pack whose rePath agrees with a fresh parse", async () => {
    const r = await checkRePathConsistency(makeToyPack(), {
      repo: "r",
      pathA: "a/one.toy",
      pathB: "b/deeper/two.toy",
      content,
      options: { source_roots: ["b"] },
    });
    expect(r).toEqual({ ok: true });
    await expect(
      assertRePathConsistent(makeToyPack(), {
        repo: "r",
        pathA: "a.toy",
        pathB: "b.toy",
        content,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails, showing both serializations, for a pack whose rePath diverges", async () => {
    const r = await checkRePathConsistency(makeToyPack({ rePath: "buggy" }), {
      repo: "r",
      pathA: "a.toy",
      pathB: "b.toy",
      content,
    });
    expect(r.ok).toBe(false);
    expect(r.rePathed).toContain('"path":"a.toy"');
    expect(r.reparsed).not.toContain('"path":"a.toy"');
    await expect(
      assertRePathConsistent(makeToyPack({ rePath: "buggy" }), {
        repo: "r",
        pathA: "a.toy",
        pathB: "b.toy",
        content,
      }),
    ).rejects.toThrow(/rePath\(a.toy -> b.toy\) differs/);
  });

  it("refuses to check a pack with no rePath", async () => {
    await expect(
      checkRePathConsistency(makeToyPack({ rePath: "none" }), {
        repo: "r",
        pathA: "a.toy",
        pathB: "b.toy",
        content,
      }),
    ).rejects.toThrow(/no rePath/);
  });
});

describe("core-side rePath guard", () => {
  it("lists every structural disagreement", async () => {
    const pack = makeToyPack({ rePath: "buggy" });
    const original = toPerFileResult(
      "r",
      "a.toy",
      await pack.parse("r", "a.toy", content, {}),
    );
    const moved = pack.rePath?.(original, "r", "b.toy", {});
    if (moved === undefined) throw new Error("no rePath");
    const violations = rePathViolations(moved, "r", "b.toy", original);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.includes("old path"))).toBe(true);
    const good = makeToyPack().rePath?.(original, "r", "b.toy", {});
    if (good === undefined) throw new Error("no rePath");
    expect(rePathViolations(good, "r", "b.toy", original)).toEqual([]);
    expect(rePathViolations(good, "r", "c.toy", original)).toEqual([
      expect.stringContaining("labelled r:b.toy, expected r:c.toy"),
      expect.stringContaining("does not carry the new path"),
      expect.stringContaining("does not carry the new path"),
    ]);
  });
});

describe("file-level pack_data across rePath", () => {
  it("is recomputed by a good rePath and flagged, not rejected, when returned unchanged", async () => {
    const content = "def a\n";
    const original = toPerFileResult(
      "r",
      "x/a.toy",
      await makeToyPack().parse("r", "x/a.toy", content, {}),
    );
    expect(original.pack_data).toEqual({ module: "x.a", defs: ["a"] });
    const good = makeToyPack().rePath?.(original, "r", "y/a.toy", {});
    expect(good?.pack_data).toEqual({ module: "y.a", defs: ["a"] });
    if (good === undefined) throw new Error("no rePath");
    expect(rePathFileDataUnchanged(good, original)).toBe(false);
    const stale = makeToyPack({ rePath: "stale-file-data" }).rePath?.(
      original,
      "r",
      "y/a.toy",
      {},
    );
    if (stale === undefined) throw new Error("no rePath");
    expect(rePathViolations(stale, "r", "y/a.toy", original)).toEqual([]);
    expect(rePathFileDataUnchanged(stale, original)).toBe(true);
  });
});
