import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  JSON_SCHEMA_FILES,
  graphJsonSchemas,
  renderJsonSchema,
} from "../src/json-schema.js";

// Runs from dist/scripts/ after `tsc -b`; ../../schema resolves to core/schema either way.
const outDir = new URL("../../schema/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const schemas = graphJsonSchemas();
for (const key of ["canonical", "artifact"] as const) {
  const target = new URL(JSON_SCHEMA_FILES[key], outDir);
  writeFileSync(target, renderJsonSchema(schemas[key]));
  console.log(`wrote ${fileURLToPath(target)}`);
}
