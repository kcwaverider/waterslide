import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Python standard library top-level modules. One list, shared: the Python
 * pack skips a direct stdlib call silently, and stage 4 gives the same
 * treatment to an alias whose target is rooted in the stdlib (C19). The
 * standard library is neither a node nor a coverage gap, so a reference that
 * resolves into it is nothing to draw and nothing to report.
 *
 * `core/data/stdlib-modules.json` is the canonical copy; the pack's
 * `data/stdlib-modules.json` is to import from here once it can.
 */

const StdlibListSchema = z.object({
  $comment: z.string().optional(),
  names: z.array(z.string()),
});

function load(): ReadonlySet<string> {
  // src/pipeline/stdlib.ts and dist/src/pipeline/stdlib.js sit at different
  // depths; try both so vitest (from src) and the built package (from dist)
  // find core/data.
  const candidates = [
    new URL("../../data/stdlib-modules.json", import.meta.url),
    new URL("../../../data/stdlib-modules.json", import.meta.url),
  ];
  const url = candidates.find((u) => existsSync(u));
  if (url === undefined) {
    throw new Error(
      `core/data/stdlib-modules.json not found (looked in ${candidates.map((u) => u.pathname).join(", ")})`,
    );
  }
  const parsed = StdlibListSchema.parse(
    JSON.parse(readFileSync(url, "utf8")) as unknown,
  );
  return new Set(parsed.names);
}

export const STDLIB_MODULES: ReadonlySet<string> = load();

/** The root module of a qualified name: `logging.getLogger().info` → `logging`. A trailing call marker on the root is ignored. */
export function rootModule(name: string): string {
  const dot = name.indexOf(".");
  const root = dot === -1 ? name : name.slice(0, dot);
  return root.endsWith("()") ? root.slice(0, -2) : root;
}

export function isStdlibRooted(name: string): boolean {
  return STDLIB_MODULES.has(rootModule(name));
}
