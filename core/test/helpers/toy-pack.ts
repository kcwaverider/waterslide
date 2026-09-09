import { GRAPH_SCHEMA_VERSION } from "../../src/model/graph.js";
import type {
  Diagnostic,
  LanguagePack,
  PackNode,
  PackOptions,
  PackPatch,
  PackResult,
  PartialEdge,
  PerFileResult,
  Provide,
} from "../../src/model/pack.js";
import { spanHash } from "../../src/span-hash.js";

/**
 * A deterministic toy language pack for exercising core's pipeline without a
 * real parser. One statement per line:
 *
 *   def NAME                 a function; provides `{module}.NAME` globally
 *   call TARGET              an edge from the enclosing def to symbol TARGET
 *   route METHOD /path       marks the enclosing def an http_route entry point,
 *                            provides "METHOD /path" as an http provide
 *   import NAME from MODULE  a file-scoped bare-name alias of `MODULE.NAME`
 *   ? anything               an unsupported construct diagnostic
 *   !!throw                  the pack throws (it must not; core must survive)
 *   !!bad                    the pack returns a malformed result
 *
 * `module` is the path minus `.toy`, minus a matching `source_roots` entry
 * from options, with `/` as `.` — path-derived on purpose, so rePath has
 * something real to recompute.
 */

/**
 * `good` recomputes everything; `buggy` forgets to move the spans (the guard
 * must catch it); `stale-file-data` recomputes everything except the
 * file-level pack_data (suspicious, not fatal); `none` has no rePath.
 */
export type RePathMode = "good" | "buggy" | "stale-file-data" | "none";

export interface ToyPackOptions {
  id?: string;
  version?: string;
  rePath?: RePathMode;
  compose?: boolean;
}

export interface ToyPack extends LanguagePack {
  parseCalls: number;
  composeCalls: number;
  /** The (repo, path) order compose last received, for the sorted-input guarantee. */
  lastComposeOrder: string[];
}

export function moduleName(path: string, options: PackOptions): string {
  let p = path.endsWith(".toy") ? path.slice(0, -4) : path;
  const roots = Array.isArray(options.source_roots)
    ? (options.source_roots as string[])
    : [];
  for (const root of roots) {
    if (p.startsWith(`${root}/`)) {
      p = p.slice(root.length + 1);
      break;
    }
  }
  return p.replace(/\//g, ".");
}

export function makeToyPack(opts: ToyPackOptions = {}): ToyPack {
  const id = opts.id ?? "toy";
  const rePathMode = opts.rePath ?? "good";
  const pack: ToyPack = {
    parseCalls: 0,
    composeCalls: 0,
    lastComposeOrder: [],
    manifest: {
      id,
      version: opts.version ?? "1.0.0",
      graph_schema_version: GRAPH_SCHEMA_VERSION,
      extensions: [".toy"],
      frameworks: [],
    },
    parse(repo, path, content, options) {
      pack.parseCalls += 1;
      if (content.includes("!!throw")) throw new Error("toy pack exploded");
      if (content.includes("!!bad"))
        return { nodes: "nope" } as unknown as PackResult;
      return parseToy(repo, path, content, options);
    },
  };
  if (rePathMode !== "none") {
    pack.rePath = (result, repo, path, options) =>
      rePathToy(result, repo, path, options, rePathMode);
  }
  if (opts.compose === true) {
    pack.compose = (results, _options) => {
      pack.composeCalls += 1;
      pack.lastComposeOrder = results.map((r) => `${r.repo}:${r.path}`);
      return composeToy(results, id);
    };
  }
  return pack;
}

function parseToy(
  repo: string,
  path: string,
  content: string,
  options: PackOptions,
): PackResult {
  const lines = content.split("\n");
  const mod = moduleName(path, options);
  const moduleId = `${repo}:${path}`;
  const nodes: PackNode[] = [
    {
      id: moduleId,
      kind: "module",
      label: path.slice(path.lastIndexOf("/") + 1),
      tier: "domain",
      parent: null,
      sources: [
        {
          repo,
          path,
          line_start: 1,
          line_end: lines.length,
          hash: spanHash(content),
        },
      ],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    },
  ];
  const edges: PartialEdge[] = [];
  const provides: Provide[] = [];
  const diagnostics: Diagnostic[] = [];

  // First pass: def boundaries, so span hashes cover the def's text.
  const defs: { name: string; start: number; end: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^def (\w+)/.exec(line);
    if (m?.[1] !== undefined)
      defs.push({ name: m[1], start: i + 1, end: lines.length });
  });
  defs.forEach((d, i) => {
    const next = defs[i + 1];
    if (next !== undefined) d.end = next.start - 1;
  });

  for (const d of defs) {
    const nodeId = `${moduleId}#${d.name}`;
    const node: PackNode = {
      id: nodeId,
      kind: "function",
      label: d.name,
      tier: "domain",
      parent: null, // left for core's completeHierarchy on purpose
      sources: [
        {
          repo,
          path,
          line_start: d.start,
          line_end: d.end,
          hash: spanHash(lines.slice(d.start - 1, d.end).join("\n")),
        },
      ],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    };
    provides.push({
      name: `${mod}.${d.name}`,
      node_id: nodeId,
      alias_of: null,
      ref_kind: "symbol",
      visibility: "public",
      scope: "global",
      scope_path: null,
    });
    for (let ln = d.start + 1; ln <= d.end; ln++) {
      const line = lines[ln - 1] ?? "";
      const call = /^\s*call (\S+)/.exec(line);
      const route = /^\s*route (\w+) (\S+)/.exec(line);
      if (call?.[1] !== undefined) {
        edges.push({
          from: nodeId,
          to: { ref_kind: "symbol", value: call[1], source_line: ln },
          kind: "call",
          label: call[1],
          schema_id: null,
          response_schema_id: null,
          confidence: "certain",
          confidence_reason: null,
          condition: null,
          exclusive_group: null,
          branch_ordinal: null,
          is_error_path: false,
          source: { repo, path, line_start: ln, line_end: null },
        });
      } else if (route?.[1] !== undefined && route[2] !== undefined) {
        node.kind = "endpoint";
        node.tier = "api";
        node.label = `${route[1]} ${route[2]}`;
        node.is_entry_point = true;
        node.entry_point_kind = "http_route";
        // Structured facts for this pack's own compose (parser §3.3), never
        // encoded into the label and never meant to reach the graph.
        node.pack_data = { method: route[1], local_path: route[2] };
        provides.push({
          name: `${route[1]} ${route[2]}`,
          node_id: nodeId,
          alias_of: null,
          ref_kind: "http",
          visibility: "public",
          scope: "global",
          scope_path: null,
        });
      }
    }
    nodes.push(node);
  }

  lines.forEach((line, i) => {
    const imp = /^import (\w+) from (\S+)/.exec(line);
    if (imp?.[1] !== undefined && imp[2] !== undefined) {
      provides.push({
        name: imp[1],
        node_id: null,
        alias_of: `${imp[2]}.${imp[1]}`,
        ref_kind: "symbol",
        visibility: "private",
        scope: "file",
        scope_path: path,
      });
    } else if (line.startsWith("?")) {
      diagnostics.push({
        severity: "warning",
        code: "unsupported_construct",
        message: `toy pack does not understand ${JSON.stringify(line)}`,
        repo,
        path,
        line: i + 1,
        pack: "toy",
      });
    }
  });

  return {
    nodes,
    edges,
    schemas: [],
    provides,
    diagnostics,
    // File-level pack_data (parser §3.3): the module name is path-derived, so
    // rePath must recompute it; `defs` is not, and is here to prove compose
    // sees file-level data on warm runs.
    pack_data: { module: mod, defs: defs.map((d) => d.name) },
  };
}

function rePathToy(
  result: PerFileResult,
  repo: string,
  path: string,
  options: PackOptions,
  mode: RePathMode,
): PerFileResult {
  const oldPrefix = `${result.repo}:${result.path}`;
  const newPrefix = `${repo}:${path}`;
  const mod = moduleName(path, options);
  const mapId = (id: string): string =>
    id === oldPrefix || id.startsWith(`${oldPrefix}#`)
      ? newPrefix + id.slice(oldPrefix.length)
      : id;
  const mapSpanish = <T extends { repo: string; path: string }>(s: T): T =>
    s.repo === result.repo && s.path === result.path ? { ...s, repo, path } : s;
  const r = result.result;
  return {
    repo,
    path,
    result: {
      nodes: r.nodes.map((n) => ({
        ...n,
        id: mapId(n.id),
        label:
          n.kind === "module" ? path.slice(path.lastIndexOf("/") + 1) : n.label,
        parent: n.parent === null ? null : mapId(n.parent),
        // The buggy variant forgets to move the spans: the guard must catch it.
        sources: mode === "buggy" ? n.sources : n.sources.map(mapSpanish),
      })),
      edges: r.edges.map((e) => ({
        ...e,
        from: mapId(e.from),
        to: typeof e.to === "string" ? mapId(e.to) : e.to,
        source: e.source === null ? null : mapSpanish(e.source),
      })),
      schemas: r.schemas,
      provides: r.provides.map((p) => {
        if (p.alias_of !== null) {
          return { ...p, scope_path: p.scope_path === null ? null : path };
        }
        const nodeId = p.node_id === null ? null : mapId(p.node_id);
        if (p.ref_kind === "symbol" && nodeId !== null) {
          const name = nodeId.slice(nodeId.indexOf("#") + 1);
          return { ...p, node_id: nodeId, name: `${mod}.${name}` };
        }
        return { ...p, node_id: nodeId };
      }),
      diagnostics: r.diagnostics.map((d) =>
        d.repo === result.repo && d.path === result.path
          ? { ...d, repo, path }
          : d,
      ),
    },
    pack_data:
      mode === "stale-file-data"
        ? result.pack_data
        : result.pack_data === null
          ? null
          : { ...result.pack_data, module: mod },
  };
}

/**
 * Compose: one `svc:{id}-{repo}` service per repo, every module parented to
 * it. A file containing `!!patch-replace` makes the patch also try to re-add
 * that file's module node (must be rejected); `!!patch-badparent` makes it
 * set a nonexistent parent (must be rejected).
 */
function composeToy(results: readonly PerFileResult[], id: string): PackPatch {
  const patch: PackPatch = {
    nodes: [],
    edges: [],
    schemas: [],
    provides: [],
    node_updates: [],
    diagnostics: [],
  };
  for (const r of results) {
    // File-level pack_data reaches compose, cold or warm.
    const defs = r.pack_data?.defs;
    const moduleNode = r.result.nodes.find((n) => n.kind === "module");
    if (Array.isArray(defs) && moduleNode !== undefined) {
      patch.node_updates.push({
        node_id: moduleNode.id,
        add_sources: [],
        tags: [`defs:${String(defs.length)}`],
      });
    }
  }
  const repos = new Set(results.map((r) => r.repo));
  for (const repo of repos) {
    patch.nodes.push({
      id: `svc:${id}-${repo}`,
      kind: "service",
      label: `${repo} (${id})`,
      tier: "domain",
      parent: null,
      sources: [],
      confidence: "inferred",
      confidence_reason: "one service per repo, composed by the toy pack",
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    });
  }
  for (const r of results) {
    for (const n of r.result.nodes) {
      const method = n.pack_data?.method;
      if (typeof method === "string") {
        patch.node_updates.push({
          node_id: n.id,
          add_sources: [],
          tags: [`method:${method}`],
        });
      }
    }
    const moduleNode = r.result.nodes.find((n) => n.kind === "module");
    if (moduleNode === undefined) continue;
    patch.node_updates.push({
      node_id: moduleNode.id,
      add_sources: [],
      parent: `svc:${id}-${r.repo}`,
    });
    if (
      r.result.diagnostics.some((d) => d.message.includes("!!patch-replace"))
    ) {
      patch.nodes.push({ ...moduleNode });
    }
    if (
      r.result.diagnostics.some((d) => d.message.includes("!!patch-badparent"))
    ) {
      patch.node_updates.push({
        node_id: moduleNode.id,
        add_sources: [],
        parent: "svc:does-not-exist",
      });
    }
  }
  return patch;
}
