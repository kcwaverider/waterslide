import { promises as fs } from "node:fs";
import { byteCompare, spanCompare } from "../canonical.js";
import type { Node, PayloadSchema, SourceSpan } from "../model/graph.js";
import { GRAPH_SCHEMA_VERSION } from "../model/graph.js";
import {
  PackPatchSchema,
  PackResultSchema,
  assertPackCompatible,
  type LanguagePack,
  type NodeUpdate,
  type PackOptions,
  type PackPatch,
  type Diagnostic,
  type PackResult,
  type PartialEdge,
  type PerFileResult,
  type PackNode,
  type Provide,
  stripNodePackData,
  toPerFileResult,
} from "../model/pack.js";
import { cacheKey, entryMatches, type ParseCache } from "./cache.js";
import {
  packOptionsHash,
  resolvePackOptions,
  type WaterslideConfig,
} from "./config.js";
import type { DiscoveredFile } from "./discover.js";
import { canonicalJson, contentHash } from "./hash.js";
import { rePathFileDataUnchanged, rePathViolations } from "./repath.js";

/**
 * Core-emitted diagnostic codes for this stage. Graph model §10 leaves codes
 * open-ended; only the ones with cross-consumer meaning are in the reserved
 * table. These are core's own and grouped by the same `code` key.
 */
export const STAGE3_DIAGNOSTIC_CODES = {
  /** A pack threw from `parse` or `compose`, which §9 says it never should. Output for that call is discarded. */
  pack_exception: "error",
  /** A pack returned something that is not a `PackResult`. Discarded. */
  invalid_pack_result: "error",
  /** A pack returned something that is not a `PackPatch`. Discarded. */
  invalid_pack_patch: "error",
  /** A `rePath` result failed the core-side guard; the file was re-parsed instead. */
  repath_rejected: "warning",
  /** A `rePath` result kept its file-level `pack_data` byte-identical across a path change. Accepted, but worth a look. */
  repath_pack_data_unchanged: "info",
  /** Two files emitted the same node id with differing fields; spans were merged and the first file's fields kept. */
  node_definition_conflict: "warning",
  /** Two files emitted the same schema id with differing fields; the first file's definition kept. */
  schema_definition_conflict: "warning",
} as const;

const EMPTY_RESULT: PackResult = {
  nodes: [],
  edges: [],
  schemas: [],
  provides: [],
  diagnostics: [],
};

/** A cache entry (or a rePath result) as a `PerFileResult`, file-level `pack_data` included. */
function fromEntry(entry: {
  repo: string;
  path: string;
  result: PerFileResult["result"];
  pack_data: PerFileResult["pack_data"];
}): PerFileResult {
  return {
    repo: entry.repo,
    path: entry.path,
    result: entry.result,
    pack_data: entry.pack_data,
  };
}

function coreDiagnostic(
  code: keyof typeof STAGE3_DIAGNOSTIC_CODES,
  message: string,
  where: { repo?: string | null; path?: string | null; pack?: string | null },
): Diagnostic {
  return {
    severity: STAGE3_DIAGNOSTIC_CODES[code],
    code,
    message,
    repo: where.repo ?? null,
    path: where.path ?? null,
    line: null,
    pack: where.pack ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pack registry — which pack claims which extension.
// ---------------------------------------------------------------------------

export class PackRegistry {
  private readonly byExtension = new Map<string, LanguagePack>();
  readonly packs: readonly LanguagePack[];

  constructor(packs: readonly LanguagePack[]) {
    for (const pack of packs) assertPackCompatible(pack.manifest);
    // Sorted by id so every per-pack loop downstream runs in one order.
    this.packs = [...packs].sort((a, b) =>
      byteCompare(a.manifest.id, b.manifest.id),
    );
    const ids = new Set<string>();
    for (const pack of this.packs) {
      if (ids.has(pack.manifest.id))
        throw new Error(`two packs share the id "${pack.manifest.id}"`);
      ids.add(pack.manifest.id);
      for (const ext of pack.manifest.extensions) {
        const prior = this.byExtension.get(ext);
        if (prior !== undefined) {
          throw new Error(
            `extension "${ext}" is claimed by both "${prior.manifest.id}" and "${pack.manifest.id}"; one pack per extension`,
          );
        }
        this.byExtension.set(ext, pack);
      }
    }
  }

  get extensions(): ReadonlySet<string> {
    return new Set(this.byExtension.keys());
  }

  packFor(path: string): LanguagePack | null {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    if (dot === -1 || dot < slash) return null;
    return this.byExtension.get(path.slice(dot)) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — parse every discovered file, through the cache.
// ---------------------------------------------------------------------------

export interface Stage3Stats {
  files: number;
  parsed: number;
  cache_hits: number;
  repathed: number;
  repath_fallbacks: number;
}

export interface Stage3Output {
  readonly files: readonly PerFileResult[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: Stage3Stats;
}

export interface ParseFilesOptions {
  readonly cache: ParseCache;
  readonly config: WaterslideConfig;
  /** Injected for tests; defaults to reading from disk. */
  readonly readFile?: (absPath: string) => Promise<Uint8Array>;
}

export async function parseFiles(
  files: readonly DiscoveredFile[],
  registry: PackRegistry,
  options: ParseFilesOptions,
): Promise<Stage3Output> {
  const readFile =
    options.readFile ?? ((p: string): Promise<Uint8Array> => fs.readFile(p));
  const diagnostics: Diagnostic[] = [];
  const stats: Stage3Stats = {
    files: 0,
    parsed: 0,
    cache_hits: 0,
    repathed: 0,
    repath_fallbacks: 0,
  };
  const out: PerFileResult[] = [];
  const optionsByPack = new Map<
    string,
    { options: PackOptions; hash: string }
  >();

  // Sequential, in the caller's (sorted) order. Parallelism would be a
  // performance change only, but the order results are appended in must not
  // depend on completion order, so it is not done casually.
  for (const file of files) {
    const pack = registry.packFor(file.path);
    if (pack === null) continue; // parser §9: no pack claims it, silent skip
    stats.files += 1;

    let resolved = optionsByPack.get(pack.manifest.id);
    if (resolved === undefined) {
      const o = resolvePackOptions(options.config, pack.manifest.id);
      resolved = { options: o, hash: packOptionsHash(o) };
      optionsByPack.set(pack.manifest.id, resolved);
    }

    const bytes = await readFile(file.absPath);
    const parts = {
      contentHash: contentHash(bytes),
      packId: pack.manifest.id,
      packVersion: pack.manifest.version,
      graphSchemaVersion: GRAPH_SCHEMA_VERSION,
      optionsHash: resolved.hash,
      ...(pack.rePath === undefined
        ? { location: `${file.repo}:${file.path}` }
        : {}),
    };
    const key = cacheKey(parts);
    const entry = await options.cache.get(key);

    if (entry !== null && entryMatches(entry, parts)) {
      if (entry.repo === file.repo && entry.path === file.path) {
        stats.cache_hits += 1;
        out.push(fromEntry(entry));
        continue;
      }
      if (pack.rePath !== undefined) {
        const original = fromEntry(entry);
        const moved = pack.rePath(
          original,
          file.repo,
          file.path,
          resolved.options,
        );
        const violations = rePathViolations(
          moved,
          file.repo,
          file.path,
          original,
        );
        if (violations.length === 0) {
          stats.cache_hits += 1;
          stats.repathed += 1;
          if (rePathFileDataUnchanged(moved, original)) {
            diagnostics.push(
              coreDiagnostic(
                "repath_pack_data_unchanged",
                `pack "${pack.manifest.id}" rePath from ${entry.repo}:${entry.path} to ${file.repo}:${file.path} returned file-level pack_data unchanged; fine if it holds no path-derived data`,
                { repo: file.repo, path: file.path, pack: pack.manifest.id },
              ),
            );
          }
          out.push(fromEntry(moved));
          continue;
        }
        stats.repath_fallbacks += 1;
        diagnostics.push(
          coreDiagnostic(
            "repath_rejected",
            `pack "${pack.manifest.id}" rePath from ${entry.repo}:${entry.path} to ${file.repo}:${file.path} failed the guard and the file was re-parsed: ${violations.join("; ")}`,
            { repo: file.repo, path: file.path, pack: pack.manifest.id },
          ),
        );
      }
      // No rePath, or the guard failed: a moved file is a miss.
    }

    stats.parsed += 1;
    const content = Buffer.from(bytes).toString("utf8");
    const parsed = await safeParse(
      pack,
      file,
      content,
      resolved.options,
      diagnostics,
    );
    const perFile = toPerFileResult(
      file.repo,
      file.path,
      parsed ?? EMPTY_RESULT,
    );
    out.push(perFile);
    // A failed parse is not cached: its diagnostic must recur until it is fixed.
    if (parsed !== null) {
      await options.cache.put(key, {
        cache_format: 1,
        content_hash: parts.contentHash,
        pack_id: parts.packId,
        pack_version: parts.packVersion,
        graph_schema_version: GRAPH_SCHEMA_VERSION,
        options_hash: parts.optionsHash,
        repo: file.repo,
        path: file.path,
        result: perFile.result,
        pack_data: perFile.pack_data,
      });
    }
  }
  return { files: out, diagnostics, stats };
}

/** Parser §9: a pack never throws. When one does anyway, the run survives and says so. */
async function safeParse(
  pack: LanguagePack,
  file: DiscoveredFile,
  content: string,
  options: PackOptions,
  diagnostics: Diagnostic[],
): Promise<PackResult | null> {
  let raw: unknown;
  try {
    raw = await pack.parse(file.repo, file.path, content, options);
  } catch (e) {
    diagnostics.push(
      coreDiagnostic(
        "pack_exception",
        `pack "${pack.manifest.id}" threw while parsing ${file.repo}:${file.path}: ${errorText(e)}`,
        { repo: file.repo, path: file.path, pack: pack.manifest.id },
      ),
    );
    return null;
  }
  const parsed = PackResultSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push(
      coreDiagnostic(
        "invalid_pack_result",
        `pack "${pack.manifest.id}" returned a malformed result for ${file.repo}:${file.path}: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        { repo: file.repo, path: file.path, pack: pack.manifest.id },
      ),
    );
    return null;
  }
  return parsed.data;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Compose — the pack-level cross-file pass. Never cached: this function takes
// the in-memory stage-3 output and returns additions; there is no cache type
// it could write to and it receives none.
// ---------------------------------------------------------------------------

/** What a pack's patch added, after enforcement. Still pack-facing: `pack_data` is stripped by `mergeNodes` and the corpus assembly. */
export interface PackAdditions {
  readonly pack: string;
  readonly nodes: readonly PackNode[];
  readonly edges: readonly PartialEdge[];
  readonly schemas: readonly PayloadSchema[];
  readonly provides: readonly Provide[];
}

export interface ComposeOutput {
  /** The per-file results with accepted `node_updates` applied. */
  readonly files: readonly PerFileResult[];
  readonly additions: readonly PackAdditions[];
  readonly diagnostics: readonly Diagnostic[];
}

export function composePacks(
  stage3: Stage3Output,
  registry: PackRegistry,
  config: WaterslideConfig,
): ComposeOutput {
  const diagnostics: Diagnostic[] = [];
  const additions: PackAdditions[] = [];
  let files: PerFileResult[] = stage3.files.map(cloneFile);

  for (const pack of registry.packs) {
    if (pack.compose === undefined) continue;
    const mine = files.filter((f) => registry.packFor(f.path) === pack);
    // Already sorted by (repo, path): parseFiles preserves discovery order,
    // which discover() sorts. Re-sorting here keeps the guarantee even when a
    // caller hands parseFiles an unsorted list.
    mine.sort(
      (a, b) => byteCompare(a.repo, b.repo) || byteCompare(a.path, b.path),
    );
    const options = resolvePackOptions(config, pack.manifest.id);
    let raw: unknown;
    try {
      raw = pack.compose(mine, options);
    } catch (e) {
      diagnostics.push(
        coreDiagnostic(
          "pack_exception",
          `pack "${pack.manifest.id}" threw in compose: ${errorText(e)}`,
          { pack: pack.manifest.id },
        ),
      );
      continue;
    }
    const parsed = PackPatchSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.push(
        coreDiagnostic(
          "invalid_pack_patch",
          `pack "${pack.manifest.id}" returned a malformed patch: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
          { pack: pack.manifest.id },
        ),
      );
      continue;
    }
    const applied = applyPatch(files, parsed.data, pack.manifest.id);
    files = applied.files;
    additions.push(applied.additions);
    diagnostics.push(...parsed.data.diagnostics, ...applied.diagnostics);
  }
  return { files, additions, diagnostics };
}

function cloneFile(f: PerFileResult): PerFileResult {
  return {
    repo: f.repo,
    path: f.path,
    result: { ...f.result, nodes: f.result.nodes.map((n) => ({ ...n })) },
    pack_data: f.pack_data,
  };
}

export interface AppliedPatch {
  readonly files: PerFileResult[];
  readonly additions: PackAdditions;
  readonly diagnostics: Diagnostic[];
}

/**
 * Enforces the patch capability table (parser §3.3). A patch MAY add nodes,
 * edges, schemas and provides, add spans to a node, set `parent`, and annotate
 * label, entry-point fields and tags. It MAY NOT change a node id — there is
 * no field for it — or remove or replace a node. Anything outside the table is
 * dropped with a `rejected_pack_patch` diagnostic; the rest of the patch is
 * kept.
 */
export function applyPatch(
  files: readonly PerFileResult[],
  patch: PackPatch,
  packId: string,
): AppliedPatch {
  const diagnostics: Diagnostic[] = [];
  const reject = (what: string): void => {
    diagnostics.push({
      severity: "error",
      code: "rejected_pack_patch",
      message: `pack "${packId}" compose patch rejected: ${what}`,
      repo: null,
      path: null,
      line: null,
      pack: packId,
    });
  };

  const out = files.map(cloneFile);
  const located = new Map<string, PackNode>();
  for (const f of out) for (const n of f.result.nodes) located.set(n.id, n);

  const addedNodes: PackNode[] = [];
  for (const node of patch.nodes) {
    if (located.has(node.id)) {
      reject(
        `adds node "${node.id}", which already exists; a patch may not replace a node`,
      );
      continue;
    }
    const copy = { ...node };
    located.set(copy.id, copy);
    addedNodes.push(copy);
  }

  for (const update of patch.node_updates) {
    const target = located.get(update.node_id);
    if (target === undefined) {
      reject(`updates node "${update.node_id}", which does not exist`);
      continue;
    }
    const problem = checkUpdate(update, located);
    if (problem !== null) {
      reject(`update to "${update.node_id}" ${problem}`);
      continue;
    }
    applyUpdate(target, update);
  }

  return {
    files: out,
    additions: {
      pack: packId,
      nodes: addedNodes,
      edges: patch.edges,
      schemas: patch.schemas,
      provides: patch.provides,
    },
    diagnostics,
  };
}

function checkUpdate(
  update: NodeUpdate,
  located: ReadonlyMap<string, PackNode>,
): string | null {
  if (update.parent !== undefined && update.parent !== null) {
    if (!located.has(update.parent))
      return `sets parent to "${update.parent}", which does not exist`;
    if (update.parent === update.node_id)
      return `makes the node its own parent`;
  }
  const target = located.get(update.node_id);
  const entry = update.is_entry_point ?? target?.is_entry_point ?? false;
  const kind =
    update.entry_point_kind !== undefined
      ? update.entry_point_kind
      : (target?.entry_point_kind ?? null);
  if (entry && kind === null)
    return `marks it an entry point without an entry_point_kind (invariant 7)`;
  if (
    update.tags !== undefined &&
    new Set(update.tags).size !== update.tags.length
  )
    return `sets duplicate tags (invariant 23)`;
  return null;
}

function applyUpdate(target: PackNode, update: NodeUpdate): void {
  if (update.add_sources.length > 0) {
    target.sources = dedupeSpans([...target.sources, ...update.add_sources]);
  }
  if (update.parent !== undefined) target.parent = update.parent;
  if (update.label !== undefined) target.label = update.label;
  if (update.is_entry_point !== undefined)
    target.is_entry_point = update.is_entry_point;
  if (update.entry_point_kind !== undefined)
    target.entry_point_kind = update.entry_point_kind;
  if (update.tags !== undefined) target.tags = [...update.tags];
}

function dedupeSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const sorted = [...spans].sort(spanCompare);
  return sorted.filter(
    (s, i) => i === 0 || spanCompare(sorted[i - 1] as SourceSpan, s) !== 0,
  );
}

// ---------------------------------------------------------------------------
// Merge — one node list from many files.
// ---------------------------------------------------------------------------

/**
 * Two files may emit the same node id — a definition split across files
 * whose pack has no compose pass yet. Spans are unioned; every other field
 * comes from the first file in (repo, path) order, and a difference is
 * reported once per node so it is visible rather than silently resolved.
 *
 * This runs after compose, so it is also where `pack_data` leaves: every node
 * is stripped on the way in (parser §3.3). Nothing downstream sees the key.
 */
export function mergeNodes(
  files: readonly PerFileResult[],
  additions: readonly PackAdditions[],
): { nodes: Node[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map<string, { node: Node; origin: string }>();
  const consider = (packNode: PackNode, origin: string): void => {
    const node = stripNodePackData(packNode);
    const prior = byId.get(node.id);
    if (prior === undefined) {
      byId.set(node.id, { node, origin });
      return;
    }
    const merged = prior.node;
    merged.sources = dedupeSpans([...merged.sources, ...node.sources]);
    const { sources: _a, ...restPrior } = prior.node;
    const { sources: _b, ...restNew } = node;
    if (canonicalJson(restPrior) !== canonicalJson(restNew)) {
      diagnostics.push({
        severity: "warning",
        code: "node_definition_conflict",
        message: `node "${node.id}" is emitted by ${prior.origin} and ${origin} with differing fields; spans were merged and ${prior.origin}'s fields kept`,
        repo: null,
        path: null,
        line: null,
        pack: null,
      });
    }
  };
  for (const f of files)
    for (const n of f.result.nodes) consider(n, `${f.repo}:${f.path}`);
  for (const a of additions)
    for (const n of a.nodes) consider(n, `pack ${a.pack} compose`);
  const nodes = [...byId.values()]
    .map((v) => v.node)
    .sort((a, b) => byteCompare(a.id, b.id));
  return { nodes, diagnostics };
}

/**
 * One schema list from many files. Graph model §4 makes schema ids unique, and
 * a Pydantic model imported by several files is legitimately emitted by each:
 * identical definitions collapse to one, a differing definition under the same
 * id keeps the first (in (repo, path) order) and is reported once.
 */
export function mergeSchemas(
  files: readonly PerFileResult[],
  additions: readonly PackAdditions[],
): { schemas: PayloadSchema[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map<string, { schema: PayloadSchema; origin: string }>();
  const consider = (schema: PayloadSchema, origin: string): void => {
    const prior = byId.get(schema.id);
    if (prior === undefined) {
      byId.set(schema.id, { schema, origin });
      return;
    }
    if (canonicalJson(prior.schema) !== canonicalJson(schema)) {
      diagnostics.push({
        severity: "warning",
        code: "schema_definition_conflict",
        message: `schema "${schema.id}" is emitted by ${prior.origin} and ${origin} with differing fields; ${prior.origin}'s definition kept`,
        repo: null,
        path: null,
        line: null,
        pack: null,
      });
    }
  };
  for (const f of files)
    for (const s of f.result.schemas) consider(s, `${f.repo}:${f.path}`);
  for (const a of additions)
    for (const s of a.schemas) consider(s, `pack ${a.pack} compose`);
  const schemas = [...byId.values()]
    .map((v) => v.schema)
    .sort((a, b) => byteCompare(a.id, b.id));
  return { schemas, diagnostics };
}
