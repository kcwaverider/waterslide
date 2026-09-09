/**
 * Contract items agreed with the orchestrator on 2026-09-08 that Path C is
 * adding to `core/`. They are mirrored here so the Python pack can build against
 * them now. **Delete this file and import from `@waterslide/core` the moment
 * core exports them.** Nothing here may drift from the agreed shapes:
 *
 * - `Provide.ref_kind` — same enum as `UnresolvedRef.ref_kind`; stage 4 keys
 *   its index by (ref_kind, name, scope).
 * - `Provide.alias_of` — a provide may target another NAME instead of a node.
 *   Core resolves alias chains, caps depth, and drops cycles with a diagnostic.
 * - `compose(results: PerFileResult[]): PackPatch` — a pack-level pass that
 *   runs after stage 3 over the complete, (repo, path)-sorted set of the pack's
 *   per-file results. Never cached. Same capability table as a framework
 *   recognizer: may add edges, schemas and provides, may annotate a node's
 *   label, is_entry_point, entry_point_kind and tags; may not change an id or
 *   remove a node.
 */
import {
  DiagnosticSchema,
  EntryPointKindSchema,
  NodeSchema,
  PartialEdgeSchema,
  PayloadSchemaSchema,
  ProvideScopeSchema,
  RefKindSchema,
  SourceSpanSchema,
  VisibilitySchema,
} from "@waterslide/core";
import { z } from "zod";

export const ProvideSchema = z
  .strictObject({
    ref_kind: RefKindSchema,
    name: z.string(),
    node_id: z.string().nullable(),
    alias_of: z.string().nullable(),
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
    message: "exactly one of node_id and alias_of must be non-null",
    path: ["alias_of"],
  });
export type Provide = z.infer<typeof ProvideSchema>;

export const PackResultSchema = z.strictObject({
  nodes: z.array(NodeSchema),
  edges: z.array(PartialEdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  provides: z.array(ProvideSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type PackResult = z.infer<typeof PackResultSchema>;

/** One file's stage-3 output, as handed to `compose`. */
export interface PerFileResult {
  readonly repo: string;
  readonly path: string;
  readonly result: PackResult;
}

/**
 * Amendment A1 (2026-09-08): what `compose` may do to a node emitted by a
 * per-file pass. `node_id` names it; absent keys are left alone. `add_sources`
 * appends spans (a Swift extension in another file); `parent` overwrites.
 */
export const NodeAnnotationSchema = z.strictObject({
  node_id: z.string(),
  label: z.string().optional(),
  is_entry_point: z.boolean().optional(),
  entry_point_kind: EntryPointKindSchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  add_sources: z.array(SourceSpanSchema).optional(),
});
export type NodeAnnotation = z.infer<typeof NodeAnnotationSchema>;

/** MAY add nodes, edges, schemas, provides and annotate; MAY NOT change an id or remove a node. */
export const PackPatchSchema = z.strictObject({
  nodes: z.array(NodeSchema),
  annotations: z.array(NodeAnnotationSchema),
  edges: z.array(PartialEdgeSchema),
  schemas: z.array(PayloadSchemaSchema),
  provides: z.array(ProvideSchema),
  diagnostics: z.array(DiagnosticSchema),
});
export type PackPatch = z.infer<typeof PackPatchSchema>;
