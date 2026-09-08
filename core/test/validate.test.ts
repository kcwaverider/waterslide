import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GRAPH_SCHEMA_VERSION,
  type CanonicalGraph,
  type GraphArtifact,
} from "../src/model/graph.js";
import { validate } from "../src/validate.js";

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
        const codes = new Set(result.errors.map((e) => e.code));
        expect(codes.has("E_VOLATILE_SHAPE")).toBe(true);
        expect(result.errors.some((e) => e.path === "$.parsed_at")).toBe(true);
      });

      it("validates as artifact shape once the volatile fields are added", () => {
        const canonical = validate(raw, { shape: "canonical" });
        if (!canonical.ok) throw new Error("fixture not canonical-valid");
        const artifact = toArtifact(canonical.graph);
        const result = validate(artifact, { shape: "artifact" });
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("as an artifact, is rejected as canonical shape (§7.3)", () => {
        const canonical = validate(raw, { shape: "canonical" });
        if (!canonical.ok) throw new Error("fixture not canonical-valid");
        const result = validate(toArtifact(canonical.graph), {
          shape: "canonical",
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.every((e) => e.code === "E_VOLATILE_SHAPE")).toBe(
          true,
        );
        expect(result.errors.map((e) => e.path).sort()).toEqual(
          ["$", "$.repos[0]"]
            .concat(canonical.graph.repos.length > 1 ? ["$.repos[1]"] : [])
            .sort(),
        );
      });
    });
  }
});

describe("malformed fixtures", () => {
  it("number at least six, and every file has an expectation", () => {
    expect(malformedFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of malformedFiles)
      expect(expected[f], `expected.json lacks ${f}`).toBeDefined();
    for (const f of Object.keys(expected)) expect(malformedFiles).toContain(f);
  });

  for (const file of malformedFiles) {
    it(`${file} is rejected with ${expected[file]?.code ?? "?"} at ${expected[file]?.path ?? "?"}`, () => {
      const want = expected[file];
      if (want === undefined) throw new Error(`no expectation for ${file}`);
      const result = validate(readJson(`malformed/${file}`), {
        shape: "canonical",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const hit = result.errors.find(
        (e) => e.code === want.code && e.path === want.path,
      );
      expect(
        hit,
        `errors were: ${JSON.stringify(result.errors, null, 2)}`,
      ).toBeDefined();
      expect(hit?.message.length ?? 0).toBeGreaterThan(20);
    });
  }

  it("every malformed fixture is a distinct case, and every error code has one", () => {
    const whys = new Set(Object.values(expected).map((e) => e.why));
    expect(whys.size).toBe(Object.keys(expected).length);
    const contents = new Set(
      malformedFiles.map((f) =>
        readFileSync(new URL(`malformed/${f}`, fixturesDir), "utf8"),
      ),
    );
    expect(contents.size).toBe(malformedFiles.length);
    const codes = new Set(Object.values(expected).map((e) => e.code));
    for (const code of [
      "E_NOT_OBJECT",
      "E_SCHEMA_VERSION",
      "E_MISSING_KEY",
      "E_UNKNOWN_KEY",
      "E_VOLATILE_SHAPE",
      "E_ILLEGAL_ENUM",
      "E_TYPE",
      "E_RANGE",
      "E_CANONICAL_ORDER",
      "E_CANONICAL_NFC",
      "E_ID_FORMAT",
      "E_DUPLICATE_ID",
      "E_EDGE_ENDPOINT",
      "E_PARENT",
      "E_SCHEMA_REF",
      "E_CONFIDENCE_REASON",
      "E_ENTRY_POINT_KIND",
      "E_BROKEN_REASON",
      "E_FORK_SOURCE",
      "E_TOMBSTONE_SOURCE",
      "E_SOURCE_COUNT",
      "E_BRANCH_ORDINAL",
      "E_BRANCH_ORDINAL_DUPLICATE",
      "E_SKIPS_TIERS_EXCLUDED",
    ]) {
      expect(codes.has(code), `no malformed fixture exercises ${code}`).toBe(
        true,
      );
    }
  });
});

describe("invariant 17: canonical order is enforced in canonical shape only", () => {
  const base = readJson("valid/derived-ids.json") as CanonicalGraph;

  it("rejects swapped edges as canonical but accepts them as artifact", () => {
    const g = structuredClone(base);
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
    const g = structuredClone(base);
    const n = g.nodes.find((x) => x.is_entry_point);
    if (!n) throw new Error("no entry point");
    n.tags = ["b", "a"];
    n.label = n.label + " cafe\u0301";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "E_CANONICAL_NFC",
      "E_CANONICAL_ORDER",
    ]);
  });

  it("does not object to the serializer's own concerns, key order, when parsed", () => {
    const g = structuredClone(base);
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
});

describe("invariant 18: node id format", () => {
  const base = readJson("valid/single-repo-minimal.json") as CanonicalGraph;

  it("accepts all six scope forms in the valid fixtures", () => {
    const scopes = new Set<string>();
    for (const f of validFiles) {
      for (const n of (readJson(`valid/${f}`) as CanonicalGraph).nodes) {
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
      const g = structuredClone(base);
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
      g.nodes.sort((a, b) =>
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      );
      const result = validate(g, { shape: "canonical" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.errors.map((e) => e.code)).toEqual(["E_ID_FORMAT"]);
    }
  });

  it("rejects a repo-scoped node whose source.repo differs from its scope", () => {
    const g = structuredClone(base);
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
    const base = readJson("valid/derived-ids.json") as CanonicalGraph;
    const g = structuredClone(base);
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
    const base = readJson("valid/derived-ids.json") as CanonicalGraph;
    const g = structuredClone(base);
    const s0 = g.schemas[0];
    const f0 = s0?.fields[0];
    if (!s0 || !f0) throw new Error("fixture too small");
    f0.ref_schema_id = "sch_nowhere";
    const result = validate(g, { shape: "canonical" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("$.schemas[0].fields[0].ref_schema_id");
  });

  it("does not require a broken edge to point at a tombstone (handoff §5)", () => {
    const g = readJson("valid/tombstone-broken-edge.json") as CanonicalGraph;
    const brokenToLive = g.edges.filter(
      (e) =>
        e.is_broken && g.nodes.find((n) => n.id === e.to)?.kind !== "tombstone",
    );
    expect(brokenToLive.length).toBeGreaterThan(0);
    expect(validate(g, { shape: "canonical" }).ok).toBe(true);
  });
});
