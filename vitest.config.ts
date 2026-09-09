import { defineConfig } from "vitest/config";

export default defineConfig({
  // TEMPORARY (Stage 2, Path A): core/package.json exports `./dist/index.js`
  // but core/tsconfig.json emits to `dist/src/`, so the package cannot be
  // imported by name. Alias to source until core fixes the export; then delete
  // this block and the matching `paths` entry in packs/python/tsconfig.json.
  resolve: {
    alias: {
      "@waterslide/core": new URL("./core/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
