import { createHash } from "node:crypto";

/** Full lowercase hex SHA-256. Cache keys and content hashes use the whole digest. */
export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof data === "string") h.update(data, "utf8");
  else h.update(data);
  return h.digest("hex");
}

/** Stage 2: the content hash of a file, over its raw bytes. Drives stage 3's cache. */
export function contentHash(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/**
 * JSON with object keys sorted recursively, no whitespace. Used wherever a
 * structure is hashed, so key insertion order can never reach a hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
