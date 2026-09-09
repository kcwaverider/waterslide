import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PerFileResult } from "@waterslide/core";
import type { PythonPack, PythonPackOptionsInput } from "../../src/index.js";

/**
 * Test-only file discovery. Stage 1 (discover) is core's; this walker exists so
 * the pack can be exercised over a tree before the CLI lands. Excludes tests,
 * virtualenvs and tool directories by default (parser §1.3).
 */
export interface WalkOptions {
  readonly exclude?: (relativePath: string) => boolean;
}

export const DEFAULT_EXCLUDE = (rel: string): boolean =>
  /(^|\/)(tests?|\.venv|venv|node_modules|__pycache__|\.claude|\.git)(\/|$)/.test(
    rel,
  ) ||
  /(^|\/)test_[^/]*\.py$/.test(rel) ||
  /(^|\/)conftest\.py$/.test(rel);

export function walkPython(root: string, options: WalkOptions = {}): string[] {
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full).split("\\").join("/");
      if (exclude(rel)) continue;
      const st = statSync(full);
      if (st.isDirectory()) visit(full);
      else if (entry.endsWith(".py")) out.push(rel);
    }
  };
  visit(root);
  return out.sort(byteCompare);
}

export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Parse every file under `root` as repo `repo`, in the given order (default: sorted). */
export function parseTree(
  pack: PythonPack,
  repo: string,
  root: string,
  files: readonly string[] = walkPython(root),
  options: PythonPackOptionsInput = {},
): PerFileResult[] {
  return files.map((path) => ({
    repo,
    path,
    result: pack.parse(
      repo,
      path,
      readFileSync(join(root, path), "utf8"),
      options,
    ),
    pack_data: null, // file-level pack scratch; this pack keeps none
  }));
}

/** `compose` requires (repo, path)-sorted input; the caller sorts, as core will. */
export function sortForCompose(
  results: readonly PerFileResult[],
): PerFileResult[] {
  return [...results].sort(
    (a, b) => byteCompare(a.repo, b.repo) || byteCompare(a.path, b.path),
  );
}

/** Deterministic shuffle for the discovery-order test. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
