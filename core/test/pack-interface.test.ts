import { describe, expect, it } from "vitest";
import { BaselineRepoSchema, BaselineSchema } from "../src/model/baseline.js";
import {
  DEFAULT_TIER_BY_KIND,
  NodeKindSchema,
  RESERVED_DIAGNOSTIC_CODES,
  TierSchema,
} from "../src/model/enums.js";
import { GRAPH_SCHEMA_VERSION } from "../src/model/graph.js";
import {
  DiagnosticSchema,
  PackManifestSchema,
  PackResultSchema,
  PartialEdgeSchema,
  ProvideSchema,
  UnresolvedRefSchema,
  assertPackCompatible,
} from "../src/model/pack.js";

describe("pack manifest (parser §3.1)", () => {
  const manifest = {
    id: "python",
    version: "0.1.0",
    graph_schema_version: GRAPH_SCHEMA_VERSION,
    extensions: [".py"],
    frameworks: ["fastapi"],
  };

  it("parses", () => {
    expect(PackManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("fails loudly, naming the pack, on a graph model version mismatch", () => {
    expect(() =>
      assertPackCompatible({
        ...manifest,
        graph_schema_version: GRAPH_SCHEMA_VERSION + 1,
      }),
    ).toThrow(/"python".*Refusing to run/s);
    expect(() => assertPackCompatible(manifest)).not.toThrow();
  });
});

describe("UnresolvedRef (parser §3.6)", () => {
  it("accepts every ref_kind, with optional hints", () => {
    for (const ref_kind of [
      "symbol",
      "http",
      "topic",
      "datastore",
      "external",
    ] as const) {
      expect(
        UnresolvedRefSchema.safeParse({ ref_kind, value: "x", source_line: 1 })
          .success,
      ).toBe(true);
    }
    expect(
      UnresolvedRefSchema.safeParse({
        ref_kind: "http",
        value: "/notes/{id}",
        hints: { method: "PUT", base_url_expr: "APIConfig.baseURL" },
        source_line: 88,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown ref_kind", () => {
    expect(
      UnresolvedRefSchema.safeParse({
        ref_kind: "grpc",
        value: "x",
        source_line: 1,
      }).success,
    ).toBe(false);
  });
});

describe("PartialEdge (parser §3.3, §3.5)", () => {
  const base = {
    from: "tapistree:ios/Services/NoteService.swift#NoteService.update",
    kind: "http_request",
    label: null,
    schema_id: null,
    response_schema_id: null,
    confidence: "certain",
    confidence_reason: null,
    condition: null,
    exclusive_group: null,
    branch_ordinal: null,
    is_error_path: false,
    source: {
      repo: "tapistree",
      path: "ios/Services/NoteService.swift",
      line_start: 88,
      line_end: null,
    },
  };

  it("accepts a resolved string target", () => {
    expect(
      PartialEdgeSchema.safeParse({
        ...base,
        to: "tapistree:api/routers/notes.py#update_note",
      }).success,
    ).toBe(true);
  });

  it("accepts an UnresolvedRef target", () => {
    expect(
      PartialEdgeSchema.safeParse({
        ...base,
        to: { ref_kind: "http", value: "/notes/{id}", source_line: 88 },
      }).success,
    ).toBe(true);
  });

  it("has no core-owned fields: id, source_count, is_broken, skips_tiers are rejected", () => {
    for (const extra of [
      { id: "e_x" },
      { source_count: 1 },
      { is_broken: false },
      { skips_tiers: [] },
    ]) {
      expect(
        PartialEdgeSchema.safeParse({ ...base, to: "x", ...extra }).success,
      ).toBe(false);
    }
  });
});

describe("Provide (parser §3.4)", () => {
  it("requires scope_path exactly when scope is file", () => {
    const ok1 = {
      name: "services.memory_service.display",
      node_id: "n",
      visibility: "public",
      scope: "global",
      scope_path: null,
    };
    const ok2 = {
      name: "display",
      node_id: "n",
      visibility: "public",
      scope: "file",
      scope_path: "api/services/notes.py",
    };
    expect(ProvideSchema.safeParse(ok1).success).toBe(true);
    expect(ProvideSchema.safeParse(ok2).success).toBe(true);
    expect(ProvideSchema.safeParse({ ...ok2, scope_path: null }).success).toBe(
      false,
    );
    expect(
      ProvideSchema.safeParse({ ...ok1, scope_path: "x.py" }).success,
    ).toBe(false);
  });
});

describe("Diagnostic (graph model §10)", () => {
  const d = {
    severity: "error",
    code: "syntax_error",
    message: "unexpected token",
    repo: "tapistree",
    path: "api/x.py",
    line: 3,
    pack: "python",
  };

  it("parses with every key present", () => {
    expect(DiagnosticSchema.parse(d)).toEqual(d);
  });

  it("allows core-emitted diagnostics with null repo/path/line/pack", () => {
    expect(
      DiagnosticSchema.safeParse({
        severity: "warning",
        code: "redundant_annotation",
        message: "m",
        repo: null,
        path: null,
        line: null,
        pack: null,
      }).success,
    ).toBe(true);
  });

  it("requires a snake_case code and rejects an omitted key", () => {
    expect(
      DiagnosticSchema.safeParse({ ...d, code: "SyntaxError" }).success,
    ).toBe(false);
    const { pack: _pack, ...missing } = d;
    expect(DiagnosticSchema.safeParse(missing).success).toBe(false);
  });

  it("reserves the five documented codes", () => {
    expect(Object.keys(RESERVED_DIAGNOSTIC_CODES).sort()).toEqual(
      [
        "recognizer_failure",
        "redundant_annotation",
        "syntax_error",
        "unresolved_ref",
        "unsupported_construct",
      ].sort(),
    );
  });
});

describe("PackResult (parser §3.3) — all five returns", () => {
  it("requires every return and rejects extras", () => {
    const empty = {
      nodes: [],
      edges: [],
      schemas: [],
      provides: [],
      diagnostics: [],
    };
    expect(PackResultSchema.safeParse(empty).success).toBe(true);
    expect(
      PackResultSchema.safeParse({
        nodes: [],
        edges: [],
        schemas: [],
        provides: [],
      }).success,
    ).toBe(false);
    expect(
      PackResultSchema.safeParse({ ...empty, entry_points: [] }).success,
    ).toBe(false);
  });
});

describe("enums and defaults (graph model §2.1, §6.1)", () => {
  it("has fifteen node kinds and seven tiers", () => {
    expect(NodeKindSchema.options).toHaveLength(15);
    expect(TierSchema.options).toHaveLength(7);
  });

  it("gives every kind a default tier except tombstone", () => {
    for (const kind of NodeKindSchema.options) {
      const tier = DEFAULT_TIER_BY_KIND[kind];
      if (kind === "tombstone") expect(tier).toBeNull();
      else expect(TierSchema.options).toContain(tier);
    }
  });
});

describe("baseline.json (persisted files §1.5)", () => {
  it("parses the documented shape", () => {
    const b = {
      schema_version: 1,
      captured_at: "2026-09-08T12:00:00.000Z",
      repos: [
        {
          name: "tapistree",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      nodes: {
        "mongo:tapistree.notes": {
          baseline_hash: "sha256:abcd",
          label: "notes",
          tier: "store",
        },
      },
      edges: ["e_dd18a22155d2d22b"],
    };
    expect(BaselineSchema.parse(b)).toEqual(b);
  });

  it("uses a repo record deliberately narrower than the graph artifact's", () => {
    expect(
      BaselineRepoSchema.safeParse({ name: "r", commit: "c" }).success,
    ).toBe(true);
    expect(
      BaselineRepoSchema.safeParse({
        name: "r",
        commit: "c",
        path: "/x",
        dirty: false,
      }).success,
    ).toBe(false);
  });
});
