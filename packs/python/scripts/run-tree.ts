/**
 * Run the Python pack over a directory and print the M1 gate report:
 * validation result, entry-point count, diagnostics by code, and every
 * unresolved reference grouped by ref_kind. Optionally writes the canonical
 * graph. Test tooling until the CLI lands (Path C).
 *
 *   npx tsx packs/python/scripts/run-tree.ts <dir> [--repo name] [--root server] [--out graph.json] [--only server/]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPythonPack,
  formatUnresolved,
  summarizeUnresolved,
} from "../src/index.js";
import {
  DEFAULT_EXCLUDE,
  parseTree,
  walkPython,
} from "../test/support/harness.js";
import { assemble } from "../test/support/resolver.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error(
    "usage: run-tree.ts <dir> [--repo name] [--root server] [--out graph.json] [--only prefix/]",
  );
  process.exit(2);
}
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const repo = opt("repo") ?? "repo";
const roots = opt("root") ? [opt("root") as string] : [];
const only = opt("only");
const out = opt("out");

const options = { source_roots: roots };
const pack = await createPythonPack();
const root = resolve(dir);
const files = walkPython(root, {
  exclude: (rel) =>
    DEFAULT_EXCLUDE(rel) ||
    (only !== undefined &&
      !rel.startsWith(only) &&
      !only.startsWith(rel + "/")),
});
const results = parseTree(pack, repo, root, files, options);
const assembled = assemble(pack, results, repo, options);

const routes = assembled.graph.nodes.filter((n) => n.is_entry_point);
console.log(
  `files: ${String(files.length)}  nodes: ${String(assembled.graph.nodes.length)}  edges: ${String(assembled.graph.edges.length)}  schemas: ${String(assembled.graph.schemas.length)}`,
);
console.log(
  `entry points: ${String(routes.length)} (${String(routes.filter((n) => n.entry_point_kind === "http_route").length)} http_route, ${String(routes.filter((n) => n.entry_point_kind === "app_launch").length)} app_launch)`,
);
console.log(`validation: ${assembled.validation.ok ? "ok" : "FAILED"}`);
if (!assembled.validation.ok)
  for (const e of assembled.validation.errors.slice(0, 20))
    console.log(`  ${e.code} ${e.path}: ${e.message}`);

const byCode = new Map<string, number>();
for (const d of assembled.diagnostics)
  byCode.set(
    `${d.severity}/${d.code}`,
    (byCode.get(`${d.severity}/${d.code}`) ?? 0) + 1,
  );
console.log(`diagnostics: ${String(assembled.diagnostics.length)}`);
for (const [code, n] of [...byCode.entries()].sort())
  console.log(`  ${String(n).padStart(4)}  ${code}`);
if (assembled.ambiguous.length > 0)
  console.log(
    `ambiguous references (left unresolved, never guessed): ${String(assembled.ambiguous.length)}`,
  );

const summary = summarizeUnresolved(results, (ref, file) =>
  assembled.resolvedTargets.has(
    `${file.path}:${String(ref.source_line)}:${ref.value}`,
  ),
);
console.log(formatUnresolved(summary, Number(opt("limit") ?? 25)));

if (out) {
  writeFileSync(out, assembled.text);
  console.log(`wrote ${out}`);
}
