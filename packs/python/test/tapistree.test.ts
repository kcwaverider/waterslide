import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatUnresolved, summarizeUnresolved } from "../src/index.js";
import { parseTree, shuffle, walkPython } from "./support/harness.js";
import { getPack } from "./support/pack.js";
import { assemble } from "./support/resolver.js";
import { ordinalLimbViolations } from "./support/ordinals.js";

const SERVER = { source_roots: ["server"] };

/**
 * The M1 gate against the reference codebase (handoff §6). Runs only when a
 * tapistree checkout is present: `WATERSLIDE_TAPISTREE=/path` or a sibling
 * checkout at `../tapistree`. Skipped, loudly, otherwise.
 */
const TAPISTREE =
  process.env["WATERSLIDE_TAPISTREE"] ??
  resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
    "..",
    "tapistree",
  );
const present = existsSync(join(TAPISTREE, "server", "main.py"));

/**
 * Hand count of FastAPI route decorators in tapistree's `server/` tree at commit
 * 1ce0d91 (2026-09-08): `grep -rnE '@(app|router)\.(get|post|put|delete|patch|
 * websocket|api_route)\(' server --include='*.py' | grep -v /tests/` → 78, of
 * which 76 are `@router.*` in server/api/endpoints/*.py and 2 are `@app.*` in
 * server/main.py. It will drift when tapistree changes; recount before editing.
 */
const EXPECTED_ROUTES = 78;
const EXPECTED_MONGO_COLLECTIONS = 13; // distinct `db.<collection>.<method>` attributes at the same commit

describe.skipIf(!present)("tapistree Python backend (M1 gate)", () => {
  const REPO = "tapistree";
  const exclude = (rel: string): boolean =>
    !(rel === "server" || rel.startsWith("server/")) ||
    /(^|\/)(tests|\.venv|venv|__pycache__)(\/|$)/.test(rel) ||
    /(^|\/)test_[^/]*\.py$/.test(rel);

  it("parses, validates, and reports every unresolved reference", async () => {
    const pack = await getPack();
    const files = walkPython(TAPISTREE, { exclude });
    expect(files.length).toBeGreaterThan(40);
    const results = parseTree(pack, REPO, TAPISTREE, files, SERVER);
    const assembled = assemble(pack, results, REPO, SERVER);

    // Item 7: nothing threw; syntax errors, if any, are diagnostics.
    const failures = assembled.diagnostics.filter(
      (d) => d.code === "recognizer_failure" || d.code === "pack_failure",
    );
    expect(failures).toEqual([]);

    // Item 1: all invariants, invariant 15 in its contiguity form included.
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors?.slice(0, 5), null, 2),
    ).toBe(true);
    // Item 2 of A6: edges sharing an ordinal come from one limb.
    expect(ordinalLimbViolations(results)).toEqual([]);

    // Item 3: every route, against the hand count.
    const routes = assembled.graph.nodes.filter(
      (n) => n.is_entry_point && n.entry_point_kind === "http_route",
    );
    expect(routes).toHaveLength(EXPECTED_ROUTES);
    expect(
      routes.every((n) =>
        /^[A-Z]+(, [A-Z]+)* \/api\/|^[A-Z]+ \//.test(n.label),
      ),
    ).toBe(true);
    expect(
      routes.filter(
        (n) => n.label.startsWith("GET /health") || n.label === "GET /",
      ),
    ).toHaveLength(2);
    expect(
      assembled.patch.diagnostics.filter(
        (d) => d.code === "router_not_mounted" || d.code === "unresolved_mount",
      ),
    ).toEqual([]);

    // Collections reached, as a coverage check on the Mongo recognizer.
    const collections = new Set(
      assembled.graph.nodes
        .filter((n) => n.kind === "collection")
        .map((n) => n.label),
    );
    expect(collections.size, [...collections].sort().join(", ")).toBe(
      EXPECTED_MONGO_COLLECTIONS,
    );

    // Item 6: the summary is printed on every run, grouped by ref_kind.
    const summary = summarizeUnresolved(results, (ref, file) =>
      assembled.resolvedTargets.has(
        `${file.path}:${String(ref.source_line)}:${ref.value}`,
      ),
    );
    console.log(formatUnresolved(summary, 15));
    console.log(
      `diagnostics: ${String(assembled.diagnostics.length)} (${Object.entries(
        countBy(assembled.diagnostics.map((d) => d.code)),
      )
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ")})`,
    );
    expect(summary.by_kind.datastore.count).toBe(0);
    expect(summary.by_kind.external.count).toBe(0);
  });

  it("is byte-identical across runs and across shuffled discovery order", async () => {
    const pack = await getPack();
    const files = walkPython(TAPISTREE, { exclude });
    const a = assemble(
      pack,
      parseTree(pack, REPO, TAPISTREE, files, SERVER),
      REPO,
      SERVER,
    ).text;
    const b = assemble(
      pack,
      parseTree(pack, REPO, TAPISTREE, files, SERVER),
      REPO,
      SERVER,
    ).text;
    expect(b).toBe(a);
    const c = assemble(
      pack,
      parseTree(pack, REPO, TAPISTREE, shuffle(files, 2026), SERVER),
      REPO,
      SERVER,
    ).text;
    expect(c).toBe(a);
  });
});

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
