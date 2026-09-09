import {
  spanHash,
  type Node as GraphNode,
  type UnresolvedRef,
} from "@waterslide/core";
import type { Emitter } from "../emitter.js";
import { lineStart, stringLiteral } from "../tree-sitter/runtime.js";
import {
  annotationChain,
  moduleVariableAlias,
  qualify,
  resolveTypeChain,
} from "./analyze.js";
import type { CallSite, Definition, DictTable, FileModel } from "./model.js";

/**
 * Language emission — the part of the pack that knows Python and nothing else.
 * `emitStructure` runs before the framework recognizers (nodes and provides they
 * annotate); `emitCalls` runs after them, turning every call site no recognizer
 * claimed into a `call` edge or a diagnostic.
 */
export function emitStructure(model: FileModel, em: Emitter): void {
  const { file } = model;
  const moduleLabel =
    file.module !== ""
      ? file.module
      : (file.path.split("/").pop() ?? file.path);

  em.addNode({
    id: em.moduleId,
    kind: "module",
    label: moduleLabel,
    tier: em.defaultTier("module"),
    parent: null,
    sources: [
      {
        repo: file.repo,
        path: file.path,
        line_start: 1,
        line_end: file.lineCount,
        hash: spanHash(file.content),
      },
    ],
    confidence: "certain",
    confidence_reason: null,
    is_entry_point: false,
    entry_point_kind: null,
    is_infrastructure: false,
    tags: [],
  });
  if (file.module !== "") {
    em.addProvide({
      ref_kind: "symbol",
      name: file.module,
      node_id: em.moduleId,
      alias_of: null,
      visibility: "public",
      scope: "global",
      scope_path: null,
    });
  }

  for (const def of model.definitions) {
    const id = em.nodeIdFor(def);
    const node: GraphNode = {
      id,
      kind: def.kind,
      label: def.qualifiedName,
      tier: em.defaultTier(def.kind),
      parent: def.parent ? em.nodeIdFor(def.parent) : em.moduleId,
      sources: [em.span(def.outer)],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    };
    em.addNode(node);
    em.addProvide({
      ref_kind: "symbol",
      name: qualify(file, def.qualifiedName),
      node_id: id,
      alias_of: null,
      visibility: visibilityOf(def),
      scope: "global",
      scope_path: null,
    });
  }

  // Every imported binding is a file-scoped alias (parser §3.4): the bare or
  // renamed name is valid only in this file and stands for the qualified target.
  for (const imp of model.imports) {
    if (imp.local === imp.qualified) continue;
    em.addProvide({
      ref_kind: "symbol",
      name: imp.local,
      node_id: null,
      alias_of: imp.qualified,
      visibility: "public",
      scope: "file",
      scope_path: file.path,
    });
  }

  // Re-exports (decision item 3): every module-level import is importable from
  // this module under its local name — `from .oauth2 import get_current_user`
  // in auth/__init__.py makes `auth.get_current_user` valid — so each one is a
  // global alias, and a two-hop chain resolves in stage 4.
  if (file.module !== "") {
    for (const imp of model.imports) {
      if (!imp.moduleLevel) continue; // a deferred import inside a def is not importable from the module
      if (imp.form === "import" && imp.local === imp.qualified) continue;
      if (em.data.stdlibModules.has(imp.qualified.split(".")[0] as string))
        continue;
      em.addProvide({
        ref_kind: "symbol",
        name: `${file.module}.${imp.local}`,
        node_id: null,
        alias_of: imp.qualified,
        visibility: imp.local.startsWith("_") ? "module" : "public",
        scope: "global",
        scope_path: null,
      });
    }
    emitModuleGetattr(model, em);
  }

  // A module-level variable is importable by name; when it holds a constructor
  // result (`db = Database()`) or a call result (`logger = logging.getLogger()`)
  // it forwards to that type or call, so `from db import db` then `db.connect()`
  // can reach `db.database.Database.connect` in stage 4.
  if (file.module !== "") {
    for (const [name, binding] of model.moduleScope.bindings) {
      if (binding.kind !== "variable" || !binding.value) continue;
      const target = moduleVariableAlias(
        binding.value,
        file,
        model.moduleScope,
        em.data,
      );
      if (!target) continue;
      em.addProvide({
        ref_kind: "symbol",
        name: `${file.module}.${name}`,
        node_id: null,
        alias_of: target,
        visibility: name.startsWith("_") ? "module" : "public",
        scope: "global",
        scope_path: null,
      });
    }
  }

  // A function with a return annotation names what its call returns:
  // `services.get_s3_service()` → `services.s3_service.S3Service`. Callers in
  // other files reference `services.get_s3_service().upload_bytes`; a
  // prefix-aware stage 4 can join the two (proposal, see the 2026-09-08 report).
  for (const def of model.definitions) {
    if (def.kind !== "function" || def.returnType === null) continue;
    const chain = annotationChain(def.returnType);
    const target = chain
      ? resolveTypeChain(chain, model.moduleScope, file)
      : null;
    // A stdlib or builtin return type (`-> Any`, `-> dict`) names nothing on the map.
    if (!target || em.data.stdlibModules.has(target.split(".")[0] as string))
      continue;
    em.addProvide({
      ref_kind: "symbol",
      name: `${qualify(file, def.qualifiedName)}()`,
      node_id: null,
      alias_of: target,
      visibility: visibilityOf(def),
      scope: "global",
      scope_path: null,
    });
  }

  for (const u of model.unsupported) em.unsupported(u.what, u.line);
}

/**
 * PEP 562: a module `__getattr__` that maps names to submodules through a
 * literal dict (tapistree's `_ROUTER_MODULES`). The attribute fetched from the
 * submodule is read from a `getattr(import_module(...), "<attr>")` literal in
 * the body. Anything less literal is diagnosed, never guessed.
 */
function emitModuleGetattr(model: FileModel, em: Emitter): void {
  const getattr = model.definitions.find(
    (d) =>
      d.kind === "function" && d.parent === null && d.name === "__getattr__",
  );
  if (!getattr) return;
  const line = lineStart(getattr.node);
  const body = getattr.node.childForFieldName("body")?.text ?? "";
  const attr =
    /getattr\(\s*import_module\([^)]*\)\s*,\s*["']([A-Za-z_]\w*)["']\s*\)/.exec(
      body,
    )?.[1] ?? null;
  // The map is the dict the body indexes (`_ROUTER_MODULES.get(name)` or
  // `_ROUTER_MODULES[name]`), not any string dict that happens to be in the file.
  const indexed = [...body.matchAll(/\b([A-Za-z_]\w*)\s*(?:\[|\.get\s*\()/g)]
    .map((m) => m[1] as string)
    .filter((name) => model.dictTables.has(name));
  const tables = indexed
    .map((name) => model.dictTables.get(name) as DictTable)
    .filter(
      (t) =>
        t.entries !== null &&
        t.entries.length > 0 &&
        t.entries.every((e) => stringLiteral(e.valueNode) !== null),
    );
  if (tables.length === 0) {
    em.unsupported(
      "module __getattr__ re-exports names through a mapping that is not a literal dict of strings; the names it exposes cannot be resolved",
      line,
    );
    return;
  }
  for (const table of tables) {
    for (const entry of table.entries ?? []) {
      const submodule = stringLiteral(entry.valueNode) as string;
      const target = `${model.file.module}.${submodule}${attr ? `.${attr}` : ""}`;
      em.addProvide({
        ref_kind: "symbol",
        name: `${model.file.module}.${entry.key}`,
        node_id: null,
        alias_of: target,
        visibility: "public",
        scope: "global",
        scope_path: null,
      });
    }
  }
}

function visibilityOf(def: Definition): "public" | "module" {
  const leaf = def.name;
  const isDunder = leaf.startsWith("__") && leaf.endsWith("__");
  const parentPrivate = def.parent ? def.parent.name.startsWith("_") : false;
  return (leaf.startsWith("_") && !isDunder) || parentPrivate
    ? "module"
    : "public";
}

export function emitCalls(model: FileModel, em: Emitter): void {
  for (const site of model.callSites) {
    if (em.isClaimed(site)) continue;
    emitCall(model, em, site);
  }
}

function labelFor(site: CallSite): string {
  if (site.chain && site.chain.length > 0)
    return site.chain[site.chain.length - 1] as string;
  return site.calleeNode.text;
}

function emitCall(model: FileModel, em: Emitter, site: CallSite): void {
  const callee = site.callee;
  switch (callee.kind) {
    case "in_file":
      em.edgeFromSite(site, {
        to: em.nodeIdFor(callee.def),
        kind: "call",
        label: callee.def.name,
        confidence: "certain",
        confidence_reason: null,
      });
      return;
    case "symbol": {
      const segments = callee.value.split(".");
      const rootModule = segments[0] as string;
      if (em.data.stdlibModules.has(rootModule)) return; // the standard library is not on the map
      if (isNoise(segments, callee.rest.length, em)) return; // data/noise.json; silent by design
      const ref: UnresolvedRef = {
        ref_kind: "symbol",
        value: callee.value,
        hints: { arity: site.arity, receiver_type: callee.root.qualified },
        source_line: site.line,
      };
      em.edgeFromSite(site, {
        to: ref,
        kind: "call",
        // The real name, never one file's alias for it (parser §3.5).
        label: callee.value.split(".").pop() ?? labelFor(site),
        confidence: callee.uncertainty ? "inferred" : "certain",
        confidence_reason: callee.uncertainty,
      });
      return;
    }
    case "unbound": {
      const ref: UnresolvedRef = {
        ref_kind: "symbol",
        value: callee.value,
        hints: { arity: site.arity, receiver_type: null },
        source_line: site.line,
      };
      em.edgeFromSite(site, {
        to: ref,
        kind: "call",
        label: callee.value,
        confidence: "inferred",
        confidence_reason: `bare name ${callee.value} is not bound in this file; only a file-scoped provide can match it`,
      });
      return;
    }
    case "builtin":
    case "local":
    case "builtin_value":
      return;
    case "opaque":
      em.diag(
        "info",
        "untyped_receiver",
        `call ${site.calleeNode.text}(...) skipped: ${callee.reason}`,
        site.line,
      );
      return;
    case "dynamic":
      em.diag(
        "info",
        "dynamic_call",
        `call through ${callee.text} skipped: callee is not a name or attribute chain`,
        site.line,
      );
      return;
    case "dispatch":
      emitDispatch(model, em, site);
      return;
  }
}

/**
 * A10 item 1: calls that exist but tell a reader nothing, from data/noise.json.
 * Reached only for references the resolver could not bind to an in-file node.
 */
function isNoise(
  segments: readonly string[],
  restLength: number,
  em: Emitter,
): boolean {
  const { libraryModules, valueMethods, modelMethods } = em.data.noise;
  const root = (segments[0] as string).replace(/\(\)$/, "");
  if (libraryModules.has(root)) return true;
  const last = (segments[segments.length - 1] as string).replace(/\(\)$/, "");
  // A builtin-value method needs receiver evidence beyond its name: the call
  // sits on an attribute of a typed value (`request.name.strip()`), or on the
  // result of a call that is itself a builtin-value producer (`model.dict()`,
  // `text.strip()`). A method called directly on an imported name
  // (`formatter.format(report)`) or on an untyped call result
  // (`opaque().format(x)`) may be a domain method and keeps its edge.
  const producers = segments
    .slice(0, -1)
    .filter((x) => x.endsWith("()"))
    .map((x) => x.slice(0, -2));
  const throughValue =
    restLength >= 2 ||
    producers.some((p) => modelMethods.has(p) || valueMethods.has(p));
  if (valueMethods.has(last) && throughValue) return true;
  const receiver =
    segments.length >= 2 ? (segments[segments.length - 2] as string) : "";
  return modelMethods.has(last) && /^[A-Z]/.test(receiver);
}

/** Parser §6.4: a literal handler map is a fork with one alternative per key. */
function emitDispatch(model: FileModel, em: Emitter, site: CallSite): void {
  if (site.callee.kind !== "dispatch") return;
  const { table } = site.callee;
  if (table.entries === null) {
    em.unsupported(
      `dispatch through ${table.name}[...] skipped: the table has non-literal keys or values`,
      site.line,
    );
    return;
  }
  const scope = model.scopeFor(site.owner);
  const owner = site.owner;
  const group = `${model.file.path}:${owner ? owner.qualifiedName : "<module>"}:L${String(site.line)}:dispatch`;
  table.entries.forEach((entry, ordinal) => {
    const branch = {
      group,
      ordinal,
      expr: JSON.stringify(entry.key),
      conditionLine: site.line,
    };
    if (!entry.valueChain) {
      em.unsupported(
        `dispatch key ${JSON.stringify(entry.key)} in ${table.name} maps to a non-name value`,
        table.line,
      );
      return;
    }
    const target = model.resolveChain(entry.valueChain, scope, owner);
    if (target.kind === "in_file") {
      em.edgeWithFixedBranch(
        site.call,
        owner,
        {
          to: em.nodeIdFor(target.def),
          kind: "call",
          label: target.def.name,
          confidence: "certain",
          confidence_reason: null,
        },
        branch,
      );
    } else if (target.kind === "symbol") {
      em.edgeWithFixedBranch(
        site.call,
        owner,
        {
          to: {
            ref_kind: "symbol",
            value: target.value,
            hints: { arity: site.arity, receiver_type: target.root.qualified },
            source_line: site.line,
          },
          kind: "call",
          label: entry.valueChain[entry.valueChain.length - 1] as string,
          confidence: target.uncertainty ? "inferred" : "certain",
          confidence_reason: target.uncertainty,
        },
        branch,
      );
    } else {
      em.unsupported(
        `dispatch key ${JSON.stringify(entry.key)} in ${table.name} maps to ${entry.valueChain.join(".")}, which does not resolve`,
        table.line,
      );
    }
  });
}
