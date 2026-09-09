import type { z } from "zod";
import { byteCompare, spanCompare } from "./canonical.js";
import {
  FIXED_ID_SCOPES,
  RefKindSchema,
  SKIPS_TIERS_EXCLUDED_KINDS,
  UNKNOWN_SCOPE,
} from "./model/enums.js";
import { parseUnknownNodeId } from "./unknown-id.js";
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
 * The validator — every invariant in the handoff §5 table, plus the loud version check
 * (§5.2) and the explicit shape (graph model §7.3).
 *
 * The caller names the shape. There is no default: an unlabelled call is a type
 * error, because discriminating by presence would silently weaken invariant 12
 * for exactly the volatile fields.
 *
 * Errors are collected within a phase, not across phases (§7.3): a structural
 * failure returns before the semantic phase runs.
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
  | "E_RANGE"
  | "E_CANONICAL_ORDER"
  | "E_CANONICAL_NFC"
  | "E_ID_FORMAT"
  | "E_SOURCE_REPO"
  | "E_PARENT_CYCLE"
  | "E_TOMBSTONE_CONFIDENCE"
  | "E_DUPLICATE_VALUE"
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
  | "E_BRANCH_ORDINAL_GAP"
  | "E_SKIPS_TIERS_EXCLUDED"
  | "E_UNKNOWN_NODE";

export interface ValidationError {
  readonly code: ValidationErrorCode;
  /** JSONPath-style location, e.g. `$.edges[3].to`. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly graph: T; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

type Report = (
  code: ValidationErrorCode,
  path: string,
  message: string,
) => void;

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

  // Structural phase.
  const parsed =
    shape === "canonical"
      ? CanonicalGraphSchema.safeParse(input, { reportInput: true })
      : GraphArtifactSchema.safeParse(input, { reportInput: true });
  if (!parsed.success) {
    return fail(parsed.error.issues.map((issue) => mapIssue(issue, shape)));
  }

  // Semantic phase. Runs only once the structural phase has passed: the checks
  // below index by id and dereference fields, which is unsafe on a graph that
  // failed to parse. A graph with both kinds of error therefore reports the
  // structural ones first and the semantic ones on the next run (§7.3).
  const semantic = checkInvariants(parsed.data, shape);
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

  if (issue.code === "too_small" || issue.code === "too_big") {
    return { code: "E_RANGE", path, message: issue.message };
  }

  return { code: "E_TYPE", path, message: issue.message };
}

// ---------------------------------------------------------------------------
// Semantic invariants — the handoff §5 table, minus the rows Zod covers (5, 11, 12).
// ---------------------------------------------------------------------------

function checkInvariants(
  graph: CanonicalGraph | GraphArtifact,
  shape: GraphShape,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const err: Report = (code, path, message) => {
    errors.push({ code, path, message });
  };

  // 1 (repos) and 18 (repos). A repo name is an identity and an id scope.
  const repoNames = new Set<string>();
  graph.repos.forEach((repo, i) => {
    const p = `$.repos[${String(i)}].name`;
    if (repoNames.has(repo.name)) {
      err(
        "E_DUPLICATE_ID",
        p,
        `duplicate repo name "${repo.name}"; node ids scoped to it would be ambiguous`,
      );
    } else {
      repoNames.add(repo.name);
    }
    if (FIXED_ID_SCOPES.has(repo.name)) {
      err(
        "E_ID_FORMAT",
        p,
        `repo name "${repo.name}" collides with a fixed id scope; node ids would be ambiguous (graph model §1)`,
      );
    } else if (repo.name.length === 0 || repo.name.includes(":")) {
      err(
        "E_ID_FORMAT",
        p,
        `repo name ${JSON.stringify(repo.name)} cannot be an id scope: it must be non-empty and contain no ":" (graph model §1)`,
      );
    }
  });

  // 1. Unique ids.
  const nodesById = indexUnique(graph.nodes, "nodes", err);
  indexUnique(graph.edges, "edges", err);
  const schemasById = indexUnique(graph.schemas, "schemas", err);

  // 18. Node ids are `{scope}:{locator}` (graph model §1).
  graph.nodes.forEach((node, i) =>
    checkNodeId(node, repoNames, `$.nodes[${String(i)}]`, err),
  );

  // 19. Every source.repo names a repo in repos[] (graph model §2.4).
  const checkSourceRepo = (
    source: { repo: string } | null,
    path: string,
    nested = true,
  ): void => {
    if (source !== null && !repoNames.has(source.repo)) {
      err(
        "E_SOURCE_REPO",
        nested ? `${path}.source.repo` : `${path}.repo`,
        `source.repo "${source.repo}" is not a repo in repos[] (graph model §2.4)`,
      );
    }
  };
  graph.nodes.forEach((n, i) =>
    n.sources.forEach((span, j) =>
      checkSourceRepo(
        span,
        `$.nodes[${String(i)}].sources[${String(j)}]`,
        false,
      ),
    ),
  );
  graph.edges.forEach((e, i) =>
    checkSourceRepo(e.source, `$.edges[${String(i)}]`),
  );
  graph.schemas.forEach((sc, i) =>
    checkSourceRepo(sc.source, `$.schemas[${String(i)}]`),
  );

  // 17. Canonical order, canonical shape only (graph model §7.2).
  if (shape === "canonical") checkCanonicalOrder(graph, err);

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
    // 6. Non-certain → reason. Tombstones are covered by 22 and unknown nodes
    // by 24; both subsume this.
    if (node.kind !== "tombstone" && node.kind !== "unknown")
      checkReason(node, p, err);
    // 7. Entry point → kind.
    if (node.is_entry_point && node.entry_point_kind === null) {
      err(
        "E_ENTRY_POINT_KIND",
        `${p}.entry_point_kind`,
        `node "${node.id}" is an entry point but has no entry_point_kind`,
      );
    }
    // 10. Tombstone → no defining span.
    if (node.kind === "tombstone" && node.sources.length > 0) {
      err(
        "E_TOMBSTONE_SOURCE",
        `${p}.sources`,
        `tombstone "${node.id}" must have sources: [] — its definition is gone (graph model §5.1)`,
      );
    }
    // 22. Tombstone → inferred, with a reason. It appears nowhere in source.
    if (
      node.kind === "tombstone" &&
      (node.confidence !== "inferred" || node.confidence_reason === null)
    ) {
      err(
        "E_TOMBSTONE_CONFIDENCE",
        `${p}.confidence`,
        `tombstone "${node.id}" must be inferred with a confidence_reason; it is reconstructed from the baseline and the parser never saw it (graph model §5.1)`,
      );
    }
    // 24. Unknown → no defining span, inferred, with a reason. It is minted for
    // a reference that matched nothing, so `certain` or a source would claim
    // the parser saw a definition it definitionally did not.
    if (node.kind === "unknown") {
      if (node.sources.length > 0) {
        err(
          "E_UNKNOWN_NODE",
          `${p}.sources`,
          `unknown node "${node.id}" must have sources: [] — it stands in for a reference that matched no definition (invariant 24)`,
        );
      }
      if (node.confidence !== "inferred") {
        err(
          "E_UNKNOWN_NODE",
          `${p}.confidence`,
          `unknown node "${node.id}" must be inferred, not ${node.confidence}; the parser never saw its definition (invariant 24)`,
        );
      }
      if (node.confidence_reason === null) {
        err(
          "E_UNKNOWN_NODE",
          `${p}.confidence_reason`,
          `unknown node "${node.id}" must carry a confidence_reason naming the unresolved reference and where it originated (invariant 24)`,
        );
      }
    }
    // 21. line_end never precedes line_start, per span.
    node.sources.forEach((span, j) =>
      checkLineRange(span, `${p}.sources[${String(j)}]`, err),
    );
    // 23. No duplicate tags.
    checkUnique(node.tags, `${p}.tags`, "tags", err);
  });

  // 20. The parent chain is acyclic (graph model §2.3). A self-parent is the
  // degenerate case; any cycle breaks zoom aggregation.
  graph.nodes.forEach((node, i) => {
    const chain: string[] = [node.id];
    let cursor: Node | undefined = node;
    while (cursor !== undefined && cursor.parent !== null) {
      const next: Node | undefined = nodesById.get(cursor.parent);
      if (next === undefined) break; // unresolved parents are invariant 3's report
      if (next.id === node.id) {
        err(
          "E_PARENT_CYCLE",
          `$.nodes[${String(i)}].parent`,
          `parent chain of "${node.id}" cycles: ${[...chain, next.id].join(" → ")} (graph model §2.3)`,
        );
        break;
      }
      if (chain.includes(next.id)) break; // a cycle not containing this node is reported by its own members
      chain.push(next.id);
      cursor = next;
    }
  });

  // 15. Ordinals within a group are contiguous from 0. Collected per group in
  // array order; the gap is reported once, at the first edge past it.
  const ordinalsByGroup = new Map<
    string,
    { ordinal: number; index: number }[]
  >();

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

    // 21. line_end never precedes line_start.
    checkLineRange(edge.source, `${p}.source`, err);
    // 23. No duplicate skips_tiers.
    checkUnique(edge.skips_tiers, `${p}.skips_tiers`, "skips_tiers", err);

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

    // 15. Collect ordinals; the contiguity check runs after the loop.
    if (edge.exclusive_group !== null && edge.branch_ordinal !== null) {
      const list = ordinalsByGroup.get(edge.exclusive_group) ?? [];
      list.push({ ordinal: edge.branch_ordinal, index: i });
      ordinalsByGroup.set(edge.exclusive_group, list);
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

  // 15. branch_ordinal is the zero-based position of the ALTERNATIVE within
  // its exclusive_group, in source order. Two edges from one alternative share
  // an ordinal — the fork edge-id key already includes `to`, so they stay
  // distinct — but the ordinals present must run 0, 1, 2… with no gaps, or the
  // count of alternatives cannot be read from the group.
  for (const [group, entries] of ordinalsByGroup) {
    const present = [...new Set(entries.map((e) => e.ordinal))].sort(
      (a, b) => a - b,
    );
    const firstGap = present.findIndex((o, k) => o !== k);
    if (firstGap === -1) continue;
    const missing = firstGap; // present[firstGap] > firstGap, so this value is absent
    const offender = entries
      .filter((e) => e.ordinal > missing)
      .sort((a, b) => a.ordinal - b.ordinal || a.index - b.index)[0];
    if (offender === undefined) continue;
    err(
      "E_BRANCH_ORDINAL_GAP",
      `$.edges[${String(offender.index)}].branch_ordinal`,
      `exclusive_group "${group}" has branch_ordinal ${String(offender.ordinal)} but no ${String(missing)}; ordinals are the zero-based positions of alternatives in source order and must be contiguous from 0 (graph model §3.3)`,
    );
  }

  graph.schemas.forEach((schema, i) => {
    const p = `$.schemas[${String(i)}]`;
    checkReason(schema, p, err);
    checkLineRange(schema.source, `${p}.source`, err);
    schema.fields.forEach((field, j) => {
      checkUnique(
        field.classification,
        `${p}.fields[${String(j)}].classification`,
        "classification",
        err,
      );
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

  // One defect, one error: a check that fires identically more than once for the
  // same location (two foreign-repo spans on one node, say) reports it once.
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.code}@${e.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function indexUnique<T extends { id: string }>(
  items: readonly T[],
  collection: string,
  err: Report,
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
  err: Report,
): void {
  if (entity.confidence !== "certain" && entity.confidence_reason === null) {
    err(
      "E_CONFIDENCE_REASON",
      `${path}.confidence_reason`,
      `"${entity.id}" is ${entity.confidence} but has no confidence_reason; every non-certain entity explains itself (graph model §5)`,
    );
  }
}

// ---------------------------------------------------------------------------
// 18. Id format — graph model §1.
// ---------------------------------------------------------------------------

function checkNodeId(
  node: Node,
  repoNames: ReadonlySet<string>,
  path: string,
  err: Report,
): void {
  const colon = node.id.indexOf(":");
  if (colon <= 0 || colon === node.id.length - 1) {
    err(
      "E_ID_FORMAT",
      `${path}.id`,
      `node id "${node.id}" is not of the form {scope}:{locator} (graph model §1)`,
    );
    return;
  }
  const scope = node.id.slice(0, colon);
  const locator = node.id.slice(colon + 1);

  if (scope === UNKNOWN_SCOPE) {
    // `unknown:{ref_kind}:{encoded_value}` — ref_kind is a legal UnresolvedRef
    // kind and the value is non-empty and canonically percent-encoded.
    if (parseUnknownNodeId(node.id) === null) {
      err(
        "E_ID_FORMAT",
        `${path}.id`,
        `node id "${node.id}" has scope "unknown" but its locator is not {ref_kind}:{encoded_value} with ref_kind one of ${RefKindSchema.options.join(", ")} and a non-empty value in which ":", "/", "%", space and control characters are percent-encoded (graph model §1, parser §4.2)`,
      );
    }
    return;
  }

  if (FIXED_ID_SCOPES.has(scope)) {
    const separator =
      scope === "mongo" || scope === "sql" ? "." : scope === "ext" ? "/" : null;
    if (separator !== null) {
      const parts = locator.split(separator);
      if (parts.length < 2 || parts.some((p) => p.length === 0)) {
        const form =
          scope === "mongo"
            ? "{db}.{collection}"
            : scope === "sql"
              ? "{schema}.{table}"
              : "{vendor}/{surface}";
        err(
          "E_ID_FORMAT",
          `${path}.id`,
          `node id "${node.id}" has scope "${scope}" but its locator is not ${form} (graph model §1)`,
        );
      }
    }
    return;
  }

  if (!repoNames.has(scope)) {
    err(
      "E_ID_FORMAT",
      `${path}.id`,
      `node id "${node.id}" has scope "${scope}", which is neither one of ${[...FIXED_ID_SCOPES].join(", ")} nor a repo in repos[] (graph model §1)`,
    );
    return;
  }

  const hash = locator.indexOf("#");
  const filePath = hash === -1 ? locator : locator.slice(0, hash);
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    (hash !== -1 && hash === locator.length - 1)
  ) {
    err(
      "E_ID_FORMAT",
      `${path}.id`,
      `node id "${node.id}" must be {repo}:{path} or {repo}:{path}#{qualified_name}, with a relative forward-slash path (graph model §1)`,
    );
    return;
  }
  if (node.sources.length > 0) {
    for (const span of node.sources) {
      // A span whose repo is not in repos[] is invariant 19's report; only a
      // resolved-but-different repo is an id/source disagreement.
      if (repoNames.has(span.repo) && span.repo !== scope) {
        err(
          "E_ID_FORMAT",
          `${path}.id`,
          `node id "${node.id}" is scoped to repo "${scope}" but a span's repo is "${span.repo}" (graph model §1)`,
        );
      }
    }
    if (!node.sources.some((span) => span.path === filePath)) {
      err(
        "E_ID_FORMAT",
        `${path}.id`,
        `node id "${node.id}" names path "${filePath}" but no span has that path; the id names the declaring file (graph model §1)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 17. Canonical order — graph model §7.2. Only what survives JSON.parse:
// array order and string normalization. Whitespace and key order are the
// serializer's business and are checked by byte diff. Id and name arrays are
// checked non-decreasing: equal neighbours are invariant 1's report, not this one's.
// ---------------------------------------------------------------------------

function checkCanonicalOrder(
  graph: CanonicalGraph | GraphArtifact,
  err: Report,
): void {
  const checkSorted = (
    items: readonly string[],
    path: string,
    what: string,
  ): void => {
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      if (prev === undefined || cur === undefined) continue;
      if (byteCompare(prev, cur) > 0) {
        err(
          "E_CANONICAL_ORDER",
          `${path}[${String(i)}]`,
          `${what} is not in canonical order: "${cur}" must not follow "${prev}" (byte-wise ascending, graph model §7.2)`,
        );
        return;
      }
    }
  };

  checkSorted(
    graph.repos.map((r) => r.name),
    "$.repos",
    "repos (by name)",
  );
  checkSorted(
    graph.nodes.map((n) => n.id),
    "$.nodes",
    "nodes (by id)",
  );
  graph.nodes.forEach((n, i) => {
    for (let j = 1; j < n.sources.length; j++) {
      const prev = n.sources[j - 1];
      const cur = n.sources[j];
      if (
        prev !== undefined &&
        cur !== undefined &&
        spanCompare(prev, cur) > 0
      ) {
        err(
          "E_CANONICAL_ORDER",
          `$.nodes[${String(i)}].sources[${String(j)}]`,
          `sources are not in canonical order: sort by repo, path, line_start, line_end (null first), hash (graph model §7.2)`,
        );
        break;
      }
    }
  });
  checkSorted(
    graph.edges.map((e) => e.id),
    "$.edges",
    "edges (by id)",
  );
  checkSorted(
    graph.schemas.map((s) => s.id),
    "$.schemas",
    "schemas (by id)",
  );
  graph.nodes.forEach((n, i) =>
    checkSorted(n.tags, `$.nodes[${String(i)}].tags`, "tags"),
  );
  graph.edges.forEach((e, i) =>
    checkSorted(
      e.skips_tiers,
      `$.edges[${String(i)}].skips_tiers`,
      "skips_tiers",
    ),
  );
  graph.schemas.forEach((s, i) =>
    s.fields.forEach((f, j) =>
      checkSorted(
        f.classification,
        `$.schemas[${String(i)}].fields[${String(j)}].classification`,
        "classification",
      ),
    ),
  );

  checkNfc(graph, "$", err);
}

function checkNfc(value: unknown, path: string, err: Report): void {
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      err(
        "E_CANONICAL_NFC",
        path,
        `string is not NFC-normalized (graph model §7.2): ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkNfc(v, `${path}[${String(i)}]`, err));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value))
      checkNfc(v, `${path}.${k}`, err);
  }
}

// ---------------------------------------------------------------------------
// 21. line_end ≥ line_start — graph model §2.4. Reported at the object, since
// the pair is the problem. A pack must not repair this with null.
// ---------------------------------------------------------------------------

function checkLineRange(
  source: { line_start: number; line_end: number | null } | null,
  path: string,
  err: Report,
): void {
  if (
    source !== null &&
    source.line_end !== null &&
    source.line_end < source.line_start
  ) {
    err(
      "E_RANGE",
      path,
      `line_end ${String(source.line_end)} precedes line_start ${String(source.line_start)}; a span cannot end before it starts, and a pack must not repair this with null (graph model §2.4)`,
    );
  }
}

// ---------------------------------------------------------------------------
// 23. Scalar arrays are sets — graph model §7.2, §3.4. Rejected, never deduped.
// ---------------------------------------------------------------------------

function checkUnique(
  items: readonly string[],
  path: string,
  what: string,
  err: Report,
): void {
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    if (seen.has(item)) {
      err(
        "E_DUPLICATE_VALUE",
        `${path}[${String(i)}]`,
        `${what} contains "${item}" more than once; duplicates are rejected, not deduplicated (graph model §7.2)`,
      );
      return;
    }
    seen.add(item);
  }
}
