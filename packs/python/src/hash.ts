import { createHash } from "node:crypto";

/**
 * Span hash for `sources[].hash`: `sha256:` + the first 16 lowercase hex
 * characters of SHA-256 over the NFC-normalized span text, matching the width
 * the M0 fixtures use.
 */
export function spanHash(text: string): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(text.normalize("NFC"), "utf8")
      .digest("hex")
      .slice(0, 16)
  );
}
