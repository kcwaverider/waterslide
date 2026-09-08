import { z } from "zod";
import {
  ConfidenceSchema,
  EdgeKindSchema,
  EntryPointKindSchema,
  NodeKindSchema,
  TierSchema,
} from "./enums.js";

/** Graph model §7. Bump on breaking model changes. Mismatch must fail loudly. */
export const GRAPH_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Source shapes — graph model §2.4. Two shapes, not one.
// ---------------------------------------------------------------------------

/** Nodes only. A definition that can change, so it carries a hash. */
export const SourceSpanSchema = z.strictObject({
  repo: z.string(),
  path: z.string(),
  line_start: z.int(),
  line_end: z.int().nullable(),
  hash: z.string(),
});
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

/** Edges and schemas. A place in a file. No hash. */
export const SourceLocationSchema = z.strictObject({
  repo: z.string(),
  path: z.string(),
  line_start: z.int(),
  line_end: z.int().nullable(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

// ---------------------------------------------------------------------------
// Node — graph model §2. Key order here is the canonical key order (§7.2).
// ---------------------------------------------------------------------------

export const NodeSchema = z.strictObject({
  id: z.string(),
  kind: NodeKindSchema,
  label: z.string(),
  tier: TierSchema,
  parent: z.string().nullable(),
  source: SourceSpanSchema.nullable(),
  confidence: ConfidenceSchema,
  confidence_reason: z.string().nullable(),
  is_entry_point: z.boolean(),
  entry_point_kind: EntryPointKindSchema.nullable(),
  is_infrastructure: z.boolean(),
  tags: z.array(z.string()),
});
export type Node = z.infer<typeof NodeSchema>;

// ---------------------------------------------------------------------------
// Edge — graph model §3.
// ---------------------------------------------------------------------------

export const ConditionSchema = z.strictObject({
  expr: z.string(),
  source_line: z.int().nullable(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const EdgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  label: z.string().nullable(),
  schema_id: z.string().nullable(),
  response_schema_id: z.string().nullable(),
  confidence: ConfidenceSchema,
  confidence_reason: z.string().nullable(),
  condition: ConditionSchema.nullable(),
  exclusive_group: z.string().nullable(),
  is_error_path: z.boolean(),
  source: SourceLocationSchema.nullable(),
  source_count: z.int().nonnegative(),
  branch_ordinal: z.int().nonnegative().nullable(),
  is_broken: z.boolean(),
  broken_reason: z.string().nullable(),
  skips_tiers: z.array(TierSchema),
});
export type Edge = z.infer<typeof EdgeSchema>;

// ---------------------------------------------------------------------------
// Schema (payload shape) — graph model §4.
// ---------------------------------------------------------------------------

export const FieldSchema = z.strictObject({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
  classification: z.array(z.string()),
  ref_schema_id: z.string().nullable(),
});
export type Field = z.infer<typeof FieldSchema>;

export const PayloadSchemaSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  source: SourceLocationSchema.nullable(),
  confidence: ConfidenceSchema,
  confidence_reason: z.string().nullable(),
  fields: z.array(FieldSchema),
});
export type PayloadSchema = z.infer<typeof PayloadSchemaSchema>;

// ---------------------------------------------------------------------------
// Graph metadata — graph model §7, §7.1, §7.3.
// ---------------------------------------------------------------------------

/** Canonical repo record: `path` and `dirty` are volatile (§7.1). */
export const CanonicalRepoSchema = z.strictObject({
  name: z.string(),
  commit: z.string(),
});
export type CanonicalRepo = z.infer<typeof CanonicalRepoSchema>;

/** Artifact repo record, in field-table order. */
export const ArtifactRepoSchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  commit: z.string(),
  dirty: z.boolean(),
});
export type ArtifactRepo = z.infer<typeof ArtifactRepoSchema>;

/**
 * §7: "Counts, including breakdown by confidence." The spec does not fix the
 * keys, and `stats` is artifact-only and excluded from the canonical graph, so
 * it is left as an open record until a consumer needs more.
 */
export const StatsSchema = z.record(z.string(), z.unknown());
export type Stats = z.infer<typeof StatsSchema>;

/** §7.3 — the shape fixtures, `--canonical` output and every diff read. */
export const CanonicalGraphSchema = z.strictObject({
  schema_version: z.literal(GRAPH_SCHEMA_VERSION),
  tier_config_hash: z.string(),
  repos: z.array(CanonicalRepoSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
});
export type CanonicalGraph = z.infer<typeof CanonicalGraphSchema>;

/** §7.3 — `graph.json` as written by `parse`: canonical plus the volatile fields. */
export const GraphArtifactSchema = z.strictObject({
  schema_version: z.literal(GRAPH_SCHEMA_VERSION),
  parsed_at: z.iso.datetime(),
  tier_config_hash: z.string(),
  repos: z.array(ArtifactRepoSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  stats: StatsSchema.optional(),
});
export type GraphArtifact = z.infer<typeof GraphArtifactSchema>;

/** §7.1 — the fields that exist only in the artifact shape. */
export const VOLATILE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "parsed_at",
  "stats",
]);
export const VOLATILE_REPO_KEYS: ReadonlySet<string> = new Set([
  "path",
  "dirty",
]);
