/**
 * Dev driver for the Swift pack. Not the CLI (Path C owns `cli/`); this is
 * how the pack is exercised against a real tree before the pipeline exists.
 *
 *   node packs/swift/dist/scripts/run.js --repo tapistree --path ~/code/tapistree/iOS [--shuffle N] [--out graph.json] [--quiet]
 *
 * Discovers .swift files (tests, Pods, build output excluded per parser
 * §1.3), runs the per-file pass in discovery order, sorts results by (repo,
 * path) byte-wise as core will, runs compose, applies the patch, then
 * assembles a canonical graph so core's validator can judge the output.
 * `unknown` target nodes for UnresolvedRefs are minted HERE, by the driver,
 * with core's id encoder, so the graph has two endpoints per edge. In the
 * pipeline core mints them at stage 4 (amendment B1); the pack never does.
 */
import {
  callSiteCompare,
  edgeId,
  serializeCanonical,
  unknownNodeId,
  unknownNodeLabel,
  validate,
  type CanonicalGraph,
  type Edge,
  type Node as GraphNode,
  type PartialEdge,
  type PerFileResult,
} from "@waterslide/core";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  applyPatch,
  composeWithReport,
  formatSummary,
  SwiftPack,
} from "../src/index.js";

const EXCLUDED_DIRS =
  /^(Pods|DerivedData|\.build|build|Carthage|node_modules|\.git)$|Tests$/;

export function discover(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!EXCLUDED_DIRS.test(name)) walk(full);
      } else if (name.endsWith(".swift")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Deterministic shuffle so a run is reproducible by seed. */
export function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const byteCmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export interface Assembled {
  graph: CanonicalGraph;
  merged: ReturnType<typeof applyPatch>;
  report: ReturnType<typeof composeWithReport>["report"];
}

export function assemble(
  results: readonly PerFileResult[],
  repoName: string,
  commit: string,
): Assembled {
  const sorted = [...results].sort(
    (a, b) => byteCmp(a.repo, b.repo) || byteCmp(a.path, b.path),
  );
  const { patch, report } = composeWithReport(sorted);
  const merged = applyPatch(sorted, patch);

  const nodes = new Map<string, GraphNode>(merged.nodes.map((n) => [n.id, n]));
  const standIns = new Map<string, GraphNode>();
  const collapsed = new Map<string, { edge: Edge; conditions: Set<string> }>();
  for (const pe of merged.edges) {
    const fromTier = nodes.get(pe.from)?.tier ?? "domain";
    const to = resolveTo(pe, standIns, fromTier);
    const key = edgeId({
      from: pe.from,
      to,
      kind: pe.kind,
      exclusive_group: pe.exclusive_group,
      branch_ordinal: pe.branch_ordinal,
    });
    const existing = collapsed.get(key);
    const condKey = JSON.stringify(pe.condition);
    if (existing === undefined) {
      collapsed.set(key, {
        edge: {
          id: key,
          from: pe.from,
          to,
          kind: pe.kind,
          label: pe.label,
          schema_id: pe.schema_id,
          response_schema_id: pe.response_schema_id,
          confidence: pe.confidence,
          confidence_reason: pe.confidence_reason,
          condition: pe.condition,
          exclusive_group: pe.exclusive_group,
          is_error_path: pe.is_error_path,
          source: pe.source,
          source_count: pe.source === null ? 0 : 1,
          branch_ordinal: pe.branch_ordinal,
          is_broken: false,
          broken_reason: null,
          skips_tiers: [],
        },
        conditions: new Set([condKey]),
      });
      continue;
    }
    // Graph model §3.3 collapsing rules.
    const e = existing.edge;
    e.source_count += 1;
    if (
      pe.source !== null &&
      (e.source === null || callSiteCompare(pe.source, e.source) < 0)
    ) {
      e.source = pe.source;
    }
    existing.conditions.add(condKey);
    if (existing.conditions.size > 1) e.condition = null;
    if (pe.confidence === "inferred" && e.confidence === "certain") {
      e.confidence = "inferred";
      e.confidence_reason = pe.confidence_reason;
    }
    e.is_error_path = e.is_error_path && pe.is_error_path;
  }
  for (const s of standIns.values()) nodes.set(s.id, s);

  const graph: CanonicalGraph = {
    schema_version: 1,
    tier_config_hash: `sha256:${createHash("sha256").update("").digest("hex").slice(0, 16)}`,
    repos: [{ name: repoName, commit }],
    nodes: [...nodes.values()],
    edges: [...collapsed.values()].map((c) => c.edge),
    schemas: merged.schemas,
  };
  return { graph, merged, report };
}

function resolveTo(
  pe: PartialEdge,
  standIns: Map<string, GraphNode>,
  fromTier: GraphNode["tier"],
): string {
  if (typeof pe.to === "string") return pe.to;
  const id = unknownNodeId(pe.to.ref_kind, pe.to.value);
  if (!standIns.has(id)) {
    standIns.set(id, {
      id,
      kind: "unknown",
      label: unknownNodeLabel(pe.to.ref_kind, pe.to.value),
      tier: fromTier,
      parent: null,
      sources: [],
      confidence: "inferred",
      confidence_reason: `unresolved ${pe.to.ref_kind} reference \`${pe.to.value}\` from ${pe.from} (driver-minted; core mints this at stage 4)`,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    });
  }
  return id;
}

function gitCommit(dir: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "0".repeat(40);
  }
}

export async function runTree(
  repoName: string,
  root: string,
  order: "sorted" | number,
): Promise<{
  assembled: Assembled;
  bytes: string;
  results: PerFileResult[];
}> {
  const pack = new SwiftPack();
  let files = discover(root).sort(byteCmp);
  if (order !== "sorted") files = shuffle(files, order);
  const results: PerFileResult[] = [];
  for (const f of files) {
    const path = relative(root, f).split("\\").join("/");
    const analysis = await pack.analyze(
      repoName,
      path,
      readFileSync(f, "utf8"),
    );
    results.push({ repo: repoName, path, result: analysis.result });
  }
  const assembled = assemble(results, repoName, gitCommit(root));
  return { assembled, bytes: serializeCanonical(assembled.graph), results };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | null => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const repoName = opt("repo") ?? "repo";
  const root = opt("path");
  if (root === null) {
    console.error(
      "usage: run.js --repo <name> --path <dir> [--shuffle <seed>] [--out <file>] [--quiet]",
    );
    process.exit(2);
  }
  const seed = opt("shuffle");
  const started = Date.now();
  const { assembled, bytes } = await runTree(
    repoName,
    root,
    seed === null ? "sorted" : Number(seed),
  );
  const out = opt("out");
  if (out !== null) writeFileSync(out, bytes);

  const result = validate(JSON.parse(bytes), { shape: "canonical" });
  // Pending: the settled ordinal rule lets two edges in one limb share an
  // ordinal; core is dropping invariant 15's uniqueness clause. Until it lands,
  // that one code is reported separately rather than failing the run.
  const pending = result.ok
    ? []
    : result.errors.filter((e) => e.code === "E_BRANCH_ORDINAL_DUPLICATE");
  const real = result.ok
    ? []
    : result.errors.filter((e) => e.code !== "E_BRANCH_ORDINAL_DUPLICATE");
  if (pending.length > 0) {
    console.log(
      `validator: ${String(pending.length)} E_BRANCH_ORDINAL_DUPLICATE (pending core's invariant-15 change; same-limb edges share an ordinal by the settled rule)`,
    );
  }
  if (!args.includes("--quiet")) {
    console.log(formatSummary(assembled.merged, assembled.report));
    console.log("");
  }
  if (real.length === 0) {
    console.log(
      `validator: OK (${String(assembled.graph.nodes.length)} nodes, ${String(assembled.graph.edges.length)} edges, ${String(assembled.graph.schemas.length)} schemas) in ${String(Date.now() - started)} ms`,
    );
  } else {
    console.log(`validator: FAILED with ${String(real.length)} error(s)`);
    for (const e of real.slice(0, 40))
      console.log(`  ${e.code} ${e.path}: ${e.message}`);
    process.exitCode = 1;
  }
  const bytesHash = createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 16);
  console.log(`canonical sha256: ${bytesHash}`);
}

if (process.argv[1]?.endsWith("run.js") === true) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
