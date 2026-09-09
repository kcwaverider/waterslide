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
  NodeUpdateSchema,
  PROVIDE_ALIAS_MAX_DEPTH,
  PackManifestSchema,
  PackOptionsSchema,
  PackPatchSchema,
  PackResultSchema,
  PartialEdgeSchema,
  PerFileResultSchema,
  ProvideSchema,
  UnresolvedRefSchema,
  assertPackCompatible,
  type LanguagePack,
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
        hints: {
          method: "PUT",
          base_url_expr: "APIConfig.baseURL",
          query: null,
        },
        source_line: 88,
      }).success,
    ).toBe(true);
  });

  it("types hints per ref_kind: every key present, null where unseen, no extras", () => {
    const ok = (ref_kind: string, hints: unknown): boolean =>
      UnresolvedRefSchema.safeParse({
        ref_kind,
        value: "x",
        source_line: 1,
        hints,
      }).success;
    expect(ok("symbol", { arity: 2, receiver_type: null })).toBe(true);
    expect(ok("symbol", { arity: 2 })).toBe(false);
    expect(
      ok("http", { method: "PUT", base_url_expr: null, query: "q=1" }),
    ).toBe(true);
    expect(ok("http", { method: "PUT", base_url_expr: null })).toBe(false);
    expect(ok("topic", { direction: "publish" })).toBe(true);
    expect(ok("topic", { direction: "emit" })).toBe(false);
    expect(
      ok("datastore", { operation: "write", store: "mongo", namespace: null }),
    ).toBe(true);
    expect(
      ok("datastore", { operation: "write", store: "redis", namespace: null }),
    ).toBe(false);
    expect(ok("datastore", { operation: "write", store: "mongo" })).toBe(false);
    expect(ok("external", { sdk_symbol: "cohere.Client.embed" })).toBe(true);
    expect(ok("external", { sdk_symbol: null, extra: 1 })).toBe(false);
    // Hints from a different ref_kind are rejected, not silently ignored.
    expect(
      ok("symbol", { method: "PUT", base_url_expr: null, query: null }),
    ).toBe(false);
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
  const ok1 = {
    name: "services.memory_service.display",
    node_id: "n",
    alias_of: null,
    ref_kind: "symbol",
    visibility: "public",
    scope: "global",
    scope_path: null,
  };
  const ok2 = {
    name: "display",
    node_id: "n",
    alias_of: null,
    ref_kind: "symbol",
    visibility: "public",
    scope: "file",
    scope_path: "api/services/notes.py",
  };

  it("requires scope_path exactly when scope is file", () => {
    expect(ProvideSchema.safeParse(ok1).success).toBe(true);
    expect(ProvideSchema.safeParse(ok2).success).toBe(true);
    expect(ProvideSchema.safeParse({ ...ok2, scope_path: null }).success).toBe(
      false,
    );
    expect(
      ProvideSchema.safeParse({ ...ok1, scope_path: "x.py" }).success,
    ).toBe(false);
  });

  it("requires ref_kind, from the UnresolvedRef enum", () => {
    const { ref_kind: _k, ...missing } = ok1;
    expect(ProvideSchema.safeParse(missing).success).toBe(false);
    expect(ProvideSchema.safeParse({ ...ok1, ref_kind: "grpc" }).success).toBe(
      false,
    );
    expect(
      ProvideSchema.safeParse({
        ...ok1,
        ref_kind: "http",
        name: "PUT /notes/{id}",
      }).success,
    ).toBe(true);
  });

  it("targets a node or aliases a name, never both or neither", () => {
    expect(
      ProvideSchema.safeParse({
        ...ok1,
        node_id: null,
        alias_of: "services.memory_service.display",
      }).success,
    ).toBe(true);
    expect(
      ProvideSchema.safeParse({ ...ok1, node_id: null, alias_of: null })
        .success,
    ).toBe(false);
    expect(ProvideSchema.safeParse({ ...ok1, alias_of: "other" }).success).toBe(
      false,
    );
    const { alias_of: _a, ...missing } = ok1;
    expect(ProvideSchema.safeParse(missing).success).toBe(false);
  });
});

describe("PerFileResult, PackPatch and NodeUpdate (compose hook)", () => {
  const empty = {
    nodes: [],
    edges: [],
    schemas: [],
    provides: [],
    diagnostics: [],
  };

  it("PerFileResult carries repo, path and one PackResult", () => {
    expect(
      PerFileResultSchema.safeParse({ repo: "r", path: "a.py", result: empty })
        .success,
    ).toBe(true);
    expect(
      PerFileResultSchema.safeParse({ repo: "r", result: empty }).success,
    ).toBe(false);
  });

  it("PackPatch requires every collection, node_updates included", () => {
    expect(
      PackPatchSchema.safeParse({ ...empty, node_updates: [] }).success,
    ).toBe(true);
    expect(PackPatchSchema.safeParse(empty).success).toBe(false);
  });

  it("NodeUpdate may omit a field to leave it unchanged, and cannot carry id or kind", () => {
    expect(
      NodeUpdateSchema.safeParse({ node_id: "n", add_sources: [] }).success,
    ).toBe(true);
    expect(
      NodeUpdateSchema.safeParse({
        node_id: "n",
        add_sources: [],
        parent: null,
        label: "L",
        is_entry_point: true,
        entry_point_kind: "http_route",
        tags: ["t"],
      }).success,
    ).toBe(true);
    expect(
      NodeUpdateSchema.safeParse({ node_id: "n", add_sources: [], id: "m" })
        .success,
    ).toBe(false);
    expect(
      NodeUpdateSchema.safeParse({
        node_id: "n",
        add_sources: [],
        kind: "function",
      }).success,
    ).toBe(false);
    expect(NodeUpdateSchema.safeParse({ node_id: "n" }).success).toBe(false);
  });

  it("caps alias chains at eight hops", () => {
    expect(PROVIDE_ALIAS_MAX_DEPTH).toBe(8);
  });

  it("LanguagePack: options on every call, compose synchronous", () => {
    // A compile-time check as much as a runtime one: this literal must satisfy
    // the interface with four-argument parse and a non-Promise compose.
    const pack: LanguagePack = {
      manifest: {
        id: "t",
        version: "0",
        graph_schema_version: 1,
        extensions: [".t"],
        frameworks: [],
      },
      parse: (_repo, _path, _content, options) => ({
        ...empty,
        diagnostics: [
          {
            severity: "info",
            code: "saw_options",
            message: JSON.stringify(options),
            repo: null,
            path: null,
            line: null,
            pack: "t",
          },
        ],
      }),
      compose: (results, _options) => ({
        ...empty,
        node_updates: results.map((r) => ({
          node_id: `${r.repo}:${r.path}`,
          add_sources: [],
        })),
      }),
      rePath: (result, repo, path, _options) => ({ ...result, repo, path }),
    };
    const parsed = pack.parse("r", "a.t", "", { source_roots: ["server"] });
    expect(parsed).not.toBeInstanceOf(Promise);
    const patch = pack.compose?.(
      [{ repo: "r", path: "a.t", result: empty }],
      {},
    );
    expect(patch?.node_updates.map((u) => u.node_id)).toEqual(["r:a.t"]);
    expect(
      PackOptionsSchema.safeParse({ source_roots: ["server"] }).success,
    ).toBe(true);
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

  it("reserves the documented codes", () => {
    expect(Object.keys(RESERVED_DIAGNOSTIC_CODES).sort()).toEqual(
      [
        "recognizer_failure",
        "redundant_annotation",
        "syntax_error",
        "unresolved_ref",
        "unsupported_construct",
        "undeclared_datastore_namespace",
        "unresolvable_provide_alias",
        "rejected_pack_patch",
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
  it("has sixteen node kinds and seven tiers", () => {
    expect(NodeKindSchema.options).toHaveLength(16);
    expect(NodeKindSchema.options).toContain("unknown");
    expect(TierSchema.options).toHaveLength(7);
  });

  it("gives every kind a default tier except tombstone and unknown, which inherit", () => {
    for (const kind of NodeKindSchema.options) {
      const tier = DEFAULT_TIER_BY_KIND[kind];
      if (kind === "tombstone" || kind === "unknown") expect(tier).toBeNull();
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
