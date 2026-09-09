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
 * The one place the key is validated and turned into hash input parts. Both
 * `edgeId` and `edgeIdInput` go through here, so they cannot disagree.
 */
function keyParts(key: EdgeIdKey): (string | number)[] {
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

  return group === null
    ? [nfc(key.from), nfc(key.to), nfc(key.kind)]
    : [
        nfc(key.from),
        nfc(key.to),
        nfc(key.kind),
        nfc(group),
        ordinal as number,
      ];
}

/**
 * The exact bytes `edgeId` hashes: the key as a JSON array with no whitespace,
 * strings NFC-normalized. Exposed for tests and diagnostics. Rejects the same
 * keys `edgeId` rejects.
 */
export function edgeIdInput(key: EdgeIdKey): string {
  return JSON.stringify(keyParts(key));
}

/**
 * Derive an edge id per graph model §3.3.1: SHA-256 over `edgeIdInput(key)`
 * as UTF-8, output `e_` + the first 16 lowercase hex characters.
 *
 * This is the only implementation. Whoever knows both endpoint ids calls it —
 * a pack for edges resolved within a file, core after resolution for the rest.
 */
export function edgeId(key: EdgeIdKey): string {
  const digest = createHash("sha256")
    .update(edgeIdInput(key), "utf8")
    .digest("hex");
  return ID_PREFIX + digest.slice(0, HEX_CHARS);
}
