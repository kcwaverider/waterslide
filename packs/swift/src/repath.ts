/**
 * `rePath` (amendment B3): the stage-3 cache is keyed by content hash, so a
 * moved file hits the cache with a stale path in its payload. Core calls this
 * on every such hit. Every path-derived field is recomputed: node ids, span
 * repo and path, parents, edge sources, exclusive_group ids (which embed the
 * owning node id), schema ids, diagnostics, and the per-file state.
 *
 * Swift `provides` names are not path-derived, so they are untouched except
 * for their `node_id`.
 */
import type { PerFileResult } from "@waterslide/core";

/** A node id prefix ends at the string end, at `#` (member), or at `/` (branch group suffix). */
function idBoundary(rest: string): boolean {
  return rest === "" || rest.startsWith("#") || rest.startsWith("/");
}

export function rePath(
  result: PerFileResult,
  repo: string,
  path: string,
): PerFileResult {
  const oldPrefix = `${result.repo}:${result.path}`;
  const newPrefix = `${repo}:${path}`;
  const oldSchema = `sch:${oldPrefix}#`;
  const newSchema = `sch:${newPrefix}#`;
  if (oldPrefix === newPrefix) return result;

  const rewriteString = (s: string): string => {
    if (s.startsWith(oldPrefix) && idBoundary(s.slice(oldPrefix.length))) {
      return newPrefix + s.slice(oldPrefix.length);
    }
    if (s.startsWith(oldSchema)) return newSchema + s.slice(oldSchema.length);
    return s;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return rewriteString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const isLocation =
        typeof o.path === "string" &&
        typeof o.repo === "string" &&
        o.path === result.path &&
        o.repo === result.repo;
      for (const [k, val] of Object.entries(o)) {
        if (isLocation && k === "repo") out[k] = repo;
        else if (isLocation && k === "path") out[k] = path;
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  // Node ids, spans, edge sources and the file-level pack_data (whose own
  // repo/path fields and every node id inside it are path-derived) all go
  // through the same walk.
  const rewritten = walk({
    result: result.result,
    pack_data: result.pack_data,
  }) as Pick<PerFileResult, "result" | "pack_data">;
  const state = rewritten.pack_data?.swift as
    { repo: string; path: string } | undefined;
  if (state !== undefined) {
    state.repo = repo;
    state.path = path;
  }
  // The module node's label is the file basename, which is path-derived.
  const moduleNode = rewritten.result.nodes.find((n) => n.id === newPrefix);
  if (moduleNode !== undefined) {
    const i = path.lastIndexOf("/");
    moduleNode.label = i < 0 ? path : path.slice(i + 1);
  }
  return {
    repo,
    path,
    result: rewritten.result,
    pack_data: rewritten.pack_data,
  };
}
