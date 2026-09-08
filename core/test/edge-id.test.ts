import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgeId, edgeIdInput } from "../src/edge-id.js";

describe("edgeId (graph model §3.3.1)", () => {
  // Reference digests computed outside this codebase with
  //   printf '%s' '<input>' | shasum -a 256
  // so the encoding is pinned to a literal, not to whatever the code emits.
  it("hashes a non-fork key as a JSON array of [from, to, kind]", () => {
    const key = { from: "a", to: "b", kind: "call" };
    expect(edgeIdInput(key)).toBe('["a","b","call"]');
    // sha256('["a","b","call"]') = e1f638db4b2a2054372aebc7ca4c1fe9b35a11f4952994a823b8248261187fca
    expect(edgeId(key)).toBe("e_e1f638db4b2a2054");
  });

  it("pins a realistic non-fork id", () => {
    const key = {
      from: "tapistree:api/routers/notes.py#update_note",
      to: "tapistree:api/services/note_service.py#NoteService.update",
      kind: "call",
    };
    // sha256 = dd18a22155d2d22bc5f824dd230ea2934b766871f7b8b6b542f1fa14a94909f2
    expect(edgeId(key)).toBe("e_dd18a22155d2d22b");
  });

  it("appends exclusive_group and branch_ordinal for fork edges", () => {
    const key = {
      from: "tapistree:api/services/note_service.py#NoteService.update",
      to: "tapistree:api/repositories/note_repo.py#NoteRepository.save",
      kind: "call",
      exclusive_group: "note_service.py:NoteService.update:L40",
      branch_ordinal: 0,
    };
    expect(edgeIdInput(key)).toBe(
      '["tapistree:api/services/note_service.py#NoteService.update","tapistree:api/repositories/note_repo.py#NoteRepository.save","call","note_service.py:NoteService.update:L40",0]',
    );
    // sha256 = 542f164d5f46dab89a97ce3e59d95c6a33fa98bcc2b348d6e215e087d64e7adc
    expect(edgeId(key)).toBe("e_542f164d5f46dab8");
  });

  it("gives fork alternatives on the same line distinct ids", () => {
    const base = { from: "x", to: "y", kind: "call", exclusive_group: "g" };
    expect(edgeId({ ...base, branch_ordinal: 0 })).not.toBe(
      edgeId({ ...base, branch_ordinal: 1 }),
    );
  });

  it("keys a fork edge differently from a non-fork edge with the same endpoints", () => {
    expect(edgeId({ from: "x", to: "y", kind: "call" })).not.toBe(
      edgeId({
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: 0,
      }),
    );
  });

  it("treats explicit null and absent fork fields identically", () => {
    expect(
      edgeId({
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: null,
        branch_ordinal: null,
      }),
    ).toBe(edgeId({ from: "x", to: "y", kind: "call" }));
  });

  it("NFC-normalizes strings before hashing", () => {
    const composed = "café"; // é as one code point
    const decomposed = "café"; // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(edgeId({ from: composed, to: "y", kind: "call" })).toBe(
      edgeId({ from: decomposed, to: "y", kind: "call" }),
    );
  });

  it("is immune to separator ambiguity because the key is a JSON array", () => {
    // Naive "from|to|kind" concatenation would collide these two.
    expect(edgeId({ from: "a|b", to: "c", kind: "call" })).not.toBe(
      edgeId({ from: "a", to: "b|c", kind: "call" }),
    );
  });

  it("rejects a half-specified fork key (invariant 14)", () => {
    expect(() =>
      edgeId({ from: "x", to: "y", kind: "call", exclusive_group: "g" }),
    ).toThrow(TypeError);
    expect(() =>
      edgeId({ from: "x", to: "y", kind: "call", branch_ordinal: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      edgeId({
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: -1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      edgeId({
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: 1.5,
      }),
    ).toThrow(TypeError);
  });

  it("is provably e_ + sha256(edgeIdInput(key)).slice(0, 16), not coincidentally", () => {
    const keys = [
      { from: "a", to: "b", kind: "call" },
      {
        from: "tapistree:api/routers/notes.py#update_note",
        to: "mongo:tapistree.notes",
        kind: "write",
      },
      {
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: 3,
      },
      { from: "café", to: "naïve", kind: "http_request" },
    ];
    for (const key of keys) {
      const expected =
        "e_" +
        createHash("sha256")
          .update(edgeIdInput(key), "utf8")
          .digest("hex")
          .slice(0, 16);
      expect(edgeId(key)).toBe(expected);
    }
  });

  it("edgeIdInput rejects exactly the keys edgeId rejects", () => {
    const bad = [
      { from: "x", to: "y", kind: "call", exclusive_group: "g" },
      { from: "x", to: "y", kind: "call", branch_ordinal: 0 },
      {
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: -1,
      },
      {
        from: "x",
        to: "y",
        kind: "call",
        exclusive_group: "g",
        branch_ordinal: 1.5,
      },
    ];
    for (const key of bad) {
      expect(() => edgeIdInput(key)).toThrow(TypeError);
      expect(() => edgeId(key)).toThrow(TypeError);
    }
  });

  it("has the documented output shape: e_ + 16 lowercase hex", () => {
    expect(edgeId({ from: "x", to: "y", kind: "call" })).toMatch(
      /^e_[0-9a-f]{16}$/,
    );
  });
});

describe("fixtures/valid/derived-ids.json", () => {
  interface FixtureEdge {
    id: string;
    from: string;
    to: string;
    kind: string;
    exclusive_group: string | null;
    branch_ordinal: number | null;
  }
  const url = new URL("../../fixtures/valid/derived-ids.json", import.meta.url);
  const graph = JSON.parse(readFileSync(url, "utf8")) as {
    edges: FixtureEdge[];
  };

  it("carries ids that edgeId reproduces from the edge's own fields", () => {
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const e of graph.edges) {
      expect(edgeId(e), `edge ${e.from} -> ${e.to} (${e.kind})`).toBe(e.id);
    }
  });

  it("includes both a fork pair and non-fork edges", () => {
    const forks = graph.edges.filter((e) => e.exclusive_group !== null);
    expect(forks.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length - forks.length).toBeGreaterThan(0);
  });

  it("is sorted by id byte-wise, as canonical form requires (§7.2)", () => {
    const ids = graph.edges.map((e) => e.id);
    const sorted = [...ids].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    expect(ids).toEqual(sorted);
  });
});
