import type { Node } from "web-tree-sitter";
import type { PackData } from "../data.js";
import {
  attributeChain,
  lineEnd,
  lineStart,
  positionalArguments,
  stringLiteral,
  unwrapExpression,
  type Runtime,
} from "../tree-sitter/runtime.js";
import type {
  AttributeInfo,
  Binding,
  Callee,
  CallSite,
  ClassInfo,
  Definition,
  DictTable,
  FileContext,
  FileModel,
  ImportRecord,
  RootInfo,
  Scope,
  ValueInfo,
} from "./model.js";
import { resolveRelativeModule } from "./module-name.js";

/**
 * Language recognition (parser §3.5, inside the boundary): import tables and
 * aliases, definitions, local scope, `self` and class context. Everything here
 * is derivable from this one file. Nothing here knows what a route is.
 */
export function analyzeFile(
  runtime: Runtime,
  file: FileContext,
  root: Node,
  data: PackData,
): FileModel {
  const unsupported: { line: number; what: string }[] = [];
  const moduleScope: Scope = { bindings: new Map(), parent: null };

  // --- Imports -------------------------------------------------------------
  const imports = collectImports(runtime, file, root, moduleScope, unsupported);

  // --- Definitions ---------------------------------------------------------
  const { definitions, classes, defByNode } = collectDefinitions(runtime, root);
  for (const def of definitions) {
    if (def.parent === null) {
      moduleScope.bindings.set(def.name, { kind: "definition", def });
    }
  }

  // --- Module-level assignments and dict tables ----------------------------
  const dictTables = collectDictTables(runtime, root);

  const functionScopes = new Map<Definition, Scope>();
  const scopeFor = (def: Definition | null): Scope => {
    if (def === null) return moduleScope;
    let s = functionScopes.get(def);
    if (!s) {
      s = buildFunctionScope(def, moduleScope);
      functionScopes.set(def, s);
    }
    return s;
  };

  const resolveChain = (
    chain: readonly string[],
    scope: Scope,
    owner: Definition | null,
  ): Callee =>
    resolveChainImpl(chain, scope, owner, file, classes, data, dictTables);
  const resolveCallResult = (
    receiverCall: Node,
    attrs: readonly string[],
    scope: Scope,
    owner: Definition | null,
  ): Callee =>
    resolveCallResultImpl(
      receiverCall,
      attrs,
      scope,
      owner,
      file,
      classes,
      data,
      resolveChain,
    );

  // Module-level `name = <call>` bindings, so `router = APIRouter()` and
  // `db = Database()` carry a receiver type. Two passes: imports/defs are
  // already bound, so constructor callees can resolve.
  bindBlockNames(root, moduleScope, null, resolveChain);

  // Class attributes: `self.x = ...` in methods, `x: T` in the class body.
  for (const info of classes.values()) {
    collectClassAttributes(info, scopeFor, resolveChain);
  }

  // --- Call sites ----------------------------------------------------------
  const callSites = collectCallSites(
    runtime,
    root,
    defByNode,
    dictTables,
    scopeFor,
    resolveChain,
    resolveCallResult,
  );

  return {
    file,
    root,
    moduleScope,
    definitions,
    classes,
    imports,
    dictTables,
    callSites,
    unsupported,
    scopeFor,
    resolveChain,
    resolveCallResult,
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function collectImports(
  runtime: Runtime,
  file: FileContext,
  root: Node,
  scope: Scope,
  unsupported: { line: number; what: string }[],
): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const match of runtime.queries.get("imports").matches(root)) {
    const cap = match.captures[0];
    if (!cap) continue;
    const stmt = cap.node;
    const line = lineStart(stmt);
    if (stmt.type === "import_statement") {
      for (const item of stmt.namedChildren) {
        if (item.type === "dotted_name") {
          // `import a.b.c` binds `a` → `a`.
          const qualified = item.text;
          const local = qualified.split(".")[0] as string;
          scope.bindings.set(local, {
            kind: "module_import",
            qualified: local,
            line,
          });
          records.push({ local, qualified: local, form: "import", line });
        } else if (item.type === "aliased_import") {
          const name = item.childForFieldName("name");
          const alias = item.childForFieldName("alias");
          if (!name || !alias) continue;
          scope.bindings.set(alias.text, {
            kind: "module_import",
            qualified: name.text,
            line,
          });
          records.push({
            local: alias.text,
            qualified: name.text,
            form: "import",
            line,
          });
        }
      }
    } else if (stmt.type === "import_from_statement") {
      const moduleNode = stmt.childForFieldName("module_name");
      if (!moduleNode) continue;
      let moduleName: string | null;
      if (moduleNode.type === "relative_import") {
        const prefix = moduleNode.namedChildren.find(
          (c) => c.type === "import_prefix",
        );
        const dotted = moduleNode.namedChildren.find(
          (c) => c.type === "dotted_name",
        );
        const level = prefix ? prefix.text.length : 0;
        moduleName = resolveRelativeModule(
          file.package,
          level,
          dotted?.text ?? "",
        );
        if (moduleName === null) {
          unsupported.push({
            line,
            what: `relative import beyond the top-level package: ${stmt.text}`,
          });
          continue;
        }
      } else {
        moduleName = moduleNode.text;
      }
      const names = stmt.childrenForFieldName("name");
      if (stmt.namedChildren.some((c) => c.type === "wildcard_import")) {
        unsupported.push({
          line,
          what: `star import from ${moduleName}: bare names from it cannot be resolved`,
        });
        continue;
      }
      for (const item of names) {
        if (item.type === "dotted_name") {
          const qualified = joinModule(moduleName, item.text);
          scope.bindings.set(item.text, {
            kind: "name_import",
            qualified,
            line,
          });
          records.push({ local: item.text, qualified, form: "from", line });
        } else if (item.type === "aliased_import") {
          const name = item.childForFieldName("name");
          const alias = item.childForFieldName("alias");
          if (!name || !alias) continue;
          const qualified = joinModule(moduleName, name.text);
          scope.bindings.set(alias.text, {
            kind: "name_import",
            qualified,
            line,
          });
          records.push({ local: alias.text, qualified, form: "from", line });
        }
      }
    }
  }
  return records;
}

function joinModule(moduleName: string, name: string): string {
  return moduleName === "" ? name : `${moduleName}.${name}`;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function decoratorsOf(outer: Node): Node[] {
  if (outer.type !== "decorated_definition") return [];
  return outer.namedChildren
    .filter((c) => c.type === "decorator")
    .map((d) => d.namedChildren[0])
    .filter((n): n is Node => n !== undefined);
}

function collectDefinitions(
  runtime: Runtime,
  root: Node,
): {
  definitions: Definition[];
  classes: Map<string, ClassInfo>;
  defByNode: Map<number, Definition>;
} {
  const definitions: Definition[] = [];
  const classes = new Map<string, ClassInfo>();
  const defByNode = new Map<number, Definition>();
  const classByNode = new Map<number, Definition>();

  const matches = runtime.queries.get("definitions").matches(root);
  // Classes first so methods can find their parent regardless of match order.
  const pending: { outer: Node; capture: string }[] = [];
  for (const m of matches) {
    const cap = m.captures[0];
    if (!cap) continue;
    pending.push({ outer: cap.node, capture: cap.name });
  }
  pending.sort((a, b) => a.outer.startIndex - b.outer.startIndex);

  for (const { outer, capture } of pending) {
    const inner =
      outer.type === "decorated_definition"
        ? outer.childForFieldName("definition")
        : outer;
    if (!inner) continue;
    const nameNode = inner.childForFieldName("name");
    if (!nameNode) continue;
    const name = nameNode.text;
    if (capture === "class") {
      const def: Definition = {
        kind: "class",
        name,
        qualifiedName: name,
        node: inner,
        outer,
        decorators: decoratorsOf(outer),
        parent: null,
        isAsync: false,
        returnType: null,
      };
      definitions.push(def);
      defByNode.set(inner.id, def);
      classByNode.set(inner.id, def);
      const supers = inner.childForFieldName("superclasses");
      const bases = supers
        ? positionalArguments(supers)
            .map((b) =>
              attributeChain(
                b.type === "subscript"
                  ? (b.childForFieldName("value") ?? b)
                  : b,
              ),
            )
            .filter((c): c is string[] => c !== null)
        : [];
      classes.set(name, {
        def,
        methods: new Map(),
        attributes: new Map(),
        bases,
      });
    } else if (capture === "function") {
      const def: Definition = {
        kind: "function",
        name,
        qualifiedName: name,
        node: inner,
        outer,
        decorators: decoratorsOf(outer),
        parent: null,
        isAsync: inner.children.some((c) => c.type === "async"),
        returnType: typeText(inner.childForFieldName("return_type")),
      };
      definitions.push(def);
      defByNode.set(inner.id, def);
    } else if (capture === "method") {
      // parent chain: function_definition → [decorated_definition] → block → class_definition
      let classNode = outer.parent;
      while (classNode && classNode.type !== "class_definition")
        classNode = classNode.parent;
      const classDef = classNode ? classByNode.get(classNode.id) : undefined;
      if (!classDef) continue; // nested class inside a function: folded away
      const def: Definition = {
        kind: "function",
        name,
        qualifiedName: `${classDef.name}.${name}`,
        node: inner,
        outer,
        decorators: decoratorsOf(outer),
        parent: classDef,
        isAsync: inner.children.some((c) => c.type === "async"),
        returnType: typeText(inner.childForFieldName("return_type")),
      };
      definitions.push(def);
      defByNode.set(inner.id, def);
      classes.get(classDef.name)?.methods.set(name, def);
    }
  }
  return { definitions, classes, defByNode };
}

// ---------------------------------------------------------------------------
// Dict tables (dispatch, PEP 562 maps)
// ---------------------------------------------------------------------------

function collectDictTables(
  runtime: Runtime,
  root: Node,
): Map<string, DictTable> {
  const tables = new Map<string, DictTable>();
  for (const m of runtime.queries.get("dict-literals").matches(root)) {
    const name = m.captures.find((c) => c.name === "name")?.node;
    const dict = m.captures.find((c) => c.name === "dict")?.node;
    if (!name || !dict) continue;
    const entries: {
      key: string;
      valueChain: readonly string[] | null;
      valueNode: Node;
    }[] = [];
    let literal = true;
    for (const pair of dict.namedChildren) {
      if (pair.type === "comment") continue;
      if (pair.type !== "pair") {
        literal = false;
        break;
      }
      const key = stringLiteral(pair.childForFieldName("key"));
      const valueNode = pair.childForFieldName("value");
      if (key === null || !valueNode) {
        literal = false;
        break;
      }
      entries.push({ key, valueChain: attributeChain(valueNode), valueNode });
    }
    tables.set(name.text, {
      name: name.text,
      node: dict,
      line: lineStart(dict),
      entries: literal ? entries : null,
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

function typeText(node: Node | null): string | null {
  return node ? node.text : null;
}

function bindAssignment(
  assignment: Node,
  scope: Scope,
  owner: Definition | null,
  resolveChain: FileModel["resolveChain"],
): void {
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  if (!left) return;
  if (
    left.type === "pattern_list" ||
    left.type === "tuple_pattern" ||
    left.type === "list_pattern"
  ) {
    for (const id of identifiersIn(left))
      if (!scope.bindings.has(id))
        scope.bindings.set(id, {
          kind: "loop_or_context",
          line: lineStart(assignment),
        });
    return;
  }
  if (left.type !== "identifier") return;
  if (scope.bindings.get(left.text)?.kind === "definition") return; // a def wins over a later rebinding
  const annotation = typeText(assignment.childForFieldName("type"));
  const value = right ? valueInfoOf(right, scope, owner, resolveChain) : null;
  // First binding wins: the type at first assignment is the one to trust.
  const existing = scope.bindings.get(left.text);
  // First resolved binding wins. A name-only pass (dynamic callee) or a
  // non-call value never blocks the later pass that can resolve the constructor.
  if (
    existing &&
    existing.kind === "variable" &&
    existing.value !== null &&
    existing.value.callee.kind !== "dynamic"
  )
    return;
  scope.bindings.set(left.text, {
    kind: "variable",
    value,
    annotation,
    line: lineStart(assignment),
  });
}

function valueInfoOf(
  right: Node,
  scope: Scope,
  owner: Definition | null,
  resolveChain: FileModel["resolveChain"],
): ValueInfo | null {
  const expr = unwrapExpression(right);
  if (expr.type !== "call") return null;
  const fn = expr.childForFieldName("function");
  if (!fn) return null;
  const chain = attributeChain(fn);
  if (!chain) return null;
  return { call: expr, callee: resolveChain(chain, scope, owner), chain };
}

function buildFunctionScope(def: Definition, moduleScope: Scope): Scope {
  const scope: Scope = { bindings: new Map(), parent: moduleScope };
  const params = def.node.childForFieldName("parameters");
  if (params) {
    for (const p of params.namedChildren) {
      const { name, annotation } = parameterName(p);
      if (name) scope.bindings.set(name, { kind: "parameter", annotation });
    }
  }
  const body = def.node.childForFieldName("body");
  // Names only; `x = Call(...)` receiver types are bound in bindFunctionLocals
  // once the scope exists for resolution.
  if (body)
    bindBlockNames(body, scope, def, () => ({ kind: "dynamic", text: "" }));
  return scope;
}

/**
 * Bind every name a block assigns without entering nested definitions:
 * `x = ...` (with a receiver type when the value is a constructor call), `for x
 * in`, `with ... as x`, `except ... as x`, comprehension variables and lambda
 * parameters. Used for the module scope and, per function, for locals.
 */
function bindBlockNames(
  block: Node,
  scope: Scope,
  owner: Definition | null,
  resolveChain: FileModel["resolveChain"],
): void {
  const visit = (n: Node): void => {
    if (n.type === "function_definition" || n.type === "class_definition") {
      if (n.id !== block.id) {
        // Nested def or class: bind its name, fold its body into the owner.
        // Its parameters and locals are bound here too, because calls in its
        // body are attributed to the owner and resolved in this scope.
        const nested = n.childForFieldName("name");
        if (nested && !scope.bindings.has(nested.text))
          scope.bindings.set(nested.text, {
            kind: "nested_definition",
            line: lineStart(n),
          });
        const params = n.childForFieldName("parameters");
        for (const p of params?.namedChildren ?? []) {
          const { name } = parameterName(p);
          if (name && !scope.bindings.has(name))
            scope.bindings.set(name, {
              kind: "loop_or_context",
              line: lineStart(n),
            });
        }
        const nestedBody = n.childForFieldName("body");
        if (nestedBody) for (const c of nestedBody.namedChildren) visit(c);
        return;
      }
    }
    if (n.type === "assignment") bindAssignment(n, scope, owner, resolveChain);
    else if (n.type === "for_statement" || n.type === "for_in_clause") {
      const left = n.childForFieldName("left");
      if (left)
        for (const id of identifiersIn(left))
          if (!scope.bindings.has(id))
            scope.bindings.set(id, {
              kind: "loop_or_context",
              line: lineStart(n),
            });
    } else if (n.type === "as_pattern") {
      const alias = n.childForFieldName("alias");
      if (alias)
        for (const id of identifiersIn(alias))
          if (!scope.bindings.has(id))
            scope.bindings.set(id, {
              kind: "loop_or_context",
              line: lineStart(n),
            });
    } else if (n.type === "lambda") {
      const params = n.childForFieldName("parameters");
      for (const p of params?.namedChildren ?? []) {
        const { name } = parameterName(p);
        if (name && !scope.bindings.has(name))
          scope.bindings.set(name, {
            kind: "loop_or_context",
            line: lineStart(n),
          });
      }
    } else if (n.type === "named_expression") {
      const name = n.childForFieldName("name");
      if (name && !scope.bindings.has(name.text))
        scope.bindings.set(name.text, {
          kind: "loop_or_context",
          line: lineStart(n),
        });
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(block);
}

/** Second pass for a function scope: bind `x = Call(...)` locals with the scope available for resolution. */
function bindFunctionLocals(
  def: Definition,
  scope: Scope,
  resolveChain: FileModel["resolveChain"],
): void {
  const body = def.node.childForFieldName("body");
  if (body) bindBlockNames(body, scope, def, resolveChain);
}

function parameterName(p: Node): {
  name: string | null;
  annotation: string | null;
} {
  switch (p.type) {
    case "identifier":
      return { name: p.text, annotation: null };
    case "typed_parameter": {
      const id = p.namedChildren.find((c) => c.type === "identifier");
      return {
        name: id?.text ?? null,
        annotation: typeText(p.childForFieldName("type")),
      };
    }
    case "default_parameter":
      return {
        name: p.childForFieldName("name")?.text ?? null,
        annotation: null,
      };
    case "typed_default_parameter":
      return {
        name: p.childForFieldName("name")?.text ?? null,
        annotation: typeText(p.childForFieldName("type")),
      };
    case "list_splat_pattern":
    case "dictionary_splat_pattern": {
      const id = p.namedChildren.find((c) => c.type === "identifier");
      return { name: id?.text ?? null, annotation: null };
    }
    default:
      return { name: null, annotation: null };
  }
}

function identifiersIn(node: Node): string[] {
  if (node.type === "identifier") return [node.text];
  const out: string[] = [];
  for (const c of node.namedChildren) out.push(...identifiersIn(c));
  return out;
}

function lookup(scope: Scope, name: string): Binding | null {
  let s: Scope | null = scope;
  while (s) {
    const b = s.bindings.get(name);
    if (b) return b;
    s = s.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Class attributes
// ---------------------------------------------------------------------------

function collectClassAttributes(
  info: ClassInfo,
  scopeFor: FileModel["scopeFor"],
  resolveChain: FileModel["resolveChain"],
): void {
  const body = info.def.node.childForFieldName("body");
  if (body) {
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "expression_statement") continue;
      const a = stmt.namedChildren[0];
      if (!a || a.type !== "assignment") continue;
      const left = a.childForFieldName("left");
      const type = a.childForFieldName("type");
      if (!left || left.type !== "identifier" || !type) continue;
      if (!info.attributes.has(left.text)) {
        info.attributes.set(left.text, {
          name: left.text,
          annotation: type.text,
          value: null,
          literal: false,
          line: lineStart(a),
        });
      }
    }
  }
  // `self.<attr> = value` inside methods, `__init__` first because it runs first.
  const methods = [...info.methods.values()].sort((a, b) =>
    a.name === "__init__"
      ? -1
      : b.name === "__init__"
        ? 1
        : a.node.startIndex - b.node.startIndex,
  );
  for (const method of methods) {
    const params = method.node.childForFieldName("parameters");
    const selfName = params?.namedChildren[0]
      ? parameterName(params.namedChildren[0]).name
      : null;
    if (!selfName) continue;
    const scope = scopeFor(method);
    bindFunctionLocals(method, scope, resolveChain);
    const body = method.node.childForFieldName("body");
    if (!body) continue;
    const visit = (n: Node): void => {
      if (n.type === "function_definition" || n.type === "lambda") return;
      if (n.type === "assignment") {
        const left = n.childForFieldName("left");
        if (left && left.type === "attribute") {
          const chain = attributeChain(left);
          if (chain && chain.length === 2 && chain[0] === selfName) {
            const attr = chain[1] as string;
            const right = n.childForFieldName("right");
            const annotation = typeText(n.childForFieldName("type"));
            const value = right
              ? valueInfoOf(right, scope, method, resolveChain)
              : null;
            const existing = info.attributes.get(attr);
            const literalTypes = new Set([
              "dictionary",
              "list",
              "set",
              "tuple",
              "string",
              "integer",
              "float",
              "none",
              "true",
              "false",
              "concatenated_string",
              "list_comprehension",
              "dictionary_comprehension",
            ]);
            const record: AttributeInfo = {
              name: attr,
              annotation: annotation ?? existing?.annotation ?? null,
              value: value ?? existing?.value ?? null,
              literal:
                existing?.literal ??
                (right !== null &&
                  literalTypes.has(unwrapExpression(right).type)),
              line: existing?.line ?? lineStart(n),
            };
            info.attributes.set(attr, record);
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(body);
  }
}

// ---------------------------------------------------------------------------
// Chain resolution — the alias-killing step (parser §3.5)
// ---------------------------------------------------------------------------

function isTypeLike(callee: Callee): boolean {
  if (callee.kind === "in_file") return callee.def.kind === "class";
  if (callee.kind === "symbol") {
    const last =
      callee.rest.length > 0
        ? callee.rest[callee.rest.length - 1]
        : callee.value.split(".").pop();
    return last !== undefined && /^[A-Z]/.test(last);
  }
  return false;
}

/** The qualified name a value's constructor stands for, if the value is type-like. */
function receiverTypeOf(
  value: ValueInfo | null,
  file: FileContext,
  scope: Scope,
  stdlib: ReadonlySet<string>,
): string | null {
  if (!value) return null;
  if (value.callee.kind === "in_file") {
    const def = value.callee.def;
    if (def.kind === "class") return qualify(file, def.qualifiedName);
    // A factory defined in this file: its return annotation is the type.
    const chain = def.returnType ? annotationChain(def.returnType) : null;
    return chain
      ? nonStdlib(resolveTypeChain(chain, scope, file), stdlib)
      : null;
  }
  if (value.callee.kind === "symbol")
    return isTypeLike(value.callee) ? value.callee.value : null;
  return null;
}

/** `typing.Any`, `datetime.datetime`: the standard library is not a receiver type the map can follow. */
function nonStdlib(
  qualified: string | null,
  stdlib: ReadonlySet<string>,
): string | null {
  return qualified !== null && stdlib.has(qualified.split(".")[0] as string)
    ? null
    : qualified;
}

export function qualify(file: FileContext, qualifiedName: string): string {
  return file.module === "" ? qualifiedName : `${file.module}.${qualifiedName}`;
}

function resolveChainImpl(
  chain: readonly string[],
  scope: Scope,
  owner: Definition | null,
  file: FileContext,
  classes: Map<string, ClassInfo>,
  data: PackData,
  dictTables: Map<string, DictTable>,
): Callee {
  const rootName = chain[0];
  if (rootName === undefined) return { kind: "dynamic", text: "" };
  const rest = chain.slice(1);
  const binding = lookup(scope, rootName);

  // `self.x` inside a method: class context.
  if (
    binding &&
    binding.kind === "parameter" &&
    owner &&
    owner.parent &&
    isFirstParameter(owner, rootName)
  ) {
    const info = classes.get(owner.parent.name);
    const attr = rest[0];
    if (info && attr !== undefined) {
      const method = info.methods.get(attr);
      if (method && rest.length === 1) return { kind: "in_file", def: method };
      const attribute = info.attributes.get(attr);
      const tail = rest.slice(1);
      const root: RootInfo = {
        name: `${rootName}.${attr}`,
        binding,
        qualified: null,
        constructor: attribute?.value ?? null,
        annotation: attribute?.annotation ?? null,
        via: method ? "self_method" : "self_attribute",
      };
      if (method) {
        return {
          kind: "symbol",
          value: [qualify(file, method.qualifiedName), ...tail].join("."),
          root: { ...root, qualified: qualify(file, method.qualifiedName) },
          rest: tail,
          uncertainty: null,
        };
      }
      const traced = receiverTypeOf(
        attribute?.value ?? null,
        file,
        scope,
        data.stdlibModules,
      );
      if (traced) {
        return {
          kind: "symbol",
          value: [traced, ...tail].join("."),
          root: { ...root, qualified: traced },
          rest: tail,
          uncertainty: null,
        };
      }
      if (attribute?.annotation) {
        const typeChain = annotationChain(attribute.annotation);
        const resolvedType = typeChain
          ? resolveTypeChain(typeChain, scope, file)
          : null;
        if (resolvedType) {
          return {
            kind: "symbol",
            value: [resolvedType, ...tail].join("."),
            root: { ...root, qualified: resolvedType },
            rest: tail,
            uncertainty: null,
          };
        }
      }
      if (attribute?.literal) {
        return {
          kind: "opaque",
          reason: `receiver ${rootName}.${attr} is assigned a literal in ${owner.parent.qualifiedName}; a builtin container, not a node`,
          root,
        };
      }
      // Cheap version of parser §10's open question: name the attribute, mark inferred.
      const value = [
        qualify(file, owner.parent.qualifiedName),
        attr,
        ...tail,
      ].join(".");
      return {
        kind: "symbol",
        value,
        root,
        rest: tail,
        uncertainty: `receiver ${rootName}.${attr} has no annotation or constructor assignment in ${owner.parent.qualifiedName}; target named by attribute`,
      };
    }
  }

  if (binding === null) {
    if (rest.length === 0 && data.builtins.has(rootName))
      return { kind: "builtin", name: rootName };
    const root: RootInfo = {
      name: rootName,
      binding: null,
      qualified: null,
      constructor: null,
      annotation: null,
      via: "unbound",
    };
    if (rest.length === 0) return { kind: "unbound", value: rootName, root };
    return {
      kind: "symbol",
      value: chain.join("."),
      root,
      rest,
      uncertainty: `name ${rootName} is not bound in this file`,
    };
  }

  switch (binding.kind) {
    case "module_import": {
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: binding.qualified,
        constructor: null,
        annotation: null,
        via: "module_import",
      };
      return {
        kind: "symbol",
        value: [binding.qualified, ...rest].join("."),
        root,
        rest,
        uncertainty: null,
      };
    }
    case "name_import": {
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: binding.qualified,
        constructor: null,
        annotation: null,
        via: "name_import",
      };
      return {
        kind: "symbol",
        value: [binding.qualified, ...rest].join("."),
        root,
        rest,
        uncertainty: null,
      };
    }
    case "definition": {
      const def = binding.def;
      if (rest.length === 0) return { kind: "in_file", def };
      const info = classes.get(def.name);
      const method =
        rest.length === 1 && def.kind === "class"
          ? info?.methods.get(rest[0] as string)
          : undefined;
      if (method) return { kind: "in_file", def: method };
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: qualify(file, def.qualifiedName),
        constructor: null,
        annotation: null,
        via: "definition",
      };
      return {
        kind: "symbol",
        value: [qualify(file, def.qualifiedName), ...rest].join("."),
        root,
        rest,
        uncertainty: null,
      };
    }
    case "variable": {
      const traced = receiverTypeOf(
        binding.value,
        file,
        scope,
        data.stdlibModules,
      );
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: traced,
        constructor: binding.value,
        annotation: binding.annotation,
        via: "variable",
      };
      if (traced) {
        if (binding.value?.callee.kind === "in_file" && rest.length === 1) {
          const method = classes
            .get(binding.value.callee.def.name)
            ?.methods.get(rest[0] as string);
          if (method) return { kind: "in_file", def: method };
        }
        return {
          kind: "symbol",
          value: [traced, ...rest].join("."),
          root,
          rest,
          uncertainty: null,
        };
      }
      if (binding.annotation) {
        const typeChain = annotationChain(binding.annotation);
        const resolvedType = typeChain
          ? resolveTypeChain(typeChain, scope, file)
          : null;
        if (resolvedType)
          return {
            kind: "symbol",
            value: [resolvedType, ...rest].join("."),
            root: { ...root, qualified: resolvedType },
            rest,
            uncertainty: null,
          };
      }
      const factory = binding.value
        ? calleeQualified(binding.value.callee, file)
        : null;
      if (factory !== null && rest.length > 0) {
        return callResultSymbol(factory, rest, root, rootName);
      }
      return {
        kind: "opaque",
        reason: binding.value
          ? `receiver ${rootName} is the result of a call, not a traceable type`
          : `receiver ${rootName} is a local with no traceable type`,
        root,
      };
    }
    case "parameter": {
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: null,
        constructor: null,
        annotation: binding.annotation,
        via: "parameter",
      };
      if (binding.annotation && rest.length > 0) {
        const typeChain = annotationChain(binding.annotation);
        const resolvedType = typeChain
          ? resolveTypeChain(typeChain, scope, file)
          : null;
        if (resolvedType)
          return {
            kind: "symbol",
            value: [resolvedType, ...rest].join("."),
            root: { ...root, qualified: resolvedType },
            rest,
            uncertainty: null,
          };
      }
      return {
        kind: "opaque",
        reason: `receiver ${rootName} is a parameter${binding.annotation ? ` annotated ${binding.annotation}, which does not resolve in this file` : " with no annotation"}`,
        root,
      };
    }
    case "nested_definition":
      return { kind: "local", name: rootName };
    case "loop_or_context": {
      const root: RootInfo = {
        name: rootName,
        binding,
        qualified: null,
        constructor: null,
        annotation: null,
        via: "variable",
      };
      return {
        kind: "opaque",
        reason: `receiver ${rootName} is a loop or context variable`,
        root,
      };
    }
  }
}

/** The qualified name of a callee, for naming what a call returned. */
function calleeQualified(callee: Callee, file: FileContext): string | null {
  if (callee.kind === "in_file") return qualify(file, callee.def.qualifiedName);
  if (callee.kind === "symbol") return callee.value;
  return null;
}

/**
 * `x = get_service(); x.run()` where the factory's return type is not visible
 * here: the reference is named `get_service().run` — the resolved-as-far-as-
 * possible form (parser §3.6). The defining file emits a `get_service()` alias
 * to the return type, so a prefix-aware stage 4 can close the gap.
 */
function callResultSymbol(
  factory: string,
  rest: readonly string[],
  root: RootInfo,
  receiverText: string,
): Callee {
  return {
    kind: "symbol",
    value: [`${factory}()`, ...rest].join("."),
    root,
    rest,
    uncertainty: `receiver ${receiverText} is the result of ${factory}(); its return type is not visible in this file`,
  };
}

function resolveCallResultImpl(
  receiverCall: Node,
  attrs: readonly string[],
  scope: Scope,
  owner: Definition | null,
  file: FileContext,
  classes: Map<string, ClassInfo>,
  data: PackData,
  resolveChain: FileModel["resolveChain"],
): Callee {
  const fn = receiverCall.childForFieldName("function");
  const chain = fn ? attributeChain(fn) : null;
  if (!chain || attrs.length === 0)
    return { kind: "dynamic", text: receiverCall.text };
  const inner = resolveChain(chain, scope, owner);
  const value: ValueInfo = { call: receiverCall, callee: inner, chain };
  const traced = receiverTypeOf(value, file, scope, data.stdlibModules);
  const root: RootInfo = {
    name: `${chain.join(".")}()`,
    binding: null,
    qualified: traced,
    constructor: value,
    annotation: null,
    via: "variable",
  };
  if (traced) {
    const local = [...classes.values()].find(
      (c) => qualify(file, c.def.qualifiedName) === traced,
    );
    const method =
      local && attrs.length === 1
        ? local.methods.get(attrs[0] as string)
        : undefined;
    if (method) return { kind: "in_file", def: method };
    return {
      kind: "symbol",
      value: [traced, ...attrs].join("."),
      root,
      rest: attrs,
      uncertainty: null,
    };
  }
  const factory = calleeQualified(inner, file);
  if (factory === null) return { kind: "dynamic", text: receiverCall.text };
  return callResultSymbol(factory, attrs, root, `${chain.join(".")}()`);
}

function isFirstParameter(def: Definition, name: string): boolean {
  const params = def.node.childForFieldName("parameters");
  const first = params?.namedChildren[0];
  return first !== undefined && parameterName(first).name === name;
}

/** `Optional[Foo]`, `list[Foo]`, `Foo | None`, `"Foo"` → ["Foo"]; `a.Foo` → ["a","Foo"]. */
export function annotationChain(annotation: string): string[] | null {
  let t = annotation.trim().replace(/^["']|["']$/g, "");
  for (;;) {
    // Only wrappers that leave the value's own type visible are unwrapped;
    // `list[X]` is a list, not an X, so it yields no receiver type.
    const m = /^(Optional|Annotated|Type|type)\[(.*)\]$/s.exec(t);
    if (!m) break;
    t = (m[2] as string).split(",")[0]?.trim() ?? "";
  }
  if (
    /^(List|list|Sequence|Iterable|Set|set|Dict|dict|Tuple|tuple|FrozenSet|frozenset|Mapping|deque|Awaitable|Coroutine)\[/.test(
      t,
    )
  )
    return null;
  t = t.replace(/\s*\|\s*None$/, "").replace(/^None\s*\|\s*/, "");
  return /^[A-Za-z_][\w.]*$/.test(t) ? t.split(".") : null;
}

export function resolveTypeChain(
  chain: string[],
  scope: Scope,
  file: FileContext,
): string | null {
  const b = lookup(scope, chain[0] as string);
  if (!b) return null;
  if (b.kind === "module_import" || b.kind === "name_import")
    return [b.qualified, ...chain.slice(1)].join(".");
  if (b.kind === "definition")
    return [qualify(file, b.def.qualifiedName), ...chain.slice(1)].join(".");
  return null;
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

function collectCallSites(
  runtime: Runtime,
  root: Node,
  defByNode: Map<number, Definition>,
  dictTables: Map<string, DictTable>,
  scopeFor: FileModel["scopeFor"],
  resolveChain: FileModel["resolveChain"],
  resolveCallResult: FileModel["resolveCallResult"],
): CallSite[] {
  const sites: CallSite[] = [];
  const boundFunctions = new Set<Definition>();
  for (const m of runtime.queries.get("calls").matches(root)) {
    const call = m.captures.find((c) => c.name === "call")?.node;
    const calleeNode = m.captures.find((c) => c.name === "callee")?.node;
    const argumentList = m.captures.find((c) => c.name === "arguments")?.node;
    if (!call || !calleeNode || !argumentList) continue;

    const placement = classify(call, defByNode);
    if (placement.kind === "skip") continue;
    const owner = placement.owner;
    const scope = scopeFor(owner);
    if (owner && !boundFunctions.has(owner)) {
      boundFunctions.add(owner);
      bindFunctionLocals(owner, scope, resolveChain);
    }

    const chain = attributeChain(calleeNode);
    let callee: Callee;
    if (chain) {
      callee = resolveChain(chain, scope, owner);
    } else if (calleeNode.type === "subscript") {
      const value = calleeNode.childForFieldName("value");
      const table =
        value && value.type === "identifier"
          ? dictTables.get(value.text)
          : undefined;
      if (table) callee = { kind: "dispatch", table };
      else if (
        value &&
        value.type === "identifier" &&
        lookup(scope, value.text)?.kind === "variable"
      )
        // A module or local variable indexed and called: a dispatch table the pack cannot read.
        callee = {
          kind: "dispatch",
          table: {
            name: value.text,
            node: value,
            line: lineStart(value),
            entries: null,
          },
        };
      else callee = { kind: "dynamic", text: calleeNode.text };
    } else if (calleeNode.type === "call") {
      // `table.get(key)(...)` over a literal dict is also a dispatch.
      const innerFn = calleeNode.childForFieldName("function");
      const innerChain = innerFn ? attributeChain(innerFn) : null;
      const table =
        innerChain && innerChain.length === 2 && innerChain[1] === "get"
          ? dictTables.get(innerChain[0] as string)
          : undefined;
      callee = table
        ? { kind: "dispatch", table }
        : { kind: "dynamic", text: calleeNode.text };
    } else if (calleeNode.type === "attribute") {
      // `get_service().run(...)`: attributes hanging off a call result.
      const attrs: string[] = [];
      let n: Node = calleeNode;
      while (n.type === "attribute") {
        const attr = n.childForFieldName("attribute");
        const object = n.childForFieldName("object");
        if (!attr || !object) break;
        attrs.unshift(attr.text);
        n = unwrapExpression(object);
      }
      callee =
        n.type === "call"
          ? resolveCallResult(n, attrs, scope, owner)
          : { kind: "dynamic", text: calleeNode.text };
    } else {
      callee = { kind: "dynamic", text: calleeNode.text };
    }

    sites.push({
      call,
      calleeNode,
      argumentList,
      chain,
      callee,
      owner,
      line: lineStart(call),
      lineEnd: lineEnd(call),
      arity: argumentList.namedChildren.filter((a) => a.type !== "comment")
        .length,
    });
  }
  return sites;
}

type Placement = { kind: "skip" } | { kind: "site"; owner: Definition | null };

/**
 * Decide whether a call is a call *site* (executed as plumbing) and who owns it.
 * Decorators and parameter defaults are declarations, not calls the map should
 * draw; class-body statements are import-time configuration. Nested functions
 * fold into the enclosing definition.
 */
function classify(call: Node, defByNode: Map<number, Definition>): Placement {
  let n: Node | null = call.parent;
  let owner: Definition | null = null;
  while (n) {
    if (n.type === "decorator" || n.type === "parameters" || n.type === "type")
      return { kind: "skip" };
    // `raise X(...)`: constructing the exception is the end of a path, not a call the map draws.
    if (n.type === "raise_statement") return { kind: "skip" };
    if (n.type === "function_definition") {
      const def = defByNode.get(n.id);
      if (def) {
        owner = def;
        break;
      }
      // nested def: keep walking to the enclosing definition
    } else if (n.type === "class_definition") {
      // class-body level statement (or a nested class): import-time configuration, not plumbing
      return { kind: "skip" };
    } else if (n.type === "module") {
      break;
    }
    n = n.parent;
  }
  return { kind: "site", owner };
}
