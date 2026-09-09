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
  type InfrastructureMarker,
  type LanguagePack,
  type PackOptions,
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
      --pack-option <pack_id>.<option>=<value>
                           set one pack option for this run (repeatable); a
                           comma-separated value becomes a list where the
                           pack's schema expects one. Flag beats config beats
                           pack default, and changes the cache key.
      --infrastructure <glob>
                           mark every node with a source span under this
                           repo-relative glob as infrastructure (repeatable).
                           Never inferred; absent means no node is marked.
      --exclude <name>:<glob>
                           skip files under a repo-relative glob in the named
                           repo (repeatable). Applied at discovery: the files
                           are never read, hashed or parsed. Quote the glob so
                           the shell leaves "**" alone.
      --include <name>:<glob>
                           only parse files under this glob in the named repo
                           (repeatable). Applied before --exclude.
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
    const takesValue = [
      "state-dir",
      "pack",
      "pack-option",
      "infrastructure",
      "exclude",
      "include",
      "shape",
      "out",
    ].includes(name);
    if (takesValue && value === undefined) {
      value = argv[i + 1];
      // The next token is the value only if it is not itself an option:
      // `--infrastructure --canonical` is a missing glob, not a glob named
      // "--canonical" and a silently dropped --canonical.
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`--${name} needs a value`);
      i++;
    }
    flags.set(name, [...(flags.get(name) ?? []), value ?? "true"]);
  }
  return { positional, flags };
}

class UsageError extends Error {}

function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // A graph is an object. `null`, an array or a scalar parse fine and would
  // then be dereferenced by the shape check; reject them here instead.
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "a graph must be a JSON object" };
  return { ok: true, value };
}

function flag(args: Args, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

// ---------------------------------------------------------------------------
// Packs. Fixed convention: each pack module exports a named `pack`.
// ---------------------------------------------------------------------------

const BUILT_IN_PACKS = ["@waterslide/pack-python", "@waterslide/pack-swift"];

interface LoadedPack {
  readonly pack: LanguagePack;
  /**
   * The pack's options schema, when its module exposes one: `optionsSchema`
   * by convention, or any export named `*OptionsSchema` with `safeParse`.
   * Used only to coerce and validate `--pack-option` values.
   */
  readonly optionsSchema: ZodLike | null;
}

interface ZodLike {
  safeParse(input: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
}

function findOptionsSchema(mod: Record<string, unknown>): ZodLike | null {
  const isZod = (v: unknown): v is ZodLike =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === "function";
  if (isZod(mod.optionsSchema)) return mod.optionsSchema;
  for (const [name, value] of Object.entries(mod).sort()) {
    if (name.endsWith("OptionsSchema") && isZod(value)) return value;
  }
  return null;
}

async function loadPacks(
  extra: readonly string[],
  log: (s: string) => void,
): Promise<LoadedPack[]> {
  const packs: LoadedPack[] = [];
  for (const spec of [...BUILT_IN_PACKS, ...extra]) {
    // Resolve first, import second. A package that is not installed is a
    // skip; a package that resolves but fails to import (a broken build, a
    // missing transitive dependency) is a loud failure, never a thin graph
    // with exit code 0.
    let target: string;
    if (spec.startsWith(".") || nodePath.isAbsolute(spec)) {
      target = pathToFileURL(nodePath.resolve(spec)).href;
    } else {
      try {
        target = import.meta.resolve(spec);
      } catch (e) {
        if (extra.includes(spec)) throw e;
        log(`pack ${spec}: not installed, skipped`);
        continue;
      }
    }
    const mod = (await import(target)) as Record<string, unknown>;
    const pack = mod.pack as LanguagePack | undefined;
    if (pack === undefined || typeof pack.parse !== "function") {
      if (extra.includes(spec))
        throw new UsageError(
          `${spec} does not export a language pack named \`pack\``,
        );
      log(`pack ${spec}: no \`pack\` export yet (stub), skipped`);
      continue;
    }
    packs.push({ pack, optionsSchema: findOptionsSchema(mod) });
  }
  return packs;
}

// ---------------------------------------------------------------------------
// --pack-option: {pack_id}.{option.path}=value, repeatable. The value is a
// string; the pack's own schema decides what it becomes. Candidates are tried
// in order — the string itself, a list (comma-split, or the single value), a
// number, a boolean — and the first the schema accepts wins. Without a schema
// the value stays a string, or a list when it contains a comma.
// ---------------------------------------------------------------------------

export function applyPackOptions(
  specs: readonly string[],
  loaded: readonly LoadedPack[],
): Record<string, PackOptions> {
  const byPack = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq === -1)
      throw new UsageError(
        `--pack-option ${spec}: expected <pack_id>.<option>=<value>`,
      );
    const key = spec.slice(0, eq);
    const raw = spec.slice(eq + 1);
    const dot = key.indexOf(".");
    if (dot <= 0 || dot === key.length - 1)
      throw new UsageError(
        `--pack-option ${spec}: key must be <pack_id>.<option>`,
      );
    const packId = key.slice(0, dot);
    const path = key.slice(dot + 1).split(".");
    const target = loaded.find((l) => l.pack.manifest.id === packId);
    if (target === undefined) {
      throw new UsageError(
        `--pack-option ${spec}: no loaded pack is named "${packId}" (loaded: ${loaded.map((l) => l.pack.manifest.id).join(", ") || "none"})`,
      );
    }
    const current = byPack.get(packId) ?? {};
    const asList = raw.includes(",")
      ? raw.split(",").map((s) => s.trim())
      : [raw];
    const candidates: unknown[] = [raw, asList];
    if (raw.trim() !== "" && Number.isFinite(Number(raw)))
      candidates.push(Number(raw));
    if (raw === "true" || raw === "false") candidates.push(raw === "true");

    let accepted: Record<string, unknown> | null = null;
    let lastError = "";
    if (target.optionsSchema === null) {
      accepted = setPath(
        structuredClone(current),
        path,
        raw.includes(",") ? asList : raw,
      );
    } else {
      for (const candidate of candidates) {
        const attempt = setPath(structuredClone(current), path, candidate);
        const result = target.optionsSchema.safeParse(attempt);
        if (result.success) {
          accepted = attempt;
          break;
        }
        lastError = (result.error?.issues ?? [])
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
      }
    }
    if (accepted === null) {
      throw new UsageError(
        `--pack-option ${spec}: pack "${packId}" rejects it (${lastError || "no candidate value accepted"})`,
      );
    }
    byPack.set(packId, accepted);
  }
  return Object.fromEntries(byPack);
}

function setPath(
  obj: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  let cursor = obj;
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      cursor[key] = value;
    } else {
      const next = cursor[key];
      if (typeof next !== "object" || next === null || Array.isArray(next))
        cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
  }
  return obj;
}

/** `--infrastructure <glob>`, repeatable: one persisted-files §3.2 marker per occurrence. */
export function parseInfrastructure(
  globs: readonly string[],
): InfrastructureMarker[] {
  return globs.map((glob) => {
    if (glob.trim() === "")
      throw new UsageError("--infrastructure needs a non-empty glob");
    return { glob };
  });
}

/**
 * `--exclude <name>:<glob>` and `--include <name>:<glob>`, repeatable. Unlike
 * the tier and infrastructure globs these are REPO-QUALIFIED: an exclude that
 * silently applied to every repo is the kind of thing found by noticing a
 * missing subtree. Repo names contain no ":" (graph model §1), so the first
 * colon is the split. The globs land on the repo list entry itself (parser
 * §1.1), which is where config.yaml will put them too; flag beats config.
 */
export function applyRepoGlobs(
  repos: readonly RepoInput[],
  field: "include" | "exclude",
  specs: readonly string[],
): RepoInput[] {
  const byRepo = new Map<string, string[]>();
  for (const spec of specs) {
    const colon = spec.indexOf(":");
    if (colon <= 0 || colon === spec.length - 1)
      throw new UsageError(`--${field} ${spec}: expected <name>:<glob>`);
    const name = spec.slice(0, colon);
    const glob = spec.slice(colon + 1);
    if (!repos.some((r) => r.name === name)) {
      throw new UsageError(
        `--${field} ${spec}: no repo is named "${name}" (repos: ${repos.map((r) => r.name).join(", ")})`,
      );
    }
    byRepo.set(name, [...(byRepo.get(name) ?? []), glob]);
  }
  return repos.map((repo) => {
    const globs = byRepo.get(repo.name);
    return globs === undefined ? repo : { ...repo, [field]: globs };
  });
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
  const repos = applyRepoGlobs(
    applyRepoGlobs(
      parseRepos(args.positional),
      "include",
      args.flags.get("include") ?? [],
    ),
    "exclude",
    args.flags.get("exclude") ?? [],
  );
  const loaded = await loadPacks(args.flags.get("pack") ?? [], log);
  const packs = loaded.map((l) => l.pack);
  if (packs.length === 0) {
    err(
      "no language packs loaded; the graph will contain only what discovery finds (nothing).",
    );
  }
  // Flag beats config beats pack default. Config is M3; until then the flag
  // is the only source, and it reaches the cache key through resolvePackOptions.
  const packOptions = applyPackOptions(
    args.flags.get("pack-option") ?? [],
    loaded,
  );
  // Same precedence as --pack-option once config.yaml arrives (M3): the flag
  // list replaces the config block. It is stage-5-only config, so it stays out
  // of the stage 3 cache key on purpose — see WaterslideConfigSchema.
  const infrastructure = parseInfrastructure(
    args.flags.get("infrastructure") ?? [],
  );
  const config: WaterslideConfig = {
    ...(flag(args, "include-tests") === "true" ? { include_tests: true } : {}),
    ...(Object.keys(packOptions).length > 0 ? { packs: packOptions } : {}),
    ...(infrastructure.length > 0 ? { infrastructure } : {}),
  };
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
  const parsed = parseJson(text);
  if (!parsed.ok) {
    err(`${file}: not valid JSON: ${parsed.error}`);
    return 2;
  }
  const result = validate(parsed.value, { shape });
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
  const parsed = parseJson(text);
  if (!parsed.ok) {
    err(`${file}: not valid JSON: ${parsed.error}`);
    return 2;
  }
  const raw = parsed.value as { parsed_at?: unknown };
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
  const count = (xs: readonly string[]): string => {
    const tally = new Map<string, number>();
    for (const x of xs) tally.set(x, (tally.get(x) ?? 0) + 1);
    return [...tally]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, n]) => `${k}=${String(n)}`)
      .join(" ");
  };
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
  const parsed = parseJson(text);
  if (!parsed.ok)
    throw new UsageError(`${file}: not valid JSON: ${parsed.error}`);
  const raw = parsed.value as { parsed_at?: unknown };
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
    // `start` is a cmd.exe builtin, not an executable, so on Windows it must
    // go through the command interpreter; the empty string is the window title.
    const [opener, openerArgs] =
      process.platform === "darwin"
        ? (["open", [target]] as const)
        : process.platform === "win32"
          ? (["cmd.exe", ["/c", "start", "", target]] as const)
          : (["xdg-open", [target]] as const);
    execFile(opener, [...openerArgs], (e) => {
      if (e !== null) out(`could not open ${target}: ${e.message}`);
    });
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
