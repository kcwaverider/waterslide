/**
 * The cross-file pass (decisions item 1): `compose(results) → PackPatch`.
 *
 * Run by core after stage 3 over every file this pack claimed, never cached,
 * with `results` sorted by (repo, path) byte-wise. Everything here iterates in
 * that order and relies on it; nothing is re-sorted.
 *
 * MAY: add nodes, edges, schemas, provides; add a source span to a node
 * emitted by another file; set or overwrite `parent`; annotate label,
 * is_entry_point, entry_point_kind, tags (plus `kind` for the client_service
 * rule, item 7; flagged in the report). MAY NOT: change a node id, remove a node.
 */
import {
  DEFAULT_TIER_BY_KIND,
  type Diagnostic,
  type Node as GraphNode,
  type NodeKind,
  type NodeUpdate,
  type PackPatch,
  type PackResult,
  type PartialEdge,
  type PerFileResult,
  type SymbolHints,
} from "@waterslide/core";
import { codeId, moduleId } from "./ids.js";
import { httpEdgeFrom } from "./recognizers/calls.js";
import {
  HOP_CAP,
  resolveThroughCallee,
  type FactsIndex,
  type HttpResolution,
} from "./recognizers/network.js";
import type {
  ArgValue,
  Candidate,
  FunctionFact,
  PropertyFact,
  SwiftFileState,
  TypeFact,
} from "./state.js";

/**
 * Core's `PerFileResult` is `{ repo, path, result }`. The Swift pack needs one
 * more thing per file to do cross-file work: the pack-private state recorded
 * by the per-file pass (extension spans with hashes, helper bodies, cross-file
 * call sites). Until the contract carries it, `compose` accepts results that
 * happen to have it and reports every file that does not.
 */
export interface SwiftPerFileResult extends PerFileResult {
  state?: SwiftFileState;
}

export type { NodeUpdate, PackPatch } from "@waterslide/core";

/** Coverage figures the run summary prints (handoff §6 item 6). */
export interface ComposeReport {
  /** Call sites whose receiver type is not declared in any file of the pack, by type name. */
  external_refs: Map<string, number>;
  /** Free-function calls to names not declared in the pack, by name. */
  external_functions: Map<string, number>;
  http_via_helper: number;
  symbol_edges: number;
  hop_cap_hits: number;
  extensions_merged: number;
  extensions_minted: number;
}

const byteCmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

interface RepoIndex {
  types: Map<string, { file: SwiftPerFileResult; fact: TypeFact }>;
  /** `${type}#${member}` (type "" for top level) → facts. */
  functions: Map<string, FunctionFact[]>;
  /** Properties contributed by extensions, by type name. */
  extProps: Map<string, PropertyFact[]>;
  /** Node kind by id, as emitted by the per-file pass. */
  kinds: Map<string, NodeKind>;
  schemaByType: Map<string, string>;
}

function fkey(type: string | null, member: string): string {
  return `${type ?? ""}#${member}`;
}

function buildIndex(
  results: readonly SwiftPerFileResult[],
  diagnostics: Diagnostic[],
): Map<string, RepoIndex> {
  const repos = new Map<string, RepoIndex>();
  for (const r of results) {
    if (r.state === undefined) continue;
    let idx = repos.get(r.repo);
    if (idx === undefined) {
      idx = {
        types: new Map(),
        functions: new Map(),
        extProps: new Map(),
        kinds: new Map(),
        schemaByType: new Map(),
      };
      repos.set(r.repo, idx);
    }
    for (const n of r.result.nodes) idx.kinds.set(n.id, n.kind);
    for (const t of r.state.types) {
      const existing = idx.types.get(t.qualified);
      if (existing !== undefined) {
        diagnostics.push({
          severity: "warning",
          code: "ambiguous_type_declaration",
          message: `type \`${t.qualified}\` is declared in both ${existing.file.path} and ${r.path}; references resolve against the first`,
          repo: r.repo,
          path: r.path,
          line: null,
          pack: "swift",
        });
        continue;
      }
      idx.types.set(t.qualified, { file: r, fact: t });
      if (t.schema_id !== null) idx.schemaByType.set(t.qualified, t.schema_id);
    }
    for (const f of r.state.functions) {
      const k = fkey(f.owner_type, f.member);
      const list = idx.functions.get(k);
      if (list === undefined) idx.functions.set(k, [f]);
      else list.push(f);
    }
    for (const e of r.state.extensions) {
      const list = idx.extProps.get(e.type_name);
      if (list === undefined) idx.extProps.set(e.type_name, [...e.properties]);
      else list.push(...e.properties);
    }
  }
  return repos;
}

function factsIndex(idx: RepoIndex): FactsIndex {
  return {
    functions: (typeName, member) =>
      idx.functions.get(fkey(typeName, member)) ?? [],
    type: (typeName) => idx.types.get(typeName)?.fact ?? null,
  };
}

interface Resolved {
  type_name: string | null;
  form: "instance" | "type";
  reason: string | null;
}

/** Finish a receiver chain against the whole repo's facts. */
function resolveChain(c: Candidate, idx: RepoIndex): Resolved | null {
  const first = c.chain[0];
  if (first === undefined)
    return { type_name: null, form: "type", reason: null };
  let cur: string;
  let form: "instance" | "type";
  if (first.kind === "type") {
    cur = first.name;
    form = "type";
  } else if (first.kind === "instance") {
    cur = first.type_name;
    form = "instance";
  } else {
    return null;
  }
  let reason: string | null = null;
  for (const step of c.chain.slice(1)) {
    if (step.kind !== "member") return null;
    const nested = idx.types.get(`${cur}.${step.name}`);
    if (nested !== undefined && form === "type") {
      cur = nested.fact.qualified;
      form = "type";
      continue;
    }
    const t = idx.types.get(cur);
    const props = [
      ...(t?.fact.properties ?? []),
      ...(idx.extProps.get(cur) ?? []),
    ];
    const prop = props.find(
      (p) => p.name === step.name && p.is_static === (form === "type"),
    );
    if (prop?.type) {
      cur = prop.type;
      form = "instance";
      continue;
    }
    if (form === "type") {
      reason = `receiver reaches static member \`${step.name}\` of ${cur} whose type is not written in source; taken as an instance of ${cur} (singleton convention)`;
      form = "instance";
      continue;
    }
    return null;
  }
  return { type_name: cur, form, reason };
}

function schemaFor(
  idx: RepoIndex,
  typeName: string | null | undefined,
): string | null {
  if (typeName === null || typeName === undefined) return null;
  return idx.schemaByType.get(typeName) ?? null;
}

function encodedType(args: Candidate["args"]): string | null {
  const walk = (v: ArgValue): string | null => {
    if (v.kind === "encoded") return v.type_name ?? null;
    for (const a of v.args ?? []) {
      const t = walk(a.value);
      if (t !== null) return t;
    }
    return null;
  };
  for (const a of args) {
    const t = walk(a.value);
    if (t !== null) return t;
  }
  return null;
}

export function compose(results: readonly SwiftPerFileResult[]): PackPatch {
  return composeWithReport(results).patch;
}

export function composeWithReport(results: readonly SwiftPerFileResult[]): {
  patch: PackPatch;
  report: ComposeReport;
} {
  const patch: PackPatch = {
    nodes: [],
    edges: [],
    schemas: [],
    provides: [],
    diagnostics: [],
    node_updates: [],
  };
  const report: ComposeReport = {
    external_refs: new Map(),
    external_functions: new Map(),
    http_via_helper: 0,
    symbol_edges: 0,
    hop_cap_hits: 0,
    extensions_merged: 0,
    extensions_minted: 0,
  };
  const repos = buildIndex(results, patch.diagnostics);
  const httpTypes = new Set<string>();
  for (const r of results)
    for (const id of r.state?.http_types ?? []) httpTypes.add(id);

  // --- Extensions (item 2) --------------------------------------------------
  const minted = new Map<string, string>(); // `${repo}|${type}` → node id
  for (const r of results) {
    const idx = repos.get(r.repo);
    if (idx === undefined || r.state === undefined) continue;
    for (const ext of r.state.extensions) {
      const declared = idx.types.get(ext.type_name);
      let typeNodeId: string;
      if (declared !== undefined) {
        typeNodeId = declared.fact.node_id;
        patch.node_updates.push({
          node_id: typeNodeId,
          add_sources: [ext.span],
        });
        report.extensions_merged++;
      } else {
        const key = `${r.repo}|${ext.type_name}`;
        const existing = minted.get(key);
        if (existing === undefined) {
          // The declaring file is not among this pack's results (a framework
          // type): the first extension file, in sorted order, is the declaring site.
          typeNodeId = codeId(r.repo, r.path, ext.type_name);
          minted.set(key, typeNodeId);
          patch.nodes.push({
            id: typeNodeId,
            kind: "class",
            label: ext.type_name,
            tier: DEFAULT_TIER_BY_KIND.class ?? "domain",
            parent: moduleId(r.repo, r.path),
            sources: [ext.span],
            confidence: "certain",
            confidence_reason: null,
            is_entry_point: false,
            entry_point_kind: null,
            is_infrastructure: false,
            tags: [],
          });
          patch.provides.push({
            name: ext.type_name,
            node_id: typeNodeId,
            alias_of: null,
            ref_kind: "symbol",
            visibility: "module",
            scope: "global",
            scope_path: null,
          });
          idx.kinds.set(typeNodeId, "class");
          report.extensions_minted++;
        } else {
          typeNodeId = existing;
          patch.node_updates.push({
            node_id: typeNodeId,
            add_sources: [ext.span],
          });
        }
      }
      for (const member of ext.member_ids) {
        patch.node_updates.push({
          node_id: member,
          add_sources: [],
          parent: typeNodeId,
        });
      }
      for (const f of ext.functions) {
        if (
          r.result.edges.some(
            (e) => e.from === f.node_id && e.kind === "http_request",
          )
        ) {
          httpTypes.add(typeNodeId);
        }
      }
    }
  }

  // --- Candidates -----------------------------------------------------------
  for (const r of results) {
    const idx = repos.get(r.repo);
    if (idx === undefined || r.state === undefined) continue;
    const facts = factsIndex(idx);
    const externals = new Map<string, number>();
    for (const c of r.state.candidates) {
      if (c.consumed) continue;
      const line = c.edge.source?.line_start ?? 1;
      if (c.form === "free_function") {
        const name = c.member ?? "";
        const declared = idx.functions.get(fkey(null, name)) ?? [];
        if (declared.length === 0) {
          report.external_functions.set(
            name,
            (report.external_functions.get(name) ?? 0) + 1,
          );
          continue;
        }
        const http = tryHttp(declared, c, facts, patch, r, report);
        patch.edges.push(http ?? symbolEdge(c, name, null));
        if (http === null) report.symbol_edges++;
        if (http !== null && c.from_type !== null) httpTypes.add(c.from_type);
        continue;
      }
      const resolved = resolveChain(c, idx);
      if (resolved === null || resolved.type_name === null) {
        const root = c.chain[0];
        const name =
          root?.kind === "type"
            ? root.name
            : root?.kind === "instance"
              ? root.type_name
              : "?";
        externals.set(name, (externals.get(name) ?? 0) + 1);
        continue;
      }
      const typeName = resolved.type_name;
      const declaredType = idx.types.get(typeName);
      if (c.form === "constructor") {
        if (declaredType === undefined) {
          externals.set(typeName, (externals.get(typeName) ?? 0) + 1);
          continue;
        }
        patch.edges.push(symbolEdge(c, typeName, typeName, resolved.reason));
        report.symbol_edges++;
        continue;
      }
      const member = c.member ?? "";
      const memberFacts = idx.functions.get(fkey(typeName, member)) ?? [];
      if (declaredType === undefined && memberFacts.length === 0) {
        externals.set(typeName, (externals.get(typeName) ?? 0) + 1);
        continue;
      }
      const http =
        memberFacts.length === 0
          ? null
          : tryHttp(memberFacts, c, facts, patch, r, report);
      if (http !== null) {
        http.response_schema_id = schemaFor(idx, c.result_type);
        http.schema_id = schemaFor(idx, encodedType(c.args));
        patch.edges.push(http);
        if (c.from_type !== null) httpTypes.add(c.from_type);
        continue;
      }
      patch.edges.push(
        symbolEdge(c, `${typeName}.${member}`, typeName, resolved.reason),
      );
      report.symbol_edges++;
    }
    if (externals.size > 0) {
      const entries = [...externals.entries()].sort(
        (a, b) => b[1] - a[1] || byteCmp(a[0], b[0]),
      );
      for (const [name, n] of entries)
        report.external_refs.set(
          name,
          (report.external_refs.get(name) ?? 0) + n,
        );
      patch.diagnostics.push({
        severity: "info",
        code: "external_type_reference",
        message: `${String(entries.reduce((s, e) => s + e[1], 0))} call site(s) target types not declared in this pack's files (framework or other package), not drawn: ${entries
          .slice(0, 12)
          .map(([k, v]) => `${k} (${String(v)})`)
          .join(", ")}${entries.length > 12 ? ", …" : ""}`,
        repo: r.repo,
        path: r.path,
        line: null,
        pack: "swift",
      });
    }
  }

  // --- client_service (item 7) -----------------------------------------------
  // A type whose members reach HTTP only through a helper in another file is
  // known here, but `NodeUpdate` carries no `kind`, so the reclassification is
  // unrepresentable in a PackPatch. Reported rather than silently dropped; the
  // per-file pass already marks types with a direct send.
  const stillClass: string[] = [];
  for (const id of [...httpTypes].sort(byteCmp)) {
    let kind: NodeKind | undefined;
    for (const idx of repos.values()) kind ??= idx.kinds.get(id);
    if (kind === "class") stillClass.push(id);
  }
  if (stillClass.length > 0) {
    patch.diagnostics.push({
      severity: "warning",
      code: "kind_update_unrepresentable",
      message: `${String(stillClass.length)} type(s) issue HTTP requests only through a helper and should be client_service (decisions item 7), but NodeUpdate cannot change kind; left as class: ${stillClass.map((id) => id.split("#")[1] ?? id).join(", ")}`,
      repo: null,
      path: null,
      line: null,
      pack: "swift",
    });
  }

  patch.nodes.sort((a, b) => byteCmp(a.id, b.id));
  patch.provides.sort((a, b) =>
    byteCmp(`${a.name} ${a.node_id}`, `${b.name} ${b.node_id}`),
  );
  return { patch, report };
}

function symbolEdge(
  c: Candidate,
  value: string,
  receiverType: string | null,
  reason: string | null = null,
): PartialEdge {
  const hints: SymbolHints = {
    arity: c.args.length,
    receiver_type: receiverType,
  };
  const e: PartialEdge = {
    ...c.edge,
    to: {
      ref_kind: "symbol",
      value,
      hints,
      source_line: c.edge.source?.line_start ?? 1,
    },
  };
  if (reason !== null) {
    e.confidence = "inferred";
    e.confidence_reason =
      e.confidence_reason === null
        ? reason
        : `${e.confidence_reason}; ${reason}`;
  }
  return e;
}

function tryHttp(
  callees: FunctionFact[],
  c: Candidate,
  facts: FactsIndex,
  patch: PackPatch,
  r: SwiftPerFileResult,
  report: ComposeReport,
): PartialEdge | null {
  const line = c.edge.source?.line_start ?? 1;
  const resolutions: HttpResolution[] = [];
  let hopCap: string | null = null;
  for (const f of callees) {
    const res = resolveThroughCallee(f, c.args, facts);
    if (res === null) continue;
    if ("hop_cap" in res) {
      hopCap = res.stopped_at;
      continue;
    }
    if (
      !resolutions.some(
        (x) => x.rendered.path === res.rendered.path && x.method === res.method,
      )
    )
      resolutions.push(res);
  }
  const single = resolutions[0];
  if (resolutions.length === 1 && single !== undefined) {
    report.http_via_helper++;
    const bound = c.args.find((a) => a.label !== null)?.label ?? null;
    return httpEdgeFrom(c.edge, single, c.args, bound, line);
  }
  if (resolutions.length > 1) {
    patch.diagnostics.push({
      severity: "warning",
      code: "ambiguous_helper_resolution",
      message: `call at line ${String(line)} resolves to ${String(resolutions.length)} different paths through overloads (${resolutions.map((x) => x.rendered.path).join(", ")}); emitted as a call edge rather than guessing`,
      repo: r.repo,
      path: r.path,
      line,
      pack: "swift",
    });
  }
  if (hopCap !== null && resolutions.length === 0) {
    report.hop_cap_hits++;
    patch.diagnostics.push({
      severity: "warning",
      code: "url_reconstruction_hop_cap",
      message: `URL reconstruction for the call at line ${String(line)} stopped at ${hopCap} (hop cap ${String(HOP_CAP)}); emitted as a call edge`,
      repo: r.repo,
      path: r.path,
      line,
      pack: "swift",
    });
  }
  return null;
}

/** Merge per-file results and a patch into one five-return result (for the driver and tests). */
export function applyPatch(
  results: readonly SwiftPerFileResult[],
  patch: PackPatch,
): PackResult {
  const nodes = new Map<string, GraphNode>();
  const out: PackResult = {
    nodes: [],
    edges: [],
    schemas: [],
    provides: [],
    diagnostics: [],
  };
  for (const r of results) {
    for (const n of r.result.nodes) nodes.set(n.id, structuredClone(n));
    out.edges.push(...r.result.edges);
    out.schemas.push(...r.result.schemas);
    out.provides.push(...r.result.provides);
    out.diagnostics.push(...r.result.diagnostics);
  }
  for (const n of patch.nodes) nodes.set(n.id, structuredClone(n));
  for (const u of patch.node_updates) {
    const n = nodes.get(u.node_id);
    if (n === undefined) {
      out.diagnostics.push({
        severity: "error",
        code: "recognizer_failure",
        message: `compose update targets unknown node ${u.node_id}`,
        repo: null,
        path: null,
        line: null,
        pack: "swift",
      });
      continue;
    }
    n.sources.push(...u.add_sources);
    if (u.parent !== undefined) n.parent = u.parent;
    if (u.label !== undefined) n.label = u.label;
    if (u.is_entry_point !== undefined) n.is_entry_point = u.is_entry_point;
    if (u.entry_point_kind !== undefined)
      n.entry_point_kind = u.entry_point_kind;
    if (u.tags !== undefined) n.tags = u.tags;
  }
  out.nodes = [...nodes.values()].sort((a, b) => byteCmp(a.id, b.id));
  out.edges.push(...patch.edges);
  out.schemas.push(...patch.schemas);
  out.provides.push(...patch.provides);
  out.diagnostics.push(...patch.diagnostics);
  return out;
}
