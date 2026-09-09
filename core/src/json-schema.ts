import { z } from "zod";
import { CanonicalGraphSchema, GraphArtifactSchema } from "./model/graph.js";

/**
 * Handoff §5.2: emit JSON Schema from the model with z.toJSONSchema() and
 * commit it. The committed files under core/schema/ are checked against this
 * output by a test, so they cannot drift from the Zod source of truth.
 */
export function graphJsonSchemas(): {
  canonical: Record<string, unknown>;
  artifact: Record<string, unknown>;
} {
  return {
    canonical: {
      title: "CanonicalGraph",
      ...z.toJSONSchema(CanonicalGraphSchema),
    },
    artifact: {
      title: "GraphArtifact",
      ...z.toJSONSchema(GraphArtifactSchema),
    },
  };
}

export const JSON_SCHEMA_FILES = {
  canonical: "canonical-graph.schema.json",
  artifact: "graph-artifact.schema.json",
} as const;

export function renderJsonSchema(schema: Record<string, unknown>): string {
  return JSON.stringify(schema, null, 2) + "\n";
}
