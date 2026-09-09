/**
 * Pack-private per-file state, handed from the per-file pass to `compose`.
 *
 * `parse()` returns exactly the five contract returns (parser §3.3). What the
 * cross-file pass needs beyond those — extension spans with their hashes,
 * helper bodies that build URLs, call sites whose receiver type lives in
 * another file — cannot be recovered from nodes and edges alone and cannot be
 * recomputed without re-reading the file, which would defeat the stage-3
 * cache. So the per-file pass records it here, JSON-serializable, versioned,
 * to be cached alongside the PackResult.
 */
import { z } from "zod";
import { PartialEdgeSchema, SourceSpanSchema } from "@waterslide/core";

export const STATE_VERSION = 1;

/** One piece of a URL expression, in source order. */
export const UrlPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), text: z.string() }),
  z.strictObject({ kind: z.literal("param"), name: z.string() }),
  z.strictObject({ kind: z.literal("property"), name: z.string() }),
  z.strictObject({ kind: z.literal("expr"), text: z.string() }),
]);
export type UrlPart = z.infer<typeof UrlPartSchema>;

export const UrlConstructionSchema = z.strictObject({
  line: z.int().positive(),
  /** `URL(string:)` or `URLRequest(url:)`; the latter wins when both appear. */
  form: z.enum(["URL", "URLRequest"]),
  parts: z.array(UrlPartSchema),
  method: UrlPartSchema.nullable(),
});
export type UrlConstruction = z.infer<typeof UrlConstructionSchema>;

/** `request(endpoint.request)`: parameter `endpoint` forwarded via member `request`. */
export const ForwardSchema = z.strictObject({
  source: z.enum(["param", "property"]),
  name: z.string(),
  via_member: z.string().nullable(),
  callee_type: z.string().nullable(),
  callee_member: z.string(),
});
export type Forward = z.infer<typeof ForwardSchema>;

export const ParamSchema = z.strictObject({
  label: z.string().nullable(),
  name: z.string(),
  type: z.string().nullable(),
});
export type Param = z.infer<typeof ParamSchema>;

export const FunctionFactSchema = z.strictObject({
  node_id: z.string(),
  qualified: z.string(),
  owner_type: z.string().nullable(),
  member: z.string(),
  is_static: z.boolean(),
  form: z.enum(["function", "init", "computed", "requirement", "slot"]),
  params: z.array(ParamSchema),
  return_type: z.string().nullable(),
  url_constructions: z.array(UrlConstructionSchema),
  forwards: z.array(ForwardSchema),
  /** The body itself hands a request to URLSession. */
  sends_request: z.boolean(),
  /** `self.path = path` in an init body: property ← parameter. */
  property_assignments: z.array(
    z.strictObject({ property: z.string(), from_param: z.string() }),
  ),
});
export type FunctionFact = z.infer<typeof FunctionFactSchema>;

export const PropertyFactSchema = z.strictObject({
  name: z.string(),
  type: z.string().nullable(),
  is_static: z.boolean(),
  is_stored: z.boolean(),
});
export type PropertyFact = z.infer<typeof PropertyFactSchema>;

export const TypeFactSchema = z.strictObject({
  qualified: z.string(),
  node_id: z.string(),
  declaration_kind: z.enum(["class", "struct", "enum", "actor", "protocol"]),
  conformances: z.array(z.string()),
  /** Enum cases: `Type.case(x)` is a value construction, not a call. */
  cases: z.array(z.string()),
  properties: z.array(PropertyFactSchema),
  has_explicit_init: z.boolean(),
  is_codable: z.boolean(),
  schema_id: z.string().nullable(),
});
export type TypeFact = z.infer<typeof TypeFactSchema>;

/** An extension whose target is not declared in this file. */
export const ExtensionFactSchema = z.strictObject({
  type_name: z.string(),
  span: SourceSpanSchema,
  conformances: z.array(z.string()),
  member_ids: z.array(z.string()),
  functions: z.array(FunctionFactSchema),
  properties: z.array(PropertyFactSchema),
});
export type ExtensionFact = z.infer<typeof ExtensionFactSchema>;

export const ChainStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("type"), name: z.string() }),
  z.strictObject({ kind: z.literal("instance"), type_name: z.string() }),
  z.strictObject({ kind: z.literal("member"), name: z.string() }),
]);
export type ChainStep = z.infer<typeof ChainStepSchema>;

// Recursive: a construction's arguments may themselves be constructions.
export interface ArgValue {
  kind:
    | "literal"
    | "template"
    | "ident"
    | "construction"
    | "call"
    | "encoded"
    | "expr";
  text: string;
  parts?: UrlPart[] | undefined;
  type_name?: string | undefined;
  args?: ArgFact[] | undefined;
}
export interface ArgFact {
  label: string | null;
  value: ArgValue;
}
export const ArgValueSchema: z.ZodType<ArgValue> = z.lazy(() =>
  z.strictObject({
    kind: z.enum([
      "literal",
      "template",
      "ident",
      "construction",
      "call",
      "encoded",
      "expr",
    ]),
    text: z.string(),
    parts: z.array(UrlPartSchema).optional(),
    type_name: z.string().optional(),
    args: z.array(ArgFactSchema).optional(),
  }),
);
export const ArgFactSchema: z.ZodType<ArgFact> = z.lazy(() =>
  z.strictObject({ label: z.string().nullable(), value: ArgValueSchema }),
);

/**
 * A call site whose target needs another file. The edge is complete except
 * that `to` is the best-effort symbol ref; compose finishes it.
 */
export const CandidateSchema = z.strictObject({
  edge: PartialEdgeSchema,
  form: z.enum(["constructor", "method", "static_method", "free_function"]),
  chain: z.array(ChainStepSchema),
  member: z.string().nullable(),
  args: z.array(ArgFactSchema),
  result_type: z.string().nullable(),
  /** A construction whose value feeds a call carries no edge of its own. */
  consumed: z.boolean(),
  /**
   * Set when the candidate sits in a fork limb that has no definite (in-file)
   * edge. Whether that limb is an alternative at all depends on whether the
   * candidate is drawn, which compose decides; compose then appends the
   * limb's ordinal after the `definite_count` alternatives numbered per-file,
   * in limb source order, keeping ordinals contiguous (graph model §3.3).
   */
  pending_fork: z
    .strictObject({
      limb_position: z.int().nonnegative(),
      definite_count: z.int().nonnegative(),
    })
    .nullable(),
  from_type: z.string().nullable(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const SwiftFileStateSchema = z.strictObject({
  version: z.literal(STATE_VERSION),
  repo: z.string(),
  path: z.string(),
  imports: z.array(z.string()),
  typealiases: z.record(z.string(), z.string()),
  types: z.array(TypeFactSchema),
  functions: z.array(FunctionFactSchema),
  extensions: z.array(ExtensionFactSchema),
  candidates: z.array(CandidateSchema),
  /** node ids of types whose members issue a direct HTTP request in this file. */
  http_types: z.array(z.string()),
  /** `Button(action: viewModel.method)`: the referenced method is the entry point; compose marks it. */
  entry_point_refs: z.array(
    z.strictObject({ type_name: z.string(), member: z.string() }),
  ),
  dropped_receivers: z.int().nonnegative(),
});
export type SwiftFileState = z.infer<typeof SwiftFileStateSchema>;
