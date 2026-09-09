import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph } from "@waterslide/core";
import { aggregateGraph, depthOf, levelsOf } from "../src/browser/aggregate.js";
import { layoutGraph } from "../src/layout.js";
import { blastRadius, planPlayback } from "../src/browser/flow.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const load = (f: string): CanonicalGraph =>
  JSON.parse(readFileSync(new URL(f, validDir), "utf8")) as CanonicalGraph;

describe("semantic zoom aggregation (UI §2.2, graph model §2.3)", () => {
  it("depth follows the parent chain: service 0, module 1, function 2", () => {
    const g = load("single-repo-minimal.json");
    const d = depthOf(g.nodes);
    expect(d.get("svc:ledger-api")).toBe(0);
    expect(d.get("ledger:app/routes.py")).toBe(1);
    expect(d.get("ledger:app/routes.py#list_entries")).toBe(2);
    expect(d.get("mongo:ledger.entries")).toBe(0);
  });

  it("names levels by the predominant kind that has children, coarsest first", () => {
    expect(levelsOf(load("single-repo-minimal.json").nodes)).toEqual([
      { depth: 0, name: "services" },
      { depth: 1, name: "modules" },
      { depth: 2, name: "functions" },
    ]);
    expect(levelsOf(load("derived-ids.json").nodes).map((l) => l.name)).toEqual(
      ["modules", "functions"],
    );
  });

  it("the deepest level is the graph itself", () => {
    const g = load("derived-ids.json");
    const a = aggregateGraph(g, 1);
    expect(a.nodes).toEqual(g.nodes);
    expect(a.edges).toEqual(g.edges);
    expect(a.weights.size).toBe(0);
    for (const n of g.nodes) expect(a.representative.get(n.id)).toBe(n.id);
  });

  it("folds functions into modules, merges their edges, drops internal ones", () => {
    const g = load("derived-ids.json");
    const a = aggregateGraph(g, 0);
    const ids = new Set(a.nodes.map((n) => n.id));
    expect(ids.has("tapistree:api/services/note_service.py")).toBe(true);
    expect(
      ids.has("tapistree:api/services/note_service.py#NoteService.update"),
    ).toBe(false);
    expect(ids.has("mongo:tapistree.notes")).toBe(true);
    // update → reject was inside note_service.py: internal, gone.
    expect(
      a.edges.some(
        (e) =>
          e.from === e.to &&
          e.from === "tapistree:api/services/note_service.py",
      ),
    ).toBe(false);
    // Every remaining edge joins two drawn nodes.
    for (const e of a.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.exclusive_group).toBeNull();
    }
    // The module is an entry point because the route inside it is.
    expect(
      a.nodes.find((n) => n.id === "tapistree:api/routers/notes.py")
        ?.is_entry_point,
    ).toBe(true);
    expect(a.members.get("tapistree:api/services/note_service.py")).toEqual([
      "tapistree:api/services/note_service.py",
      "tapistree:api/services/note_service.py#NoteService.reject",
      "tapistree:api/services/note_service.py#NoteService.update",
    ]);
  });

  it("weights a merged edge by the edges it stands for and is conservative about confidence", () => {
    const g = load("single-repo-minimal.json");
    const a = aggregateGraph(g, 0);
    // queries.py#load_entries reads entries and writes audit_log; at service level both leave svc:ledger-api.
    const toEntries = a.edges.find(
      (e) => e.from === "svc:ledger-api" && e.to === "mongo:ledger.entries",
    );
    expect(toEntries).toBeDefined();
    expect(toEntries?.confidence).toBe("inferred");
    expect(toEntries?.confidence_reason).toMatch(/folded into this one/);
    expect(a.weights.get(toEntries?.id ?? "")).toBe(1);
    // Two writes into one collection from two different aggregates stay two edges; a root with no parent stays itself.
    const b = aggregateGraph(load("band-skip.json"), 0);
    const writes = b.edges.filter((e) => e.kind === "write");
    expect(writes.map((e) => e.from).sort()).toEqual([
      "tapistree-ios:Sources/Views/NoteEditorView.swift#NoteEditorView",
      "tapistree:api/repositories/note_repo.py",
    ]);
  });

  it("merges parallel edges into one weighted edge", () => {
    const g = load("derived-ids.json");
    // Two functions in one module both calling into one other module: fabricate by re-parenting.
    const nodes = g.nodes.map((n) =>
      n.id === "tapistree:api/repositories/note_repo.py#NoteRepository.save"
        ? { ...n, parent: "tapistree:api/services/note_service.py" }
        : n,
    );
    const a = aggregateGraph({ nodes, edges: g.edges }, 0);
    const toNotes = a.edges.filter((e) => e.to === "mongo:tapistree.notes");
    expect(toNotes).toHaveLength(1);
    const many = aggregateGraph(
      {
        nodes,
        edges: [
          ...g.edges,
          {
            ...(g.edges.find(
              (e) => e.kind === "external_call",
            ) as CanonicalGraph["edges"][number]),
            id: "e_extra",
            from: "tapistree:api/services/note_service.py#NoteService.reject",
          },
        ],
      },
      0,
    );
    const ext = many.edges.find((e) => e.to === "ext:cohere/embed");
    expect(many.weights.get(ext?.id ?? "")).toBe(2);
    expect(ext?.label).toBe("2 × external call");
  });

  it("lays out, plans and animates at every level, deterministically", () => {
    for (const f of [
      "single-repo-minimal.json",
      "band-skip.json",
      "derived-ids.json",
    ]) {
      const g = load(f);
      for (const level of levelsOf(g.nodes)) {
        const a = aggregateGraph(g, level.depth);
        const b = aggregateGraph(
          { nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() },
          level.depth,
        );
        expect(JSON.stringify(b.edges)).toBe(JSON.stringify(a.edges));
        const layout = layoutGraph(a);
        expect(layout.nodes).toHaveLength(a.nodes.length);
        expect(layout.edges).toHaveLength(a.edges.length);
        const entry = g.nodes.find((n) => n.is_entry_point);
        if (entry === undefined) continue;
        const rep = a.representative.get(entry.id) as string;
        const radius = blastRadius(a, rep);
        expect(radius.nodes.has(rep)).toBe(true);
        for (const gen of planPlayback(a, rep, new Map()))
          for (const h of gen) expect(radius.edges.has(h.edge.id)).toBe(true);
      }
    }
  });
});
