import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GRAPH_SCHEMA_VERSION,
  type CanonicalGraph,
  type GraphArtifact,
} from "../src/model/graph.js";
import { validate, type ValidationErrorCode } from "../src/validate.js";

const fixturesDir = new URL("../../fixtures/", import.meta.url);
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(new URL(rel, fixturesDir), "utf8"));
const validFiles = readdirSync(new URL("valid/", fixturesDir)).filter((f) =>
  f.endsWith(".json"),
);

const expected = readJson("malformed/expected.json") as Record<
  string,
  { code: string; path: string; why: string }
>;
const malformedFiles = readdirSync(new URL("malformed/", fixturesDir)).filter(
  (f) => f.endsWith(".json") && f !== "expected.json",
);

const byteSort = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

function toArtifact(canonical: CanonicalGraph): GraphArtifact {
  return {
    schema_version: canonical.schema_version,
    parsed_at: "2026-09-08T12:00:00.000Z",
    tier_config_hash: canonical.tier_config_hash,
    repos: canonical.repos.map((r) => ({
      name: r.name,
      path: `/tmp/checkouts/${r.name}`,
      commit: r.commit,
      dirty: false,
    })),
    nodes: canonical.nodes,
    edges: canonical.edges,
    schemas: canonical.schemas,
    stats: { node_count: canonical.nodes.length },
  };
}

function load(file: string): CanonicalGraph {
  const result = validate(readJson(`valid/${file}`), { shape: "canonical" });
  if (!result.ok)
    throw new Error(`${file} is not valid: ${JSON.stringify(result.errors)}`);
  return structuredClone(result.graph);
}

describe("valid fixtures", () => {
  it("exist, and at least one is multi-repo (graph model §0)", () => {
    expect(validFiles.length).toBeGreaterThanOrEqual(3);
    const multi = validFiles.filter(
      (f) => (readJson(`valid/${f}`) as CanonicalGraph).repos.length >= 2,
    );
    expect(multi.length).toBeGreaterThanOrEqual(1);
  });

  for (const file of validFiles) {
    describe(file, () => {
      const raw = readJson(`valid/${file}`);

      it("validates as canonical shape with no errors", () => {
        const result = validate(raw, { shape: "canonical" });
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("is rejected as artifact shape because the volatile fields are absent (§7.3)", () => {
        const result = validate(raw, { shape: "artifact" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(
          new Set(result.errors.map((e) => e.code)).has("E_VOLATILE_SHAPE"),
        ).toBe(true);
        expect(result.errors.some((e) => e.path === "$.parsed_at")).toBe(true);
      });

      it("validates as artifact shape once the volatile fields are added", () => {
        const result = validate(toArtifact(load(file)), { shape: "artifact" });
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("as an artifact, is rejected as canonical shape (§7.3)", () => {
        const graph = load(file);
        const result = validate(toArtifact(graph), { shape: "canonical" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.every((e) => e.code === "E_VOLATILE_SHAPE")).toBe(
          true,
        );
        const wantPaths = [
          "$",
          ...graph.repos.map((_, i) => `$.repos[${String(i)}]`),
        ].sort();
        expect(result.errors.map((e) => e.path).sort()).toEqual(wantPaths);
      });
    });
  }

  it("collectively cover the positive cases the malformed set only negates", () => {
    const graphs = validFiles.map(load);
    const nodes = graphs.flatMap((g) => g.nodes);
    const edges = graphs.flatMap((g) => g.edges);
    const schemas = graphs.flatMap((g) => g.schemas);
    expect(
      schemas.some((s) => s.fields.some((f) => f.ref_schema_id !== null)),
      "non-null ref_schema_id",
    ).toBe(true);
    expect(
      schemas.some((s) => s.confidence !== "certain"),
      "non-certain schema",
    ).toBe(true);
    expect(
      edges.some((e) => e.kind === "publish"),
      "publish edge",
    ).toBe(true);
    expect(
      edges.some((e) => e.skips_tiers.length > 0),
      "band-skipping edge",
    ).toBe(true);
    expect(
      edges.some((e) => e.from === e.to),
      "self-loop edge",
    ).toBe(true);
    const externalByConfig = nodes.filter(
      (n) => n.tier === "external" && n.kind !== "external_service",
    );
    expect(
      externalByConfig.length,
      "node in tier external whose kind is not external_service",
    ).toBeGreaterThan(0);
    expect(
      edges.some((e) =>
        externalByConfig.some((n) => n.id === e.to || n.id === e.from),
      ),
      "an edge touching it",
    ).toBe(true);
  });
});

describe("malformed fixtures", () => {
  it("number at least six, and every file has an expectation", () => {
    expect(malformedFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of malformedFiles)
      expect(expected[f], `expected.json lacks ${f}`).toBeDefined();
    for (const f of Object.keys(expected)) expect(malformedFiles).toContain(f);
  });

  for (const file of malformedFiles) {
    it(`${file} is rejected with exactly ${expected[file]?.code ?? "?"} at ${expected[file]?.path ?? "?"}`, () => {
      const want = expected[file];
      if (want === undefined) throw new Error(`no expectation for ${file}`);
      const result = validate(readJson(`malformed/${file}`), {
        shape: "canonical",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Exactly one error: each fixture breaks exactly one rule (fixtures/malformed/README.md).
      expect(
        result.errors,
        `errors were: ${JSON.stringify(result.errors, null, 2)}`,
      ).toHaveLength(1);
      const hit = result.errors[0];
      expect(hit?.code).toBe(want.code);
      expect(hit?.path).toBe(want.path);
      expect(hit?.message.length ?? 0).toBeGreaterThan(20);
    });
  }

  it("no two fixtures share a code and path, except the documented allowlist", () => {
    // Pairs that legitimately share code@path: different branches of one invariant,
    // built from different base graphs. Kept explicit so loosening is a visible edit.
    const ALLOWED_SHARED: readonly (readonly [string, string])[] = [
      ["skips-tiers-into-tombstone.json", "skips-tiers-external-tier.json"],
    ];
    const byKey = new Map<string, string[]>();
    for (const [file, e] of Object.entries(expected)) {
      const key = `${e.code}@${e.path}`;
      byKey.set(key, [...(byKey.get(key) ?? []), file]);
    }
    for (const [key, files] of byKey) {
      if (files.length < 2) continue;
      const allowed = ALLOWED_SHARED.some(
        (pair) => files.length === 2 && pair.every((f) => files.includes(f)),
      );
      expect(
        allowed,
        `${key} is shared by ${files.join(", ")} and is not allowlisted`,
      ).toBe(true);
    }
  });

  it("every ValidationErrorCode has at least one malformed fixture", () => {
    // A Record over the code type: adding a code without updating this map is a
    // compile error, so a code can no longer lose its fixture silently.
    const COVERED: Record<ValidationErrorCode, true> = {
      E_NOT_OBJECT: true,
      E_SCHEMA_VERSION: true,
      E_MISSING_KEY: true,
      E_UNKNOWN_KEY: true,
      E_VOLATILE_SHAPE: true,
      E_ILLEGAL_ENUM: true,
      E_TYPE: true,
      E_RANGE: true,
      E_CANONICAL_ORDER: true,
      E_CANONICAL_NFC: true,
      E_ID_FORMAT: true,
      E_SOURCE_REPO: true,
      E_PARENT_CYCLE: true,
      E_DUPLICATE_ID: true,
      E_EDGE_ENDPOINT: true,
      E_PARENT: true,
      E_SCHEMA_REF: true,
      E_CONFIDENCE_REASON: true,
      E_ENTRY_POINT_KIND: true,
      E_BROKEN_REASON: true,
      E_FORK_SOURCE: true,
      E_TOMBSTONE_SOURCE: true,
      E_SOURCE_COUNT: true,
      E_BRANCH_ORDINAL: true,
      E_BRANCH_ORDINAL_DUPLICATE: true,
      E_SKIPS_TIERS_EXCLUDED: true,
    };
    const codes = new Set(Object.values(expected).map((e) => e.code));
    for (const code of Object.keys(COVERED)) {
      expect(codes.has(code), `no malformed fixture exercises ${code}`).toBe(
        true,
      );
    }
  });
});

describe("invariant 17: canonical order is enforced in canonical shape only", () => {
  it("rejects swapped edges as canonical but accepts them as artifact", () => {
    const g = load("derived-ids.json");
    const [a, b] = [g.edges[0], g.edges[1]];
    if (!a || !b) throw new Error("fixture too small");
    g.edges[0] = b;
    g.edges[1] = a;
    const canonical = validate(g, { shape: "canonical" });
    expect(canonical.ok).toBe(false);
    if (!canonical.ok)
      expect(canonical.errors.map((e) => e.code)).toEqual([
        "E_CANONICAL_ORDER",
      ]);
    expect(validate(toArtifact(g), { shape: "artifact" }).ok).toBe(true);
  });

  it("rejects unsorted scalar arrays and non-NFC strings as canonical", () => {
    const g = load("derived-ids.json");
    const n = g.nodes.find((x) => x.is_entry_point);
    if (!n) throw new Error("no entry point");
    n.tags = ["b", "a"];
    n.label = n.label + " café";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "E_CANONICAL_NFC",
      "E_CANONICAL_ORDER",
    ]);
  });

  it("does not object to the serializer's own concerns, key order, when parsed", () => {
    const g = load("derived-ids.json");
    const reordered = {
      edges: g.edges,
      schemas: g.schemas,
      nodes: g.nodes,
      repos: g.repos,
      tier_config_hash: g.tier_config_hash,
      schema_version: g.schema_version,
    };
    expect(validate(reordered, { shape: "canonical" }).ok).toBe(true);
  });

  it("reports a duplicate id once, under invariant 1, not also as an order violation", () => {
    const g = load("derived-ids.json");
    const n0 = g.nodes[0];
    if (!n0) throw new Error("fixture too small");
    g.nodes.splice(1, 0, structuredClone(n0));
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.code)).toEqual(["E_DUPLICATE_ID"]);
  });
});

describe("invariant 18: node id format", () => {
  it("accepts all six scope forms in the valid fixtures", () => {
    const scopes = new Set<string>();
    for (const f of validFiles) {
      for (const n of load(f).nodes) {
        const scope = n.id.slice(0, n.id.indexOf(":"));
        scopes.add(
          ["svc", "mongo", "sql", "topic", "ext"].includes(scope)
            ? scope
            : "{repo}",
        );
      }
    }
    expect([...scopes].sort()).toEqual([
      "ext",
      "mongo",
      "sql",
      "svc",
      "topic",
      "{repo}",
    ]);
  });

  it("rejects a mongo id without a dot, an ext id without a slash, and an id with no scope", () => {
    for (const [bad, kind, tier] of [
      ["mongo:notes", "collection", "store"],
      ["ext:cohere", "external_service", "external"],
      ["justaname", "service", "domain"],
    ] as const) {
      const g = load("single-repo-minimal.json");
      g.nodes.push({
        id: bad,
        kind,
        label: "x",
        tier,
        parent: null,
        source: null,
        confidence: "certain",
        confidence_reason: null,
        is_entry_point: false,
        entry_point_kind: null,
        is_infrastructure: false,
        tags: [],
      });
      g.nodes.sort((a, b) => byteSort(a.id, b.id));
      const result = validate(g, { shape: "canonical" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.map((e) => e.code)).toEqual(["E_ID_FORMAT"]);
    }
  });

  it("rejects a repo-scoped node whose source.repo differs from its scope", () => {
    const g = load("single-repo-minimal.json");
    const n = g.nodes.find((x) => x.source !== null);
    if (!n || !n.source) throw new Error("no sourced node");
    n.source.repo = "other";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.errors.some(
          (e) => e.code === "E_ID_FORMAT" && e.message.includes("source.repo"),
        ),
      ).toBe(true);
  });
});

describe("repos[] identity (invariants 1, 18, 19)", () => {
  it("rejects a duplicate repo name in artifact shape too", () => {
    const g = toArtifact(load("derived-ids.json"));
    const r0 = g.repos[0];
    if (!r0) throw new Error("no repos");
    g.repos = [r0, { ...r0 }, ...g.repos.slice(1)];
    const result = validate(g, { shape: "artifact" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.code)).toEqual(["E_DUPLICATE_ID"]);
  });

  it("reports a repo whose name contains ':' at the repo entry", () => {
    const g = load("derived-ids.json");
    g.repos = [...g.repos, { name: "bad:name", commit: "c" }].sort((a, b) =>
      byteSort(a.name, b.name),
    );
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.errors.some(
          (e) => e.code === "E_ID_FORMAT" && e.path.startsWith("$.repos["),
        ),
      ).toBe(true);
  });

  it("rejects a source.repo that is not in repos[] on nodes, edges and schemas", () => {
    for (const coll of ["nodes", "edges", "schemas"] as const) {
      const g = load("derived-ids.json");
      const item = g[coll].find((x) => x.source !== null);
      if (!item || !item.source) throw new Error(`no sourced ${coll}`);
      item.source.repo = "not-a-repo";
      const result = validate(g, { shape: "canonical" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some(
            (e) =>
              e.code === "E_SOURCE_REPO" && e.path.startsWith(`$.${coll}[`),
          ),
        ).toBe(true);
    }
  });
});

describe("parent chain (invariant 20)", () => {
  it("rejects a two-node parent cycle at both members", () => {
    const g = load("derived-ids.json");
    const a = g.nodes.find(
      (n) => n.kind === "module" && n.id.startsWith("tapistree:api/routers"),
    );
    const b = g.nodes.find(
      (n) => n.kind === "module" && n.id.startsWith("tapistree:api/services"),
    );
    if (!a || !b) throw new Error("fixture shape changed");
    a.parent = b.id;
    b.parent = a.id;
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.errors.filter((e) => e.code === "E_PARENT_CYCLE"),
      ).toHaveLength(2);
  });

  it("keeps self-loop edges legal: a recursive function is a real thing", () => {
    const g = load("annotated-edge.json");
    expect(g.edges.some((e) => e.from === e.to)).toBe(true);
    expect(validate(g, { shape: "canonical" }).ok).toBe(true);
  });
});

describe("version check", () => {
  it("fails loudly and alone on a version mismatch, before any other check", () => {
    const base = readJson("valid/derived-ids.json") as CanonicalGraph;
    const result = validate(
      { ...base, schema_version: GRAPH_SCHEMA_VERSION + 1, nodes: "garbage" },
      { shape: "canonical" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("E_SCHEMA_VERSION");
    expect(result.errors[0]?.message).toContain("Refusing");
  });

  it("rejects a missing version the same way", () => {
    const result = validate({ nodes: [] }, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("E_SCHEMA_VERSION");
  });
});

describe("error reporting", () => {
  it("collects every semantic error rather than stopping at the first", () => {
    const g = load("derived-ids.json");
    const e0 = g.edges[0];
    const n0 = g.nodes[0];
    if (!e0 || !n0) throw new Error("fixture too small");
    e0.to = "nowhere";
    e0.schema_id = "sch_nowhere";
    n0.parent = "nowhere-else";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "E_EDGE_ENDPOINT",
      "E_PARENT",
      "E_SCHEMA_REF",
    ]);
  });

  it("returns paths in JSONPath form", () => {
    const g = load("derived-ids.json");
    const f0 = g.schemas[0]?.fields[0];
    if (!f0) throw new Error("fixture too small");
    f0.ref_schema_id = "sch_nowhere";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("$.schemas[0].fields[0].ref_schema_id");
  });

  it("does not require a broken edge to point at a tombstone (handoff §5)", () => {
    const g = load("tombstone-broken-edge.json");
    const brokenToLive = g.edges.filter(
      (e) =>
        e.is_broken && g.nodes.find((n) => n.id === e.to)?.kind !== "tombstone",
    );
    expect(brokenToLive.length).toBeGreaterThan(0);
    expect(validate(g, { shape: "canonical" }).ok).toBe(true);
  });
});
