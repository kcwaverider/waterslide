import { createHash } from "node:crypto";

const PREFIX = "sha256:";
const HEX_CHARS = 16;

/**
 * The one span-hash implementation. Persisted-files §1.5 derives
 * `baseline_hash` from every span's `hash`, so two packs hashing differently
 * would make change detection mean two things. Same reasoning as `edgeId`:
 * one function in core, every pack calls it.
 *
 * Input: the span's exact source text, untrimmed. Output: `sha256:` followed
 * by the first 16 lowercase hex characters of SHA-256 over the NFC-normalized
 * UTF-8 bytes of that text.
 */
export function spanHash(text: string): string {
  const digest = createHash("sha256")
    .update(text.normalize("NFC"), "utf8")
    .digest("hex");
  return PREFIX + digest.slice(0, HEX_CHARS);
}
