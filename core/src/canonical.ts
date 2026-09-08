import type {
  CanonicalGraph,
  CanonicalRepo,
  Condition,
  Edge,
  Field,
  GraphArtifact,
  Node,
  PayloadSchema,
  SourceLocation,
  SourceSpan,
} from "./model/graph.js";

/**
 * Canonical serialization — graph model §7.1 and §7.2.
 *
 * Everything that compares, diffs or checks determinism reads the output of
 * `serializeCanonical`. Fixtures are written in exactly this form, so the
 * round-trip test is a byte comparison.
 */

/** Byte-wise comparison on the UTF-8 encoding. Never locale-aware (§7.2). */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const nfc = (s: string): string => s.normalize("NFC");
const nfcOrNull = (s: string | null): string | null =>
  s === null ? null : nfc(s);
const sortedStrings = (xs: readonly string[]): string[] =>
  xs.map(nfc).sort(byteCompare);

function canonicalSpan(s: SourceSpan | null): SourceSpan | null {
  if (s === null) return null;
  return {
    repo: nfc(s.repo),
    path: nfc(s.path),
    line_start: s.line_start,
    line_end: s.line_end,
    hash: nfc(s.hash),
  };
}

function canonicalLocation(s: SourceLocation | null): SourceLocation | null {
  if (s === null) return null;
  return {
    repo: nfc(s.repo),
    path: nfc(s.path),
    line_start: s.line_start,
    line_end: s.line_end,
  };
}

function canonicalCondition(c: Condition | null): Condition | null {
  if (c === null) return null;
  return { expr: nfc(c.expr), source_line: c.source_line };
}

// Object literals below are written in field-table order deliberately: that
// order is the canonical key order (§7.2), and JSON.stringify preserves it.

export function canonicalNode(n: Node): Node {
  return {
    id: nfc(n.id),
    kind: n.kind,
    label: nfc(n.label),
    tier: n.tier,
    parent: nfcOrNull(n.parent),
    source: canonicalSpan(n.source),
    confidence: n.confidence,
    confidence_reason: nfcOrNull(n.confidence_reason),
    is_entry_point: n.is_entry_point,
    entry_point_kind: n.entry_point_kind,
    is_infrastructure: n.is_infrastructure,
    tags: sortedStrings(n.tags),
  };
}

export function canonicalEdge(e: Edge): Edge {
  return {
    id: nfc(e.id),
    from: nfc(e.from),
    to: nfc(e.to),
    kind: e.kind,
    label: nfcOrNull(e.label),
    schema_id: nfcOrNull(e.schema_id),
    response_schema_id: nfcOrNull(e.response_schema_id),
    confidence: e.confidence,
    confidence_reason: nfcOrNull(e.confidence_reason),
    condition: canonicalCondition(e.condition),
    exclusive_group: nfcOrNull(e.exclusive_group),
    is_error_path: e.is_error_path,
    source: canonicalLocation(e.source),
    source_count: e.source_count,
    branch_ordinal: e.branch_ordinal,
    is_broken: e.is_broken,
    broken_reason: nfcOrNull(e.broken_reason),
    skips_tiers: [...e.skips_tiers].sort(byteCompare),
  };
}

function canonicalField(f: Field): Field {
  // `fields` keep declaration order (§7.2); only the scalar array inside is sorted.
  return {
    name: nfc(f.name),
    type: nfc(f.type),
    optional: f.optional,
    classification: sortedStrings(f.classification),
    ref_schema_id: nfcOrNull(f.ref_schema_id),
  };
}

export function canonicalSchema(s: PayloadSchema): PayloadSchema {
  return {
    id: nfc(s.id),
    name: nfc(s.name),
    source: canonicalLocation(s.source),
    confidence: s.confidence,
    confidence_reason: nfcOrNull(s.confidence_reason),
    fields: s.fields.map(canonicalField),
  };
}

function canonicalRepo(r: { name: string; commit: string }): CanonicalRepo {
  return { name: nfc(r.name), commit: nfc(r.commit) };
}

const byId = <T extends { id: string }>(a: T, b: T): number =>
  byteCompare(a.id, b.id);

/**
 * Strip volatile fields, NFC-normalize every string, sort every array the
 * spec sorts, and order every key. Accepts either shape (§7.3); the result is
 * always the canonical shape.
 */
export function canonicalize(
  graph: CanonicalGraph | GraphArtifact,
): CanonicalGraph {
  return {
    schema_version: graph.schema_version,
    tier_config_hash: nfc(graph.tier_config_hash),
    repos: graph.repos
      .map(canonicalRepo)
      .sort((a, b) => byteCompare(a.name, b.name)),
    nodes: graph.nodes.map(canonicalNode).sort(byId),
    edges: graph.edges.map(canonicalEdge).sort(byId),
    schemas: graph.schemas.map(canonicalSchema).sort(byId),
  };
}

/**
 * The canonical bytes: two-space indent, `\n` line endings, trailing newline,
 * UTF-8 with no BOM, and JSON.stringify's escaping (only what RFC 8259 §7
 * requires; non-ASCII stays literal). §7.2.
 */
export function serializeCanonical(
  graph: CanonicalGraph | GraphArtifact,
): string {
  return JSON.stringify(canonicalize(graph), null, 2) + "\n";
}
