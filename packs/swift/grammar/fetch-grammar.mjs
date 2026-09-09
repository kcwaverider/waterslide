// Fetch the pinned tree-sitter-swift wasm and verify it against the sidecar.
// Handoff §2: the grammar is web-tree-sitter; the npm grammar package ships no
// wasm, so the release asset is pinned here by version and sha256 instead.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = JSON.parse(
  readFileSync(join(here, "tree-sitter-swift.wasm.json"), "utf8"),
);
const target = join(here, "tree-sitter-swift.wasm");

const res = await fetch(sidecar.source);
if (!res.ok) {
  throw new Error(`fetch ${sidecar.source}: HTTP ${res.status}`);
}
const bytes = Buffer.from(await res.arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== sidecar.sha256) {
  throw new Error(
    `sha256 mismatch for ${sidecar.grammar} ${sidecar.version}: expected ${sidecar.sha256}, got ${sha256}. Not writing.`,
  );
}
writeFileSync(target, bytes);
console.log(`wrote ${target} (${bytes.length} bytes, sha256 ${sha256})`);
