import { describe, expect, it } from "vitest";
import type { Node } from "../src/model/graph.js";
import {
  packOptionsHash,
  resolvePackOptions,
  tierConfigHash,
} from "../src/pipeline/config.js";
import {
  assignTiers,
  fillParents,
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
  it("fills a null parent with the module node when it exists, and only then", () => {
    const nodes = [
      node("r:a.py#f"),
      node("r:a.py", { kind: "module" }),
      node("r:b.py#g"),
      node("r:a.py#h", { parent: "svc:x" }),
      node("svc:x", { kind: "service" }),
    ];
    const out = fillParents(nodes);
    expect(out.map((n) => n.parent)).toEqual([
      "r:a.py",
      null,
      null,
      "svc:x",
      null,
    ]);
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
