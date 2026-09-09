import { byteCompare } from "../canonical.js";
import {
  DEFAULT_TIER_BY_KIND,
  ORDERED_TIERS,
  type NodeKind,
  type RefKind,
  type Tier,
} from "../model/enums.js";
import type { Node } from "../model/graph.js";
import {
  PROVIDE_ALIAS_MAX_DEPTH,
  type Diagnostic,
  type UnresolvedRef,
} from "../model/pack.js";
import { unknownNodeId, unknownNodeLabel } from "../unknown-id.js";
import type { ResolvedPartialEdge } from "./derive-edges.js";
import type { Corpus, EdgeOrigin, ProvideOrigin } from "./index.js";
import { vendorByHost, vendorById } from "./vendors.js";

/**
 * Stage 4 — resolution. Parser §4.
 *
 * Runs in full on every parse over the whole in-memory corpus; it receives no
 * cache and there is no cache type it could write to (§2.2). It is a pure
 * function of the corpus, so shuffling discovery order cannot change it as
 * long as every collection it iterates is sorted first — which is why every
 * loop below runs over a sorted copy.
 */

export const STAGE4_DIAGNOSTIC_CODES = {
  /** A pack emitted an edge whose string endpoint names no node. The edge is dropped: an id is not a name and cannot dangle. */
  edge_endpoint_missing: "error",
  /** A provide's node_id names no node. The provide is ignored. */
  provide_target_missing: "error",
  /** A reference matched several provides; every candidate was drawn, all inferred. */
  ambiguous_ref: "info",
  /** Stage 4 could not resolve an UnresolvedRef (graph model §10). */
  unresolved_ref: "warning",
  unresolvable_provide_alias: "warning",
  undeclared_datastore_namespace: "warning",
} as const;

type Stage4Code = keyof typeof STAGE4_DIAGNOSTIC_CODES;

export interface ResolveStats {
  /** References that matched exactly one target. */
  resolved: number;
  /** References that matched several targets and fanned out. */
  ambiguous: number;
  /** References that matched nothing and were drawn to an unknown node. */
  dangling: number;
  /** References resolved through a factory's return annotation (C9). */
  via_factory: number;
  /** Unresolved references grouped by ref_kind: the coverage metric (handoff §6 item 6). */
  unresolved_by_kind: Record<RefKind, number>;
  /** Nodes minted by resolution, by kind. */
  minted: Partial<Record<NodeKind, number>>;
}

export interface ResolveOutput {
  /** Corpus nodes plus minted nodes, sorted by id. */
  readonly nodes: Node[];
  /** Every edge with a node-id target, one per call site; collapsing is stage 5's. */
  readonly edges: ResolvedPartialEdge[];
  readonly diagnostics: Diagnostic[];
  readonly stats: ResolveStats;
}

// ---------------------------------------------------------------------------
// The index — keyed by (ref_kind, name), scope-aware at match time (§3.4).
// ---------------------------------------------------------------------------

interface IndexEntry {
  readonly origin: ProvideOrigin;
  /** Node ids this entry resolves to, alias chains followed. Empty when the chain ends nowhere. */
  readonly targets: readonly string[];
  /** The name the alias chain ended at; the entry's own name when it is not an alias. */
  readonly terminal: string;
}

const indexKey = (ref_kind: RefKind, name: string): string =>
  `${ref_kind} ${name}`;

const isBare = (name: string): boolean => !name.includes(".");

function provideCompare(a: ProvideOrigin, b: ProvideOrigin): number {
  return (
    byteCompare(a.provide.ref_kind, b.provide.ref_kind) ||
    byteCompare(a.provide.name, b.provide.name) ||
    byteCompare(a.repo ?? "", b.repo ?? "") ||
    byteCompare(a.path ?? "", b.path ?? "") ||
    byteCompare(JSON.stringify(a.provide), JSON.stringify(b.provide))
  );
}

class ProvideIndex {
  private readonly byKey = new Map<string, IndexEntry[]>();

  constructor(
    provides: readonly ProvideOrigin[],
    nodeIds: ReadonlySet<string>,
    diagnostics: Diagnostic[],
  ) {
    const sorted = [...provides].sort(provideCompare);
    const direct = new Map<string, ProvideOrigin[]>();
    for (const p of sorted) {
      const k = indexKey(p.provide.ref_kind, p.provide.name);
      const list = direct.get(k) ?? [];
      list.push(p);
      direct.set(k, list);
    }
    for (const p of sorted) {
      const entry = resolveTargets(p, direct, nodeIds, diagnostics);
      if (entry === null) continue;
      const k = indexKey(p.provide.ref_kind, p.provide.name);
      const list = this.byKey.get(k) ?? [];
      list.push(entry);
      this.byKey.set(k, list);
    }
  }

  lookup(ref_kind: RefKind, name: string): readonly IndexEntry[] {
    return this.byKey.get(indexKey(ref_kind, name)) ?? [];
  }
}

/**
 * Follows `alias_of` chains, breadth-first since a hop may fan out to several
 * candidates. Alias targets are qualified names, so only global provides can
 * satisfy a hop. Returns null when the entry must be dropped: a cycle, or more
 * than PROVIDE_ALIAS_MAX_DEPTH hops. A chain that ends at a name nobody
 * provides is kept with no targets; a reference through it dangles, naming
 * the terminal, which is more useful than dropping the alias.
 */
function resolveTargets(
  start: ProvideOrigin,
  direct: ReadonlyMap<string, ProvideOrigin[]>,
  nodeIds: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): IndexEntry | null {
  const kind = start.provide.ref_kind;
  if (start.provide.alias_of === null) {
    const id = start.provide.node_id ?? "";
    if (!nodeIds.has(id)) {
      diagnostics.push(
        diag(
          "provide_target_missing",
          `provide "${start.provide.name}" (${kind}) names node "${id}", which no pack emitted; ignored`,
          start,
        ),
      );
      return null;
    }
    return { origin: start, targets: [id], terminal: start.provide.name };
  }
  let frontier: string[] = [start.provide.alias_of];
  const seen = new Set<string>([start.provide.name]);
  const targets = new Set<string>();
  let terminal = start.provide.alias_of;
  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > PROVIDE_ALIAS_MAX_DEPTH) {
      diagnostics.push(
        diag(
          "unresolvable_provide_alias",
          `provide "${start.provide.name}" (${kind}) aliases through more than ${String(PROVIDE_ALIAS_MAX_DEPTH)} hops; dropped`,
          start,
        ),
      );
      return null;
    }
    const next: string[] = [];
    for (const name of [...frontier].sort(byteCompare)) {
      if (seen.has(name)) {
        diagnostics.push(
          diag(
            "unresolvable_provide_alias",
            `provide "${start.provide.name}" (${kind}) aliases in a cycle through "${name}"; dropped`,
            start,
          ),
        );
        return null;
      }
      seen.add(name);
      terminal = name;
      const candidates = (direct.get(indexKey(kind, name)) ?? []).filter(
        (c) => c.provide.scope === "global",
      );
      for (const c of candidates) {
        if (c.provide.alias_of !== null) next.push(c.provide.alias_of);
        else if (c.provide.node_id !== null && nodeIds.has(c.provide.node_id))
          targets.add(c.provide.node_id);
      }
    }
    frontier = next;
  }
  return { origin: start, targets: [...targets].sort(byteCompare), terminal };
}

function diag(
  code: Stage4Code,
  message: string,
  where: { repo: string | null; path: string | null },
  line: number | null = null,
): Diagnostic {
  return {
    severity: STAGE4_DIAGNOSTIC_CODES[code],
    code,
    message,
    repo: where.repo,
    path: where.path,
    line,
    pack: null,
  };
}

// ---------------------------------------------------------------------------
// Scope and visibility (§3.4, plus the same-repo rule for bare global names).
// ---------------------------------------------------------------------------

function visibleFrom(entry: IndexEntry, origin: EdgeOrigin): boolean {
  const p = entry.origin.provide;
  const sameRepo =
    entry.origin.repo !== null && entry.origin.repo === origin.repo;
  const sameFile = sameRepo && entry.origin.path === origin.path;
  if (p.scope === "file") {
    // Bound in the importing file only. scope_path is a path within the
    // provide's own repo, so the repo must agree as well.
    if (!(sameRepo && p.scope_path === origin.path)) return false;
  } else if (p.ref_kind === "symbol" && isBare(p.name) && !sameRepo) {
    // A bare global symbol is module-wide within its repo, not across repos:
    // two repos each declaring `APIClient` are not an ambiguity. Route names
    // ("PUT /notes/{id}") have no dots and are global by nature.
    return false;
  }
  switch (p.visibility) {
    case "public":
      return true;
    case "module":
      return sameRepo;
    case "private":
      return sameFile;
  }
}

// ---------------------------------------------------------------------------
// Resolution proper.
// ---------------------------------------------------------------------------

interface Pending {
  readonly origin: EdgeOrigin;
  readonly ref: UnresolvedRef;
}

interface Mint {
  id: string;
  kind: NodeKind;
  label: string;
  confidence: "certain" | "inferred";
  reason: string;
  okay: boolean;
}

interface MintedNode {
  node: Node;
  anyCertain: boolean;
  reasons: Set<string>;
  fromTiers: Set<Tier>;
  origins: string[];
}

/** The name a reference is looked up under: http refs carry their method, `?` when unknown (C-Q2). */
export function refLookupName(ref: UnresolvedRef): string {
  if (ref.ref_kind === "http")
    return `${ref.hints?.method ?? "?"} ${ref.value}`;
  return ref.value;
}

export function resolve(corpus: Corpus): ResolveOutput {
  const diagnostics: Diagnostic[] = [];
  const stats: ResolveStats = {
    resolved: 0,
    ambiguous: 0,
    dangling: 0,
    via_factory: 0,
    unresolved_by_kind: {
      symbol: 0,
      http: 0,
      topic: 0,
      datastore: 0,
      external: 0,
    },
    minted: {},
  };
  const nodesById = new Map<string, Node>();
  for (const n of corpus.nodes) nodesById.set(n.id, n);
  const index = new ProvideIndex(
    corpus.provides,
    new Set(nodesById.keys()),
    diagnostics,
  );
  const minted = new Map<string, MintedNode>();
  const out: ResolvedPartialEdge[] = [];

  // Sorted so minted-node reasons, tiers and origins accumulate in one order
  // regardless of how the corpus was assembled.
  const edges = [...corpus.edges].sort(edgeOriginCompare);

  for (const origin of edges) {
    const e = origin.edge;
    const line = e.source?.line_start ?? null;
    if (!nodesById.has(e.from)) {
      diagnostics.push(
        diag(
          "edge_endpoint_missing",
          `edge from "${e.from}" (${e.kind}) names a source node no pack emitted; dropped`,
          origin,
          line,
        ),
      );
      continue;
    }
    if (typeof e.to === "string") {
      if (!nodesById.has(e.to)) {
        diagnostics.push(
          diag(
            "edge_endpoint_missing",
            `edge from "${e.from}" to "${e.to}" (${e.kind}) names a target node no pack emitted; dropped`,
            origin,
            line,
          ),
        );
        continue;
      }
      out.push({ ...e, to: e.to });
      continue;
    }
    const pending: Pending = { origin, ref: e.to };
    const from = nodesById.get(e.from) as Node;
    switch (pending.ref.ref_kind) {
      case "symbol":
      case "http":
        resolveByIndex(pending, from);
        break;
      case "topic":
        mintAndConnect(pending, from, {
          id: `topic:${pending.ref.value}`,
          kind: "topic",
          label: pending.ref.value,
          confidence: "inferred",
          reason: `matched topic string '${pending.ref.value}'; the broker holds the real mapping`,
          okay: pending.ref.value.length > 0,
        });
        break;
      case "datastore":
        resolveDatastore(pending, from);
        break;
      case "external":
        resolveExternal(pending, from);
        break;
    }
  }

  const mintedNodes = [...minted.values()]
    .sort((a, b) => byteCompare(a.node.id, b.node.id))
    .map((m) => finishMinted(m));
  for (const m of mintedNodes)
    stats.minted[m.kind] = (stats.minted[m.kind] ?? 0) + 1;
  const allNodes = [...corpus.nodes, ...mintedNodes].sort((a, b) =>
    byteCompare(a.id, b.id),
  );

  return { nodes: allNodes, edges: out, diagnostics, stats };

  // -- helpers closing over run state ---------------------------------------

  function lookupVisible(
    ref_kind: RefKind,
    name: string,
    origin: EdgeOrigin,
  ): IndexEntry[] {
    return index
      .lookup(ref_kind, name)
      .filter((entry) => visibleFrom(entry, origin));
  }

  function resolveByIndex(p: Pending, from: Node): void {
    const { ref, origin } = p;
    const name = refLookupName(ref);
    let candidates = lookupVisible(ref.ref_kind, name, origin);
    let targets = uniqueTargets(candidates);
    let factory: { call: string; terminal: string; file: string } | null = null;

    if (targets.length === 0 && ref.ref_kind === "symbol") {
      // C9: a factory-returned receiver. `services.get_s3_service().upload_bytes`
      // is a call whose result's type the pack could not see; the defining
      // file provides `services.get_s3_service()` as an alias of its return
      // annotation. Longest prefix ending in "()", split at ".", one
      // re-resolution pass, never a loop.
      const hit = factoryPrefix(name, origin);
      if (hit !== null) {
        factory = hit;
        candidates = lookupVisible(ref.ref_kind, hit.retargeted, origin);
        targets = uniqueTargets(candidates);
        if (targets.length === 0) {
          dangle(
            p,
            from,
            `matched factory '${hit.call}' with return annotation '${hit.terminal}' (${hit.file}), but '${hit.retargeted}' matched no definition`,
          );
          return;
        }
      }
    }

    if (targets.length === 0) {
      const terminal = candidates.find((c) => c.terminal !== name)?.terminal;
      const what = ref.ref_kind === "http" ? "route" : "definition";
      const via = terminal === undefined ? "" : ` (via alias to '${terminal}')`;
      const methodNote =
        ref.ref_kind === "http" && (ref.hints?.method ?? null) === null
          ? "; the HTTP method was not determinable, so no route can match"
          : "";
      dangle(p, from, `matched no ${what}${via}${methodNote}`);
      return;
    }

    const base = origin.edge;
    if (targets.length === 1) {
      stats.resolved += 1;
      const to = targets[0] as string;
      if (factory !== null) {
        stats.via_factory += 1;
        out.push(
          downgrade(
            { ...base, to },
            `resolved through factory '${factory.call}': its return annotation '${factory.terminal}' in ${factory.file} names the receiver type; the annotation was not verified at the call site`,
          ),
        );
      } else if (ref.ref_kind === "http") {
        out.push(
          downgrade(
            { ...base, to },
            `matched URL path literal '${name}' to route provide in ${originOf(candidates[0] as IndexEntry)}`,
          ),
        );
      } else {
        out.push({ ...base, to });
      }
      return;
    }

    stats.ambiguous += 1;
    const list = targets.join(", ");
    diagnostics.push(
      diag(
        "ambiguous_ref",
        `${ref.ref_kind} reference '${name}' from ${where(origin)} matches ${String(targets.length)} definitions: ${list}; every candidate drawn`,
        origin,
        ref.source_line,
      ),
    );
    for (const to of targets) {
      out.push(
        downgrade(
          { ...base, to },
          `ambiguous: '${name}' is provided by ${String(targets.length)} definitions (${list}); every candidate is drawn rather than one chosen`,
        ),
      );
    }
  }

  /** Longest prefix of `name`, split at ".", ending in "()", that is provided and visible. */
  function factoryPrefix(
    name: string,
    origin: EdgeOrigin,
  ): {
    call: string;
    terminal: string;
    file: string;
    retargeted: string;
  } | null {
    for (
      let i = name.lastIndexOf(".");
      i > 0;
      i = name.lastIndexOf(".", i - 1)
    ) {
      const prefix = name.slice(0, i);
      if (!prefix.endsWith("()")) continue;
      const entries = lookupVisible("symbol", prefix, origin);
      if (entries.length === 0) continue;
      // Several entries for one factory name would be an ambiguity of the
      // factory itself; take them all into account by retargeting against
      // each terminal and letting the second lookup fan out.
      const terminals = [...new Set(entries.map((en) => en.terminal))].sort(
        byteCompare,
      );
      const first = entries[0] as IndexEntry;
      const terminal = terminals[0] as string;
      return {
        call: prefix,
        terminal,
        file: originOf(first),
        retargeted: `${terminal}${name.slice(i)}`,
      };
    }
    return null;
  }

  function resolveDatastore(p: Pending, from: Node): void {
    const { ref, origin } = p;
    if (ref.ref_kind !== "datastore") return;
    const hints = ref.hints;
    if (hints === undefined) {
      dangle(
        p,
        from,
        "carried no datastore hints, so the store and namespace are unknown",
      );
      return;
    }
    const namespace = hints.namespace ?? "unknown";
    if (hints.namespace === null) {
      diagnostics.push(
        diag(
          "undeclared_datastore_namespace",
          `collection '${ref.value}' referenced from ${where(origin)} has no visible ${hints.store === "mongo" ? "database" : "schema"} name; minted as ${hints.store}:unknown.${ref.value}`,
          origin,
          ref.source_line,
        ),
      );
    }
    mintAndConnect(p, from, {
      id: `${hints.store}:${namespace}.${ref.value}`,
      kind: hints.store === "mongo" ? "collection" : "table",
      label: ref.value,
      confidence: origin.edge.confidence === "certain" ? "certain" : "inferred",
      reason:
        origin.edge.confidence_reason ??
        `named in a ${hints.operation} at ${where(origin)}`,
      okay:
        ref.value.length > 0 &&
        !ref.value.includes(".") &&
        namespace.length > 0 &&
        !namespace.includes("."),
    });
  }

  function resolveExternal(p: Pending, from: Node): void {
    const { ref } = p;
    if (ref.ref_kind !== "external") return;
    const sdk = ref.hints?.sdk_symbol ?? null;
    const slash = ref.value.indexOf("/");
    const looksLikeUrl = ref.value.includes("://");
    if (!looksLikeUrl && slash > 0 && slash < ref.value.length - 1) {
      const vendor = ref.value.slice(0, slash);
      const known = vendorById(vendor);
      mintAndConnect(p, from, {
        id: `ext:${ref.value}`,
        kind: "external_service",
        label:
          known === null
            ? ref.value
            : `${known.label} ${ref.value.slice(slash + 1)}`,
        confidence: sdk === null ? "inferred" : "certain",
        reason:
          sdk === null
            ? `vendor surface '${ref.value}' named without an SDK symbol`
            : `SDK symbol ${sdk}`,
        okay: true,
      });
      return;
    }
    if (looksLikeUrl) {
      let host = "";
      let firstSegment = "api";
      try {
        const u = new URL(ref.value);
        host = u.hostname;
        firstSegment =
          u.pathname.split("/").filter((s) => s.length > 0)[0] ?? "api";
      } catch {
        host = "";
      }
      const vendor = host === "" ? null : vendorByHost(host);
      if (vendor !== null) {
        mintAndConnect(p, from, {
          id: `ext:${vendor.id}/${firstSegment}`,
          kind: "external_service",
          label: `${vendor.label} ${firstSegment}`,
          confidence: "inferred",
          reason: `matched bare URL host '${host}' to vendor ${vendor.label}`,
          okay: true,
        });
        return;
      }
    }
    dangle(p, from, "names no known vendor surface or host");
  }

  function mintAndConnect(p: Pending, from: Node, mint: Mint): void {
    if (!mint.okay) {
      dangle(p, from, "is not a well-formed target name");
      return;
    }
    if (!nodesById.has(mint.id)) {
      const m = minted.get(mint.id) ?? {
        node: syntheticNode(
          mint.id,
          mint.kind,
          mint.label,
          DEFAULT_TIER_BY_KIND[mint.kind] ?? "store",
        ),
        anyCertain: false,
        reasons: new Set<string>(),
        fromTiers: new Set<Tier>(),
        origins: [],
      };
      if (mint.confidence === "certain") m.anyCertain = true;
      else m.reasons.add(mint.reason);
      minted.set(mint.id, m);
    }
    stats.resolved += 1;
    const base = p.origin.edge;
    if (p.ref.ref_kind === "topic")
      out.push(downgrade({ ...base, to: mint.id }, mint.reason));
    else out.push({ ...base, to: mint.id });
  }

  /** Parser §4.2: a dangling edge to `unknown:{ref_kind}:{value}`, never a dropped one. */
  function dangle(p: Pending, from: Node, why: string): void {
    const { ref, origin } = p;
    const value = refLookupName(ref);
    const id = unknownNodeId(ref.ref_kind, value);
    const m = minted.get(id) ?? {
      node: syntheticNode(
        id,
        "unknown",
        unknownNodeLabel(ref.ref_kind, value),
        "domain",
      ),
      anyCertain: false,
      reasons: new Set<string>(),
      fromTiers: new Set<Tier>(),
      origins: [],
    };
    m.fromTiers.add(from.tier);
    m.origins.push(`${where(origin)}:${String(ref.source_line)}`);
    m.reasons.add(`unresolved ${ref.ref_kind} reference '${value}' ${why}`);
    minted.set(id, m);
    stats.dangling += 1;
    stats.unresolved_by_kind[ref.ref_kind] += 1;
    diagnostics.push(
      diag(
        "unresolved_ref",
        `${ref.ref_kind}: '${value}' from ${where(origin)}:${String(ref.source_line)} ${why}; drawn to ${id}`,
        origin,
        ref.source_line,
      ),
    );
    out.push(
      downgrade(
        { ...origin.edge, to: id },
        `unresolved ${ref.ref_kind} reference '${value}' ${why}; drawn to a synthetic unknown node`,
      ),
    );
  }

  function finishMinted(m: MintedNode): Node {
    const n = m.node;
    if (n.kind === "unknown") {
      const origins = [...new Set(m.origins)].sort(byteCompare);
      const first = origins[0] ?? "an unknown location";
      const more =
        origins.length > 1 ? ` and ${String(origins.length - 1)} more` : "";
      return {
        ...n,
        tier: inheritedTier(m.fromTiers),
        confidence: "inferred",
        confidence_reason: `${[...m.reasons].sort(byteCompare)[0] ?? "unresolved reference"}; referenced from ${first}${more}`,
      };
    }
    if (m.anyCertain)
      return { ...n, confidence: "certain", confidence_reason: null };
    return {
      ...n,
      confidence: "inferred",
      confidence_reason: [...m.reasons].sort(byteCompare).join("; "),
    };
  }
}

function uniqueTargets(entries: readonly IndexEntry[]): string[] {
  return [...new Set(entries.flatMap((c) => c.targets))].sort(byteCompare);
}

/**
 * Graph model §6.1: an unknown node sits in the shallowest band of its
 * callers. `external` is not a band and never wins; it is the answer only when
 * nothing but external-tier nodes refer to the unknown.
 */
export function inheritedTier(fromTiers: ReadonlySet<Tier>): Tier {
  let best = Number.POSITIVE_INFINITY;
  for (const t of fromTiers) {
    const i = ORDERED_TIERS.indexOf(t as (typeof ORDERED_TIERS)[number]);
    if (i !== -1 && i < best) best = i;
  }
  if (best === Number.POSITIVE_INFINITY) return "external";
  return ORDERED_TIERS[best] as Tier;
}

function syntheticNode(
  id: string,
  kind: NodeKind,
  label: string,
  tier: Tier,
): Node {
  return {
    id,
    kind,
    label,
    tier,
    parent: null,
    sources: [],
    confidence: "inferred",
    confidence_reason: "minted by resolution",
    is_entry_point: false,
    entry_point_kind: null,
    is_infrastructure: false,
    tags: [],
  };
}

/** Core may downgrade confidence, never upgrade (§3.6). Annotated is an origin, not a level, and is left alone. */
function downgrade(
  e: ResolvedPartialEdge,
  reason: string,
): ResolvedPartialEdge {
  if (e.confidence === "annotated") return e;
  return { ...e, confidence: "inferred", confidence_reason: reason };
}

function where(origin: EdgeOrigin): string {
  return origin.repo === null
    ? "a compose patch"
    : `${origin.repo}:${origin.path ?? ""}`;
}

function originOf(entry: IndexEntry): string {
  return entry.origin.repo === null
    ? "a compose patch"
    : `${entry.origin.repo}:${entry.origin.path ?? ""}`;
}

function edgeOriginCompare(a: EdgeOrigin, b: EdgeOrigin): number {
  return (
    byteCompare(a.repo ?? "", b.repo ?? "") ||
    byteCompare(a.path ?? "", b.path ?? "") ||
    byteCompare(a.edge.from, b.edge.from) ||
    byteCompare(JSON.stringify(a.edge), JSON.stringify(b.edge))
  );
}
