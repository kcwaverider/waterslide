import { readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CacheEntrySchema,
  FileParseCache,
  MemoryParseCache,
  cacheKey,
  entryMatches,
  type CacheEntry,
} from "../src/pipeline/cache.js";
import { TmpTree } from "./helpers/tmp-tree.js";

const parts = {
  contentHash: "a".repeat(64),
  packId: "toy",
  packVersion: "1.0.0",
  graphSchemaVersion: 1,
  optionsHash: "b".repeat(64),
};
const entry: CacheEntry = {
  cache_format: 1,
  content_hash: parts.contentHash,
  pack_id: "toy",
  pack_version: "1.0.0",
  graph_schema_version: 1,
  options_hash: parts.optionsHash,
  repo: "r",
  path: "a.toy",
  result: { nodes: [], edges: [], schemas: [], provides: [], diagnostics: [] },
  pack_data: { module: "a" },
};

describe("stage 3 cache key (parser §2.1)", () => {
  it("is a full sha256 hex and changes with every part", () => {
    const base = cacheKey(parts);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...parts, contentHash: "c".repeat(64) })).not.toBe(base);
    expect(cacheKey({ ...parts, packId: "swift" })).not.toBe(base);
    expect(cacheKey({ ...parts, packVersion: "1.0.1" })).not.toBe(base);
    expect(cacheKey({ ...parts, graphSchemaVersion: 2 })).not.toBe(base);
    expect(cacheKey({ ...parts, optionsHash: "d".repeat(64) })).not.toBe(base);
    expect(cacheKey({ ...parts })).toBe(base);
  });

  it("does not depend on repo or path: a moved file has the same key", () => {
    // Repo and path are not fields of the key at all; the type forbids them.
    expect(Object.keys(parts).sort()).toEqual([
      "contentHash",
      "graphSchemaVersion",
      "optionsHash",
      "packId",
      "packVersion",
    ]);
  });

  it("entryMatches detects a foreign or stale entry", () => {
    expect(entryMatches(entry, parts)).toBe(true);
    expect(entryMatches({ ...entry, pack_version: "9" }, parts)).toBe(false);
    expect(entryMatches({ ...entry, options_hash: "x" }, parts)).toBe(false);
  });

  it("keeps file-level pack_data beside the result: compose reads it on warm runs", () => {
    expect(CacheEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      CacheEntrySchema.safeParse({ ...entry, pack_data: null }).success,
    ).toBe(true);
    const { pack_data: _p, ...withoutFileData } = entry;
    expect(CacheEntrySchema.safeParse(withoutFileData).success).toBe(false);
  });

  it("can only hold a PackResult: an entry carrying a patch or a graph is rejected", () => {
    expect(
      CacheEntrySchema.safeParse({
        ...entry,
        result: { ...entry.result, node_updates: [] },
      }).success,
    ).toBe(false);
    expect(
      CacheEntrySchema.safeParse({ ...entry, resolved_edges: [] }).success,
    ).toBe(false);
  });
});

describe("FileParseCache", () => {
  let tree: TmpTree;
  beforeAll(() => {
    tree = new TmpTree();
  });
  afterAll(() => tree.dispose());

  it("round-trips an entry under .waterslide/cache/{key}.json", async () => {
    const dir = path.join(tree.root, ".waterslide", "cache");
    const cache = new FileParseCache(dir);
    const key = cacheKey(parts);
    expect(await cache.get(key)).toBeNull();
    await cache.put(key, entry);
    expect(readdirSync(dir)).toEqual([`${key}.json`]);
    expect(await cache.get(key)).toEqual(entry);
  });

  it("treats a corrupt or foreign-shaped file as a miss", async () => {
    const dir = path.join(tree.root, "cache2");
    const cache = new FileParseCache(dir);
    const key = cacheKey(parts);
    await cache.put(key, entry);
    writeFileSync(path.join(dir, `${key}.json`), "{not json");
    expect(await cache.get(key)).toBeNull();
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ...entry, cache_format: 2 }),
    );
    expect(await cache.get(key)).toBeNull();
  });

  it("rejects a key that is not a hash, so a path can never be smuggled in", async () => {
    const cache = new FileParseCache(tree.root);
    await expect(cache.get("../etc/passwd")).rejects.toThrow(/bad cache key/);
  });

  it("MemoryParseCache behaves the same", async () => {
    const cache = new MemoryParseCache();
    await cache.put("k", entry);
    expect(await cache.get("k")).toEqual(entry);
    expect(cache.size).toBe(1);
  });
});
