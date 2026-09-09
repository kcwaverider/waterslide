import type { Node } from "../../src/model/graph.js";
import type { NodeKind, RefKind, Tier } from "../../src/model/enums.js";
import type {
  CorePartialEdge,
  Provide,
  UnresolvedRef,
} from "../../src/model/pack.js";
import type {
  Corpus,
  EdgeOrigin,
  ProvideOrigin,
} from "../../src/pipeline/index.js";

/** Builders for synthetic corpora, so stage 4 is exercised without a pack. */

export function node(
  id: string,
  kind: NodeKind = "function",
  tier: Tier = "domain",
  extra: Partial<Node> = {},
): Node {
  return {
    id,
    kind,
    label: id.slice(id.lastIndexOf("#") + 1),
    tier,
    parent: null,
    sources: [],
    confidence: "certain",
    confidence_reason: null,
    is_entry_point: false,
    entry_point_kind: null,
    is_infrastructure: false,
    tags: [],
    ...extra,
  };
}

export interface Origin {
  repo: string;
  path: string;
}

export function ref(
  from: string,
  to: UnresolvedRef | string,
  origin: Origin,
  extra: Partial<CorePartialEdge> = {},
): EdgeOrigin {
  const line = typeof to === "string" ? 1 : to.source_line;
  return {
    repo: origin.repo,
    path: origin.path,
    edge: {
      from,
      to,
      kind: "call",
      label: null,
      schema_id: null,
      response_schema_id: null,
      confidence: "certain",
      confidence_reason: null,
      condition: null,
      exclusive_group: null,
      branch_ordinal: null,
      is_error_path: false,
      source: {
        repo: origin.repo,
        path: origin.path,
        line_start: line,
        line_end: null,
      },
      ...extra,
    },
  };
}

export function sym(value: string, source_line = 1): UnresolvedRef {
  return { ref_kind: "symbol", value, source_line };
}

export function provide(
  name: string,
  node_id: string | null,
  origin: Origin,
  extra: Partial<Provide> & { ref_kind?: RefKind } = {},
): ProvideOrigin {
  return {
    repo: origin.repo,
    path: origin.path,
    provide: {
      name,
      node_id,
      alias_of: null,
      ref_kind: "symbol",
      visibility: "public",
      scope: "global",
      scope_path: null,
      ...extra,
    },
  };
}

export function corpus(parts: {
  nodes?: Node[];
  edges?: EdgeOrigin[];
  provides?: ProvideOrigin[];
}): Corpus {
  return {
    repos: [],
    tier_config_hash: "sha256:e3b0c44298fc1c14",
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    schemas: [],
    provides: parts.provides ?? [],
    diagnostics: [],
    stats: {
      files: 0,
      parsed: 0,
      cache_hits: 0,
      repathed: 0,
      repath_fallbacks: 0,
    },
    discovery: { excluded_by_glob: 0 },
  };
}

export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
