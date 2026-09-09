#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  FileParseCache,
  NullParseCache,
  RepoInputSchema,
  emitGraph,
  runPipeline,
  summarize,
  validate,
  type GraphShape,
  type LanguagePack,
  type RepoInput,
  type WaterslideConfig,
} from "@waterslide/core";
import { buildViewerHtml } from "@waterslide/web";

/**
 * `waterslide` — parse, validate, dump, view. Handoff §9 lists `baseline` too;
 * it arrives with the baseline file in M3 and is deliberately absent here, so
 * that nothing in this milestone can write one.
 */

const USAGE = `usage:
  waterslide parse <name=path> [<name=path> ...] [options]
      --state-dir <dir>    where graph.json and cache/ live (default .waterslide)
      --no-cache           parse every file, read and write no cache
      --canonical          write the canonical shape (no volatile fields)
      --include-tests      include test files (excluded by default)
      --pack <module>      load an extra language pack module exporting \`pack\`
      --quiet              print only the summary
  waterslide validate <graph.json> [--shape artifact|canonical]   (default artifact)
  waterslide dump [graph.json]                                   (default .waterslide/graph.json)
  waterslide view [graph.json] [--out <file.html>] [--open]      (default .waterslide/graph.html)
`;

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : a.slice(eq + 1);
    const takesValue = ["state-dir", "pack", "shape", "out"].includes(name);
    if (takesValue && value === undefined) {
      value = argv[i + 1];
      i++;
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
    }
    flags.set(name, [...(flags.get(name) ?? []), value ?? "true"]);
  }
  return { positional, flags };
}

class UsageError extends Error {}

function flag(args: Args, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

// ---------------------------------------------------------------------------
// Packs. Fixed convention: each pack module exports a named `pack`.
// ---------------------------------------------------------------------------

const BUILT_IN_PACKS = ["@waterslide/pack-python", "@waterslide/pack-swift"];

async function loadPacks(
  extra: readonly string[],
  log: (s: string) => void,
): Promise<LanguagePack[]> {
  const packs: LanguagePack[] = [];
  for (const spec of [...BUILT_IN_PACKS, ...extra]) {
    let mod: Record<string, unknown>;
    try {
      const target =
        spec.startsWith(".") || nodePath.isAbsolute(spec)
          ? pathToFileURL(nodePath.resolve(spec)).href
          : spec;
      mod = (await import(target)) as Record<string, unknown>;
    } catch (e) {
      if (extra.includes(spec)) throw e;
      log(`pack ${spec}: not installed, skipped`);
      continue;
    }
    const pack = mod.pack as LanguagePack | undefined;
    if (pack === undefined || typeof pack.parse !== "function") {
      if (extra.includes(spec))
        throw new UsageError(
          `${spec} does not export a language pack named \`pack\``,
        );
      log(`pack ${spec}: no \`pack\` export yet (stub), skipped`);
      continue;
    }
    packs.push(pack);
  }
  return packs;
}

function parseRepos(specs: readonly string[]): RepoInput[] {
  if (specs.length === 0)
    throw new UsageError("parse needs at least one <name=path>");
  return specs.map((spec) => {
    const eq = spec.indexOf("=");
    const raw =
      eq === -1
        ? { name: nodePath.basename(nodePath.resolve(spec)), path: spec }
        : { name: spec.slice(0, eq), path: spec.slice(eq + 1) };
    const parsed = RepoInputSchema.safeParse(raw);
    if (!parsed.success) throw new UsageError(`bad repo "${spec}"`);
    return parsed.data;
  });
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdParse(
  args: Args,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const stateDir = nodePath.resolve(flag(args, "state-dir") ?? ".waterslide");
  const quiet = flag(args, "quiet") === "true";
  const log = quiet ? (): void => undefined : err;
  const repos = parseRepos(args.positional);
  const packs = await loadPacks(args.flags.get("pack") ?? [], log);
  if (packs.length === 0) {
    err(
      "no language packs loaded; the graph will contain only what discovery finds (nothing).",
    );
  }
  const config: WaterslideConfig =
    flag(args, "include-tests") === "true" ? { include_tests: true } : {};
  const cache =
    flag(args, "no-cache") === "true"
      ? new NullParseCache()
      : new FileParseCache(nodePath.join(stateDir, "cache"));

  const started = Date.now();
  const run = await runPipeline({ repos, packs, config, cache });
  const emitted = await emitGraph(run.artifact, {
    stateDir,
    canonical: flag(args, "canonical") === "true",
  });
  if (!emitted.ok) {
    err(
      `graph failed validation and was NOT written (${String(emitted.errors.length)} error(s)):`,
    );
    for (const e of emitted.errors.slice(0, 20))
      err(`  ${e.code} ${e.path}: ${e.message}`);
    return 2;
  }
  out(summarize(run));
  out(`wrote ${emitted.path} in ${String(Date.now() - started)} ms`);
  return 0;
}

async function cmdValidate(
  args: Args,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const file = args.positional[0];
  if (file === undefined) throw new UsageError("validate needs a graph file");
  const shapeFlag = flag(args, "shape") ?? "artifact";
  if (shapeFlag !== "artifact" && shapeFlag !== "canonical")
    throw new UsageError(`--shape must be artifact or canonical`);
  const shape: GraphShape = shapeFlag;
  const text = await fs.readFile(file, "utf8");
  const result = validate(JSON.parse(text), { shape });
  if (result.ok) {
    out(
      `${file}: valid ${shape} graph, ${String(result.graph.nodes.length)} nodes, ${String(result.graph.edges.length)} edges`,
    );
    return 0;
  }
  err(`${file}: ${String(result.errors.length)} error(s)`);
  for (const e of result.errors) err(`  ${e.code} ${e.path}: ${e.message}`);
  return 2;
}

async function cmdDump(
  args: Args,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const file = args.positional[0] ?? nodePath.join(".waterslide", "graph.json");
  const text = await fs.readFile(file, "utf8");
  const raw = JSON.parse(text) as { parsed_at?: unknown };
  const shape: GraphShape =
    raw.parsed_at === undefined ? "canonical" : "artifact";
  const result = validate(raw, { shape });
  if (!result.ok) {
    err(
      `${file} is not a valid ${shape} graph; run \`waterslide validate\` for details`,
    );
    return 2;
  }
  const g = result.graph;
  const count = (xs: readonly string[]): string =>
    [
      ...new Map(
        [...xs].sort().map((x) => [x, xs.filter((y) => y === x).length]),
      ),
    ]
      .map(([k, n]) => `${k}=${String(n)}`)
      .join(" ");
  out(`${file} (${shape})`);
  out(`repos: ${g.repos.map((r) => r.name).join(", ")}`);
  out(`nodes: ${String(g.nodes.length)}  ${count(g.nodes.map((n) => n.kind))}`);
  out(`edges: ${String(g.edges.length)}  ${count(g.edges.map((e) => e.kind))}`);
  out(
    `confidence: nodes ${count(g.nodes.map((n) => n.confidence))}; edges ${count(g.edges.map((e) => e.confidence))}`,
  );
  out(
    `entry points: ${String(g.nodes.filter((n) => n.is_entry_point).length)}; band-skipping edges: ${String(g.edges.filter((e) => e.skips_tiers.length > 0).length)}; unknown targets: ${String(g.nodes.filter((n) => n.kind === "unknown").length)}`,
  );
  const stats = (g as { stats?: Record<string, unknown> }).stats;
  if (stats?.unresolved_by_kind !== undefined) {
    out("unresolved references by ref_kind:");
    for (const [k, v] of Object.entries(
      stats.unresolved_by_kind as Record<string, number>,
    ).sort())
      out(`  ${k.padEnd(10)} ${String(v)}`);
  }
  return 0;
}

async function cmdView(args: Args, out: (s: string) => void): Promise<number> {
  const file = args.positional[0] ?? nodePath.join(".waterslide", "graph.json");
  const target =
    flag(args, "out") ?? nodePath.join(nodePath.dirname(file), "graph.html");
  const text = await fs.readFile(file, "utf8");
  const raw = JSON.parse(text) as { parsed_at?: unknown };
  const result = validate(raw, {
    shape: raw.parsed_at === undefined ? "canonical" : "artifact",
  });
  if (!result.ok)
    throw new UsageError(
      `${file} is not a valid graph; run \`waterslide validate\``,
    );
  const html = buildViewerHtml(text, {
    title: `waterslide — ${nodePath.basename(file)}`,
  });
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  await fs.writeFile(target, html, "utf8");
  out(`wrote ${target}`);
  if (flag(args, "open") === "true") {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    execFile(opener, [target], () => undefined);
  }
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    process.stderr.write(`${s}\n`);
  };
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    switch (command) {
      case "parse":
        return await cmdParse(args, out, err);
      case "validate":
        return await cmdValidate(args, out, err);
      case "dump":
        return await cmdDump(args, out, err);
      case "view":
        return await cmdView(args, out);
      case undefined:
      case "help":
      case "--help":
        out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(USAGE);
      return 1;
    }
    err(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return 3;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(nodePath.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${String(e)}\n`);
      process.exitCode = 3;
    },
  );
}
