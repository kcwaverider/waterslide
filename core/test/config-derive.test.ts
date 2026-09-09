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
