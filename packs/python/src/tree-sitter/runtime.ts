import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";

const require = createRequire(import.meta.url);

/**
 * The pack's package root, found by walking up from this module. Works from
 * both `src/` (vitest) and `dist/src/` (built), which sit at different depths.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { name?: unknown }).name === "@waterslide/pack-python"
      ) {
        return dir;
      }
    }
    dir = dirname(dir);
  }
  throw new Error("pack-python: could not locate the package root");
}

let languagePromise: Promise<Language> | null = null;

/** Initialise web-tree-sitter once and load the Python grammar once. */
export function loadPythonLanguage(): Promise<Language> {
  languagePromise ??= (async () => {
    await Parser.init();
    const wasm = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
    return Language.load(wasm);
  })();
  return languagePromise;
}

/** Forget a failed load so the next `createRuntime` retries instead of replaying the rejection. */
export function resetPythonLanguage(): void {
  languagePromise = null;
}

export type QueryName =
  "imports" | "definitions" | "calls" | "assignments" | "dict-literals";

/**
 * Queries are read from `queries/*.scm` — never string literals in code
 * (handoff §2). Compiled once per language.
 */
export class Queries {
  private readonly compiled = new Map<QueryName, Query>();
  constructor(private readonly language: Language) {}

  get(name: QueryName): Query {
    let q = this.compiled.get(name);
    if (!q) {
      const source = readFileSync(
        join(packageRoot(), "queries", `${name}.scm`),
        "utf8",
      );
      q = new Query(this.language, source);
      this.compiled.set(name, q);
    }
    return q;
  }
}

export interface Runtime {
  readonly parser: Parser;
  readonly queries: Queries;
}

export async function createRuntime(): Promise<Runtime> {
  const language = await loadPythonLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  return { parser, queries: new Queries(language) };
}

/** Parse; `null` only if the parser has no language, which cannot happen here. */
export function parseSource(runtime: Runtime, content: string): Tree {
  const tree = runtime.parser.parse(content);
  if (tree === null) throw new Error("pack-python: parser returned no tree");
  return tree;
}

/** 1-based line of a node's first character. */
export function lineStart(node: Node): number {
  return node.startPosition.row + 1;
}

/** 1-based line of a node's last character. Never less than `lineStart`. */
export function lineEnd(node: Node): number {
  const end = node.endPosition;
  // A node whose end sits at column 0 ended with the previous line's newline.
  const row =
    end.column === 0 && end.row > node.startPosition.row
      ? end.row - 1
      : end.row;
  return Math.max(row + 1, lineStart(node));
}

/** The first ERROR or MISSING node in document order, for a syntax diagnostic. */
export function firstErrorNode(root: Node): Node | null {
  if (!root.hasError) return null;
  const stack: Node[] = [root];
  let best: Node | null = null;
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.isError || n.isMissing) {
      if (best === null || n.startIndex < best.startIndex) best = n;
      continue;
    }
    if (!n.hasError) continue;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return best;
}

/** Text of a Python string literal without its quotes, or null if not a plain literal. */
export function stringLiteral(node: Node | null): string | null {
  if (!node || node.type !== "string") return null;
  const parts = node.namedChildren.filter(
    (c) => c.type !== "string_start" && c.type !== "string_end",
  );
  if (parts.some((p) => p.type === "interpolation")) return null;
  return parts.map((p) => p.text).join("");
}

/** `name=value` arguments of a call's argument_list, in order. */
export function keywordArguments(argumentList: Node | null): Map<string, Node> {
  const out = new Map<string, Node>();
  if (!argumentList) return out;
  for (const arg of argumentList.namedChildren) {
    if (arg.type !== "keyword_argument") continue;
    const name = arg.childForFieldName("name");
    const value = arg.childForFieldName("value");
    if (name && value) out.set(name.text, value);
  }
  return out;
}

/** Positional arguments of a call's argument_list, in order. */
export function positionalArguments(argumentList: Node | null): Node[] {
  if (!argumentList) return [];
  return argumentList.namedChildren.filter(
    (a) =>
      a.type !== "keyword_argument" &&
      a.type !== "list_splat" &&
      a.type !== "dictionary_splat" &&
      a.type !== "comment",
  );
}

/** `a.b.c` → ["a","b","c"]; a bare identifier → [name]; anything else → null. */
export function attributeChain(node: Node): string[] | null {
  if (node.type === "identifier") return [node.text];
  if (node.type !== "attribute") return null;
  const object = node.childForFieldName("object");
  const attr = node.childForFieldName("attribute");
  if (!object || !attr) return null;
  const head = attributeChain(object);
  return head ? [...head, attr.text] : null;
}

/** Strips `await`, parentheses and `not`/unary wrappers to the expression underneath. */
export function unwrapExpression(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === "await" || n.type === "parenthesized_expression") {
      const inner = n.namedChildren[0];
      if (!inner) return n;
      n = inner;
      continue;
    }
    return n;
  }
}
