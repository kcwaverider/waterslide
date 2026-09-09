import type {
  Confidence,
  Edge,
  Node,
  PayloadSchema,
  SourceLocation,
} from "@waterslide/core";
import { changeStateOf, type ChangeStateMap } from "./encoding.js";

/**
 * Inspection panel — UI spec §8. This module builds what the panel says; the
 * renderer turns it into DOM. Pure, so the content is unit-testable, and
 * inlined into the viewer page ahead of the renderer. No runtime imports
 * beyond the encoding module.
 *
 * Labels everywhere a reader looks first; ids only at the bottom, as the
 * address engineers need. The `confidence_reason` is the highest-value field
 * and is rendered verbatim (D1: the renderer never rewrites it).
 */

export interface PanelField {
  readonly label: string;
  readonly value: string;
  /** How the renderer sets the value: a reason is quoted, broken is red with the icon, muted is small. */
  readonly tone?: "reason" | "broken" | "muted";
}

export interface PanelSchemaField {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly classification: readonly string[];
  /** The referenced schema expanded, `"cycle"` when it is already open above, null when there is none. */
  readonly nested: PanelSchema | "cycle" | null;
}

export interface PanelSchema {
  /** What this schema is to the edge: "request", "response". */
  readonly role: string;
  readonly id: string;
  readonly name: string;
  readonly confidence: Confidence;
  readonly confidence_reason: string | null;
  readonly source: string | null;
  readonly fields: readonly PanelSchemaField[];
  /** Set when the id resolved to no schema in the graph. */
  readonly missing: boolean;
}

export interface PanelModel {
  readonly title: string;
  readonly subtitle: string;
  readonly fields: readonly PanelField[];
  readonly schemas: readonly PanelSchema[];
  /** The id. An address, not a label (scope §"Who reads the map"). */
  readonly address: string;
}

export interface PanelGraph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly schemas?: readonly PayloadSchema[];
}

/** `repo path:line_start–line_end`, per D2: text, no link scheme. */
export function formatLocation(loc: SourceLocation): string {
  const end = loc.line_end === null ? "" : `–${String(loc.line_end)}`;
  return `${loc.repo} ${loc.path}:${String(loc.line_start)}${end}`;
}

function labelOf(graph: PanelGraph, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

function confidenceFields(
  confidence: Confidence,
  reason: string | null,
): PanelField[] {
  const fields: PanelField[] = [{ label: "Confidence", value: confidence }];
  if (confidence !== "certain") {
    // Required non-null by the model when not certain; an empty string is
    // shown as such rather than hidden, so a gap in the data is visible.
    fields.push({ label: "Why", value: reason ?? "", tone: "reason" });
  }
  return fields;
}

export function describeNode(
  node: Node,
  graph: PanelGraph,
  changeState: ChangeStateMap,
): PanelModel {
  const fields: PanelField[] = [
    { label: "Kind", value: node.kind },
    { label: "Tier", value: node.tier },
  ];
  if (node.parent !== null)
    fields.push({ label: "Inside", value: labelOf(graph, node.parent) });
  if (node.sources.length === 0)
    fields.push({
      label: "Source",
      value:
        node.kind === "tombstone"
          ? "gone — the definition was removed"
          : node.kind === "unknown"
            ? "none — nothing in the code matched this reference"
            : "none — a synthetic node",
      tone: "muted",
    });
  for (const span of node.sources)
    fields.push({ label: "Source", value: formatLocation(span) });
  fields.push(...confidenceFields(node.confidence, node.confidence_reason));
  if (node.is_entry_point)
    fields.push({
      label: "Entry point",
      value: node.entry_point_kind ?? "yes",
    });
  if (node.is_infrastructure)
    fields.push({ label: "Infrastructure", value: "yes" });
  if (node.tags.length > 0)
    fields.push({ label: "Tags", value: node.tags.join(", ") });
  fields.push({ label: "Change", value: changeStateOf(changeState, node.id) });
  const outgoing = graph.edges.filter((e) => e.from === node.id).length;
  const incoming = graph.edges.filter((e) => e.to === node.id).length;
  fields.push({
    label: "Edges",
    value: `${String(incoming)} in, ${String(outgoing)} out`,
    tone: "muted",
  });
  return {
    title: node.label,
    subtitle: node.kind === "unknown" ? "unresolved reference" : node.kind,
    fields,
    schemas: [],
    address: node.id,
  };
}

export function describeEdge(edge: Edge, graph: PanelGraph): PanelModel {
  const fields: PanelField[] = [
    { label: "From", value: labelOf(graph, edge.from) },
    { label: "To", value: labelOf(graph, edge.to) },
    { label: "Kind", value: edge.kind },
  ];
  if (edge.label !== null) fields.push({ label: "Label", value: edge.label });
  if (edge.is_broken)
    fields.push({
      label: "Broken",
      value: edge.broken_reason ?? "",
      tone: "broken",
    });
  fields.push(...confidenceFields(edge.confidence, edge.confidence_reason));
  if (edge.condition !== null) {
    fields.push({ label: "Fires when", value: edge.condition.expr });
    if (edge.exclusive_group !== null) {
      const alternatives = new Set(
        graph.edges
          .filter((e) => e.exclusive_group === edge.exclusive_group)
          .map((e) => e.branch_ordinal),
      ).size;
      fields.push({
        label: "Branch",
        value: `alternative ${String((edge.branch_ordinal ?? 0) + 1)} of ${String(alternatives)}${edge.is_error_path ? ", error path" : ""}`,
      });
    }
  } else if (edge.is_error_path) {
    fields.push({ label: "Branch", value: "error path" });
  }
  if (edge.source === null)
    fields.push({
      label: "Call site",
      value: "none — hand-annotated",
      tone: "muted",
    });
  else
    fields.push({
      label: edge.source_count > 1 ? "First call site" : "Call site",
      value:
        formatLocation(edge.source) +
        (edge.source_count > 1
          ? ` (${String(edge.source_count)} call sites)`
          : ""),
    });
  if (edge.skips_tiers.length > 0)
    fields.push({ label: "Skips bands", value: edge.skips_tiers.join(", ") });
  const schemas: PanelSchema[] = [];
  if (edge.schema_id !== null)
    schemas.push(expandSchema("request", edge.schema_id, graph));
  if (edge.response_schema_id !== null)
    schemas.push(expandSchema("response", edge.response_schema_id, graph));
  return {
    title: `${labelOf(graph, edge.from)} → ${labelOf(graph, edge.to)}`,
    subtitle: edge.kind,
    fields,
    schemas,
    address: edge.id,
  };
}

/**
 * §8 "attached schema, expanded": fields with type, optionality and
 * classification, and every `ref_schema_id` expanded in place. A schema that
 * is already open above is marked as a cycle rather than expanded again
 * (graph model §4.1).
 */
export function expandSchema(
  role: string,
  id: string,
  graph: PanelGraph,
  open: ReadonlySet<string> = new Set(),
): PanelSchema {
  const schema = (graph.schemas ?? []).find((s) => s.id === id);
  if (schema === undefined)
    return {
      role,
      id,
      name: id,
      confidence: "certain",
      confidence_reason: null,
      source: null,
      fields: [],
      missing: true,
    };
  const nowOpen = new Set(open);
  nowOpen.add(id);
  return {
    role,
    id,
    name: schema.name,
    confidence: schema.confidence,
    confidence_reason: schema.confidence_reason,
    source: schema.source === null ? null : formatLocation(schema.source),
    fields: schema.fields.map((f) => ({
      name: f.name,
      type: f.type,
      optional: f.optional,
      classification: f.classification,
      nested:
        f.ref_schema_id === null
          ? null
          : nowOpen.has(f.ref_schema_id)
            ? "cycle"
            : expandSchema("field", f.ref_schema_id, graph, nowOpen),
    })),
    missing: false,
  };
}
