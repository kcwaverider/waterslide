import { describe, expect, it } from "vitest";
import { edgeId } from "../src/edge-id.js";
import {
  collapseEdges,
  finalizeEdges,
  skipsTiers,
  type ResolvedPartialEdge,
} from "../src/pipeline/derive-edges.js";
import { node } from "./helpers/corpus.js";

const site = (
  line_start: number,
  path = "a.py",
  extra: Partial<ResolvedPartialEdge> = {},
): ResolvedPartialEdge => ({
  from: "r:a.py#f",
  to: "r:b.py#g",
  kind: "call",
  label: `call@${String(line_start)}`,
  schema_id: null,
  response_schema_id: null,
  confidence: "certain",
  confidence_reason: null,
  condition: null,
  exclusive_group: null,
  branch_ordinal: null,
  is_error_path: false,
  source: { repo: "r", path, line_start, line_end: null },
  ...extra,
});

describe("collapse (graph model §3.3)", () => {
  it("merges call sites of one relationship: first site wins, count is distinct sites", () => {
    const out = collapseEdges([site(47), site(12), site(12), site(30, "z.py")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: { line_start: 12, path: "a.py" },
      source_count: 3,
      label: "call@12",
    });
  });

  it("applies the merge rules for confidence, condition and is_error_path", () => {
    const out = collapseEdges([
      site(5, "a.py", {
        is_error_path: true,
        condition: { expr: "if x", source_line: 4 },
      }),
      site(9, "a.py", {
        confidence: "inferred",
        confidence_reason: "guessed",
        is_error_path: true,
        condition: { expr: "if y", source_line: 8 },
      }),
    ]);
    expect(out[0]).toMatchObject({
      confidence: "inferred",
      confidence_reason: "guessed",
      condition: null,
      is_error_path: true,
    });
    const same = collapseEdges([
      site(5, "a.py", { condition: { expr: "if x", source_line: 4 } }),
      site(9, "a.py", {
        condition: { expr: "if x", source_line: 4 },
        is_error_path: true,
      }),
    ]);
    expect(same[0]).toMatchObject({
      condition: { expr: "if x" },
      is_error_path: false,
    });
  });

  it("keeps different kinds, targets and fork alternatives apart, and collapses same-key fork edges", () => {
    const out = collapseEdges([
      site(1),
      site(2, "a.py", { kind: "read" }),
      site(3, "a.py", { to: "r:c.py#h" }),
      site(4, "a.py", { exclusive_group: "g", branch_ordinal: 0 }),
      site(5, "a.py", { exclusive_group: "g", branch_ordinal: 1 }),
      site(6, "a.py", { exclusive_group: "g", branch_ordinal: 0 }),
    ]);
    expect(out).toHaveLength(5);
    const fork0 = out.find(
      (e) => e.exclusive_group === "g" && e.branch_ordinal === 0,
    );
    expect(fork0?.source_count).toBe(2);
  });

  it("does not depend on input order", () => {
    const edges = [
      site(47),
      site(12, "b.py"),
      site(12, "a.py"),
      site(3, "a.py", { kind: "read" }),
    ];
    const a = JSON.stringify(collapseEdges(edges));
    const b = JSON.stringify(collapseEdges([...edges].reverse()));
    expect(a).toBe(b);
  });

  it("counts only sourced sites; an unsourced edge alone has count 0", () => {
    const out = collapseEdges([site(1, "a.py", { source: null })]);
    expect(out[0]).toMatchObject({ source: null, source_count: 0 });
  });
});

describe("skips_tiers (graph model §3.4)", () => {
  it("lists the bands strictly between, sorted byte-wise, in either direction", () => {
    const ui = node("r:v.swift#V", "ui_view", "ui");
    const store = node("mongo:db.c", "collection", "store");
    const repo = node("r:x.py#R", "repository", "data_access");
    const api = node("r:y.py#E", "endpoint", "api");
    expect(skipsTiers(ui, repo)).toEqual(["api", "domain", "ui_logic"]);
    expect(skipsTiers(repo, ui)).toEqual(["api", "domain", "ui_logic"]);
    expect(skipsTiers(api, repo)).toEqual(["domain"]);
    expect(skipsTiers(api, node("r:z.py#f", "function", "domain"))).toEqual([]);
    // A collection is not an excluded kind: a view writing straight to it is
    // exactly the skip the badge exists for (fixtures/valid/band-skip.json).
    expect(skipsTiers(ui, store)).toEqual([
      "api",
      "data_access",
      "domain",
      "ui_logic",
    ]);
  });

  it("is empty for excluded kinds and for anything in tier external", () => {
    const ui = node("r:v.swift#V", "ui_view", "ui");
    expect(skipsTiers(ui, node("topic:t", "topic", "store"))).toEqual([]);
    expect(
      skipsTiers(ui, node("unknown:symbol:x", "unknown", "store")),
    ).toEqual([]);
    expect(
      skipsTiers(ui, node("ext:a/b", "external_service", "external")),
    ).toEqual([]);
    expect(skipsTiers(ui, node("r:x.py#f", "function", "external"))).toEqual(
      [],
    );
  });
});

describe("finalizeEdges", () => {
  it("derives ids with edgeId, sorts by id, and fills the no-baseline fields", () => {
    const f = node("r:a.py#f", "function", "domain");
    const g = node("r:b.py#g", "repository", "data_access");
    const byId = new Map([f, g].map((n) => [n.id, n]));
    const out = finalizeEdges(
      collapseEdges([site(1), site(2, "a.py", { kind: "read" })]),
      byId,
    );
    expect(out.map((e) => e.id)).toEqual([...out.map((e) => e.id)].sort());
    for (const e of out) {
      expect(e.id).toBe(edgeId({ from: e.from, to: e.to, kind: e.kind }));
      expect(e).toMatchObject({
        is_broken: false,
        broken_reason: null,
        skips_tiers: [],
      });
    }
  });
});
