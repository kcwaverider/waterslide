import { z } from "zod";
import {
  ConfidenceSchema,
  DatastoreOperationSchema,
  DatastoreStoreSchema,
  DiagnosticSeveritySchema,
  EdgeKindSchema,
  EntryPointKindSchema,
  NodeKindSchema,
  ProvideScopeSchema,
  RefKindSchema,
  TopicDirectionSchema,
  VisibilitySchema,
} from "./enums.js";
import {
  ConditionSchema,
  GRAPH_SCHEMA_VERSION,
  LineNumber,
  NodeSchema,
  PayloadSchemaSchema,
  SourceLocationSchema,
  SourceSpanSchema,
  type Node,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Parser pipeline §3.1 — what a pack declares about itself.
// ---------------------------------------------------------------------------

export const PackManifestSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  graph_schema_version: z.int(),
  extensions: z.array(z.string()),
  frameworks: z.array(z.string()),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/**
 * §3.1 / §9: a pack emitting a different graph model version must not run.
 * A thin map looks like a working map. Refuse loudly and name the pack.
 */
export function assertPackCompatible(manifest: PackManifest): void {
  if (manifest.graph_schema_version !== GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `Language pack "${manifest.id}" v${manifest.version} emits graph model version ` +
        `${String(manifest.graph_schema_version)}, but this core is version ${String(GRAPH_SCHEMA_VERSION)}. ` +
        `Refusing to run: the pack would produce a quietly thin map.`,
    );
  }
}

// ---------------------------------------------------------------------------
// §3.4 — `provides`: the names by which other files may refer to a node.
//
// Stage 4 keys ONE index by (ref_kind, name, scope) and matches all five
// reference kinds uniformly, so every provide states which kind of reference
// it satisfies. A route is an `http` provide whose name is
// "{METHOD} {path_template}" — method uppercase, one space, path verbatim from
// prefix composition, one entry per method.
//
// An entry may target another NAME instead of a node (`alias_of`), for Python
// `__init__.py` re-exports and Swift `typealias`. Core follows alias chains in
// stage 4, capped at depth 8, and drops cycles with a diagnostic.
// ---------------------------------------------------------------------------

/** Maximum alias hops core follows before giving up with a diagnostic. */
export const PROVIDE_ALIAS_MAX_DEPTH = 8;

export const ProvideSchema = z
  .strictObject({
    name: z.string(),
    node_id: z.string().nullable(),
    alias_of: z.string().nullable(),
    ref_kind: RefKindSchema,
    visibility: VisibilitySchema,
    scope: ProvideScopeSchema,
    scope_path: z.string().nullable(),
  })
  .refine((p) => (p.scope === "file") === (p.scope_path !== null), {
    message:
      "scope_path must be non-null exactly when scope is 'file' (parser pipeline §3.4)",
    path: ["scope_path"],
  })
  .refine((p) => (p.node_id === null) !== (p.alias_of === null), {
    message:
      "exactly one of node_id and alias_of must be non-null: a provide names a node or aliases another name, never both or neither (parser pipeline §3.4)",
    path: ["node_id"],
  });
export type Provide = z.infer<typeof ProvideSchema>;

// ---------------------------------------------------------------------------
// §3.6 — `UnresolvedRef`: what a pack puts in `to` when the target lives elsewhere.
//
// `hints` is optional, and typed per `ref_kind` when present so that a
// misspelled key is a contract error rather than a silently ignored hint. Inside
// a hints object every key is present, null where the pack cannot see it
// (graph model §2.5).
// ---------------------------------------------------------------------------

export const SymbolHintsSchema = z.strictObject({
  arity: z.int().nonnegative().nullable(),
  receiver_type: z.string().nullable(),
});
export type SymbolHints = z.infer<typeof SymbolHintsSchema>;

export const HttpHintsSchema = z.strictObject({
  /** Uppercase HTTP method. Null when the call site does not fix it. */
  method: z.string().nullable(),
  /** The expression the path was appended to, e.g. `APIConfig.baseURL`. */
  base_url_expr: z.string().nullable(),
  /** A query string parsed out of the path literal, without the leading `?`. */
  query: z.string().nullable(),
});
export type HttpHints = z.infer<typeof HttpHintsSchema>;

export const TopicHintsSchema = z.strictObject({
  direction: TopicDirectionSchema,
});
export type TopicHints = z.infer<typeof TopicHintsSchema>;

export const DatastoreHintsSchema = z.strictObject({
  operation: DatastoreOperationSchema,
  store: DatastoreStoreSchema,
  /**
   * The db (Mongo) or schema (SQL). Null when the pack cannot see it; core then
   * mints `{store}:unknown.{value}` and emits `undeclared_datastore_namespace`.
   */
  namespace: z.string().nullable(),
});
export type DatastoreHints = z.infer<typeof DatastoreHintsSchema>;

export const ExternalHintsSchema = z.strictObject({
  sdk_symbol: z.string().nullable(),
});
export type ExternalHints = z.infer<typeof ExternalHintsSchema>;

const refBase = {
  value: z.string(),
  source_line: LineNumber,
};

export const UnresolvedRefSchema = z.discriminatedUnion("ref_kind", [
  z.strictObject({
    ref_kind: z.literal("symbol"),
    ...refBase,
    hints: SymbolHintsSchema.optional(),
  }),
  z.strictObject({
    ref_kind: z.literal("http"),
    ...refBase,
    hints: HttpHintsSchema.optional(),
  }),
  z.strictObject({
    ref_kind: z.literal("topic"),
    ...refBase,
    hints: TopicHintsSchema.optional(),
  }),
  z.strictObject({
    ref_kind: z.literal("datastore"),
    ...refBase,
    hints: DatastoreHintsSchema.optional(),
  }),
  z.strictObject({
    ref_kind: z.literal("external"),
    ...refBase,
    hints: ExternalHintsSchema.optional(),
  }),
]);
export type UnresolvedRef = z.infer<typeof UnresolvedRefSchema>;

// ---------------------------------------------------------------------------
// `pack_data` — a pack's private channel from its per-file `parse` to its own
// `compose`. Core never interprets it and one pack never reads another's. It
// is STRIPPED by core after compose runs, before derivation: it does not reach
// stage 5, the validator, `graph.json` or the canonical graph, so it cannot
// affect byte-identity. It is deleted, not nulled — a field that is "ignored
// downstream" is one that eventually gets read downstream. Absent and null
// both mean "none"; optional because it is pack scratch data, not a graph
// field, so graph model §2.5's always-present rule does not govern it.
//
// It exists so a FastAPI recognizer can hand a route's method and local path,
// or a mount's `include_router` prefix, to its compose pass without encoding
// them into `label` text and parsing them back with a regex.
// ---------------------------------------------------------------------------

export const PackDataSchema = z.record(z.string(), z.unknown()).nullable();
export type PackData = z.infer<typeof PackDataSchema>;

/** A node as a pack emits it: the graph model's `Node` plus `pack_data`. */
export const PackNodeSchema = NodeSchema.extend({
  pack_data: PackDataSchema.optional(),
});
export type PackNode = z.infer<typeof PackNodeSchema>;

/** Removes `pack_data` from a node. The key is deleted, not nulled. */
export function stripNodePackData(node: PackNode): Node {
  const { pack_data: _dropped, ...rest } = node;
  return rest;
}

/** Removes `pack_data` from an edge. The key is deleted, not nulled. */
export function stripEdgePackData(edge: PartialEdge): CorePartialEdge {
  const { pack_data: _dropped, ...rest } = edge;
  return rest;
}

// ---------------------------------------------------------------------------
// §3.3 — `PartialEdge`: an edge as a pack sees it, before resolution.
//
// The pack knows the call site and what it names. It does not know the edge id
// (derived by core, §3.3.1), `source_count` (core collapses call sites),
// `is_broken` / `broken_reason` (needs the baseline) or `skips_tiers` (needs
// both endpoints' tiers). Those are added by core.
// ---------------------------------------------------------------------------

export const PartialEdgeSchema = z.strictObject({
  from: z.string(),
  to: z.union([z.string(), UnresolvedRefSchema]),
  kind: EdgeKindSchema,
  label: z.string().nullable(),
  schema_id: z.string().nullable(),
  response_schema_id: z.string().nullable(),
  confidence: ConfidenceSchema,
  confidence_reason: z.string().nullable(),
  condition: ConditionSchema.nullable(),
  exclusive_group: z.string().nullable(),
  branch_ordinal: z.int().nonnegative().nullable(),
  is_error_path: z.boolean(),
  source: SourceLocationSchema.nullable(),
  pack_data: PackDataSchema.optional(),
});
export type PartialEdge = z.infer<typeof PartialEdgeSchema>;

/** `PartialEdge` after core has stripped `pack_data`: what stage 4 resolves. */
export const CorePartialEdgeSchema = PartialEdgeSchema.omit({
  pack_data: true,
});
export type CorePartialEdge = z.infer<typeof CorePartialEdgeSchema>;

// ---------------------------------------------------------------------------
// Graph model §10 — Diagnostics. Never thrown. `code` is the grouping key and
// must be stable; `message` is for humans and may vary.
// ---------------------------------------------------------------------------

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export const DiagnosticSchema = z.strictObject({
  severity: DiagnosticSeveritySchema,
  code: z
    .string()
    .regex(SNAKE_CASE, "diagnostic code must be snake_case (graph model §10)"),
  message: z.string(),
  repo: z.string().nullable(),
  path: z.string().nullable(),
  line: LineNumber.nullable(),
  pack: z.string().nullable(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

// ---------------------------------------------------------------------------
// §3.3 — the five returns.
// ---------------------------------------------------------------------------

export const PackResultSchema = z.strictObject({
  nodes: z.array(PackNodeSchema),
  edges: z.array(PartialEdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  provides: z.array(ProvideSchema),
  diagnostics: z.array(DiagnosticSchema),
  /**
   * File-level `pack_data`: the third home, beside nodes and edges. Written by
   * `parse` for the same pack's `compose` — extension spans with hashes, helper
   * bodies, cross-file call sites, anything the five returns cannot carry
   * without re-reading source. Core lifts it out into
   * `PerFileResult.pack_data`; it is not a graph field and is stripped before
   * derivation like the other two.
   */
  pack_data: PackDataSchema.optional(),
});
export type PackResult = z.infer<typeof PackResultSchema>;

/** `PackResult` with the file-level `pack_data` lifted out: the `result` inside a `PerFileResult`. */
export const FileResultSchema = PackResultSchema.omit({ pack_data: true });
export type FileResult = z.infer<typeof FileResultSchema>;

/**
 * A pack's own resolved options block from `config.yaml` (`packs.{id}`), with
 * defaults applied by core before any call, so the pack never sees an
 * unspecified value. Passed on every call rather than configured once on the
 * instance: an instance reused across repos with different options would
 * silently carry the wrong ones. Its canonical hash is part of the cache key.
 */
export const PackOptionsSchema = z.record(z.string(), z.unknown());
export type PackOptions = z.infer<typeof PackOptionsSchema>;

/**
 * One file's stage-3 output together with the file it came from, and the
 * pack's file-level `pack_data`.
 *
 * All three `pack_data` homes — node, edge, file — are per-file stage-3
 * output: written by `parse`, read by the same pack's `compose`, stripped by
 * core after compose and before derivation, never in `graph.json` or the
 * canonical graph. All three are cached with the file's parse output, for one
 * reason: compose runs over cached and freshly parsed files alike, and a
 * cached file whose `pack_data` had been dropped would give compose different
 * inputs on a warm run than on a cold one. Their freshness is the cache key's
 * job (content, pack version, options), not the payload's.
 *
 * `rePath` receives and returns this whole shape, `pack_data` included, since
 * file-level data may be path-derived. Core treats file-level `pack_data`
 * returned unchanged across a path change as suspicious, not fatal: a pack may
 * legitimately keep path-independent data there.
 */
export const PerFileResultSchema = z.strictObject({
  repo: z.string(),
  path: z.string(),
  result: FileResultSchema,
  pack_data: PackDataSchema,
});
export type PerFileResult = z.infer<typeof PerFileResultSchema>;

/** Builds a `PerFileResult` from a pack's `parse` return, lifting the file-level `pack_data` out. */
export function toPerFileResult(
  repo: string,
  path: string,
  result: PackResult,
): PerFileResult {
  const { pack_data, ...rest } = result;
  return { repo, path, result: rest, pack_data: pack_data ?? null };
}

// ---------------------------------------------------------------------------
// The compose hook — a pack-level cross-file pass, run by core after stage 3,
// once per pack, over every file that pack claimed. NEVER cached.
//
// A `PackPatch` MAY add nodes, edges, schemas and provides; add a source span
// to a node emitted by another file; set or overwrite `parent`; and annotate
// `label`, `kind`, `is_entry_point`, `entry_point_kind` and `tags`. It MAY NOT
// change a node id or remove a node: identity is owned by exactly one
// component, and a renamed node breaks every saved position and the baseline.
// Core enforces this — a violating update is dropped with a
// `rejected_pack_patch` diagnostic.
//
// In a `NodeUpdate` an absent key means "leave unchanged", so this is the one
// place graph model §2.5's always-present rule does not apply: `parent` absent
// and `parent: null` mean different things.
// ---------------------------------------------------------------------------

export const NodeUpdateSchema = z.strictObject({
  node_id: z.string(),
  add_sources: z.array(SourceSpanSchema),
  /**
   * `kind` is not identity — `id` is — so compose may change it: a Swift type
   * becomes `client_service` once any method, possibly via a helper in another
   * file, issues an HTTP request, and only compose can see that. There is
   * still no `id` field, so a rename stays unrepresentable.
   */
  kind: NodeKindSchema.optional(),
  parent: z.string().nullable().optional(),
  label: z.string().optional(),
  is_entry_point: z.boolean().optional(),
  entry_point_kind: EntryPointKindSchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export type NodeUpdate = z.infer<typeof NodeUpdateSchema>;

export const PackPatchSchema = z.strictObject({
  nodes: z.array(PackNodeSchema),
  edges: z.array(PartialEdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  provides: z.array(ProvideSchema),
  node_updates: z.array(NodeUpdateSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type PackPatch = z.infer<typeof PackPatchSchema>;

/**
 * The language pack contract. `parse` is called once per file and must never
 * throw (§9): failures go in `diagnostics`. Every call receives the pack's
 * resolved `options`.
 *
 * `compose`, when present, is called once per parse after stage 3 with every
 * file this pack claimed, sorted by (repo, path) byte-wise. Core guarantees
 * that order and packs must not re-sort; it is what makes the output immune to
 * shuffled discovery order. It is never cached, and it is synchronous on
 * purpose: an async compose invites concurrency inside it, and two awaits in
 * parallel would make the output order nondeterministic.
 *
 * `rePath`, when present, is called on a cache hit whose repo or path differs
 * from the cached payload's. The pack recomputes every path-derived field —
 * node ids, provide names, span repo/path, parent — because the path-to-name
 * mapping is language-specific and core must not know it. A pack without
 * `rePath` gets a cache miss for a moved file instead, which is safe and costs
 * one parse.
 */
export interface LanguagePack {
  readonly manifest: PackManifest;
  parse(
    repo_name: string,
    path: string,
    content: string,
    options: PackOptions,
  ): PackResult | Promise<PackResult>;
  compose?(results: readonly PerFileResult[], options: PackOptions): PackPatch;
  rePath?(
    result: PerFileResult,
    repo: string,
    path: string,
    options: PackOptions,
  ): PerFileResult;
}
