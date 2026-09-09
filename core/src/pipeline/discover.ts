import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import picomatch from "picomatch";
import { z } from "zod";
import { byteCompare } from "../canonical.js";
import { FIXED_ID_SCOPES } from "../model/enums.js";

const execFileAsync = promisify(execFile);

/** Parser §1.1 — one entry of the repo list. */
export const RepoInputSchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
export type RepoInput = z.infer<typeof RepoInputSchema>;

/** Parser §1.2 — per-repo state captured at parse time. `branch` has no home in the graph and is not captured. */
export interface RepoState {
  readonly name: string;
  readonly path: string;
  readonly commit: string;
  readonly dirty: boolean;
}

export interface DiscoveredFile {
  readonly repo: string;
  /** Repo-relative, forward slashes, no leading slash — the form node ids embed. */
  readonly path: string;
  readonly absPath: string;
}

/** The git null object id. Reported for a directory that is not a git checkout, with `dirty: true`: we cannot know the tree is clean. */
export const NULL_COMMIT = "0".repeat(40);

/**
 * Parser §1.3: vendored dependencies, generated code, build output and
 * anything under a dot-directory are skipped by default.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  "**/.*/**",
  "**/node_modules/**",
  "**/Pods/**",
  "**/Carthage/**",
  "**/DerivedData/**",
  "**/vendor/**",
  "**/venv/**",
  "**/env/**",
  "**/__pycache__/**",
  "**/site-packages/**",
  "**/build/**",
  "**/dist/**",
  "**/*.generated.*",
  "**/*.pb.py",
];

/** Parser §1.3: tests are excluded unless `include_tests` is set. */
export const TEST_EXCLUDE_GLOBS: readonly string[] = [
  "**/test/**",
  "**/tests/**",
  "**/Tests/**",
  "**/__tests__/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "**/*Tests.swift",
  "**/*Test.swift",
  "**/*.test.*",
  "**/*.spec.*",
];

export interface DiscoverOptions {
  /** Extensions claimed by the loaded packs, e.g. ".py". A file nobody claims is silently skipped (parser §9). */
  readonly extensions: ReadonlySet<string>;
  readonly includeTests?: boolean;
}

/**
 * Validates the repo list the way the validator will judge the graph built
 * from it: names unique, non-empty, no ":", and not a fixed id scope. These
 * are configuration errors and throw; nothing downstream can be trusted after
 * one.
 */
export function assertRepoList(repos: readonly RepoInput[]): void {
  if (repos.length === 0) throw new Error("repo list is empty");
  const seen = new Set<string>();
  for (const repo of repos) {
    if (repo.name.length === 0 || repo.name.includes(":")) {
      throw new Error(
        `repo name ${JSON.stringify(repo.name)} must be non-empty and contain no ":" (graph model §1)`,
      );
    }
    if (FIXED_ID_SCOPES.has(repo.name)) {
      throw new Error(
        `repo name "${repo.name}" collides with a fixed id scope (graph model §1)`,
      );
    }
    if (seen.has(repo.name)) {
      throw new Error(
        `repo name "${repo.name}" appears twice in the repo list`,
      );
    }
    seen.add(repo.name);
  }
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/")
    ? nodePath.join(homedir(), p.slice(1))
    : p;
}

/**
 * Stage 1. Walks every repo, applies exclusions, keeps files a pack claims,
 * and returns them sorted by (repo, path) byte-wise — so the order the
 * filesystem happens to yield never reaches anything downstream.
 */
export async function discover(
  repos: readonly RepoInput[],
  options: DiscoverOptions,
): Promise<DiscoveredFile[]> {
  assertRepoList(repos);
  const out: DiscoveredFile[] = [];
  for (const repo of repos) {
    const root = nodePath.resolve(expandHome(repo.path));
    const excludes = [
      ...DEFAULT_EXCLUDE_GLOBS,
      ...(options.includeTests === true ? [] : TEST_EXCLUDE_GLOBS),
      ...(repo.exclude ?? []),
    ];
    const isExcluded = picomatch(excludes, { dot: true });
    const isIncluded =
      repo.include === undefined || repo.include.length === 0
        ? (): boolean => true
        : picomatch(repo.include, { dot: true });
    await walk(root, "", (rel) => {
      if (!options.extensions.has(nodePath.posix.extname(rel))) return;
      if (isExcluded(rel) || !isIncluded(rel)) return;
      out.push({
        repo: repo.name,
        path: rel,
        absPath: nodePath.join(root, rel),
      });
    });
  }
  return out.sort(
    (a, b) => byteCompare(a.repo, b.repo) || byteCompare(a.path, b.path),
  );
}

async function walk(
  root: string,
  rel: string,
  visit: (rel: string) => void,
): Promise<void> {
  const dir = rel === "" ? root : nodePath.join(root, rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Symlinks are not followed: a link into a sibling tree would double-count
    // it, and a cycle would never terminate.
    if (entry.isSymbolicLink()) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, childRel, visit);
    else if (entry.isFile()) visit(childRel);
  }
}

/** Stage 1, per repo: `HEAD` and whether the working tree has uncommitted changes. */
export async function captureRepoState(repo: RepoInput): Promise<RepoState> {
  const root = nodePath.resolve(expandHome(repo.path));
  try {
    const { stdout: head } = await execFileAsync("git", [
      "-C",
      root,
      "rev-parse",
      "HEAD",
    ]);
    const { stdout: status } = await execFileAsync("git", [
      "-C",
      root,
      "status",
      "--porcelain",
    ]);
    return {
      name: repo.name,
      path: root,
      commit: head.trim(),
      dirty: status.trim().length > 0,
    };
  } catch {
    return { name: repo.name, path: root, commit: NULL_COMMIT, dirty: true };
  }
}
