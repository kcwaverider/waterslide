import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph, Edge } from "@waterslide/core";
import {
  blastRadius,
  chosenAlternatives,
  defaultAlternative,
  entryPointGroups,
  isActiveBranch,
  planPlayback,
} from "../src/browser/flow.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const load = (f: string): CanonicalGraph =>
  JSON.parse(readFileSync(new URL(f, validDir), "utf8")) as CanonicalGraph;

const ROUTE = "tapistree:api/routers/notes.py#update_note";
const SERVICE = "tapistree:api/services/note_service.py#NoteService.update";

describe("entry point sidebar (UI §6)", () => {
  it("groups entry points by kind in spec order, labels not ids", () => {
    const groups = entryPointGroups(load("band-skip.json").nodes);
    expect(groups.map((g) => g.label)).toEqual(["UI handlers", "HTTP routes"]);
    expect(groups.flatMap((g) => g.nodes.map((n) => n.label))).toEqual([
      "NoteEditorView",
      "PUT /notes/{id}",
    ]);
  });

  it("a graph with no entry points has no groups", () => {
    expect(entryPointGroups(load("unknown-dangling-refs.json").nodes)).toEqual(
      [],
    );
  });
});

describe("flow mode (UI §5.2)", () => {
  it("the blast radius is the reachable set, every branch included", () => {
    const g = load("derived-ids.json");
    const r = blastRadius(g, ROUTE);
    expect(r.nodes.has(ROUTE)).toBe(true);
    expect(r.nodes.has(SERVICE)).toBe(true);
    expect(r.nodes.has("mongo:tapistree.notes")).toBe(true);
    expect(r.nodes.has("ext:cohere/embed")).toBe(true);
    // Both fork alternatives are reachable: flow mode narrows, it does not choose.
    expect(
      r.nodes.has("tapistree:api/services/note_service.py#NoteService.reject"),
    ).toBe(true);
    // The Swift caller is upstream of the route, so it is outside the radius.
    expect(
      r.nodes.has(
        "tapistree-ios:Sources/Services/NoteService.swift#NoteService.update",
      ),
    ).toBe(false);
    expect(r.edges.size).toBe(
      g.edges.filter((e) => r.nodes.has(e.from)).length,
    );
  });

  it("a leaf's blast radius is itself", () => {
    const g = load("derived-ids.json");
    const r = blastRadius(g, "mongo:tapistree.notes");
    expect([...r.nodes]).toEqual(["mongo:tapistree.notes"]);
    expect(r.edges.size).toBe(0);
  });
});

describe("branch selection (graph model §3.2, UI §7.5)", () => {
  const forkEdges = (g: CanonicalGraph): Edge[] =>
    g.edges.filter((e) => e.exclusive_group !== null);

  it("picks the happy path: the non-error alternative first", () => {
    const g = load("derived-ids.json");
    const edges = forkEdges(g);
    const chosen = defaultAlternative(edges);
    const picked = edges.find((e) => e.branch_ordinal === chosen);
    expect(picked?.condition?.expr).toBe("if note.is_valid()");
    expect(picked?.is_error_path).toBe(false);
  });

  it("orders by line, then path, then ordinal when error state ties", () => {
    const base = forkEdges(load("derived-ids.json"))[0] as Edge;
    const mk = (
      ordinal: number,
      line: number,
      path: string,
      error = false,
    ): Edge => ({
      ...base,
      id: `e_${String(ordinal)}`,
      branch_ordinal: ordinal,
      is_error_path: error,
      source: { repo: "r", path, line_start: line, line_end: null },
    });
    expect(defaultAlternative([mk(0, 20, "a.py"), mk(1, 10, "a.py")])).toBe(1);
    expect(defaultAlternative([mk(0, 10, "b.py"), mk(1, 10, "a.py")])).toBe(1);
    expect(defaultAlternative([mk(1, 10, "a.py"), mk(0, 10, "a.py")])).toBe(0);
    expect(
      defaultAlternative([mk(0, 5, "a.py", true), mk(1, 50, "z.py")]),
    ).toBe(1);
    // One limb, two calls: both edges carry the ordinal; the limb's key is the minimum.
    expect(
      defaultAlternative([
        mk(0, 30, "a.py"),
        mk(0, 12, "a.py"),
        mk(1, 20, "a.py"),
      ]),
    ).toBe(0);
  });

  it("an override wins when it names a real alternative, and is ignored otherwise", () => {
    const g = load("derived-ids.json");
    const group = (forkEdges(g)[0] as Edge).exclusive_group as string;
    expect(chosenAlternatives(g, new Map()).get(group)).toBe(0);
    expect(chosenAlternatives(g, new Map([[group, 1]])).get(group)).toBe(1);
    expect(chosenAlternatives(g, new Map([[group, 7]])).get(group)).toBe(0);
    const chosen = chosenAlternatives(g, new Map([[group, 1]]));
    for (const e of forkEdges(g))
      expect(isActiveBranch(e, chosen)).toBe(e.branch_ordinal === 1);
    for (const e of g.edges.filter((x) => x.exclusive_group === null))
      expect(isActiveBranch(e, chosen)).toBe(true);
  });
});

describe("playback plan (UI §7, §0)", () => {
  it("fires parallel edges together, one fork alternative only, and ends", () => {
    const g = load("derived-ids.json");
    const plan = planPlayback(g, ROUTE, chosenAlternatives(g, new Map()));
    const labels = plan.map((gen) => gen.map((h) => h.edge.label));
    expect(labels[0]).toEqual(["update"]);
    // From the service: the chosen branch (save) and the external call fire together; reject does not.
    expect(labels[1]?.sort()).toEqual(["embed", "save"]);
    expect(labels.flat()).not.toContain("reject");
    expect(labels[2]).toEqual(["replace_one"]);
    expect(plan).toHaveLength(3);
  });

  it("a flipped fork travels the other branch", () => {
    const g = load("derived-ids.json");
    const group = (g.edges.find((e) => e.exclusive_group !== null) as Edge)
      .exclusive_group as string;
    const plan = planPlayback(
      g,
      ROUTE,
      chosenAlternatives(g, new Map([[group, 1]])),
    );
    const labels = plan.flatMap((gen) => gen.map((h) => h.edge.label));
    expect(labels).toContain("reject");
    expect(labels).not.toContain("save");
  });

  it("a shared ordinal fires both of the limb's calls together", () => {
    const g = load("shared-branch-ordinal.json");
    const plan = planPlayback(g, ROUTE, chosenAlternatives(g, new Map()));
    const second = plan[1]?.map((h) => h.edge.branch_ordinal);
    expect(second?.filter((o) => o === 0)).toHaveLength(2);
  });

  it("travels each edge once, so a cycle is one lap and the play terminates", () => {
    const g = load("annotated-edge.json");
    const start = g.nodes.find((n) => n.is_entry_point)?.id as string;
    const plan = planPlayback(g, start, new Map());
    const ids = plan.flatMap((gen) => gen.map((h) => h.edge.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    // The recursive self-loop is travelled, once.
    expect(ids).toContain((g.edges.find((e) => e.from === e.to) as Edge).id);
  });

  it("external calls take longer; the plan never invents an edge", () => {
    const g = load("derived-ids.json");
    const plan = planPlayback(g, ROUTE, chosenAlternatives(g, new Map()));
    const known = new Set(g.edges.map((e) => e.id));
    for (const gen of plan)
      for (const h of gen) {
        expect(known.has(h.edge.id)).toBe(true);
        expect(h.duration).toBe(h.edge.kind === "external_call" ? 1.8 : 1);
      }
  });

  it("is deterministic under shuffled input", () => {
    const g = load("band-skip.json");
    const a = planPlayback(g, ROUTE, chosenAlternatives(g, new Map()));
    const shuffled = {
      nodes: [...g.nodes].reverse(),
      edges: [...g.edges].reverse(),
    };
    const b = planPlayback(
      shuffled,
      ROUTE,
      chosenAlternatives(shuffled, new Map()),
    );
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
