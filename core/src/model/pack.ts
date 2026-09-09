import { z } from "zod";
import {
  ConfidenceSchema,
  DiagnosticSeveritySchema,
  EdgeKindSchema,
  ProvideScopeSchema,
  RefKindSchema,
  VisibilitySchema,
} from "./enums.js";
import {
  ConditionSchema,
  GRAPH_SCHEMA_VERSION,
  LineNumber,
  NodeSchema,
  PayloadSchemaSchema,
  SourceLocationSchema,
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
// ---------------------------------------------------------------------------

export const ProvideSchema = z
  .strictObject({
    name: z.string(),
    node_id: z.string(),
    visibility: VisibilitySchema,
    scope: ProvideScopeSchema,
    scope_path: z.string().nullable(),
  })
  .refine((p) => (p.scope === "file") === (p.scope_path !== null), {
    message:
      "scope_path must be non-null exactly when scope is 'file' (parser pipeline §3.4)",
    path: ["scope_path"],
  });
export type Provide = z.infer<typeof ProvideSchema>;

// ---------------------------------------------------------------------------
// §3.6 — `UnresolvedRef`: what a pack puts in `to` when the target lives elsewhere.
// ---------------------------------------------------------------------------

export const UnresolvedRefSchema = z.strictObject({
  ref_kind: RefKindSchema,
  value: z.string(),
  hints: z.record(z.string(), z.unknown()).optional(),
  source_line: LineNumber,
});
export type UnresolvedRef = z.infer<typeof UnresolvedRefSchema>;

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
});
export type PartialEdge = z.infer<typeof PartialEdgeSchema>;

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
  nodes: z.array(NodeSchema),
  edges: z.array(PartialEdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  provides: z.array(ProvideSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type PackResult = z.infer<typeof PackResultSchema>;

/**
 * The language pack contract. Called once per file. Must never throw (§9):
 * failures go in `diagnostics`.
 */
export interface LanguagePack {
  readonly manifest: PackManifest;
  parse(
    repo_name: string,
    path: string,
    content: string,
  ): PackResult | Promise<PackResult>;
}
