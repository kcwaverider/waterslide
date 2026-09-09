import { describe, expect, it } from "vitest";
import {
  CorePartialEdgeSchema,
  PackNodeSchema,
  PackPatchSchema,
  PackResultSchema,
  PartialEdgeSchema,
  stripEdgePackData,
  stripNodePackData,
  type PackNode,
  type PartialEdge,
} from "../src/model/pack.js";
import { NodeSchema } from "../src/model/graph.js";

const node: PackNode = {
  id: "r:api/notes.py#update",
  kind: "endpoint",
  label: "PUT /notes/{id}",
  tier: "api",
  parent: null,
  sources: [],
  confidence: "certain",
  confidence_reason: null,
  is_entry_point: true,
  entry_point_kind: "http_route",
  is_infrastructure: false,
  tags: [],
  pack_data: { method: "PUT", local_path: "/{id}", nested: { pack_data: 1 } },
};

const edge: PartialEdge = {
  from: "r:api/main.py",
  to: "r:api/notes.py",
  kind: "call",
  label: "include_router",
  schema_id: null,
  response_schema_id: null,
  confidence: "certain",
  confidence_reason: null,
  condition: null,
  exclusive_group: null,
  branch_ordinal: null,
  is_error_path: false,
  source: null,
  pack_data: { prefix: "/notes" },
};

describe("pack_data (parser §3.3)", () => {
  it("is accepted, absent or null, on pack-facing nodes and edges", () => {
    expect(PackNodeSchema.safeParse(node).success).toBe(true);
    expect(PackNodeSchema.safeParse({ ...node, pack_data: null }).success).toBe(
      true,
    );
    const { pack_data: _p, ...bare } = node;
    expect(PackNodeSchema.safeParse(bare).success).toBe(true);
    expect(PartialEdgeSchema.safeParse(edge).success).toBe(true);
    expect(
      PackResultSchema.safeParse({
        nodes: [node],
        edges: [edge],
        schemas: [],
        provides: [],
        diagnostics: [],
      }).success,
    ).toBe(true);
    expect(
      PackPatchSchema.safeParse({
        nodes: [node],
        edges: [edge],
        schemas: [],
        provides: [],
        node_updates: [],
        diagnostics: [],
      }).success,
    ).toBe(true);
  });

  it("is not a graph field: the graph model's Node rejects it", () => {
    expect(NodeSchema.safeParse(node).success).toBe(false);
    expect(CorePartialEdgeSchema.safeParse(edge).success).toBe(false);
  });

  it("is deleted by the strip helpers, not nulled, at any depth of the serialized output", () => {
    const strippedNode = stripNodePackData(node);
    const strippedEdge = stripEdgePackData(edge);
    expect(JSON.stringify(strippedNode)).not.toContain("pack_data");
    expect(JSON.stringify(strippedEdge)).not.toContain("pack_data");
    expect("pack_data" in strippedNode).toBe(false);
    expect("pack_data" in strippedEdge).toBe(false);
    expect(NodeSchema.safeParse(strippedNode).success).toBe(true);
    expect(CorePartialEdgeSchema.safeParse(strippedEdge).success).toBe(true);
    // Everything else survives untouched.
    const { pack_data: _n, ...nodeRest } = node;
    const { pack_data: _e, ...edgeRest } = edge;
    expect(strippedNode).toEqual(nodeRest);
    expect(strippedEdge).toEqual(edgeRest);
  });
});
