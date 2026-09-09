import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const TOY = fileURLToPath(
  new URL("../../core/dist/test/helpers/toy-pack-module.js", import.meta.url),
);

/**
 * Exercises the built command line as a user would, with the toy pack loaded
 * through `--pack`. Needs `tsc -b` to have run, which `npm test` guarantees.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "waterslide-cli-"));
  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write(
    "server/api/notes.toy",
    "def create\n  call api.store.save\n  route POST /notes\ndef list\n  call api.store.missing\n",
  );
  write("server/api/store.toy", "def save\n");
  write(
    "client/App/Sync.toy",
    "import save from api.store\ndef sync\n  call save\n  call api.notes.create\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function waterslide(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: root,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: err.code ?? -1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("waterslide parse", () => {
  it("parses a multi-repo input into a valid graph.json and prints the unresolved summary", async () => {
    const r = await waterslide(
      "parse",
      `server=${root}/server`,
      `client=${root}/client`,
      "--pack",
      TOY,
      "--state-dir",
      ".waterslide",
    );
    // Built-in packs load when installed and are reported when not; either way
    // the toy pack must be the one that parsed this tree.
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("unresolved references by ref_kind:");
    expect(r.stdout).toMatch(/symbol\s+1/);
    expect(r.stdout).toContain("wrote ");
    const graphPath = path.join(root, ".waterslide", "graph.json");
    expect(existsSync(graphPath)).toBe(true);
    expect(existsSync(path.join(root, ".waterslide", "cache"))).toBe(true);
    expect(existsSync(path.join(root, ".waterslide", "baseline.json"))).toBe(
      false,
    );
    const v = await waterslide("validate", graphPath);
    expect(v.code, v.stderr).toBe(0);
    expect(v.stdout).toContain("valid artifact graph");
  });

  it("warm parse is faster or equal, hits the cache, and is canonically byte-identical", async () => {
    const args = [
      "parse",
      `server=${root}/server`,
      `client=${root}/client`,
      "--pack",
      TOY,
      "--canonical",
    ];
    const cold = await waterslide(...args);
    expect(cold.code, cold.stderr).toBe(0);
    const coldBytes = readFileSync(
      path.join(root, ".waterslide", "graph.json"),
      "utf8",
    );
    const warm = await waterslide(...args);
    expect(warm.code, warm.stderr).toBe(0);
    expect(warm.stdout).toMatch(/3 files, 0 parsed, 3 from cache/);
    expect(
      readFileSync(path.join(root, ".waterslide", "graph.json"), "utf8"),
    ).toBe(coldBytes);
    const v = await waterslide(
      "validate",
      ".waterslide/graph.json",
      "--shape",
      "canonical",
    );
    expect(v.code, v.stderr).toBe(0);
  });

  it("renaming a symbol breaks the edge from an unchanged file: resolution does not cache", async () => {
    const args = [
      "parse",
      `server=${root}/server`,
      `client=${root}/client`,
      "--pack",
      TOY,
      "--canonical",
    ];
    await waterslide(...args);
    writeFileSync(path.join(root, "server/api/store.toy"), "def persist\n");
    const r = await waterslide(...args);
    expect(r.stdout).toMatch(/1 parsed, 2 from cache/);
    const graph = JSON.parse(
      readFileSync(path.join(root, ".waterslide", "graph.json"), "utf8"),
    ) as {
      edges: { from: string; to: string }[];
    };
    const clientEdge = graph.edges.find(
      (e) =>
        e.from === "client:App/Sync.toy#sync" && e.to.startsWith("unknown:"),
    );
    expect(clientEdge?.to).toBe("unknown:symbol:save");
  });

  it("dump and view work on the emitted graph", async () => {
    await waterslide(
      "parse",
      `server=${root}/server`,
      `client=${root}/client`,
      "--pack",
      TOY,
    );
    const d = await waterslide("dump");
    expect(d.code, d.stderr).toBe(0);
    expect(d.stdout).toContain("unresolved references by ref_kind");
    expect(d.stdout).toMatch(/nodes: \d+/);
    const v = await waterslide("view");
    expect(v.code, v.stderr).toBe(0);
    const html = readFileSync(
      path.join(root, ".waterslide", "graph.html"),
      "utf8",
    );
    expect(html).toContain("server:api/notes.toy#create");
    expect(html).toContain("function renderGraph(");
  });

  it("rejects bad usage with exit 1 and a usage message", async () => {
    const r = await waterslide("parse");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage:");
    const u = await waterslide("frobnicate");
    expect(u.code).toBe(1);
    const bad = await waterslide(
      "parse",
      `unknown=${root}/server`,
      "--pack",
      TOY,
    );
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain("fixed id scope");
  });
});

describe("waterslide parse --pack-option", () => {
  const base = (): string[] => [
    "parse",
    `server=${root}/server`,
    `client=${root}/client`,
    "--pack",
    TOY,
    "--canonical",
  ];
  const graph = (): { nodes: { id: string }[] } =>
    JSON.parse(
      readFileSync(path.join(root, ".waterslide", "graph.json"), "utf8"),
    ) as { nodes: { id: string }[] };

  it("coerces a single value to a list where the pack's schema expects one, and changes the cache key", async () => {
    const plain = await waterslide(...base());
    expect(plain.code, plain.stderr).toBe(0);
    expect(
      graph().nodes.some((n) => n.id === "unknown:symbol:api.store.save"),
    ).toBe(false);
    const withRoot = await waterslide(
      ...base(),
      "--pack-option",
      "toy.source_roots=api",
    );
    expect(withRoot.code, withRoot.stderr).toBe(0);
    // A different option hash: nothing came from cache.
    expect(withRoot.stdout).toMatch(/3 parsed, 0 from cache/);
    // The toy pack now names modules without the "api." root, so the qualified
    // call no longer matches: the option demonstrably reached the pack.
    expect(
      graph().nodes.some((n) => n.id === "unknown:symbol:api.store.save"),
    ).toBe(true);
    const list = await waterslide(
      ...base(),
      "--pack-option",
      "toy.source_roots=api,lib",
    );
    expect(list.code, list.stderr).toBe(0);
  });

  it("is loud about an unknown pack id or an option the pack's schema rejects", async () => {
    const unknown = await waterslide(
      ...base(),
      "--pack-option",
      "nope.source_roots=x",
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no loaded pack is named "nope"');
    const rejected = await waterslide(
      ...base(),
      "--pack-option",
      "toy.bogus=1",
    );
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('pack "toy" rejects it');
    const malformed = await waterslide(
      ...base(),
      "--pack-option",
      "toy.source_roots",
    );
    expect(malformed.code).toBe(1);
  });
});

describe("waterslide parse --infrastructure", () => {
  const base = (): string[] => [
    "parse",
    `server=${root}/server`,
    `client=${root}/client`,
    "--pack",
    TOY,
    "--canonical",
  ];
  const graphText = (): string =>
    readFileSync(path.join(root, ".waterslide", "graph.json"), "utf8");
  const infra = (): string[] =>
    (
      JSON.parse(graphText()) as {
        nodes: { id: string; is_infrastructure: boolean }[];
      }
    ).nodes
      .filter((n) => n.is_infrastructure)
      .map((n) => n.id);

  it("is repeatable, matches any span under a repo-relative glob, and applies on a warm run from the cache", async () => {
    const plain = await waterslide(...base());
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout).toMatch(/3 files, 3 parsed, 0 from cache/);
    expect(infra()).toEqual([]);
    const plainBytes = graphText();

    const marked = await waterslide(
      ...base(),
      "--infrastructure",
      "api/store.*",
      "--infrastructure",
      "App/**",
    );
    expect(marked.code, marked.stderr).toBe(0);
    // Not a cache-key change: every file is a hit, and the marks still land.
    expect(marked.stdout).toMatch(/3 files, 0 parsed, 3 from cache/);
    expect(infra()).toEqual([
      "client:App/Sync.toy",
      "client:App/Sync.toy#sync",
      "server:api/store.toy",
      "server:api/store.toy#save",
    ]);
    expect(graphText()).not.toBe(plainBytes);
    const v = await waterslide(
      "validate",
      ".waterslide/graph.json",
      "--shape",
      "canonical",
    );
    expect(v.code, v.stderr).toBe(0);

    // Absent flag: back to no marks and the cold bytes, byte for byte.
    const again = await waterslide(...base());
    expect(again.code, again.stderr).toBe(0);
    expect(graphText()).toBe(plainBytes);
  });

  it("rejects a missing or empty glob as usage, and never takes the next option as the glob", async () => {
    const missing = await waterslide(...base(), "--infrastructure");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--infrastructure needs a value");
    // `--infrastructure --canonical` must not run with "--canonical" as the
    // glob and the canonical flag silently dropped.
    const swallowed = await waterslide(
      "parse",
      `server=${root}/server`,
      "--pack",
      TOY,
      "--infrastructure",
      "--canonical",
    );
    expect(swallowed.code).toBe(1);
    expect(swallowed.stderr).toContain("--infrastructure needs a value");
    expect(existsSync(path.join(root, ".waterslide", "graph.json"))).toBe(
      false,
    );
    const empty = await waterslide(...base(), "--infrastructure", "  ");
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("non-empty glob");
  });
});

describe("malformed graph files", () => {
  it("validate and dump report not-valid-JSON with exit 2; view treats it as usage", async () => {
    writeFileSync(path.join(root, "bad.json"), "{ not json");
    const v = await waterslide("validate", "bad.json");
    expect(v.code).toBe(2);
    expect(v.stderr).toContain("bad.json: not valid JSON");
    const d = await waterslide("dump", "bad.json");
    expect(d.code).toBe(2);
    expect(d.stderr).toContain("bad.json: not valid JSON");
    const w = await waterslide("view", "bad.json");
    expect(w.code).toBe(1);
    expect(w.stderr).toContain("bad.json: not valid JSON");
    expect(w.stderr).toContain("usage:");
  });

  it("rejects JSON that is not an object with the same exit codes", async () => {
    writeFileSync(path.join(root, "null.json"), "null");
    writeFileSync(path.join(root, "arr.json"), "[]");
    expect((await waterslide("validate", "null.json")).code).toBe(2);
    expect((await waterslide("dump", "arr.json")).code).toBe(2);
    const w = await waterslide("view", "null.json");
    expect(w.code).toBe(1);
    expect(w.stderr).toContain("must be a JSON object");
  });
});
