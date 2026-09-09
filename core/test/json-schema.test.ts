import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  JSON_SCHEMA_FILES,
  graphJsonSchemas,
  renderJsonSchema,
} from "../src/json-schema.js";

const schemaDir = new URL("../schema/", import.meta.url);

describe("committed JSON Schema (handoff §5.2)", () => {
  const generated = graphJsonSchemas();

  for (const key of ["canonical", "artifact"] as const) {
    it(`${JSON_SCHEMA_FILES[key]} matches z.toJSONSchema() output — run \`npm run schema:emit\` if not`, () => {
      const committed = readFileSync(
        new URL(JSON_SCHEMA_FILES[key], schemaDir),
        "utf8",
      );
      expect(committed).toBe(renderJsonSchema(generated[key]));
    });
  }

  it("forbids unknown keys everywhere, so canonical form cannot carry extras", () => {
    const text = JSON.stringify(generated.canonical);
    expect(text).toContain('"additionalProperties":false');
    expect(text).not.toContain('"additionalProperties":true');
  });

  it("pins schema_version to the current model version", () => {
    const props = (
      generated.canonical as { properties: Record<string, unknown> }
    ).properties;
    expect(props.schema_version).toEqual({ type: "number", const: 1 });
  });
});
