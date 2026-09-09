import { RefKindSchema, UNKNOWN_SCOPE, type RefKind } from "./model/enums.js";

/**
 * Synthetic dangling-reference targets — parser §4.2, graph model §1.
 *
 *   unknown:{ref_kind}:{encoded_value}
 *
 * The separator is a colon, matching the scope separator, so the id splits
 * back into (scope, ref_kind, value) unambiguously. `encoded_value`
 * percent-encodes `:`, `/`, `%`, the space and every code point below U+0020,
 * after NFC normalization; everything else stays literal. The space is encoded
 * because a literal space in an id is unquotable in a shell and ambiguous in a
 * log line. The encoding is canonical:
 * exactly those characters are encoded, hex is uppercase, so one value has one
 * id. Ids are addresses; the node's `label` carries the readable form.
 */

const NEEDS_ENCODING = /[:/% \x00-\x1f]/g;
const ENCODED_TOKEN = /^(?:[^:/% \x00-\x1f]|%[0-9A-F]{2})+$/u;

export function encodeUnknownValue(value: string): string {
  return value
    .normalize("NFC")
    .replace(
      NEEDS_ENCODING,
      (ch) =>
        "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
    );
}

/**
 * Inverse of `encodeUnknownValue`. Returns null when `encoded` is not a
 * canonical encoding: a literal reserved character, a malformed or lowercase
 * `%XX`, or an escape for a character that should have stayed literal.
 */
export function decodeUnknownValue(encoded: string): string | null {
  if (encoded.length === 0 || !ENCODED_TOKEN.test(encoded)) return null;
  const decoded = encoded.replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return encodeUnknownValue(decoded) === encoded ? decoded : null;
}

export function unknownNodeId(ref_kind: RefKind, value: string): string {
  return `${UNKNOWN_SCOPE}:${ref_kind}:${encodeUnknownValue(value)}`;
}

/** The readable form of an unknown node: `unresolved http /notes/{id}`. */
export function unknownNodeLabel(ref_kind: RefKind, value: string): string {
  return `unresolved ${ref_kind} ${value.normalize("NFC")}`;
}

/**
 * Splits an `unknown:` id back into its parts, or returns null when the id is
 * not a well-formed unknown id. The validator uses this for invariant 18.
 */
export function parseUnknownNodeId(
  id: string,
): { ref_kind: RefKind; value: string } | null {
  const prefix = `${UNKNOWN_SCOPE}:`;
  if (!id.startsWith(prefix)) return null;
  const locator = id.slice(prefix.length);
  const colon = locator.indexOf(":");
  if (colon === -1) return null;
  const kind = RefKindSchema.safeParse(locator.slice(0, colon));
  if (!kind.success) return null;
  const value = decodeUnknownValue(locator.slice(colon + 1));
  if (value === null) return null;
  return { ref_kind: kind.data, value };
}
