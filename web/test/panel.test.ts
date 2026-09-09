import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanonicalGraph, Edge, Node } from "@waterslide/core";
import {
  describeEdge,
  describeNode,
  expandSchema,
  formatLocation,
} from "../src/browser/panel.js";

const validDir = new URL("../../fixtures/valid/", import.meta.url);
const load = (f: string): CanonicalGraph =>
  JSON.parse(readFileSync(new URL(f, validDir), "utf8")) as CanonicalGraph;
const node = (g: CanonicalGraph, pred: (n: Node) => boolean): Node => {
  const n = g.nodes.find(pred);
  if (n === undefined) throw new Error("no such node");
  return n;
};
const edge = (g: CanonicalGraph, pred: (e: Edge) => boolean): Edge => {
  const e = g.edges.find(pred);
  if (e === undefined) throw new Error("no such edge");
  return e;
};
const field = (
  m: { fields: readonly { label: string; value: string }[] },
  label: string,
): string[] => m.fields.filter((f) => f.label === label).map((f) => f.value);

describe("inspection panel (UI §8)", () => {
  it("leads with the label, keeps the id for the address line", () => {
    const g = load("unknown-dangling-refs.json");
    const n = node(g, (x) => x.kind === "unknown" && x.tier === "ui_logic");
    const m = describeNode(n, g, {});
    expect(m.title).toBe("unresolved http /notes/{id}/archive");
    expect(m.subtitle).toBe("unresolved reference");
    expect(m.address).toBe("unknown:http:%2Fnotes%2F{id}%2Farchive");
    expect(m.fields.some((f) => f.value.includes("unknown:http"))).toBe(false);
  });

  it("shows the confidence_reason verbatim when not certain, and not at all when certain", () => {
    const g = load("unknown-dangling-refs.json");
    const n = node(g, (x) => x.kind === "unknown" && x.tier === "domain");
    const m = describeNode(n, g, {});
    expect(field(m, "Confidence")).toEqual(["inferred"]);
    expect(field(m, "Why")).toEqual([n.confidence_reason]);
    expect(m.fields.find((f) => f.label === "Why")?.tone).toBe("reason");
    const certain = node(g, (x) => x.confidence === "certain");
    expect(field(describeNode(certain, g, {}), "Why")).toEqual([]);
  });

  it("renders source spans as repo path:start–end text, one per span", () => {
    expect(
      formatLocation({
        repo: "tapistree",
        path: "api/routers/notes.py",
        line_start: 42,
        line_end: 58,
      }),
    ).toBe("tapistree api/routers/notes.py:42–58");
    expect(
      formatLocation({
        repo: "t",
        path: "a.py",
        line_start: 7,
        line_end: null,
      }),
    ).toBe("t a.py:7");
    const g = load("split-definition.json");
    const split = node(g, (x) => x.sources.length === 3);
    expect(field(describeNode(split, g, {}), "Source")).toHaveLength(3);
  });

  it("names the parent by label and reports change state from the map", () => {
    const g = load("single-repo-minimal.json");
    const n = node(g, (x) => x.id === "ledger:app/routes.py#list_entries");
    const m = describeNode(n, g, { [n.id]: "modified" });
    expect(field(m, "Inside")).toEqual(["routes"]);
    expect(field(m, "Change")).toEqual(["modified"]);
    expect(field(m, "Entry point")).toEqual(["http_route"]);
    expect(field(describeNode(n, g, {}), "Change")).toEqual(["unchanged"]);
  });

  it("explains a source-less node instead of showing nothing", () => {
    const g = load("tombstone-broken-edge.json");
    const t = node(g, (x) => x.kind === "tombstone");
    expect(field(describeNode(t, g, {}), "Source")[0]).toMatch(/gone/);
  });

  it("an edge is titled by its endpoints' labels and carries the broken_reason", () => {
    const g = load("tombstone-broken-edge.json");
    const e = edge(g, (x) => x.to.includes("ArchiveService"));
    const m = describeEdge(e, g);
    expect(m.title).toBe("POST /notes/{id}/archive → ArchiveService.archive");
    expect(field(m, "Broken")).toEqual([e.broken_reason]);
    expect(m.fields.find((f) => f.label === "Broken")?.tone).toBe("broken");
    expect(field(m, "Call site")).toEqual([
      "tapistree api/routers/notes.py:68",
    ]);
  });

  it("a conditional edge shows its condition verbatim and its place among the alternatives", () => {
    const g = load("derived-ids.json");
    const e = edge(g, (x) => x.condition?.expr === "else");
    const m = describeEdge(e, g);
    expect(field(m, "Fires when")).toEqual(["else"]);
    expect(field(m, "Branch")).toEqual(["alternative 2 of 2, error path"]);
  });

  it("an annotated edge says it has no call site; a collapsed edge counts its call sites", () => {
    const g = load("annotated-edge.json");
    const a = edge(g, (x) => x.confidence === "annotated");
    expect(field(describeEdge(a, g), "Call site")[0]).toMatch(/hand-annotated/);
    const d = load("derived-ids.json");
    const collapsed = edge(d, (x) => x.source_count > 1);
    expect(field(describeEdge(collapsed, d), "First call site")[0]).toMatch(
      /\(2 call sites\)$/,
    );
  });

  it("expands the attached schemas with fields, optionality, classification and nested refs", () => {
    const g = load("single-repo-minimal.json");
    const e = edge(
      g,
      (x) =>
        x.response_schema_id === "sch_entry_list" && x.skips_tiers.length > 0,
    );
    const m = describeEdge(e, g);
    expect(field(m, "Skips bands")).toEqual(["domain"]);
    expect(m.schemas.map((s) => [s.role, s.name])).toEqual([
      ["response", "list[Entry]"],
    ]);
    const [schema] = m.schemas;
    const owner = schema?.fields.find((f) => f.name === "owner");
    expect(owner?.nested).toMatchObject({ name: "UserRef", role: "field" });
    expect(
      owner?.nested !== null && owner?.nested !== "cycle"
        ? owner?.nested.fields.map((f) => f.name)
        : [],
    ).toEqual(["user_id"]);
    const inferred = edge(g, (x) => x.schema_id === "sch_webhook_payload");
    const [payload] = describeEdge(inferred, g).schemas;
    expect(payload?.confidence).toBe("inferred");
    expect(payload?.confidence_reason).toMatch(/dict literal/);
    expect(payload?.fields.map((f) => f.optional)).toEqual([false, true]);
  });

  it("guards against schema cycles and names a missing schema", () => {
    const loop = {
      nodes: [],
      edges: [],
      schemas: [
        {
          id: "a",
          name: "A",
          source: null,
          confidence: "certain" as const,
          confidence_reason: null,
          fields: [
            {
              name: "b",
              type: "B",
              optional: false,
              classification: [],
              ref_schema_id: "b",
            },
          ],
        },
        {
          id: "b",
          name: "B",
          source: null,
          confidence: "certain" as const,
          confidence_reason: null,
          fields: [
            {
              name: "a",
              type: "A",
              optional: false,
              classification: [],
              ref_schema_id: "a",
            },
          ],
        },
      ],
    };
    const a = expandSchema("request", "a", loop);
    const b = a.fields[0]?.nested;
    expect(b).toMatchObject({ name: "B" });
    const inner =
      b !== null && b !== undefined && b !== "cycle"
        ? b.fields[0]?.nested
        : null;
    expect(inner).toBe("cycle");
    expect(expandSchema("request", "nope", loop).missing).toBe(true);
  });
});
