/**
 * tree-sitter plumbing for the Swift pack (handoff §2).
 *
 * web-tree-sitter loads the pinned grammar wasm from `grammar/`. Queries are
 * read from `queries/*.scm` and compiled once; they are never string literals
 * in code. Everything here is a process-wide singleton because the wasm
 * runtime is.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";

/**
 * Locate the pack root. `src/` (vitest) and `dist/src/` (built) sit at
 * different depths, so walk up until the package manifest is found rather
 * than hard-coding a relative path.
 */
export function packRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
      };
      if (pkg.name === "@waterslide/pack-swift") return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("swift pack: could not locate package root");
}

/** Resolved lazily so a missing package root surfaces inside analyzeFile's try, never at import. */
export function grammarWasmPath(): string {
  return join(packRoot(), "grammar", "tree-sitter-swift.wasm");
}

let languagePromise: Promise<Language> | null = null;
let parser: Parser | null = null;
const queryCache = new Map<string, Query>();

export async function swiftLanguage(): Promise<Language> {
  if (languagePromise === null) {
    languagePromise = (async () => {
      await Parser.init();
      return Language.load(grammarWasmPath());
    })();
  }
  return languagePromise;
}

async function swiftParser(): Promise<Parser> {
  if (parser === null) {
    const lang = await swiftLanguage();
    parser = new Parser();
    parser.setLanguage(lang);
  }
  return parser;
}

/** Compile a query from `queries/{name}.scm`, once. */
export async function query(name: string): Promise<Query> {
  const cached = queryCache.get(name);
  if (cached !== undefined) return cached;
  const lang = await swiftLanguage();
  const source = readFileSync(
    join(packRoot(), "queries", `${name}.scm`),
    "utf8",
  );
  const q = new Query(lang, source);
  queryCache.set(name, q);
  return q;
}

export interface ParseInfo {
  /** Number of `await` keywords masked for the recovery parse; 0 when the first parse was used. */
  masked_awaits: number;
}

function countErrors(root: Node): number {
  if (!root.hasError) return 0;
  let n = 0;
  const visit = (x: Node): void => {
    if (x.isError || x.isMissing) {
      n++;
      return;
    }
    if (!x.hasError) return;
    for (const c of x.children) if (c !== null) visit(c);
  };
  visit(root);
  return n;
}

const AWAIT = /\bawait\b/g;

/**
 * Parse `content` and hand the tree to `fn`. The tree is deleted afterwards:
 * wasm-side memory is not garbage collected.
 *
 * Grammar workaround (tree-sitter-swift 0.7.3): `await` inside an `if let` /
 * `while let` condition is a parse error, and error recovery flattens the
 * whole enclosing type. When the first parse has errors, the file is parsed
 * again with every `await` keyword blanked to spaces (same byte length, so
 * every offset, line and column is unchanged) and, if that parse has fewer
 * errors, the tree's text callback is pointed back at the ORIGINAL content:
 * node text, spans and hashes all come from the real source. The recovery is
 * reported to the caller so it can be surfaced as a diagnostic.
 */
export async function withTree<T>(
  content: string,
  fn: (root: Node, tree: Tree, info: ParseInfo) => T,
): Promise<T> {
  const p = await swiftParser();
  let tree = p.parse(content);
  if (tree === null) {
    throw new Error("swift pack: tree-sitter returned no tree");
  }
  let masked_awaits = 0;
  if (tree.rootNode.hasError) {
    const masked = content.replace(AWAIT, "     ");
    if (masked !== content) {
      const retry = p.parse(masked);
      if (retry !== null) {
        if (countErrors(retry.rootNode) < countErrors(tree.rootNode)) {
          tree.delete();
          tree = retry;
          masked_awaits = content.match(AWAIT)?.length ?? 0;
          // Same length, same offsets: read text from the original source.
          (
            tree as unknown as { textCallback: (index: number) => string }
          ).textCallback = (index: number) =>
            content.slice(index, index + 65536);
        } else {
          retry.delete();
        }
      }
    }
  }
  try {
    return fn(tree.rootNode, tree, { masked_awaits });
  } finally {
    tree.delete();
  }
}
