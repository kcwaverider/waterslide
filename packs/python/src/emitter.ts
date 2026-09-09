import {
  DEFAULT_TIER_BY_KIND,
  type Confidence,
  type Diagnostic,
  type DiagnosticSeverity,
  type EdgeKind,
  type Node as GraphNode,
  type PackData as PackDataRecord,
  type PackNode,
  type NodeKind,
  type PartialEdge,
  type PackResult,
  type PayloadSchema,
  type Provide,
  spanHash,
  type Tier,
  type UnresolvedRef,
} from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type { PackData } from "./data.js";
import { diagnostic } from "./diagnostics.js";
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
  private readonly nodes = new Map<string, PackNode>();
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

  addNode(node: PackNode): void {
    if (this.nodes.has(node.id)) return; // identity is owned by whoever emitted first
    this.nodes.set(node.id, node);
    this.nodeOrder.push(node.id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): PackNode | undefined {
    return this.nodes.get(id);
  }

  /** Framework recognizers annotate; they never change an id or remove a node (parser §3.2). */
  annotateNode(
    id: string,
    patch: Partial<
      Pick<
        PackNode,
        | "kind"
        | "label"
        | "tier"
        | "is_entry_point"
        | "entry_point_kind"
        | "tags"
        | "pack_data"
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
      ...(spec.pack_data !== undefined ? { pack_data: spec.pack_data } : {}),
    };
    this.edges.push({
      edge,
      limb: null,
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
      // Which limb this edge came from, so the suite can check that edges
      // sharing an ordinal share a limb (A6 item 2). Pack-private; core strips it.
      ...(limb
        ? {
            pack_data: {
              python: {
                limb: limb.index,
                branch_line: lineStart(limb.statement),
              },
            },
          }
        : {}),
    };
    this.edges.push({ edge, limb, fixed });
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
   * `branch_ordinal` is the position of the ALTERNATIVE within its group
   * (graph model §3.3, amended 2026-09-09): every edge from one limb shares an
   * ordinal, and ordinals run contiguously from 0 over the limbs that actually
   * produced edges — a limb that gates no edge contributes no alternative
   * (parser §6.1). Two call sites of one relationship are collapsed by core
   * (§3.3), not here.
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
    for (const list of byGroup.values()) {
      const limbs = [...new Set(list.map((p) => (p.limb as Limb).index))].sort(
        (a, b) => a - b,
      );
      const ordinalOf = new Map(limbs.map((idx, i) => [idx, i] as const));
      for (const p of list) {
        p.edge = {
          ...p.edge,
          branch_ordinal: ordinalOf.get((p.limb as Limb).index) as number,
        };
      }
    }
    // A name that is a node in this file (`router = APIRouter()`) never also
    // aliases elsewhere: two candidates for one name would read as ambiguity.
    const nodeBacked = new Set(
      this.provides
        .filter((p) => p.node_id !== null)
        .map((p) => `${p.ref_kind} ${p.scope} ${p.name}`),
    );
    const provides = this.provides.filter(
      (p) =>
        p.alias_of === null ||
        !nodeBacked.has(`${p.ref_kind} ${p.scope} ${p.name}`),
    );
    return {
      nodes: this.nodeOrder.map((id) => this.nodes.get(id) as PackNode),
      edges: this.edges.map((p) => p.edge),
      schemas: this.schemas,
      provides,
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
  /** Pack-private facts for this pack's own `compose`; core strips it after compose. */
  readonly pack_data?: PackDataRecord;
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
  readonly fixed: FixedBranch | null;
}
