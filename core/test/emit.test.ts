import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeCanonical } from "../src/canonical.js";
import { MemoryParseCache } from "../src/pipeline/cache.js";
import {
  emitGraph,
  runPipeline,
  serializeArtifact,
  summarize,
} from "../src/pipeline/emit.js";
import { validate } from "../src/validate.js";
import { TmpTree } from "./helpers/tmp-tree.js";
import { makeToyPack } from "./helpers/toy-pack.js";

let tree: TmpTree;
beforeEach(() => {
  tree = new TmpTree();
  tree.write(
    "server/api/notes.toy",
    "def create\n  call api.store.save\n  route POST /notes\n",
  );
  tree.write("server/api/store.toy", "def save\n");
  tree.write(
    "client/App/Sync.toy",
    "import save from api.store\ndef sync\n  call save\n  call nowhere.at_all\n",
  );
});
afterEach(() => tree.dispose());

const repos = (): { name: string; path: string }[] => [
  { name: "server", path: `${tree.root}/server` },
  { name: "client", path: `${tree.root}/client` },
];
const FIXED_NOW = (): Date => new Date("2026-09-08T12:00:00.000Z");

describe("stage 6: emit (parser §0)", () => {
  it("assembles a valid artifact with volatile fields and stats, in field-table key order", async () => {
    const run = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      now: FIXED_NOW,
    });
    const bytes = serializeArtifact(run.artifact);
    expect(Object.keys(JSON.parse(bytes) as object)).toEqual([
      "schema_version",
      "parsed_at",
      "tier_config_hash",
      "repos",
      "nodes",
      "edges",
      "schemas",
      "stats",
    ]);
    expect(
      Object.keys(
        (JSON.parse(bytes) as { repos: object[] }).repos[0] as object,
      ),
    ).toEqual(["name", "path", "commit", "dirty"]);
    const result = validate(JSON.parse(bytes), { shape: "artifact" });
    expect(result.errors).toEqual([]);
    expect(run.artifact.parsed_at).toBe("2026-09-08T12:00:00.000Z");
    expect(run.artifact.stats).toMatchObject({
      unresolved_by_kind: { symbol: 1 },
      resolution: { dangling: 1 },
    });
  });

  it("writes graph.json and nothing else, atomically, and refuses an invalid graph", async () => {
    const run = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      now: FIXED_NOW,
    });
    const stateDir = path.join(tree.root, ".waterslide");
    const emitted = await emitGraph(run.artifact, { stateDir });
    expect(emitted.ok).toBe(true);
    expect(readdirSync(stateDir)).toEqual(["graph.json"]);
    if (emitted.ok) {
      expect(readFileSync(emitted.path, "utf8")).toBe(emitted.bytes);
      expect(emitted.bytes.endsWith("}\n")).toBe(true);
    }
    // Nothing named baseline.json, positions.json or anything else appears.
    const broken = structuredClone(run.artifact);
    broken.edges[0] = {
      ...(broken.edges[0] as (typeof broken.edges)[number]),
      to: "nope:x",
    };
    const refused = await emitGraph(broken, {
      stateDir: path.join(tree.root, "other"),
    });
    expect(refused.ok).toBe(false);
    expect(() => readdirSync(path.join(tree.root, "other"))).toThrow();
  });

  it("--canonical writes the canonical shape, byte-identical to serializeCanonical", async () => {
    const run = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      now: FIXED_NOW,
    });
    const emitted = await emitGraph(run.artifact, {
      stateDir: path.join(tree.root, "c"),
      canonical: true,
    });
    expect(emitted.ok).toBe(true);
    if (!emitted.ok) return;
    expect(emitted.bytes).toBe(serializeCanonical(run.artifact));
    expect(validate(JSON.parse(emitted.bytes), { shape: "canonical" }).ok).toBe(
      true,
    );
    expect(emitted.bytes).not.toContain("parsed_at");
  });

  it("is deterministic: two runs differ only in parsed_at, and the canonical bytes are identical", async () => {
    const cache = new MemoryParseCache();
    const a = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      cache,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const b = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      cache,
      now: () => new Date("2026-01-02T00:00:00Z"),
    });
    expect(serializeCanonical(a.artifact)).toBe(serializeCanonical(b.artifact));
    expect(a.artifact.parsed_at).not.toBe(b.artifact.parsed_at);
    expect(b.stage3.cache_hits).toBe(3);
  });

  it("summarises unresolved references by ref_kind and diagnostics by code", async () => {
    const run = await runPipeline({
      repos: repos(),
      packs: [makeToyPack()],
      now: FIXED_NOW,
    });
    const text = summarize(run);
    expect(text).toContain("unresolved references by ref_kind:");
    expect(text).toMatch(/symbol\s+1/);
    expect(text).toMatch(/http\s+0/);
    expect(text).toContain("unresolved_ref");
  });
});
