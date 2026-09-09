import { z } from "zod";

// Graph model §2.1 — sixteen values, six hue groups. `unknown` shares the
// Absence group with `tombstone`: both are a thing that is not there.
export const NodeKindSchema = z.enum([
  "ui_view",
  "ui_handler",
  "client_service",
  "endpoint",
  "function",
  "class",
  "repository",
  "middleware",
  "collection",
  "table",
  "topic",
  "external_service",
  "module",
  "service",
  "tombstone",
  "unknown",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

// Graph model §2.2
export const EntryPointKindSchema = z.enum([
  "ui_handler",
  "http_route",
  "webhook",
  "queue_subscriber",
  "cron",
  "app_launch",
]);
export type EntryPointKind = z.infer<typeof EntryPointKindSchema>;

// Graph model §6 — six ordered bands plus `external`, which is a column, not a depth.
export const ORDERED_TIERS = [
  "ui",
  "ui_logic",
  "api",
  "domain",
  "data_access",
  "store",
] as const;
export const TierSchema = z.enum([...ORDERED_TIERS, "external"]);
export type Tier = z.infer<typeof TierSchema>;

// Graph model §3.1
export const EdgeKindSchema = z.enum([
  "call",
  "http_request",
  "read",
  "write",
  "publish",
  "subscribe",
  "external_call",
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

// Graph model §5
export const ConfidenceSchema = z.enum(["certain", "inferred", "annotated"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Parser pipeline §3.6
export const RefKindSchema = z.enum([
  "symbol",
  "http",
  "topic",
  "datastore",
  "external",
]);
export type RefKind = z.infer<typeof RefKindSchema>;

// Parser pipeline §3.6 — typed `hints` members.
export const DatastoreOperationSchema = z.enum(["read", "write"]);
export type DatastoreOperation = z.infer<typeof DatastoreOperationSchema>;
export const DatastoreStoreSchema = z.enum(["mongo", "sql"]);
export type DatastoreStore = z.infer<typeof DatastoreStoreSchema>;
export const TopicDirectionSchema = z.enum(["publish", "subscribe"]);
export type TopicDirection = z.infer<typeof TopicDirectionSchema>;

// Parser pipeline §3.4
export const VisibilitySchema = z.enum(["public", "module", "private"]);
export type Visibility = z.infer<typeof VisibilitySchema>;
export const ProvideScopeSchema = z.enum(["global", "file"]);
export type ProvideScope = z.infer<typeof ProvideScopeSchema>;

// Graph model §10 — diagnostics.
export const DiagnosticSeveritySchema = z.enum(["error", "warning", "info"]);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

/** Graph model §10 — reserved codes with fixed meanings. Packs may add their own. */
export const RESERVED_DIAGNOSTIC_CODES = {
  syntax_error: "error",
  unsupported_construct: "warning",
  recognizer_failure: "error",
  unresolved_ref: "warning",
  redundant_annotation: "warning",
  undeclared_datastore_namespace: "warning",
  unresolvable_provide_alias: "warning",
  rejected_pack_patch: "error",
} as const satisfies Record<string, DiagnosticSeverity>;
export type ReservedDiagnosticCode = keyof typeof RESERVED_DIAGNOSTIC_CODES;

/**
 * Graph model §6.1 — default tier by kind, used when no config glob matches.
 * `tombstone` has no default: it takes whatever the baseline recorded.
 * `unknown` has no default: it inherits the tier of the referencing edge's
 * `from` node (the shallowest, in band order, when several edges reference it)
 * so it draws beside its caller rather than in a default band.
 */
export const DEFAULT_TIER_BY_KIND: Readonly<Record<NodeKind, Tier | null>> = {
  ui_view: "ui",
  ui_handler: "ui",
  client_service: "ui_logic",
  endpoint: "api",
  middleware: "api",
  function: "domain",
  class: "domain",
  module: "domain",
  service: "domain",
  repository: "data_access",
  collection: "store",
  table: "store",
  topic: "store",
  external_service: "external",
  tombstone: null,
  unknown: null,
};

/**
 * Graph model §3.4 / invariant 16 — endpoint kinds for which `skips_tiers` is
 * always empty. `unknown` is excluded for the same reason as `tombstone`: the
 * edge into it is already flagged and does not need a second badge.
 */
export const SKIPS_TIERS_EXCLUDED_KINDS: ReadonlySet<NodeKind> =
  new Set<NodeKind>(["external_service", "topic", "tombstone", "unknown"]);

/**
 * Graph model §1 — the six fixed id scopes. The seventh scope form is a repo
 * name from `repos[]`, so a repo must never be named after one of these.
 *
 * `unknown:{ref_kind}:{encoded_value}` is the synthetic target of a dangling
 * edge (parser §4.2): `ref_kind` is the UnresolvedRef's kind and the value its
 * value, NFC-normalized then percent-encoded (see unknown-id.ts), so the id is
 * deterministic from the ref alone and splits back unambiguously.
 */
export const FIXED_ID_SCOPES: ReadonlySet<string> = new Set([
  "svc",
  "mongo",
  "sql",
  "topic",
  "ext",
  "unknown",
]);

/** The scope of a synthetic dangling-reference target. */
export const UNKNOWN_SCOPE = "unknown";
