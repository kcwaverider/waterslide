import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  byteCompare,
  callSiteCompare,
  canonicalize,
  serializeCanonical,
} from "../src/canonical.js";
import type { CanonicalGraph } from "../src/model/graph.js";
import { validate } from "../src/validate.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const files = readdirSync(validDir).filter((f) => f.endsWith(".json"));

function load(file: string): { bytes: string; graph: CanonicalGraph } {
  const bytes = readFileSync(new URL(file, validDir), "utf8");
  const result = validate(JSON.parse(bytes), { shape: "canonical" });
  if (!result.ok)
    throw new Error(`${file} is not valid: ${JSON.stringify(result.errors)}`);
  return { bytes, graph: result.graph };
}

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe("canonical serialization (graph model §7.2)", () => {
  for (const file of files) {
    it(`${file} round-trips byte-identically`, () => {
      const { bytes, graph } = load(file);
      expect(serializeCanonical(graph)).toBe(bytes);
    });

    it(`${file} serializes identically after shuffling every array and reversing key order`, () => {
      const { bytes, graph } = load(file);
      const disordered = {
        // Reverse top-level key order; the serializer must restore it.
        schemas: shuffle(graph.schemas, 7),
        edges: shuffle(graph.edges, 3).map((e) => ({
          ...e,
          skips_tiers: [...e.skips_tiers].reverse(),
        })),
        nodes: shuffle(graph.nodes, 5).map((n) => ({
          ...n,
          tags: [...n.tags].reverse(),
          sources: [...n.sources].reverse(),
        })),
        repos: [...graph.repos].reverse(),
        tier_config_hash: graph.tier_config_hash,
        schema_version: graph.schema_version,
      } as CanonicalGraph;
      expect(serializeCanonical(disordered)).toBe(bytes);
    });
  }

  it("strips volatile fields from an artifact", () => {
    const { bytes, graph } = load("derived-ids.json");
    const artifact = {
      ...graph,
      parsed_at: "2026-09-08T12:00:00.000Z",
      repos: graph.repos.map((r) => ({
        ...r,
        path: "/somewhere",
        dirty: true,
      })),
      stats: { anything: 1 },
    };
    expect(serializeCanonical(artifact)).toBe(bytes);
  });

  it("NFC-normalizes strings", () => {
    const { graph } = load("annotated-edge.json");
    const decomposed = structuredClone(graph);
    for (const n of decomposed.nodes) n.label = n.label.normalize("NFD");
    expect(
      decomposed.nodes.some((n, i) => n.label !== graph.nodes[i]?.label),
    ).toBe(true);
    expect(serializeCanonical(decomposed)).toBe(serializeCanonical(graph));
  });

  it("emits non-ASCII as literal UTF-8, never as \\u escapes", () => {
    const { bytes } = load("annotated-edge.json");
    expect(bytes).toContain("café");
    expect(bytes).not.toMatch(/\\u00e9/i);
  });

  it("ends with exactly one trailing newline and uses two-space indent", () => {
    const { bytes } = load("single-repo-minimal.json");
    expect(bytes.endsWith("}\n")).toBe(true);
    expect(bytes.endsWith("}\n\n")).toBe(false);
    expect(bytes.split("\n")[1]?.startsWith('  "schema_version"')).toBe(true);
  });

  it("sorts byte-wise, not by locale: '-' (0x2d) precedes ':' (0x3a)", () => {
    expect(byteCompare("tapistree-ios:x", "tapistree:x")).toBeLessThan(0);
    const { graph } = load("derived-ids.json");
    const ids = graph.nodes.map((n) => n.id);
    const ios = ids.findIndex((i) => i.startsWith("tapistree-ios:"));
    const api = ids.findIndex((i) => i.startsWith("tapistree:"));
    expect(ios).toBeLessThan(api);
  });

  it("keeps schemas[].fields in declaration order", () => {
    const { graph } = load("derived-ids.json");
    const s = graph.schemas.find((x) => x.id === "sch_note_response");
    expect(s?.fields.map((f) => f.name)).toEqual([
      "note_id",
      "body",
      "updated_at",
    ]);
    expect(
      canonicalize(graph)
        .schemas.find((x) => x.id === "sch_note_response")
        ?.fields.map((f) => f.name),
    ).toEqual(["note_id", "body", "updated_at"]);
  });
});

describe("callSiteCompare (graph model §3.3 collapse rule)", () => {
  const site = (
    line_start: number,
    path = "a.py",
    repo = "r",
    line_end: number | null = null,
  ) => ({ repo, path, line_start, line_end });

  it("orders by line_start first, then path, then repo, then line_end with null first", () => {
    expect(callSiteCompare(site(1, "z.py"), site(2, "a.py"))).toBeLessThan(0);
    expect(callSiteCompare(site(5, "a.py"), site(5, "b.py"))).toBeLessThan(0);
    expect(
      callSiteCompare(site(5, "a.py", "r1"), site(5, "a.py", "r2")),
    ).toBeLessThan(0);
    expect(
      callSiteCompare(site(5, "a.py", "r", null), site(5, "a.py", "r", 9)),
    ).toBeLessThan(0);
    expect(
      callSiteCompare(site(5, "a.py", "r", 9), site(5, "a.py", "r", 9)),
    ).toBe(0);
  });

  it("is a total order: sorting a shuffled list yields one arrangement", () => {
    const sites = [
      site(3, "b.py", "r", 4),
      site(3, "a.py", "r", null),
      site(1, "z.py", "r", null),
      site(3, "a.py", "q", null),
      site(3, "a.py", "r", 7),
    ];
    const sorted = [...sites].sort(callSiteCompare);
    expect([...sites].reverse().sort(callSiteCompare)).toEqual(sorted);
    expect(
      sorted.map(
        (s) =>
          `${s.repo}:${s.path}:${String(s.line_start)}:${String(s.line_end)}`,
      ),
    ).toEqual([
      "r:z.py:1:null",
      "q:a.py:3:null",
      "r:a.py:3:null",
      "r:a.py:3:7",
      "r:b.py:3:4",
    ]);
  });
});
