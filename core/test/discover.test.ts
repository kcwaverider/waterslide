import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NULL_COMMIT,
  assertRepoList,
  captureRepoState,
  discover,
} from "../src/pipeline/discover.js";
import { TmpTree } from "./helpers/tmp-tree.js";

const EXT = new Set([".toy"]);

describe("stage 1: discovery (parser §1)", () => {
  let tree: TmpTree;
  beforeAll(() => {
    tree = new TmpTree();
    tree.write("api/services/notes.toy", "def a\n");
    tree.write("api/routers/notes.toy", "def b\n");
    tree.write("api/README.md", "not code");
    tree.write("api/node_modules/dep/index.toy", "def vendored\n");
    tree.write("api/tests/test_notes.toy", "def t\n");
    tree.write("api/.hidden/secret.toy", "def h\n");
    tree.write("api/build/out.toy", "def built\n");
    tree.write("api/gen/model.generated.toy", "def gen\n");
    tree.write("ios/Sources/App.toy", "def app\n");
    tree.write("ios/Tests/AppTests.toy", "def tests\n");
    tree.write("ios/Pods/X/x.toy", "def pod\n");
  });
  afterAll(() => tree.dispose());

  it("keeps claimed files, applies default exclusions, and sorts by (repo, path) byte-wise", async () => {
    const files = await discover(
      [
        { name: "ios", path: `${tree.root}/ios` },
        { name: "api", path: `${tree.root}/api` },
      ],
      { extensions: EXT },
    );
    expect(files.map((f) => `${f.repo}:${f.path}`)).toEqual([
      "api:routers/notes.toy",
      "api:services/notes.toy",
      "ios:Sources/App.toy",
    ]);
    expect(files.every((f) => f.absPath.startsWith(tree.root))).toBe(true);
  });

  it("includes tests when asked", async () => {
    const files = await discover([{ name: "api", path: `${tree.root}/api` }], {
      extensions: EXT,
      includeTests: true,
    });
    expect(files.map((f) => f.path)).toContain("tests/test_notes.toy");
  });

  it("honours include and exclude globs, exclude after include", async () => {
    const files = await discover(
      [
        {
          name: "api",
          path: `${tree.root}/api`,
          include: ["services/**", "routers/**"],
          exclude: ["routers/**"],
        },
      ],
      { extensions: EXT },
    );
    expect(files.map((f) => f.path)).toEqual(["services/notes.toy"]);
  });

  it("is independent of filesystem order: two walks agree", async () => {
    const repos = [{ name: "api", path: `${tree.root}/api` }];
    const a = await discover(repos, { extensions: EXT });
    const b = await discover(repos, { extensions: EXT });
    expect(a).toEqual(b);
  });

  it("rejects repo names the validator would reject (graph model §1)", () => {
    expect(() => assertRepoList([])).toThrow(/empty/);
    expect(() => assertRepoList([{ name: "unknown", path: "." }])).toThrow(
      /fixed id scope/,
    );
    expect(() => assertRepoList([{ name: "a:b", path: "." }])).toThrow(/":"/);
    expect(() =>
      assertRepoList([
        { name: "x", path: "." },
        { name: "x", path: ".." },
      ]),
    ).toThrow(/twice/);
  });

  it("captures the null commit and dirty for a non-git directory", async () => {
    const state = await captureRepoState({
      name: "api",
      path: `${tree.root}/api`,
    });
    expect(state.commit).toBe(NULL_COMMIT);
    expect(state.dirty).toBe(true);
  });

  it("captures HEAD and dirtiness for a git checkout", async () => {
    tree.gitInit("ios");
    const clean = await captureRepoState({
      name: "ios",
      path: `${tree.root}/ios`,
    });
    expect(clean.commit).toBe(tree.gitHead("ios"));
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);
    tree.write("ios/Sources/New.toy", "def n\n");
    const dirty = await captureRepoState({
      name: "ios",
      path: `${tree.root}/ios`,
    });
    expect(dirty.dirty).toBe(true);
  });
});
