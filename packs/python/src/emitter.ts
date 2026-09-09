import {
  DEFAULT_TIER_BY_KIND,
  edgeId,
  type Confidence,
  type Diagnostic,
  type DiagnosticSeverity,
  type EdgeKind,
  type EntryPointKind,
  type Node as GraphNode,
  type NodeKind,
  type PartialEdge,
  type PayloadSchema,
  type Tier,
  type UnresolvedRef,
} from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type { PackResult, Provide } from "./contract-pending.js";
import type { PackData } from "./data.js";
import { diagnostic } from "./diagnostics.js";
import { spanHash } from "./hash.js";
import {
  groupIdFor,
  innermostLimb,
  limbErrorPath,
  type Limb,
} from "./language/branches.js";
import { codeNodeId, moduleNodeId } from "./language/ids.js";
import type { CallSite, Definition, FileContext } from "./language/model.js";
import { lineEnd, lineStart } from "./tree-sitter/runtime.js";

/**
 * Collects one file's five returns. Both the language emitter and the framework
 * recognizers write through this, so node identity, spans, branch fields and
 * ordinal assignment live in exactly one place.
 */
export class Emitter {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly nodeOrder: string[] = [];
  private readonly edges: PendingEdge[] = [];
  private readonly schemas: PayloadSchema[] = [];
  private readonly provides: Provide[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly claimed = new Set<CallSite>();

  constructor(
    readonly file: FileContext,
    readonly data: PackData,
  ) {}

  // --- nodes ---------------------------------------------------------------

  get moduleId(): string {
    return moduleNodeId(this.file.repo, this.file.path);
  }

  nodeIdFor(def: Definition): string {
    return codeNodeId(this.file.repo, this.file.path, def.qualifiedName);
  }

  /** `from` for an edge whose call site sits in `owner` (null → module level). */
  fromFor(owner: Definition | null): string {
    return owner ? this.nodeIdFor(owner) : this.moduleId;
  }

  span(node: Node): GraphNode["sources"][number] {
    return {
      repo: this.file.repo,
      path: this.file.path,
      line_start: lineStart(node),
      line_end: lineEnd(node),
      hash: spanHash(node.text),
    };
  }

  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) return; // identity is owned by whoever emitted first
    this.nodes.set(node.id, node);
    this.nodeOrder.push(node.id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Framework recognizers annotate; they never change an id or remove a node (parser §3.2). */
  annotateNode(
    id: string,
    patch: Partial<
      Pick<
        GraphNode,
        | "kind"
        | "label"
        | "tier"
        | "is_entry_point"
        | "entry_point_kind"
        | "tags"
      >
    >,
  ): void {
    const existing = this.nodes.get(id);
    if (!existing) throw new Error(`annotateNode: no node ${id}`);
    const tags = patch.tags
      ? [...new Set([...existing.tags, ...patch.tags])].sort()
      : existing.tags;
    this.nodes.set(id, { ...existing, ...patch, tags });
  }

  defaultTier(kind: NodeKind): Tier {
    const tier = DEFAULT_TIER_BY_KIND[kind];
    if (tier === null) throw new Error(`no default tier for ${kind}`);
    return tier;
  }

  // --- call sites -----------------------------------------------------------

  claim(site: CallSite): void {
    this.claimed.add(site);
  }

  isClaimed(site: CallSite): boolean {
    return this.claimed.has(site);
  }

  /**
   * Emit an edge for a call site. Branch fields come from the site's innermost
   * limb; ordinals are assigned in `finalize` once every edge is known.
   */
  edgeFromSite(site: CallSite, spec: EdgeSpec): void {
    const limb = innermostLimb(site.call, site.owner);
    this.edgeAt(site.call, site.owner, spec, limb, null);
  }

  /** Emit an edge whose branch fields are fixed by the caller (dispatch tables). */
  edgeWithFixedBranch(
    at: Node,
    owner: Definition | null,
    spec: EdgeSpec,
    branch: FixedBranch,
  ): void {
    this.edgeAt(at, owner, spec, null, branch);
  }

  /** An edge that is not a call site (route registration, mounts). No branch fields. */
  edgePlain(at: Node | null, from: string, spec: EdgeSpec): void {
    const edge: PartialEdge = {
      from,
      to: spec.to,
      kind: spec.kind,
      label: spec.label,
      schema_id: spec.schema_id ?? null,
      response_schema_id: spec.response_schema_id ?? null,
      confidence: spec.confidence,
      confidence_reason:
        spec.confidence === "certain" ? null : spec.confidence_reason,
      condition: null,
      exclusive_group: null,
      branch_ordinal: null,
      is_error_path: false,
      source: at
        ? {
            repo: this.file.repo,
            path: this.file.path,
            line_start: lineStart(at),
            line_end: lineEnd(at),
          }
        : null,
    };
    this.edges.push({
      edge,
      limb: null,
      statementIndex: at ? at.startIndex : 0,
      fixed: null,
    });
  }

  private edgeAt(
    at: Node,
    owner: Definition | null,
    spec: EdgeSpec,
    limb: Limb | null,
    fixed: FixedBranch | null,
  ): void {
    let confidence: Confidence = spec.confidence;
    let reason: string | null =
      spec.confidence === "certain" ? null : spec.confidence_reason;
    let is_error_path = false;
    let condition: PartialEdge["condition"] = null;
    let group: string | null = null;

    if (fixed) {
      group = fixed.group;
      condition = { expr: fixed.expr, source_line: fixed.conditionLine };
    } else if (limb) {
      const verdict = limbErrorPath(limb, this.data.errorPaths);
      is_error_path = verdict.is_error_path;
      group = groupIdFor(this.file, owner, limb);
      condition = { expr: limb.expr, source_line: limb.conditionLine };
      if (verdict.uncertain) {
        const note =
          "call sits in an except handler: is_error_path defaulted to true (parser §6.2); a handler that retries may be the happy path";
        if (confidence === "certain") {
          confidence = "inferred";
          reason = note;
        } else if (reason) {
          reason = `${reason}; ${note}`;
        }
      }
    }

    const edge: PartialEdge = {
      from: this.fromFor(owner),
      to: spec.to,
      kind: spec.kind,
      label: spec.label,
      schema_id: spec.schema_id ?? null,
      response_schema_id: spec.response_schema_id ?? null,
      confidence,
      confidence_reason: reason,
      condition,
      exclusive_group: group,
      branch_ordinal: fixed ? fixed.ordinal : null, // limb ordinals assigned in finalize
      is_error_path,
      source: {
        repo: this.file.repo,
        path: this.file.path,
        line_start: lineStart(at),
        line_end: lineEnd(at),
      },
    };
    this.edges.push({ edge, limb, statementIndex: at.startIndex, fixed });
  }

  // --- the rest -------------------------------------------------------------

  addSchema(schema: PayloadSchema): void {
    if (this.schemas.some((s) => s.id === schema.id)) return;
    this.schemas.push(schema);
  }

  private readonly provideKeys = new Set<string>();

  /** Deduplicated: a TYPE_CHECKING import and a PEP 562 map may name the same alias. */
  addProvide(p: Provide): void {
    const key = JSON.stringify(p);
    if (this.provideKeys.has(key)) return;
    this.provideKeys.add(key);
    this.provides.push(p);
  }

  diag(
    severity: DiagnosticSeverity,
    code: string,
    message: string,
    line: number | null,
  ): void {
    this.diagnostics.push(diagnostic(this.file, severity, code, message, line));
  }

  unsupported(message: string, line: number | null): void {
    this.diag("warning", "unsupported_construct", message, line);
  }

  /**
   * Assign `branch_ordinal` within each limb-derived group: edges in source
   * order, deduplicated on (to, kind) within a limb so two call sites of one
   * relationship stay one edge, numbered consecutively across limbs. See the
   * report-back note: invariant 15 forbids two edges sharing an ordinal, so a
   * limb with several outgoing edges gets several ordinals.
   */
  finalize(): PackResult {
    const byGroup = new Map<string, PendingEdge[]>();
    for (const p of this.edges) {
      if (p.limb && p.edge.exclusive_group !== null && p.fixed === null) {
        const list = byGroup.get(p.edge.exclusive_group) ?? [];
        list.push(p);
        byGroup.set(p.edge.exclusive_group, list);
      }
    }
    const drop = new Set<PendingEdge>();
    for (const list of byGroup.values()) {
      list.sort(
        (a, b) =>
          (a.limb as Limb).index - (b.limb as Limb).index ||
          a.statementIndex - b.statementIndex,
      );
      const seen = new Set<string>();
      let ordinal = 0;
      for (const p of list) {
        const key = `${String((p.limb as Limb).index)} ${p.edge.from} ${targetKey(p.edge.to)} ${p.edge.kind}`;
        if (seen.has(key)) {
          drop.add(p);
          continue;
        }
        seen.add(key);
        p.edge = { ...p.edge, branch_ordinal: ordinal };
        ordinal += 1;
      }
    }
    const edges = this.edges.filter((p) => !drop.has(p)).map((p) => p.edge);
    return {
      nodes: this.nodeOrder.map((id) => this.nodes.get(id) as GraphNode),
      edges,
      schemas: this.schemas,
      provides: this.provides,
      diagnostics: this.diagnostics,
    };
  }
}

export interface EdgeSpec {
  readonly to: string | UnresolvedRef;
  readonly kind: EdgeKind;
  readonly label: string | null;
  readonly confidence: Confidence;
  readonly confidence_reason: string | null;
  readonly schema_id?: string | null;
  readonly response_schema_id?: string | null;
}

export interface FixedBranch {
  readonly group: string;
  readonly ordinal: number;
  readonly expr: string;
  readonly conditionLine: number;
}

interface PendingEdge {
  edge: PartialEdge;
  readonly limb: Limb | null;
  readonly statementIndex: number;
  readonly fixed: FixedBranch | null;
}

function targetKey(to: PartialEdge["to"]): string {
  return typeof to === "string" ? to : `${to.ref_kind}:${to.value}`;
}

/** Re-exported so recognizers resolving both endpoints in one file can mint ids (graph model §3.3.1). */
export { edgeId };
export type { EntryPointKind };
