import {
  GRAPH_SCHEMA_VERSION,
  type LanguagePack,
  type PackManifest,
  type PackOptions,
  type PackPatch,
  type PackResult,
  type PerFileResult,
} from "@waterslide/core";
import { loadPackData, type PackData } from "./data.js";
import { diagnostic, PACK_ID } from "./diagnostics.js";
import { Emitter } from "./emitter.js";
import { externalRecognizer } from "./frameworks/external.js";
import { composeFastApi } from "./frameworks/fastapi/compose.js";
import { fastapiRecognizer } from "./frameworks/fastapi/index.js";
import { awsLambdaRecognizer } from "./frameworks/aws-lambda.js";
import { mongoRecognizer } from "./frameworks/mongo.js";
import { pydanticRecognizer } from "./frameworks/pydantic.js";
import type { FrameworkRecognizer } from "./frameworks/types.js";
import { analyzeFile } from "./language/analyze.js";
import { emitCalls, emitStructure } from "./language/emit.js";
import type { FileContext } from "./language/model.js";
import { moduleNameForPath } from "./language/module-name.js";
import {
  PythonPackOptionsSchema,
  type PythonPackOptions,
  type PythonPackOptionsInput,
} from "./options.js";
import {
  createRuntime,
  firstErrorNode,
  lineStart,
  parseSource,
  resetPythonLanguage,
  type Runtime,
} from "./tree-sitter/runtime.js";
import type { Node } from "web-tree-sitter";

export {
  PythonPackOptionsSchema,
  type PythonPackOptions,
  type PythonPackOptionsInput,
} from "./options.js";
export {
  formatUnresolved,
  summarizeUnresolved,
  type UnresolvedSummary,
} from "./report.js";

export const manifest: PackManifest = {
  id: PACK_ID,
  version: "0.1.0",
  graph_schema_version: GRAPH_SCHEMA_VERSION,
  extensions: [".py"],
  frameworks: ["fastapi", "aws_lambda"],
};

/**
 * Framework recognizers, in run order. Language recognition is not in this
 * list — it is what they run *after*. Adding Django is one more entry.
 */
const RECOGNIZERS: readonly FrameworkRecognizer[] = [
  pydanticRecognizer,
  fastapiRecognizer,
  awsLambdaRecognizer,
  mongoRecognizer,
  externalRecognizer,
];

/**
 * The pack as tests drive it: `LanguagePack` with a synchronous `parse`
 * (the tree-sitter runtime is already loaded) and the optional members
 * present. Options arrive per call and are validated against
 * `PythonPackOptionsSchema`; nothing is held as instance state.
 */
export interface PythonPack extends LanguagePack {
  parse(
    repo_name: string,
    path: string,
    content: string,
    options?: PackOptions,
  ): PackResult;
  compose(results: readonly PerFileResult[], options?: PackOptions): PackPatch;
}

/** Load the tree-sitter runtime and build a pack. Tests use this directly; core uses `pack`. */
export async function createPythonPack(): Promise<PythonPack> {
  const runtime = await createRuntime();
  const data = loadPackData();
  return {
    manifest,
    parse: (repo, path, content, options = {}) => {
      const opts = tryResolveOptions(options);
      if (!opts.ok) return optionsFailure({ repo, path }, opts.error);
      return parseFile(runtime, data, opts.value, repo, path, content);
    },
    compose: (results, options = {}) => {
      const opts = tryResolveOptions(options);
      if (!opts.ok)
        return composeFailure(`invalid packs.python options: ${opts.error}`);
      return compose(results, opts.value);
    },
  };
}

/**
 * Core applies defaults before every call; this only narrows the record to our
 * shape. A malformed block is a diagnostic, never a throw (parser §9).
 */
function tryResolveOptions(
  options: PackOptions,
): { ok: true; value: PythonPackOptions } | { ok: false; error: string } {
  const parsed = PythonPackOptionsSchema.safeParse(options);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.message };
}

function optionsFailure(
  site: { repo: string; path: string },
  error: string,
): PackResult {
  const result = EMPTY();
  result.diagnostics.push(
    diagnostic(
      site,
      "error",
      "pack_failure",
      `invalid packs.python options: ${error}; nothing emitted from this file`,
      null,
    ),
  );
  return result;
}

function composeFailure(message: string): PackPatch {
  return {
    nodes: [],
    edges: [],
    schemas: [],
    provides: [],
    node_updates: [],
    diagnostics: [
      {
        severity: "error",
        code: "recognizer_failure",
        message,
        repo: null,
        path: null,
        line: null,
        pack: PACK_ID,
      },
    ],
  };
}

/**
 * The module's named `pack` export (parser §3.3). `parse` is asynchronous only
 * because the tree-sitter runtime loads on first use; `compose` is synchronous.
 * `rePath` is deliberately absent: core's re-parse fallback applies, because a
 * moved file's payload embeds its old module name in relative-import targets and
 * PEP 562 aliases that cannot be told apart from absolute names after the fact.
 */
let defaultPack: Promise<PythonPack> | null = null;
const lazy = (): Promise<PythonPack> => (defaultPack ??= createPythonPack());
export const pack: LanguagePack = {
  manifest,
  parse: async (repo, path, content, options) => {
    let ready: PythonPack;
    try {
      ready = await lazy();
    } catch (error) {
      // Parser §9 applies to initialisation too: a missing wasm or a malformed
      // data file is a diagnostic on this file, and the next call retries.
      defaultPack = null;
      resetPythonLanguage();
      const result = EMPTY();
      result.diagnostics.push(
        diagnostic(
          { repo, path },
          "error",
          "pack_failure",
          `python pack failed to initialise: ${errorMessage(error)}; nothing emitted from it`,
          null,
        ),
      );
      return result;
    }
    return ready.parse(repo, path, content, options);
  },
  compose: (results, options) => {
    const opts = tryResolveOptions(options);
    if (!opts.ok)
      return composeFailure(`invalid packs.python options: ${opts.error}`);
    return compose(results, opts.value);
  },
};

const EMPTY = (): PackResult => ({
  nodes: [],
  edges: [],
  schemas: [],
  provides: [],
  diagnostics: [],
});

/** Parser §9: a pack never throws. Every failure becomes a diagnostic. */
function parseFile(
  runtime: Runtime,
  data: PackData,
  options: PythonPackOptions,
  repo: string,
  path: string,
  content: string,
): PackResult {
  const site = { repo, path };
  try {
    const { module, package: pkg } = moduleNameForPath(
      path,
      options.source_roots,
    );
    const file: FileContext = {
      repo,
      path,
      content,
      module,
      package: pkg,
      lineCount:
        content === "" ? 1 : content.replace(/\n$/, "").split("\n").length,
    };
    const tree = parseSource(runtime, content);
    try {
      return parseTree(tree.rootNode, runtime, data, file, site);
    } finally {
      tree.delete(); // the Tree owns wasm memory; nothing below keeps a Node
    }
  } catch (error) {
    const result = EMPTY();
    result.diagnostics.push(
      diagnostic(
        site,
        "error",
        "pack_failure",
        `python pack failed on this file: ${errorMessage(error)}; nothing emitted from it`,
        null,
      ),
    );
    return result;
  }
}

function parseTree(
  root: Node,
  runtime: Runtime,
  data: PackData,
  file: FileContext,
  site: { repo: string; path: string },
): PackResult {
  {
    if (root.hasError) {
      const at = firstErrorNode(root);
      const result = EMPTY();
      result.diagnostics.push(
        diagnostic(
          site,
          "error",
          "syntax_error",
          `file could not be parsed${at ? ` (${at.isMissing ? "missing " + at.type : "unexpected input"} at line ${String(lineStart(at))})` : ""}; no nodes emitted from it`,
          at ? lineStart(at) : null,
        ),
      );
      return result;
    }

    const em = new Emitter(file, data);
    const model = analyzeFile(runtime, file, root, data);
    emitStructure(model, em);
    if (file.content.trim() === "") {
      em.diag(
        "info",
        "empty_file",
        "file is empty; only its module node is emitted",
        null,
      );
    }
    for (const recognizer of RECOGNIZERS) {
      try {
        recognizer.run(model, em);
      } catch (error) {
        em.diag(
          "error",
          "recognizer_failure",
          `${recognizer.id} recognizer failed on this file: ${errorMessage(error)}; language output kept`,
          null,
        );
      }
    }
    emitCalls(model, em);
    return em.finalize();
  }
}

function compose(
  results: readonly PerFileResult[],
  _options: PythonPackOptions,
): PackPatch {
  try {
    return composeFastApi(results);
  } catch (error) {
    return composeFailure(
      `fastapi compose failed: ${errorMessage(error)}; route paths are local, not composed`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
