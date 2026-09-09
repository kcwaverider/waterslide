import { describe, expect, it } from "vitest";
import type { Node } from "../src/model/graph.js";
import {
  packOptionsHash,
  resolvePackOptions,
  tierConfigHash,
} from "../src/pipeline/config.js";
import {
  assignTiers,
  completeHierarchy,
  markInfrastructure,
  nodeIdPath,
} from "../src/pipeline/derive.js";

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  kind: "function",
  label: id,
  tier: "domain",
  parent: null,
  sources: [],
  confidence: "certain",
  confidence_reason: null,
  is_entry_point: false,
  entry_point_kind: null,
  is_infrastructure: false,
  tags: [],
  ...extra,
});

describe("tier_config_hash (graph model §7)", () => {
  it("hashes the empty config to the value the fixtures carry", () => {
    expect(tierConfigHash({})).toBe("sha256:e3b0c44298fc1c14");
    expect(tierConfigHash({ tiers: { assign: [] } })).toBe(
      "sha256:e3b0c44298fc1c14",
    );
  });

  it("changes when an assignment changes and ignores key order", () => {
    const a = tierConfigHash({
      tiers: { assign: [{ glob: "api/**", tier: "api" }] },
    });
    expect(a).not.toBe(tierConfigHash({}));
    expect(a).toMatch(/^sha256:[0-9a-f]{16}$/);
    const b = tierConfigHash({
      tiers: { assign: [{ tier: "api", glob: "api/**" }] },
    });
    expect(b).toBe(a);
    expect(
      tierConfigHash({
        tiers: { assign: [{ glob: "api/**", tier: "domain" }] },
      }),
    ).not.toBe(a);
  });
});

describe("pack options", () => {
  it("resolves a pack's block or {} and hashes it key-order-insensitively", () => {
    const config = { packs: { python: { source_roots: ["server"], x: 1 } } };
    expect(resolvePackOptions(config, "python")).toEqual({
      source_roots: ["server"],
      x: 1,
    });
    expect(resolvePackOptions(config, "swift")).toEqual({});
    expect(packOptionsHash({ x: 1, source_roots: ["server"] })).toBe(
      packOptionsHash({ source_roots: ["server"], x: 1 }),
    );
    expect(packOptionsHash({ source_roots: ["server"] })).not.toBe(
      packOptionsHash({ source_roots: ["api"] }),
    );
  });
});

describe("stage 5: tiers (graph model §6)", () => {
  it("first matching glob wins, no match keeps the pack's tier, synthetic nodes untouched", () => {
    const nodes = [
      node("r:api/routers/notes.py#f"),
      node("r:api/routers/notes.py", { kind: "module" }),
      node("r:api/services/x.py#g", { tier: "ui" }),
      node("r:lib/util.py#h", { tier: "data_access" }),
      node("mongo:db.c", { kind: "collection", tier: "store" }),
    ];
    const out = assignTiers(nodes, {
      tiers: {
        assign: [
          { glob: "api/routers/**", tier: "api" },
          { glob: "api/**", tier: "domain" },
        ],
      },
    });
    expect(out.map((n) => n.tier)).toEqual([
      "api",
      "api",
      "domain",
      "data_access",
      "store",
    ]);
    expect(out).not.toBe(nodes);
    expect(nodes[2]?.tier).toBe("ui"); // input untouched
  });

  it("with no config returns copies with tiers as the pack set them", () => {
    const nodes = [node("r:a.py#f", { tier: "ui_logic" })];
    expect(assignTiers(nodes, {})[0]?.tier).toBe("ui_logic");
  });

  it("nodeIdPath extracts the declaring path for repo-scoped ids only", () => {
    expect(nodeIdPath("r:api/x.py#Foo.bar")).toBe("api/x.py");
    expect(nodeIdPath("r:api/x.py")).toBe("api/x.py");
    expect(nodeIdPath("mongo:db.c")).toBeNull();
    expect(nodeIdPath("unknown:symbol:x")).toBeNull();
    expect(nodeIdPath("nocolon")).toBeNull();
  });
});

describe("stage 5: infrastructure (persisted-files §3.2, policy §5)", () => {
  const span = (path: string, repo = "r"): Node["sources"][number] => ({
    repo,
    path,
    line_start: 1,
    line_end: null,
    hash: "sha256:0",
  });

  it("marks a node when ANY span matches a glob, and never a node with no sources", () => {
    const nodes = [
      node("r:api/middleware/auth.py#check", {
        sources: [span("api/middleware/auth.py")],
      }),
      // A definition split across files: one span is under the glob.
      node("r:api/deps/auth.py#Auth", {
        kind: "class",
        sources: [span("api/deps/auth_impl.py"), span("api/deps/auth.py")],
      }),
      node("r:api/routers/notes.py#f", {
        sources: [span("api/routers/notes.py")],
      }),
      // Synthetic: no path to match, whatever its kind.
      node("mongo:db.users", { kind: "collection", tier: "store" }),
      node("unknown:symbol:api.middleware.x", { kind: "unknown" }),
      node("ext:stripe", { kind: "external_service", tier: "external" }),
    ];
    const out = markInfrastructure(nodes, {
      infrastructure: [
        { glob: "api/middleware/**" },
        { glob: "api/deps/auth.py" },
      ],
    });
    expect(out.map((n) => n.is_infrastructure)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(out).not.toBe(nodes);
    expect(nodes.every((n) => !n.is_infrastructure)).toBe(true); // input untouched
  });

  it("excludes no kind: a collection with a declaring span is eligible (UI §5.3, the hub problem)", () => {
    const out = markInfrastructure(
      [
        node("r:models/user.py#User", {
          kind: "collection",
          tier: "store",
          sources: [span("models/user.py")],
        }),
      ],
      { infrastructure: [{ glob: "models/user.py" }] },
    );
    expect(out[0]?.is_infrastructure).toBe(true);
  });

  it("matches repo-relative paths in every repo, dotfiles included, and only whole path segments", () => {
    const out = markInfrastructure(
      [
        node("a:lib/log.py#l", { sources: [span("lib/log.py", "a")] }),
        node("b:lib/log.py#l", { sources: [span("lib/log.py", "b")] }),
        node("a:lib/.hidden/x.py#h", { sources: [span("lib/.hidden/x.py")] }),
        node("a:library/x.py#y", { sources: [span("library/x.py")] }),
      ],
      { infrastructure: [{ glob: "lib/**" }] },
    );
    expect(out.map((n) => n.is_infrastructure)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("with no markers, or an empty list, returns copies with every node as the pack left it", () => {
    const nodes = [
      node("r:a.py#f", { sources: [span("a.py")] }),
      node("r:b.py#g", { sources: [span("b.py")], is_infrastructure: true }),
    ];
    for (const config of [{}, { infrastructure: [] }]) {
      const out = markInfrastructure(nodes, config);
      expect(out.map((n) => n.is_infrastructure)).toEqual([false, true]);
      expect(out[0]).not.toBe(nodes[0]);
    }
  });
});

describe("stage 5: parents (graph model §2.3)", () => {
  /** Every node id → its parent, so an expectation reads as the chain it asserts. */
  const parentsOf = (out: Node[]): Record<string, string | null> =>
    Object.fromEntries(out.map((n) => [n.id, n.parent]));

  it("fills a null parent on a # node with the module node when it exists, and only then", () => {
    const out = completeHierarchy([
      node("r:a.py#f"),
      node("r:a.py", { kind: "module" }),
      node("r:b.py#g"),
      node("r:a.py#h", { parent: "svc:x" }),
      node("svc:x", { kind: "service" }),
    ]);
    expect(parentsOf(out)).toEqual({
      "r:a.py#f": "r:a.py",
      "r:a.py": "svc:r",
      "r:b.py#g": null, // no module node, so nothing to hang it on
      "r:a.py#h": "svc:x", // pack-set parents win
      "svc:x": null,
      "svc:r": null,
    });
  });

  it("mints one module node per directory level and a service node for the repo root", () => {
    const out = completeHierarchy([
      node("myrepo:server/api/endpoints/memory.py#get", { kind: "endpoint" }),
      node("myrepo:server/api/endpoints/memory.py", { kind: "module" }),
      node("myrepo:server/api/deps.py", { kind: "module" }),
      node("myrepo:server/main.py", { kind: "module" }),
    ]);
    expect(parentsOf(out)).toEqual({
      "myrepo:server/api/endpoints/memory.py#get":
        "myrepo:server/api/endpoints/memory.py",
      "myrepo:server/api/endpoints/memory.py": "myrepo:server/api/endpoints",
      "myrepo:server/api/endpoints": "myrepo:server/api",
      "myrepo:server/api/deps.py": "myrepo:server/api",
      "myrepo:server/api": "myrepo:server",
      "myrepo:server/main.py": "myrepo:server",
      "myrepo:server": "svc:myrepo",
      "svc:myrepo": null,
    });
    const dir = out.find((n) => n.id === "myrepo:server/api/endpoints");
    expect(dir).toMatchObject({
      kind: "module",
      label: "endpoints",
      tier: "domain",
      sources: [],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    });
    expect(out.find((n) => n.id === "svc:myrepo")).toMatchObject({
      kind: "service",
      label: "myrepo",
      tier: "domain",
      sources: [],
    });
  });

  it("collapses a directory whose only child is one directory", () => {
    const out = completeHierarchy([
      node("r:iOS/App/App/Views/Home.swift", { kind: "module" }),
      node("r:iOS/App/App/Models/Note.swift", { kind: "module" }),
      node("r:iOS/App/App/Main.swift", { kind: "module" }),
      node("r:server/main.py", { kind: "module" }),
    ]);
    expect(parentsOf(out)).toEqual({
      "r:iOS/App/App/Views/Home.swift": "r:iOS/App/App/Views",
      "r:iOS/App/App/Models/Note.swift": "r:iOS/App/App/Models",
      "r:iOS/App/App/Main.swift": "r:iOS/App/App",
      "r:iOS/App/App/Views": "r:iOS/App/App",
      "r:iOS/App/App/Models": "r:iOS/App/App",
      "r:iOS/App/App": "svc:r", // iOS and iOS/App carried nothing
      "r:server/main.py": "r:server", // one child, but a file: kept
      "r:server": "svc:r",
      "svc:r": null,
    });
    expect(out.find((n) => n.id === "r:iOS/App/App")?.label).toBe("App");
    expect(out.some((n) => n.id === "r:iOS")).toBe(false);
    expect(out.some((n) => n.id === "r:iOS/App")).toBe(false);
  });

  it("leaves pack-set parents alone and never re-mints an id that exists", () => {
    const out = completeHierarchy([
      node("r:app/routes.py", { kind: "module", parent: "svc:ledger-api" }),
      node("svc:ledger-api", { kind: "service" }),
      node("r:lib/util.py", { kind: "module" }),
      node("svc:r", { kind: "service", label: "from a pack", tier: "api" }),
    ]);
    expect(parentsOf(out)).toEqual({
      "r:app/routes.py": "svc:ledger-api",
      "svc:ledger-api": null,
      "r:lib/util.py": "r:lib", // one child, but a file: kept
      "r:lib": "svc:r",
      "svc:r": null,
    });
    // A module a pack already parented contributes no directory nodes.
    expect(out.some((n) => n.id === "r:app")).toBe(false);
    expect(out.find((n) => n.id === "svc:r")).toMatchObject({
      label: "from a pack",
      tier: "api",
    });
  });

  it("keeps synthetic and fixed-scope nodes parentless", () => {
    const out = completeHierarchy([
      node("mongo:db.notes", { kind: "collection", tier: "store" }),
      node("ext:cohere/embed", { kind: "external_service", tier: "external" }),
      node("unknown:symbol:x", {
        kind: "unknown",
        confidence: "inferred",
        confidence_reason: "r",
      }),
    ]);
    expect(out.every((n) => n.parent === null)).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("is a tree that terminates at a null root, from any input order", () => {
    const base = [
      node("r:a/b/c/d.py#f"),
      node("r:a/b/c/d.py", { kind: "module" }),
      node("r:a/b/e.py", { kind: "module" }),
      node("r:x.py", { kind: "module" }),
      node("s:a/b/c/d.py", { kind: "module" }),
      node("s:a/q/w.py", { kind: "module" }),
    ];
    const canonical = completeHierarchy(base);
    const byId = new Map(canonical.map((n) => [n.id, n]));
    for (const n of canonical) {
      const seen = new Set<string>([n.id]);
      let cursor: Node | undefined = n;
      while (cursor !== undefined && cursor.parent !== null) {
        expect(seen.has(cursor.parent)).toBe(false);
        seen.add(cursor.parent);
        cursor = byId.get(cursor.parent);
        expect(cursor).toBeDefined();
      }
    }
    expect(canonical.map((n) => n.id)).toEqual(
      [...canonical.map((n) => n.id)].sort(),
    );
    const shuffled = [base[3], base[5], base[1], base[0], base[4], base[2]];
    expect(JSON.stringify(completeHierarchy(shuffled as Node[]))).toBe(
      JSON.stringify(canonical),
    );
    expect(JSON.stringify(completeHierarchy([...base].reverse()))).toBe(
      JSON.stringify(canonical),
    );
  });
});

describe("pack options are a frozen snapshot", () => {
  it("returns a deep-frozen clone, so a pack cannot change what was hashed", () => {
    const config = {
      packs: { toy: { source_roots: ["server"], nested: { k: 1 } } },
    };
    const opts = resolvePackOptions(config, "toy") as {
      source_roots: string[];
      nested: { k: number };
    };
    expect(Object.isFrozen(opts)).toBe(true);
    expect(Object.isFrozen(opts.source_roots)).toBe(true);
    expect(Object.isFrozen(opts.nested)).toBe(true);
    expect(() => {
      opts.source_roots.push("x");
    }).toThrow();
    // The config itself is untouched.
    expect(config.packs.toy.source_roots).toEqual(["server"]);
  });
});
