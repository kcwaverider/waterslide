import type { z } from "zod";
import { SKIPS_TIERS_EXCLUDED_KINDS } from "./model/enums.js";
import {
  CanonicalGraphSchema,
  GRAPH_SCHEMA_VERSION,
  GraphArtifactSchema,
  VOLATILE_REPO_KEYS,
  VOLATILE_TOP_LEVEL_KEYS,
  type CanonicalGraph,
  type Edge,
  type GraphArtifact,
  type Node,
  type PayloadSchema,
} from "./model/graph.js";

/**
 * The validator — handoff §5, invariants 1–16, plus the loud version check
 * (§5.2) and the explicit shape (graph model §7.3).
 *
 * The caller names the shape. There is no default: an unlabelled call is a type
 * error, because discriminating by presence would silently weaken invariant 12
 * for exactly the volatile fields.
 */

export type GraphShape = "canonical" | "artifact";

export type ValidationErrorCode =
  | "E_NOT_OBJECT"
  | "E_SCHEMA_VERSION"
  | "E_MISSING_KEY"
  | "E_UNKNOWN_KEY"
  | "E_VOLATILE_SHAPE"
  | "E_ILLEGAL_ENUM"
  | "E_TYPE"
  | "E_DUPLICATE_ID"
  | "E_EDGE_ENDPOINT"
  | "E_PARENT"
  | "E_SCHEMA_REF"
  | "E_CONFIDENCE_REASON"
  | "E_ENTRY_POINT_KIND"
  | "E_BROKEN_REASON"
  | "E_FORK_SOURCE"
  | "E_TOMBSTONE_SOURCE"
  | "E_SOURCE_COUNT"
  | "E_BRANCH_ORDINAL"
  | "E_BRANCH_ORDINAL_DUPLICATE"
  | "E_SKIPS_TIERS_EXCLUDED";

export interface ValidationError {
  readonly code: ValidationErrorCode;
  /** JSONPath-style location, e.g. `$.edges[3].to`. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly graph: T; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export function validate(
  input: unknown,
  options: { shape: "canonical" },
): ValidationResult<CanonicalGraph>;
export function validate(
  input: unknown,
  options: { shape: "artifact" },
): ValidationResult<GraphArtifact>;
export function validate(
  input: unknown,
  options: { shape: GraphShape },
): ValidationResult<CanonicalGraph> | ValidationResult<GraphArtifact> {
  const { shape } = options;

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail([
      {
        code: "E_NOT_OBJECT",
        path: "$",
        message: "graph must be a JSON object",
      },
    ]);
  }

  // Version first, and alone: nothing else is meaningful across a version gap,
  // and a mismatch must fail loudly rather than as one issue among fifty.
  const version = (input as { schema_version?: unknown }).schema_version;
  if (version !== GRAPH_SCHEMA_VERSION) {
    return fail([
      {
        code: "E_SCHEMA_VERSION",
        path: "$.schema_version",
        message: `graph model version mismatch: expected ${String(GRAPH_SCHEMA_VERSION)}, got ${JSON.stringify(version)}. Refusing to validate a graph from a different model version.`,
      },
    ]);
  }

  const parsed =
    shape === "canonical"
      ? CanonicalGraphSchema.safeParse(input, { reportInput: true })
      : GraphArtifactSchema.safeParse(input, { reportInput: true });
  if (!parsed.success) {
    return fail(parsed.error.issues.map((issue) => mapIssue(issue, shape)));
  }

  const semantic = checkInvariants(parsed.data);
  if (semantic.length > 0) return fail(semantic);

  return shape === "canonical"
    ? { ok: true, graph: parsed.data as CanonicalGraph, errors: [] }
    : { ok: true, graph: parsed.data as GraphArtifact, errors: [] };
}

function fail(errors: ValidationError[]): {
  ok: false;
  errors: ValidationError[];
} {
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Structural issues (Zod) → invariants 5, 11, 12 and the §7.3 shape rule.
// ---------------------------------------------------------------------------

function formatPath(segments: readonly PropertyKey[]): string {
  let out = "$";
  for (const seg of segments) {
    out += typeof seg === "number" ? `[${String(seg)}]` : `.${String(seg)}`;
  }
  return out;
}

function isVolatilePath(
  segments: readonly PropertyKey[],
  key: string,
): boolean {
  if (segments.length === 0) return VOLATILE_TOP_LEVEL_KEYS.has(key);
  return (
    segments.length === 2 &&
    segments[0] === "repos" &&
    VOLATILE_REPO_KEYS.has(key)
  );
}

function mapIssue(issue: z.core.$ZodIssue, shape: GraphShape): ValidationError {
  const path = formatPath(issue.path);

  if (issue.code === "unrecognized_keys") {
    const volatile = issue.keys.filter((k) => isVolatilePath(issue.path, k));
    if (volatile.length > 0) {
      return {
        code: "E_VOLATILE_SHAPE",
        path,
        message: `shape "${shape}" forbids volatile field(s) ${volatile.map((k) => `"${k}"`).join(", ")} (graph model §7.3)`,
      };
    }
    return {
      code: "E_UNKNOWN_KEY",
      path,
      message: `unknown key(s): ${issue.keys.join(", ")}`,
    };
  }

  if (issue.code === "invalid_type" && issue.input === undefined) {
    const key = issue.path.at(-1);
    if (
      typeof key === "string" &&
      isVolatilePath(issue.path.slice(0, -1), key)
    ) {
      return {
        code: "E_VOLATILE_SHAPE",
        path,
        message: `shape "${shape}" requires volatile field "${key}" to be present (graph model §7.3)`,
      };
    }
    return {
      code: "E_MISSING_KEY",
      path,
      message: `required key is absent; expected ${issue.expected}. Keys are never omitted, only nulled (graph model §2.5)`,
    };
  }

  if (issue.code === "invalid_value") {
    return {
      code: "E_ILLEGAL_ENUM",
      path,
      message: `illegal value ${JSON.stringify(issue.input)}; expected one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`,
    };
  }

  return { code: "E_TYPE", path, message: issue.message };
}

// ---------------------------------------------------------------------------
// Semantic invariants — handoff §5, rows 1–4, 6–10, 13–16.
// ---------------------------------------------------------------------------

function checkInvariants(
  graph: CanonicalGraph | GraphArtifact,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const err = (
    code: ValidationErrorCode,
    path: string,
    message: string,
  ): void => {
    errors.push({ code, path, message });
  };

  // 1. Unique ids.
  const nodesById = indexUnique(graph.nodes, "nodes", err);
  indexUnique(graph.edges, "edges", err);
  const schemasById = indexUnique(graph.schemas, "schemas", err);

  graph.nodes.forEach((node, i) => {
    const p = `$.nodes[${String(i)}]`;

    // 3. Parent resolves.
    if (node.parent !== null && !nodesById.has(node.parent)) {
      err(
        "E_PARENT",
        `${p}.parent`,
        `parent "${node.parent}" does not resolve to a node`,
      );
    }
    // 6. Non-certain → reason.
    checkReason(node, `${p}`, err);
    // 7. Entry point → kind.
    if (node.is_entry_point && node.entry_point_kind === null) {
      err(
        "E_ENTRY_POINT_KIND",
        `${p}.entry_point_kind`,
        `node "${node.id}" is an entry point but has no entry_point_kind`,
      );
    }
    // 10. Tombstone → no source.
    if (node.kind === "tombstone" && node.source !== null) {
      err(
        "E_TOMBSTONE_SOURCE",
        `${p}.source`,
        `tombstone "${node.id}" must have source: null — its definition is gone (graph model §5.1)`,
      );
    }
  });

  const ordinalsByGroup = new Map<string, Map<number, string>>();

  graph.edges.forEach((edge, i) => {
    const p = `$.edges[${String(i)}]`;

    // 2. Endpoints resolve.
    if (!nodesById.has(edge.from))
      err(
        "E_EDGE_ENDPOINT",
        `${p}.from`,
        `edge "${edge.id}" from "${edge.from}" does not resolve to a node`,
      );
    if (!nodesById.has(edge.to))
      err(
        "E_EDGE_ENDPOINT",
        `${p}.to`,
        `edge "${edge.id}" to "${edge.to}" does not resolve to a node`,
      );

    // 4. Schema references resolve (non-null only).
    for (const key of ["schema_id", "response_schema_id"] as const) {
      const ref = edge[key];
      if (ref !== null && !schemasById.has(ref))
        err(
          "E_SCHEMA_REF",
          `${p}.${key}`,
          `${key} "${ref}" does not resolve to a schema`,
        );
    }

    // 6.
    checkReason(edge, p, err);

    // 8. Broken → reason.
    if (edge.is_broken && edge.broken_reason === null) {
      err(
        "E_BROKEN_REASON",
        `${p}.broken_reason`,
        `edge "${edge.id}" is broken but has no broken_reason`,
      );
    }

    // 9. Fork → source.
    if (edge.exclusive_group !== null && edge.source === null) {
      err(
        "E_FORK_SOURCE",
        `${p}.source`,
        `edge "${edge.id}" is in exclusive_group "${edge.exclusive_group}" but has no source; a branch exists at a place in a file (graph model §3.2)`,
      );
    }

    // 13. source ⟺ source_count.
    if ((edge.source === null) !== (edge.source_count === 0)) {
      err(
        "E_SOURCE_COUNT",
        `${p}.source_count`,
        `edge "${edge.id}" has source ${edge.source === null ? "null" : "non-null"} but source_count ${String(edge.source_count)}; source == null iff source_count == 0 (graph model §3.3)`,
      );
    }

    // 14. branch_ordinal ⟺ exclusive_group.
    if ((edge.branch_ordinal === null) !== (edge.exclusive_group === null)) {
      err(
        "E_BRANCH_ORDINAL",
        `${p}.branch_ordinal`,
        `edge "${edge.id}" must have branch_ordinal non-null exactly when exclusive_group is non-null (graph model §3.3)`,
      );
    }

    // 15. branch_ordinal unique within group.
    if (edge.exclusive_group !== null && edge.branch_ordinal !== null) {
      const seen =
        ordinalsByGroup.get(edge.exclusive_group) ?? new Map<number, string>();
      const prior = seen.get(edge.branch_ordinal);
      if (prior !== undefined) {
        err(
          "E_BRANCH_ORDINAL_DUPLICATE",
          `${p}.branch_ordinal`,
          `branch_ordinal ${String(edge.branch_ordinal)} in exclusive_group "${edge.exclusive_group}" is already used by edge "${prior}"`,
        );
      } else {
        seen.set(edge.branch_ordinal, edge.id);
        ordinalsByGroup.set(edge.exclusive_group, seen);
      }
    }

    // 16. skips_tiers empty for excluded endpoints.
    if (edge.skips_tiers.length > 0) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const excluded = [from, to].find(
        (n) =>
          n !== undefined &&
          (SKIPS_TIERS_EXCLUDED_KINDS.has(n.kind) || n.tier === "external"),
      );
      if (excluded !== undefined) {
        err(
          "E_SKIPS_TIERS_EXCLUDED",
          `${p}.skips_tiers`,
          `edge "${edge.id}" touches "${excluded.id}" (kind ${excluded.kind}, tier ${excluded.tier}), so skips_tiers must be empty (graph model §3.4)`,
        );
      }
    }
  });

  graph.schemas.forEach((schema, i) => {
    const p = `$.schemas[${String(i)}]`;
    checkReason(schema, p, err);
    schema.fields.forEach((field, j) => {
      if (
        field.ref_schema_id !== null &&
        !schemasById.has(field.ref_schema_id)
      ) {
        err(
          "E_SCHEMA_REF",
          `${p}.fields[${String(j)}].ref_schema_id`,
          `ref_schema_id "${field.ref_schema_id}" does not resolve to a schema`,
        );
      }
    });
  });

  return errors;
}

function indexUnique<T extends { id: string }>(
  items: readonly T[],
  collection: string,
  err: (code: ValidationErrorCode, path: string, message: string) => void,
): Map<string, T> {
  const byId = new Map<string, T>();
  items.forEach((item, i) => {
    if (byId.has(item.id)) {
      err(
        "E_DUPLICATE_ID",
        `$.${collection}[${String(i)}].id`,
        `duplicate ${collection.slice(0, -1)} id "${item.id}"`,
      );
    } else {
      byId.set(item.id, item);
    }
  });
  return byId;
}

function checkReason(
  entity: Pick<
    Node | Edge | PayloadSchema,
    "id" | "confidence" | "confidence_reason"
  >,
  path: string,
  err: (code: ValidationErrorCode, path: string, message: string) => void,
): void {
  if (entity.confidence !== "certain" && entity.confidence_reason === null) {
    err(
      "E_CONFIDENCE_REASON",
      `${path}.confidence_reason`,
      `"${entity.id}" is ${entity.confidence} but has no confidence_reason; every non-certain entity explains itself (graph model §5)`,
    );
  }
}
