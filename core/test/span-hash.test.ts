import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spanHash } from "../src/span-hash.js";

describe("spanHash", () => {
  // Reference digests computed outside this codebase with
  //   printf '<text>' | shasum -a 256
  // so the encoding is pinned to a literal, not to whatever the code emits.
  it("pins a realistic span to a literal expected hash", () => {
    // sha256('def f():\n    pass\n') = 16797664978a8116…
    expect(spanHash("def f():\n    pass\n")).toBe("sha256:16797664978a8116");
  });

  it("hashes the empty span to the well-known empty digest", () => {
    expect(spanHash("")).toBe("sha256:e3b0c44298fc1c14");
  });

  it("does not trim: surrounding whitespace is part of the span", () => {
    // sha256(' x ') = fc191eafd9c50bef…
    expect(spanHash(" x ")).toBe("sha256:fc191eafd9c50bef");
    expect(spanHash(" x ")).not.toBe(spanHash("x"));
  });

  it("NFC-normalizes before hashing", () => {
    const composed = "café";
    const decomposed = "café";
    expect(composed).not.toBe(decomposed);
    // sha256(utf8('café')) = 850f7dc43910ff89…
    expect(spanHash(composed)).toBe("sha256:850f7dc43910ff89");
    expect(spanHash(decomposed)).toBe(spanHash(composed));
  });

  it("is provably sha256: + sha256(nfc(text)).slice(0, 16)", () => {
    for (const text of ["", "a", "class NoteService:\n    pass\n", "naïve"]) {
      const digest = createHash("sha256")
        .update(text.normalize("NFC"), "utf8")
        .digest("hex");
      expect(spanHash(text)).toBe(`sha256:${digest.slice(0, 16)}`);
    }
  });
});
