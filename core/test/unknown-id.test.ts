import { describe, expect, it } from "vitest";
import {
  decodeUnknownValue,
  encodeUnknownValue,
  parseUnknownNodeId,
  unknownNodeId,
  unknownNodeLabel,
} from "../src/unknown-id.js";

describe("unknown node ids (graph model §1, parser §4.2)", () => {
  it("encodes only ':', '/', '%', space and control characters, uppercase hex", () => {
    expect(encodeUnknownValue("/notes/{id}")).toBe("%2Fnotes%2F{id}");
    expect(encodeUnknownValue("a:b")).toBe("a%3Ab");
    expect(encodeUnknownValue("100%")).toBe("100%25");
    expect(encodeUnknownValue("tab\there\n")).toBe("tab%09here%0A");
    expect(encodeUnknownValue("memory_service.forget")).toBe(
      "memory_service.forget",
    );
    expect(encodeUnknownValue("PUT /notes/{id}?q=1&x=é")).toBe(
      "PUT%20%2Fnotes%2F{id}?q=1&x=é",
    );
    expect(decodeUnknownValue("a b")).toBeNull();
  });

  it("NFC-normalizes before encoding", () => {
    const composed = "café";
    const decomposed = "café";
    expect(composed).not.toBe(decomposed);
    expect(encodeUnknownValue(decomposed)).toBe(encodeUnknownValue(composed));
  });

  it("round-trips through decode", () => {
    for (const v of ["/notes/{id}", "a:b/c%d", "x", "plain", "é/ü"]) {
      expect(decodeUnknownValue(encodeUnknownValue(v))).toBe(
        v.normalize("NFC"),
      );
    }
  });

  it("rejects non-canonical encodings", () => {
    expect(decodeUnknownValue("")).toBeNull();
    expect(decodeUnknownValue("a/b")).toBeNull(); // literal reserved char
    expect(decodeUnknownValue("a:b")).toBeNull();
    expect(decodeUnknownValue("%2f")).toBeNull(); // lowercase hex
    expect(decodeUnknownValue("%2")).toBeNull(); // truncated
    expect(decodeUnknownValue("%41")).toBeNull(); // 'A' must stay literal
    expect(decodeUnknownValue("%C3%A9")).toBeNull(); // non-ASCII stays literal
  });

  it("builds and parses ids", () => {
    const id = unknownNodeId("http", "/notes/{id}/archive");
    expect(id).toBe("unknown:http:%2Fnotes%2F{id}%2Farchive");
    expect(parseUnknownNodeId(id)).toEqual({
      ref_kind: "http",
      value: "/notes/{id}/archive",
    });
    expect(parseUnknownNodeId("unknown:symbol:a.b")).toEqual({
      ref_kind: "symbol",
      value: "a.b",
    });
  });

  it("rejects malformed ids", () => {
    for (const bad of [
      "unknown:grpc:x",
      "unknown:symbol",
      "unknown:symbol:",
      "unknown:symbol:a:b",
      "unknown:http:/notes",
      "tapistree:x",
      "unknown",
    ]) {
      expect(parseUnknownNodeId(bad), bad).toBeNull();
    }
  });

  it("labels carry the readable form", () => {
    expect(unknownNodeLabel("http", "/notes/{id}")).toBe(
      "unresolved http /notes/{id}",
    );
  });
});
