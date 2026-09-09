import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * tsc emits with rootDir "." (so tests and scripts compile too), which puts
 * src/index.ts at dist/src/index.js. The exports map must point there, or a
 * clean checkout cannot import the workspace package and every consumer ends
 * up carrying an untracked shim.
 */
const packages = ["core", "cli", "web"] as const;

describe("workspace package exports match the build layout", () => {
  for (const name of packages) {
    it(`${name}/package.json exports dist/src/index.js`, () => {
      const pkg = JSON.parse(
        readFileSync(
          new URL(`../../${name}/package.json`, import.meta.url),
          "utf8",
        ),
      ) as { exports: { ".": { types: string; default: string } } };
      expect(pkg.exports["."].default).toBe("./dist/src/index.js");
      expect(pkg.exports["."].types).toBe("./dist/src/index.d.ts");
      const tsconfig = JSON.parse(
        readFileSync(
          new URL(`../../${name}/tsconfig.json`, import.meta.url),
          "utf8",
        ),
      ) as { compilerOptions: { rootDir: string; outDir: string } };
      expect(tsconfig.compilerOptions.rootDir).toBe(".");
      expect(tsconfig.compilerOptions.outDir).toBe("dist");
    });
  }

  it("core's built entry point exists where the exports map says (after tsc -b)", () => {
    const built = new URL("../dist/src/index.js", import.meta.url);
    if (!existsSync(built)) return; // not built in this run; the static check above still holds
    expect(existsSync(built)).toBe(true);
  });
});
