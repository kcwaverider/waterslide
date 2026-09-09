import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph } from "@waterslide/core";
import {
  aggregateGraph,
  depthOf,
  hideUnresolved,
  levelsOf,
} from "../src/browser/aggregate.js";
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

  it("names levels by what the nodes with children ARE in the hierarchy, coarsest first", () => {
    expect(levelsOf(load("single-repo-minimal.json").nodes)).toEqual([
      { depth: 0, name: "services" },
      { depth: 1, name: "modules" },
      { depth: 2, name: "functions" },
    ]);
    expect(levelsOf(load("derived-ids.json").nodes).map((l) => l.name)).toEqual(
      ["modules", "functions"],
    );
  });

  it("tells directories from files, and methods from functions, by position in the chain", () => {
    const base = load("single-repo-minimal.json")
      .nodes[0] as CanonicalGraph["nodes"][number];
    const mk = (
      id: string,
      kind: CanonicalGraph["nodes"][number]["kind"],
      parent: string | null,
    ): CanonicalGraph["nodes"][number] => ({
      ...base,
      id,
      kind,
      label: id,
      parent,
      sources: [],
    });
    const nodes = [
      mk("svc:repo", "service", null),
      mk("r:server", "module", "svc:repo"),
      mk("r:server/api", "module", "r:server"),
      mk("r:server/api/notes.py", "module", "r:server/api"),
      mk("r:server/api/notes.py#Svc", "class", "r:server/api/notes.py"),
      mk(
        "r:server/api/notes.py#Svc.run",
        "function",
        "r:server/api/notes.py#Svc",
      ),
      mk(
        "r:server/api/notes.py#Svc.run.inner",
        "function",
        "r:server/api/notes.py#Svc.run",
      ),
      mk("mongo:db.notes", "collection", null),
    ];
    expect(levelsOf(nodes).map((l) => l.name)).toEqual([
      "services",
      "directories",
      "directories (2)",
      "modules",
      "classes",
      "methods",
      "inner functions",
    ]);
  });

  it("never names two adjacent levels identically", () => {
    for (const f of [
      "single-repo-minimal.json",
      "derived-ids.json",
      "band-skip.json",
    ]) {
      const names = levelsOf(load(f).nodes).map((l) => l.name);
      for (let i = 1; i < names.length; i++)
        expect(names[i]).not.toBe(names[i - 1]);
    }
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

describe("hide unresolved: a view filter, not a graph change", () => {
  it("removes unknown nodes and the edges touching them, and nothing else", () => {
    const g = load("unknown-dangling-refs.json");
    const f = hideUnresolved(g, true);
    expect(f.hiddenNodes).toBe(2);
    expect(f.hiddenEdges).toBe(2);
    expect(f.nodes.some((n) => n.kind === "unknown")).toBe(false);
    expect(f.nodes).toHaveLength(g.nodes.length - 2);
    expect(f.edges).toHaveLength(0);
    // The callers that only pointed at unknowns still render: no cascade.
    expect(
      f.nodes.some(
        (n) =>
          n.id === "tapistree:api/services/note_service.py#NoteService.archive",
      ),
    ).toBe(true);
    // The input is untouched.
    expect(g.nodes.filter((n) => n.kind === "unknown")).toHaveLength(2);
  });

  it("off is the identity, and a graph without unknowns hides nothing", () => {
    const g = load("unknown-dangling-refs.json");
    const off = hideUnresolved(g, false);
    expect(off.nodes).toBe(g.nodes);
    expect(off.hiddenNodes).toBe(0);
    const clean = hideUnresolved(load("derived-ids.json"), true);
    expect(clean.hiddenNodes).toBe(0);
    expect(clean.hiddenEdges).toBe(0);
  });

  it("feeds aggregation: hidden nodes never reach a level", () => {
    const g = load("unknown-dangling-refs.json");
    for (const l of levelsOf(g.nodes)) {
      const a = aggregateGraph(hideUnresolved(g, true), l.depth);
      expect(a.nodes.some((n) => n.kind === "unknown")).toBe(false);
    }
  });
});

describe("regional focus: near unfolded, far folded, edges land on folded boxes", () => {
  const base = load("single-repo-minimal.json")
    .nodes[0] as CanonicalGraph["nodes"][number];
  const baseEdge = load("single-repo-minimal.json")
    .edges[0] as CanonicalGraph["edges"][number];
  const mk = (
    id: string,
    kind: CanonicalGraph["nodes"][number]["kind"],
    parent: string | null,
  ): CanonicalGraph["nodes"][number] => ({
    ...base,
    id,
    kind,
    label: id.split("/").pop() ?? id,
    parent,
    sources: [],
    is_entry_point: false,
    entry_point_kind: null,
  });
  const call = (from: string, to: string): CanonicalGraph["edges"][number] => ({
    ...baseEdge,
    id: `e_${from}_${to}`,
    from,
    to,
    kind: "call",
    condition: null,
    exclusive_group: null,
    branch_ordinal: null,
    confidence: "certain",
    confidence_reason: null,
  });
  // repo → server → {api → {a.py → a1,a2 ; b.py → b1}, svc → {c.py → c1, d.py → d1}} ; repo → ios → {v.swift → v1}
  const nodes = [
    mk("svc:r", "service", null),
    mk("r:server", "module", "svc:r"),
    mk("r:server/api", "module", "r:server"),
    mk("r:server/api/a.py", "module", "r:server/api"),
    mk("r:server/api/a.py#a1", "function", "r:server/api/a.py"),
    mk("r:server/api/a.py#a2", "function", "r:server/api/a.py"),
    mk("r:server/api/b.py", "module", "r:server/api"),
    mk("r:server/api/b.py#b1", "function", "r:server/api/b.py"),
    mk("r:server/svc", "module", "r:server"),
    mk("r:server/svc/c.py", "module", "r:server/svc"),
    mk("r:server/svc/c.py#c1", "function", "r:server/svc/c.py"),
    mk("r:server/svc/d.py", "module", "r:server/svc"),
    mk("r:server/svc/d.py#d1", "function", "r:server/svc/d.py"),
    mk("r:ios", "module", "svc:r"),
    mk("r:ios/v.swift", "module", "r:ios"),
    mk("r:ios/v.swift#v1", "function", "r:ios/v.swift"),
    // A directory nothing near touches.
    mk("r:server/util", "module", "r:server"),
    mk("r:server/util/u.py", "module", "r:server/util"),
    mk("r:server/util/u.py#u1", "function", "r:server/util/u.py"),
  ];
  const edges = [
    call("r:server/api/a.py#a1", "r:server/api/a.py#a2"),
    call("r:server/api/a.py#a1", "r:server/api/b.py#b1"),
    call("r:server/api/a.py#a2", "r:server/svc/c.py#c1"),
    call("r:server/api/a.py#a2", "r:server/svc/d.py#d1"),
    call("r:ios/v.swift#v1", "r:server/api/a.py#a1"),
  ];
  const g = { nodes, edges };
  const FILES = 3; // depth of files

  it("with every level box near, it is the plain level aggregation", () => {
    const all = new Set(
      nodes.filter((n) => depthOf(nodes).get(n.id) === FILES).map((n) => n.id),
    );
    const focused = aggregateGraph(g, FILES, { near: all });
    const plain = aggregateGraph(g, FILES);
    expect(focused.nodes.map((n) => n.id)).toEqual(
      plain.nodes.map((n) => n.id),
    );
    expect(focused.edges.map((e) => e.id)).toEqual(
      plain.edges.map((e) => e.id),
    );
    expect(focused.folded.size).toBe(0);
  });

  it("folds far siblings into a residual box, far directories into their box, far trees into their top box", () => {
    const a = aggregateGraph(g, FILES, {
      near: new Set(["r:server/api/a.py"]),
    });
    const ids = a.nodes.map((n) => n.id).sort();
    // Ancestors shallower than the level draw as their own boxes, as at any level.
    expect(ids).toEqual(
      [
        "svc:r",
        "r:server",
        "r:ios",
        "r:server/api",
        "r:server/api/a.py",
        "r:server/svc",
      ].sort(),
    );
    // b.py folded into its own directory's residual box; c.py and d.py into svc; v.swift into ios.
    expect(a.representative.get("r:server/api/b.py#b1")).toBe("r:server/api");
    // util is under server too, but nothing near touches it: it folds on into server's residual box.
    expect(a.representative.get("r:server/util/u.py#u1")).toBe("r:server");
    expect(a.folded.get("r:server")).toBe(1);
    expect(a.representative.get("r:server/svc/d.py#d1")).toBe("r:server/svc");
    expect(a.representative.get("r:ios/v.swift#v1")).toBe("r:ios");
    // The near file stays itself, and so do its members at this level.
    expect(a.representative.get("r:server/api/a.py#a2")).toBe(
      "r:server/api/a.py",
    );
    // Boxes say how many level boxes they stand for.
    expect(a.folded.get("r:server/api")).toBe(1);
    expect(a.folded.get("r:server/svc")).toBe(2);
    // ios holds two boxes of this level: the file v.swift (shallower than the level) and v1 at level depth.
    expect(a.folded.get("r:ios")).toBe(1);
    expect(a.nodes.find((n) => n.id === "r:server/svc")?.label).toBe("svc +2");
    expect(a.nodes.find((n) => n.id === "r:server/api/a.py")?.label).toBe(
      "a.py",
    );
  });

  it("edges land on the folded boxes, weighted", () => {
    const a = aggregateGraph(g, FILES, {
      near: new Set(["r:server/api/a.py"]),
    });
    const toSvc = a.edges.find(
      (e) => e.from === "r:server/api/a.py" && e.to === "r:server/svc",
    );
    expect(toSvc).toBeDefined();
    expect(a.weights.get(toSvc?.id ?? "")).toBe(2);
    expect(toSvc?.label).toBe("2 × call");
    expect(
      a.edges.some(
        (e) => e.from === "r:server/api/a.py" && e.to === "r:server/api",
      ),
    ).toBe(true);
    expect(
      a.edges.some((e) => e.from === "r:ios" && e.to === "r:server/api/a.py"),
    ).toBe(true);
    // a1 → a2 is inside the near file: internal at this level, gone.
    expect(a.edges).toHaveLength(3);
    for (const e of a.edges) {
      expect(a.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(a.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });

  it("is deterministic and lays out", () => {
    const focus = { near: new Set(["r:server/api/a.py"]) };
    const x = aggregateGraph(g, FILES, focus);
    const y = aggregateGraph(
      { nodes: [...nodes].reverse(), edges: [...edges].reverse() },
      FILES,
      focus,
    );
    expect(JSON.stringify(y.edges)).toBe(JSON.stringify(x.edges));
    expect(layoutGraph(x).nodes).toHaveLength(x.nodes.length);
  });
});

describe("regional focus: crowded ancestors fold their far siblings into one residual box", () => {
  const base = load("single-repo-minimal.json")
    .nodes[0] as CanonicalGraph["nodes"][number];
  const baseEdge = load("single-repo-minimal.json")
    .edges[0] as CanonicalGraph["edges"][number];
  const mk = (
    id: string,
    kind: CanonicalGraph["nodes"][number]["kind"],
    parent: string | null,
  ): CanonicalGraph["nodes"][number] => ({
    ...base,
    id,
    kind,
    label: id.split("/").pop() ?? id,
    parent,
    sources: [],
    is_entry_point: false,
    entry_point_kind: null,
  });
  const nodes = [mk("svc:r", "service", null), mk("r:d", "module", "svc:r")];
  for (let i = 0; i < 20; i++) {
    nodes.push(mk(`r:d/f${String(i)}.py`, "module", "r:d"));
    nodes.push(
      mk(`r:d/f${String(i)}.py#fn`, "function", `r:d/f${String(i)}.py`),
    );
  }
  const g = { nodes, edges: [] };

  it("at the files level far sibling files are the residual box regardless of the cap", () => {
    const a = aggregateGraph(g, 2, {
      near: new Set(["r:d/f0.py"]),
      maxBranchBoxes: 30,
    });
    expect(
      a.nodes.filter((n) => n.id.startsWith("r:d/f")).map((n) => n.id),
    ).toEqual(["r:d/f0.py"]);
    expect(a.folded.get("r:d")).toBe(19);
  });

  it("at the functions level, touched far sibling files are boxes below the cap and one residual box above it", () => {
    // Every sibling file is touched by the near function, so the cap decides.
    const touching = {
      nodes,
      edges: nodes
        .filter((n) => n.id.endsWith("#fn") && n.id !== "r:d/f0.py#fn")
        .map((n) => ({
          ...baseEdge,
          id: `e_${n.id}`,
          from: "r:d/f0.py#fn",
          to: n.id,
          kind: "call" as const,
          condition: null,
          exclusive_group: null,
          branch_ordinal: null,
        })),
    };
    const few = aggregateGraph(touching, 3, {
      near: new Set(["r:d/f0.py#fn"]),
      maxBranchBoxes: 30,
    });
    expect(
      few.nodes.filter((n) => n.id.startsWith("r:d/f") && !n.id.includes("#"))
        .length,
    ).toBe(20);
    expect(few.folded.get("r:d/f7.py")).toBe(1);
    // Untouched, they fold into the residual regardless of the cap.
    const untouched = aggregateGraph(g, 3, {
      near: new Set(["r:d/f0.py#fn"]),
      maxBranchBoxes: 30,
    });
    expect(
      untouched.nodes
        .filter((n) => n.id.startsWith("r:d/f"))
        .map((n) => n.id)
        .sort(),
    ).toEqual(["r:d/f0.py", "r:d/f0.py#fn"]);
    const capped = aggregateGraph(touching, 3, {
      near: new Set(["r:d/f0.py#fn"]),
    });
    expect(
      capped.nodes
        .filter((n) => n.id.startsWith("r:d/f"))
        .map((n) => n.id)
        .sort(),
    ).toEqual(["r:d/f0.py", "r:d/f0.py#fn"]);
    expect(capped.folded.get("r:d")).toBe(19);
    expect(capped.nodes.find((n) => n.id === "r:d")?.label).toBe("r:d +19");
    expect(capped.representative.get("r:d/f7.py#fn")).toBe("r:d");
    expect(capped.representative.get("r:d/f7.py")).toBe("r:d");
  });
});
