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

/**
 * The environment git subprocesses run with: the caller's, minus every
 * `GIT_*` variable. When this code runs inside a git hook, git has exported
 * GIT_DIR and GIT_INDEX_FILE, and a bare `git -C <repo>` would silently
 * operate on the hook's repository rather than the one being parsed.
 */
export function gitCleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return env;
}

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

/** What stage 1 left out on purpose, so the summary can say the map is deliberately partial. */
export interface DiscoverStats {
  /**
   * Files a pack claims that the repo's own `include`/`exclude` globs
   * (parser §1.1) removed. Files the built-in exclusions (§1.3) remove are
   * not counted: they were never part of the map to begin with.
   */
  excluded_by_glob: number;
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
  return (await discoverWithStats(repos, options)).files;
}

/** `discover`, plus the count of files the repo list's own globs excluded. */
export async function discoverWithStats(
  repos: readonly RepoInput[],
  options: DiscoverOptions,
): Promise<{ files: DiscoveredFile[]; stats: DiscoverStats }> {
  assertRepoList(repos);
  const out: DiscoveredFile[] = [];
  const stats: DiscoverStats = { excluded_by_glob: 0 };
  for (const repo of repos) {
    const root = nodePath.resolve(expandHome(repo.path));
    const builtIn = [
      ...DEFAULT_EXCLUDE_GLOBS,
      ...(options.includeTests === true ? [] : TEST_EXCLUDE_GLOBS),
    ];
    const isBuiltInExcluded = picomatch(builtIn, { dot: true });
    // Directory-shaped built-in excludes ("**/node_modules/**") prune the walk
    // itself, so a vendored tree is never read only to be discarded file by
    // file. The repo's OWN globs deliberately do not prune: the files under
    // them are counted so the summary can report an honest number for the
    // common directory form ("infra/stacks/**"). That costs a readdir of the
    // excluded directory and nothing more — no file is opened, hashed or
    // parsed.
    const isExcludedDir = picomatch(
      builtIn.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -3)),
      { dot: true },
    );
    const userExclude = repo.exclude ?? [];
    const isUserExcluded =
      userExclude.length === 0
        ? (): boolean => false
        : picomatch(userExclude, { dot: true });
    const isIncluded =
      repo.include === undefined || repo.include.length === 0
        ? (): boolean => true
        : picomatch(repo.include, { dot: true });
    await walk(root, "", isExcludedDir, (rel) => {
      if (!options.extensions.has(nodePath.posix.extname(rel))) return;
      if (isBuiltInExcluded(rel)) return;
      // §1.1: include is the allowlist, exclude the denylist applied after it.
      if (!isIncluded(rel) || isUserExcluded(rel)) {
        stats.excluded_by_glob += 1;
        return;
      }
      out.push({
        repo: repo.name,
        path: rel,
        absPath: nodePath.join(root, rel),
      });
    });
  }
  out.sort(
    (a, b) => byteCompare(a.repo, b.repo) || byteCompare(a.path, b.path),
  );
  return { files: out, stats };
}

async function walk(
  root: string,
  rel: string,
  isExcludedDir: (rel: string) => boolean,
  visit: (rel: string) => void,
): Promise<void> {
  const dir = rel === "" ? root : nodePath.join(root, rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Symlinks are not followed: a link into a sibling tree would double-count
    // it, and a cycle would never terminate.
    if (entry.isSymbolicLink()) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isExcludedDir(childRel)) continue;
      await walk(root, childRel, isExcludedDir, visit);
    } else if (entry.isFile()) {
      visit(childRel);
    }
  }
}

/** Stage 1, per repo: `HEAD` and whether the working tree has uncommitted changes. */
export async function captureRepoState(repo: RepoInput): Promise<RepoState> {
  const root = nodePath.resolve(expandHome(repo.path));
  try {
    const env = gitCleanEnv();
    const { stdout: head } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      { env },
    );
    const { stdout: status } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain"],
      { env },
    );
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
