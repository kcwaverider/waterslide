import { createHash } from "node:crypto";

/**
 * The fields that determine an edge's identity. Graph model §3.3 / §3.3.1.
 *
 * Non-fork edges are keyed by `from` + `to` + `kind`, so two call sites of the
 * same relationship collapse to one edge. Fork edges (non-null
 * `exclusive_group`) additionally carry `branch_ordinal`, so alternatives at one
 * branch point stay distinct even when they share endpoints, kind and line.
 */
export interface EdgeIdKey {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly exclusive_group?: string | null;
  readonly branch_ordinal?: number | null;
}

const ID_PREFIX = "e_";
const HEX_CHARS = 16;

const nfc = (s: string): string => s.normalize("NFC");

/**
 * Derive an edge id per graph model §3.3.1.
 *
 * Input bytes: the key as a JSON array with no whitespace, strings
 * NFC-normalized, UTF-8. Hash: SHA-256. Output: `e_` + first 16 lowercase hex
 * characters of the digest.
 *
 * This is the only implementation. Packs call it; they never derive ids
 * themselves (handoff §5.2).
 */
export function edgeId(key: EdgeIdKey): string {
  const group = key.exclusive_group ?? null;
  const ordinal = key.branch_ordinal ?? null;

  if ((group === null) !== (ordinal === null)) {
    throw new TypeError(
      "edgeId: exclusive_group and branch_ordinal must be both null or both non-null (graph model invariant 14)",
    );
  }
  if (ordinal !== null && (!Number.isInteger(ordinal) || ordinal < 0)) {
    throw new TypeError(
      `edgeId: branch_ordinal must be a non-negative integer, got ${String(ordinal)}`,
    );
  }

  const parts: (string | number)[] =
    group === null
      ? [nfc(key.from), nfc(key.to), nfc(key.kind)]
      : [
          nfc(key.from),
          nfc(key.to),
          nfc(key.kind),
          nfc(group),
          ordinal as number,
        ];

  const input = JSON.stringify(parts);
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  return ID_PREFIX + digest.slice(0, HEX_CHARS);
}

/** Serialize an edge id key exactly as `edgeId` hashes it. Exposed for tests and diagnostics. */
export function edgeIdInput(key: EdgeIdKey): string {
  const group = key.exclusive_group ?? null;
  const ordinal = key.branch_ordinal ?? null;
  const parts: (string | number)[] =
    group === null
      ? [nfc(key.from), nfc(key.to), nfc(key.kind)]
      : [
          nfc(key.from),
          nfc(key.to),
          nfc(key.kind),
          nfc(group),
          ordinal as number,
        ];
  return JSON.stringify(parts);
}
