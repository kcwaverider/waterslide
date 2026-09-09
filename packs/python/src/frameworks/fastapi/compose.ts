import type {
  Diagnostic,
  NodeUpdate,
  PackNode,
  PackPatch,
  PerFileResult,
  Provide,
} from "@waterslide/core";
import { PACK_ID } from "../../diagnostics.js";
import { readFastApi, routeLabel } from "./index.js";

/**
 * Cross-file prefix composition (parser §8, decision item 1). Runs over the
 * complete, (repo, path)-sorted set of per-file results on every parse, never
 * cached. Reads only what the per-file recognizers emitted through
 * `pack_data.fastapi`: router/app nodes with their own prefix, mount edges with
 * theirs, route nodes with method and local path. Resolves mount targets
 * through the pack's own `provides`, alias chains included, then rewrites each
 * route's label to the composed path and emits one `http` provide per method.
 *
 * Capability table (parser §3.2): annotates labels, adds provides and
 * diagnostics. Never touches an id, never removes anything.
 */

const MAX_ALIAS_DEPTH = 8;

interface Router {
  readonly id: string;
  readonly isApp: boolean;
  readonly ownPrefix: string;
  /** `APIRouter(prefix=<expr>)`: the prefix is unknown, so no path under it is. */
  readonly dynamicPrefix: boolean;
  readonly repo: string;
  readonly path: string;
}

interface Mount {
  readonly parentId: string;
  readonly childId: string;
  readonly prefix: string | null;
}

export function composeFastApi(results: readonly PerFileResult[]): PackPatch {
  const diagnostics: Diagnostic[] = [];
  const nodesById = new Map<string, PackNode>();
  const routers = new Map<string, Router>();
  const provides = new Map<string, Provide[]>();

  for (const file of results) {
    for (const node of file.result.nodes) {
      nodesById.set(node.id, node);
      const data = readFastApi(node.pack_data);
      if (data && (data.kind === "app" || data.kind === "router")) {
        routers.set(node.id, {
          id: node.id,
          isApp: data.kind === "app",
          ownPrefix: data.prefix ?? "",
          dynamicPrefix: data.prefix === null,
          repo: file.repo,
          path: file.path,
        });
      }
    }
    for (const p of file.result.provides) {
      if (p.ref_kind !== "symbol" || p.scope !== "global") continue;
      const list = provides.get(p.name) ?? [];
      list.push(p);
      provides.set(p.name, list);
    }
  }

  const resolveName = (
    name: string,
    at: { repo: string; path: string; line: number | null },
  ): string | null => {
    let current = name;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth++) {
      if (seen.has(current)) {
        diagnostics.push(
          diag(
            "error",
            "alias_cycle",
            `alias chain for ${name} cycles at ${current}`,
            at,
          ),
        );
        return null;
      }
      seen.add(current);
      const candidates = provides.get(current) ?? [];
      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        diagnostics.push(
          diag(
            "warning",
            "ambiguous_mount",
            `${current} is provided by ${String(candidates.length)} entries; mount not composed rather than picked arbitrarily`,
            at,
          ),
        );
        return null;
      }
      const only = candidates[0] as Provide;
      if (only.node_id !== null) return only.node_id;
      current = only.alias_of as string;
    }
    diagnostics.push(
      diag(
        "error",
        "alias_depth_exceeded",
        `alias chain for ${name} exceeds ${String(MAX_ALIAS_DEPTH)} hops`,
        at,
      ),
    );
    return null;
  };

  // Mounts and routes, from edges.
  const mounts: Mount[] = [];
  const routeEdges: {
    routerId: string;
    routeId: string;
    repo: string;
    path: string;
    line: number | null;
  }[] = [];
  for (const file of results) {
    for (const edge of file.result.edges) {
      const at = {
        repo: file.repo,
        path: file.path,
        line: edge.source?.line_start ?? null,
      };
      const data = readFastApi(edge.pack_data);
      if (data?.kind === "mount" && routers.has(edge.from)) {
        let childId: string | null;
        if (typeof edge.to === "string") {
          childId = edge.to;
        } else {
          childId = resolveName(edge.to.value, at);
          if (childId === null) {
            diagnostics.push(
              diag(
                "warning",
                "unresolved_mount",
                `include_router target ${edge.to.value} does not resolve to a router in the parsed set; its routes keep their local paths`,
                at,
              ),
            );
            continue;
          }
        }
        if (!routers.has(childId)) {
          diagnostics.push(
            diag(
              "warning",
              "unresolved_mount",
              `include_router target ${childId} is not a FastAPI router or app node`,
              at,
            ),
          );
          continue;
        }
        mounts.push({ parentId: edge.from, childId, prefix: data.prefix });
      } else if (
        data?.kind === "route_edge" &&
        typeof edge.to === "string" &&
        routers.has(edge.from)
      ) {
        routeEdges.push({ routerId: edge.from, routeId: edge.to, ...at });
      }
    }
  }

  const mountsByChild = new Map<string, Mount[]>();
  for (const m of mounts) {
    const list = mountsByChild.get(m.childId) ?? [];
    list.push(m);
    mountsByChild.set(m.childId, list);
  }

  // Full prefixes per router: every path from an app down, FastAPI order
  // (parent prefixes, then include_router prefix, then the router's own prefix).
  const memo = new Map<string, string[] | null>();
  // A result computed with a branch removed by the cycle guard depends on
  // where the walk entered the cycle; it must not be cached (review round 2).
  const cycleTainted = new Set<string>();
  const prefixesFor = (id: string, stack: string[]): string[] | null => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const router = routers.get(id) as Router;
    if (stack.includes(id)) {
      for (const tainted of stack) cycleTainted.add(tainted);
      diagnostics.push(
        diag(
          "error",
          "router_mount_cycle",
          `include_router cycle: ${[...stack, id].join(" → ")}`,
          { repo: router.repo, path: router.path, line: null },
        ),
      );
      return null;
    }
    let result: string[] | null;
    if (router.dynamicPrefix) {
      diagnostics.push(
        diag(
          "warning",
          "incomplete_mount",
          `router ${id} has a non-literal own prefix; its routes keep their local paths and get no http provides`,
          { repo: router.repo, path: router.path, line: null },
        ),
      );
      result = null;
    } else if (router.isApp) {
      result = [router.ownPrefix];
    } else {
      const parents = mountsByChild.get(id) ?? [];
      if (parents.length === 0) {
        result = null; // unmounted: no full path exists
      } else {
        const out = new Set<string>();
        let incomplete = false;
        for (const m of parents) {
          if (m.prefix === null) {
            incomplete = true;
            continue;
          }
          const above = prefixesFor(m.parentId, [...stack, id]);
          if (above === null) {
            incomplete = true;
            continue;
          }
          for (const a of above) out.add(a + m.prefix + router.ownPrefix);
        }
        result = out.size > 0 ? [...out].sort(byteCompare) : null;
        if (incomplete) {
          diagnostics.push(
            diag(
              "warning",
              "incomplete_mount",
              `router ${id} has a mount whose prefix could not be composed; some of its paths are missing`,
              { repo: router.repo, path: router.path, line: null },
            ),
          );
        }
      }
    }
    if (!cycleTainted.has(id)) memo.set(id, result);
    return result;
  };

  const nodePatches: NodeUpdate[] = [];
  const httpProvides: Provide[] = [];
  const unmountedReported = new Set<string>();

  for (const r of routeEdges) {
    const route = nodesById.get(r.routeId);
    if (!route) continue;
    const parsed = readFastApi(route.pack_data);
    if (!parsed || parsed.kind !== "route") {
      diagnostics.push(
        diag(
          "error",
          "recognizer_failure",
          `route node ${r.routeId} carries no fastapi route data; the per-file pass and compose disagree`,
          r,
        ),
      );
      continue;
    }
    // Every stacked decorator is a route; non-literal paths were diagnosed per file.
    const literalRoutes = parsed.routes.filter((x) => x.path_literal);
    if (literalRoutes.length === 0) continue;
    const prefixes = prefixesFor(r.routerId, []);
    if (prefixes === null) {
      if (!unmountedReported.has(r.routerId)) {
        unmountedReported.add(r.routerId);
        diagnostics.push(
          diag(
            "warning",
            "router_not_mounted",
            `router ${r.routerId} is never passed to include_router in the parsed set; its routes keep their local paths and get no http provides`,
            r,
          ),
        );
      }
      continue;
    }
    const first = literalRoutes[0] as (typeof literalRoutes)[number];
    const firstComposed = prefixes.map((p) => p + first.path);
    nodePatches.push({
      node_id: r.routeId,
      add_sources: [],
      label: routeLabel(first.methods, firstComposed[0] as string),
    });
    const reachable = literalRoutes.flatMap((x) =>
      prefixes.map((p) => p + x.path),
    );
    if (reachable.length > 1) {
      diagnostics.push(
        diag(
          "info",
          "route_mounted_multiple",
          `route ${r.routeId} is reachable at ${reachable.join(", ")}; label shows the first`,
          r,
        ),
      );
    }
    for (const x of literalRoutes) {
      for (const path of prefixes.map((p) => p + x.path)) {
        for (const method of x.methods) {
          httpProvides.push({
            ref_kind: "http",
            name: `${method} ${path}`,
            node_id: r.routeId,
            alias_of: null,
            visibility: "public",
            scope: "global",
            scope_path: null,
          });
        }
      }
    }
  }

  return {
    nodes: [],
    edges: [],
    schemas: [],
    provides: httpProvides,
    node_updates: nodePatches,
    diagnostics,
  };
}

function diag(
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  at: { repo: string; path: string; line: number | null },
): Diagnostic {
  return {
    severity,
    code,
    message,
    repo: at.repo,
    path: at.path,
    line: at.line,
    pack: PACK_ID,
  };
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
