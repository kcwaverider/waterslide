import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { z } from "zod";
import { GRAPH_SCHEMA_VERSION } from "../model/graph.js";
import { FileResultSchema, PackDataSchema } from "../model/pack.js";
import { canonicalJson, sha256Hex } from "./hash.js";

/**
 * Stage 3 cache — parser §2.1.
 *
 * The ONLY thing this module can store is one file's stage-3 output
 * (`PackResult`), keyed by content hash plus everything that could change how
 * that content parses: pack id and version, graph model version, resolved
 * pack options. Repo and path are NOT part of the key — a moved file hits —
 * but they are part of the payload, and a hit whose path differs is handed to
 * the pack's `rePath` (stage3.ts).
 *
 * Nothing about resolution (stage 4) or compose can pass through here: there
 * is no entry type for a resolved graph or a `PackPatch`, and neither of those
 * stages receives a cache. That is the structural guarantee parser §2.2 asks
 * for, not a convention.
 */

export const CACHE_FORMAT_VERSION = 1;

export interface CacheKeyParts {
  readonly contentHash: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly graphSchemaVersion: number;
  readonly optionsHash: string;
}

/** The cache key: SHA-256 over the canonical JSON of every part. */
export function cacheKey(parts: CacheKeyParts): string {
  return sha256Hex(canonicalJson(parts));
}

export const CacheEntrySchema = z.strictObject({
  cache_format: z.literal(CACHE_FORMAT_VERSION),
  content_hash: z.string(),
  pack_id: z.string(),
  pack_version: z.string(),
  graph_schema_version: z.literal(GRAPH_SCHEMA_VERSION),
  options_hash: z.string(),
  repo: z.string(),
  path: z.string(),
  result: FileResultSchema,
  /**
   * The file-level `pack_data` (parser §3.3), cached like the node- and
   * edge-level ones inside `result`: all three are per-file stage-3 output that
   * compose reads on warm runs too.
   */
  pack_data: PackDataSchema,
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

export interface ParseCache {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

/** Checks that an entry read back describes the key it was looked up under. A stale or foreign entry is a miss, never trusted. */
export function entryMatches(entry: CacheEntry, parts: CacheKeyParts): boolean {
  return (
    entry.content_hash === parts.contentHash &&
    entry.pack_id === parts.packId &&
    entry.pack_version === parts.packVersion &&
    entry.graph_schema_version === parts.graphSchemaVersion &&
    entry.options_hash === parts.optionsHash
  );
}

/** In-memory cache, for tests and for a run that must not touch disk. */
export class MemoryParseCache implements ParseCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): Promise<CacheEntry | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** `.waterslide/cache/{key}.json`. Writes are atomic (temp file then rename). */
export class FileParseCache implements ParseCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`bad cache key: ${key}`);
    return nodePath.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const file = this.file(key);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = CacheEntrySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async put(key: string, entry: CacheEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.file(key);
    const tmp = `${target}.${process.pid.toString()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
    await fs.rename(tmp, target);
  }
}

/** A cache that never hits and never stores. `--no-cache`, and the cold half of a cold/warm comparison. */
export class NullParseCache implements ParseCache {
  get(): Promise<CacheEntry | null> {
    return Promise.resolve(null);
  }
  put(): Promise<void> {
    return Promise.resolve();
  }
}
