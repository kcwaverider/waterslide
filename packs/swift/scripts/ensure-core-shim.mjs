// TEMPORARY local workaround, not a fix. core/package.json exports point at
// ./dist/index.js, but core/tsconfig.json (rootDir ".") emits dist/src/index.js,
// so `import "@waterslide/core"` cannot resolve until core's exports are
// corrected. core/ is privileged (handoff §5.2); this only writes untracked
// build output, and only when the real entry is missing. Delete once core
// ships either dist/index.js or exports pointing at dist/src/index.js.
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coreDist = join(here, "..", "..", "..", "core", "dist");
if (!existsSync(join(coreDist, "src", "index.js"))) {
  console.error(
    "core is not built (core/dist/src/index.js missing); run `npx tsc -b core` first",
  );
  process.exit(1);
}
const shims = [
  ["index.js", 'export * from "./src/index.js";\n'],
  ["index.d.ts", 'export * from "./src/index.js";\n'],
];
for (const [name, body] of shims) {
  const target = join(coreDist, name);
  if (!existsSync(target)) {
    writeFileSync(target, body);
    console.log(`wrote shim ${target}`);
  }
}
