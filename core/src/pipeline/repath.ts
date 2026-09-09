import {
  toPerFileResult,
  type LanguagePack,
  type PackOptions,
  type PerFileResult,
} from "../model/pack.js";
import { canonicalJson } from "./hash.js";

/**
 * Core-side guard on a `rePath` result (parser §2.1). The pack recomputes
 * every path-derived field; core cannot check the language-specific ones
 * (provide names) but can check the structural ones, and a failure turns a
 * wrong map into a slow path: the caller falls back to re-parsing.
 */
export function rePathViolations(
  repathed: PerFileResult,
  repo: string,
  path: string,
  original: PerFileResult,
): string[] {
  const out: string[] = [];
  if (repathed.repo !== repo || repathed.path !== path) {
    out.push(
      `result is labelled ${repathed.repo}:${repathed.path}, expected ${repo}:${path}`,
    );
  }
  const prefix = `${repo}:${path}`;
  const nodes = repathed.result.nodes;
  if (nodes.length !== original.result.nodes.length) {
    out.push(
      `node count changed from ${String(original.result.nodes.length)} to ${String(nodes.length)}`,
    );
  }
  for (const node of nodes) {
    const scopeEnd = node.id.indexOf(":");
    const scope = scopeEnd === -1 ? "" : node.id.slice(0, scopeEnd);
    if (
      scope === repo &&
      !(node.id === prefix || node.id.startsWith(`${prefix}#`))
    ) {
      out.push(`node id "${node.id}" does not carry the new path`);
    }
    for (const span of node.sources) {
      if (span.repo === original.repo && span.path === original.path) {
        out.push(`node "${node.id}" still has a span at the old path`);
      }
    }
  }
  const moved = original.repo !== repo || original.path !== path;
  for (const d of repathed.result.diagnostics) {
    if (d.repo === original.repo && d.path === original.path && moved) {
      out.push(`a diagnostic still names the old repo and path`);
    }
  }
  return out;
}

/**
 * Suspicious, not fatal: file-level `pack_data` returned byte-identical across
 * a path change. It may hold path-derived data the pack forgot to recompute,
 * or path-independent data it legitimately kept. Reported as an info
 * diagnostic by the caller; the result is still accepted.
 */
export function rePathFileDataUnchanged(
  repathed: PerFileResult,
  original: PerFileResult,
): boolean {
  const moved =
    original.repo !== repathed.repo || original.path !== repathed.path;
  return (
    repathed.pack_data !== null &&
    moved &&
    canonicalJson(repathed.pack_data) === canonicalJson(original.pack_data)
  );
}

export interface RePathConsistencyInput {
  readonly repo: string;
  readonly pathA: string;
  readonly pathB: string;
  readonly content: string;
  readonly options?: PackOptions;
}

export interface RePathConsistencyResult {
  readonly ok: boolean;
  /** Canonical JSON of the two results, when they differ. */
  readonly rePathed?: string;
  readonly reparsed?: string;
}

/**
 * The divergence check packs run in their own suites: parse `content` at
 * `pathA`, `rePath` the result to `pathB`, parse `content` at `pathB`, and
 * compare. A pack whose `rePath` disagrees with its `parse` would otherwise
 * be invisible in normal runs, because a rePathed result is never compared
 * against a fresh parse.
 */
export async function checkRePathConsistency(
  pack: LanguagePack,
  input: RePathConsistencyInput,
): Promise<RePathConsistencyResult> {
  if (pack.rePath === undefined) {
    throw new Error(`pack "${pack.manifest.id}" has no rePath to check`);
  }
  const options = input.options ?? {};
  const atA = toPerFileResult(
    input.repo,
    input.pathA,
    await pack.parse(input.repo, input.pathA, input.content, options),
  );
  const moved = pack.rePath(atA, input.repo, input.pathB, options);
  const atB = toPerFileResult(
    input.repo,
    input.pathB,
    await pack.parse(input.repo, input.pathB, input.content, options),
  );
  const rePathed = canonicalJson(moved);
  const reparsed = canonicalJson(atB);
  return rePathed === reparsed
    ? { ok: true }
    : { ok: false, rePathed, reparsed };
}

/** `checkRePathConsistency` that throws with both serializations on mismatch, for use directly inside a test. */
export async function assertRePathConsistent(
  pack: LanguagePack,
  input: RePathConsistencyInput,
): Promise<void> {
  const r = await checkRePathConsistency(pack, input);
  if (!r.ok) {
    throw new Error(
      `pack "${pack.manifest.id}": rePath(${input.pathA} -> ${input.pathB}) differs from a fresh parse at ${input.pathB}\n--- rePath ---\n${r.rePathed ?? ""}\n--- parse ---\n${r.reparsed ?? ""}`,
    );
  }
}
