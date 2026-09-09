/**
 * Swift language recognizer: declarations (parser §7 "Types and functions",
 * "Import table", plus typealias and extensions per §3.5).
 *
 * Produces type and function nodes, the module node, provides, Codable
 * schemas, and the type/function facts compose needs. Same-file extensions
 * are merged here; cross-file extensions are recorded as facts for compose.
 */
import {
  DEFAULT_TIER_BY_KIND,
  type Field,
  type NodeKind,
  type PayloadSchema,
  type SourceSpan,
} from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import {
  diag,
  hasErrorInside,
  type FileContext,
  type Owner,
  type Param,
  type PropertyDecl,
  type TypeDecl,
} from "../context.js";
import { basename, codeId, schemaId, spanHash, visibilityOf } from "../ids.js";
import { isViewLike, receiverTypeName } from "../noise.js";
import type { FunctionFact, PropertyFact } from "../state.js";
import {
  TYPE_NODE_KINDS,
  anyChildrenOfType,
  childrenOfType,
  fieldChildren,
  firstChildOfType,
  isCapitalized,
  lineEnd,
  lineStart,
  typeRef,
  type TypeRef,
} from "../tree.js";

const DECLARATION_KEYWORDS = ["class", "struct", "enum", "actor", "extension"];
const CODABLE = new Set(["Codable", "Decodable", "Encodable"]);

/** A node's source span with core's span hash. */
export function span(ctx: FileContext, n: Node): SourceSpan {
  return {
    repo: ctx.repo,
    path: ctx.path,
    line_start: lineStart(n),
    line_end: lineEnd(n),
    hash: spanHash(n.text),
  };
}

/** The modifier tokens on a declaration. */
function modifierTexts(decl: Node): string[] {
  const mods = firstChildOfType(decl, "modifiers");
  if (mods === null) return [];
  return mods.children.filter((c): c is Node => c !== null).map((c) => c.text);
}

/** The access-level modifier on a declaration, ignoring `private(set)`-style setter modifiers. */
export function visibilityModifier(decl: Node): string | null {
  const mods = firstChildOfType(decl, "modifiers");
  if (mods === null) return null;
  for (const c of childrenOfType(mods, "visibility_modifier")) {
    if (!c.text.includes("(")) return c.text;
  }
  return null;
}

/** Whether a declaration is `static` or `class`. */
function isStatic(decl: Node): boolean {
  return modifierTexts(decl).some((t) => t === "static" || t === "class");
}

/** Whether a declaration carries `@name`. */
function hasAttribute(decl: Node, name: string): boolean {
  const mods = firstChildOfType(decl, "modifiers");
  if (mods === null) return false;
  return childrenOfType(mods, "attribute").some(
    (a) => a.text === `@${name}` || a.text.startsWith(`@${name}(`),
  );
}

/** The inherited or adopted type names on a declaration. */
function conformancesOf(decl: Node): string[] {
  const out: string[] = [];
  for (const spec of childrenOfType(decl, "inheritance_specifier")) {
    const t =
      spec.childForFieldName("inherits_from") ?? spec.namedChildren[0] ?? null;
    if (t !== null) out.push(typeRef(t).base);
  }
  return out;
}

/** A function's return type, when written. */
function returnTypeOf(decl: Node): TypeRef | null {
  // Both the name and the return type sit under the `name` field; the return
  // type is the child whose node kind is a type.
  for (const c of fieldChildren(decl, "name")) {
    if (TYPE_NODE_KINDS.has(c.type)) return typeRef(c);
  }
  // A protocol requirement carries its return type as a bare direct child.
  const direct = decl.namedChildren.filter(
    (c): c is Node => c !== null && TYPE_NODE_KINDS.has(c.type),
  );
  const last = direct[direct.length - 1];
  return last === undefined ? null : typeRef(last);
}

/** A protocol requirement's name: the first identifier child, when there is no `name` field. */
function functionNameOf(decl: Node): string {
  return (
    decl.namedChildren.find(
      (c): c is Node => c !== null && c.type === "simple_identifier",
    )?.text ?? "<anonymous>"
  );
}

/** A function's parameters with their labels and types. */
function paramsOf(decl: Node): Param[] {
  const out: Param[] = [];
  for (const p of childrenOfType(decl, "parameter")) {
    const external = p.childForFieldName("external_name");
    const named = fieldChildren(p, "name");
    const idents = named.filter((c) => c.type === "simple_identifier");
    const types = named.filter((c) => TYPE_NODE_KINDS.has(c.type));
    const internal = idents[0]?.text ?? "_";
    const type = types[0] ?? null;
    // `_ name:` has no label; `label name:` has one; `name:` labels itself.
    const label =
      external !== null
        ? external.text === "_"
          ? null
          : external.text
        : internal;
    out.push({
      label,
      name: internal,
      type: type === null ? null : typeRef(type),
    });
  }
  return out;
}

function propertyDecls(decl: Node): PropertyDecl[] {
  const out: PropertyDecl[] = [];
  const annotation = firstChildOfType(decl, "type_annotation");
  const type = annotation === null ? null : typeRef(annotation);
  const init = decl.childForFieldName("value");
  const computed = decl.childForFieldName("computed_value");
  const staticProp = isStatic(decl);
  for (const pattern of fieldChildren(decl, "name")) {
    for (const id of pattern.descendantsOfType("simple_identifier")) {
      out.push({
        name: id.text,
        type,
        is_static: staticProp,
        is_stored: computed === null,
        init,
        decl,
      });
    }
  }
  return out;
}

function newType(
  ctx: FileContext,
  decl: Node,
  qualified: string,
  kind: TypeDecl["declaration_kind"],
  extensionTarget: string | null,
): TypeDecl {
  const conformances = conformancesOf(decl);
  return {
    qualified,
    node_id: codeId(ctx.repo, ctx.path, qualified),
    decl,
    body: decl.childForFieldName("body"),
    declaration_kind: kind,
    conformances,
    extension_target: extensionTarget,
    merged_into: null,
    properties: [],
    cases: [],
    members: new Map(),
    has_explicit_init: false,
    is_view: isViewLike(conformances),
    is_app: conformances.includes("App"),
    is_codable: conformances.some((c) => CODABLE.has(c)),
    fact: null,
    ext_fact: null,
  };
}

interface RawOwner {
  decl: Node;
  form: "function" | "init" | "computed" | "requirement" | "slot";
  member: string;
  type: TypeDecl | null;
  prefix: string;
}

function describeDeclaration(n: Node, prefix: string): string {
  if (n.type === "class_declaration" || n.type === "protocol_declaration") {
    const keyword =
      n.type === "protocol_declaration"
        ? "protocol"
        : (anyChildrenOfType(n, DECLARATION_KEYWORDS)[0]?.text ?? "class");
    return `${keyword} ${n.childForFieldName("name")?.text ?? "<anonymous>"}`;
  }
  if (n.type === "init_declaration")
    return `init of ${prefix === "" ? "<top level>" : prefix}`;
  if (n.type === "function_declaration") {
    const name = n.childForFieldName("name")?.text ?? "<anonymous>";
    return `func ${prefix === "" ? name : `${prefix}.${name}`}`;
  }
  if (n.type === "property_declaration") {
    const name =
      n.descendantsOfType("simple_identifier")[0]?.text ?? "<anonymous>";
    return `property ${prefix === "" ? name : `${prefix}.${name}`}`;
  }
  return n.type;
}

/**
 * §9 as corrected in review: a declaration containing a syntax error is
 * skipped and NAMED, so the drill-down says which type or function is missing
 * rather than which file is suspect. The rest of the file is emitted.
 */
function skipWithSyntaxError(
  ctx: FileContext,
  n: Node,
  prefix: string,
): boolean {
  if (!hasErrorInside(ctx, n)) return false;
  diag(
    ctx,
    "error",
    "syntax_error",
    `${describeDeclaration(n, prefix)} (lines ${String(lineStart(n))}-${String(lineEnd(n))}) contains a syntax error and was skipped; nothing inside it is emitted`,
    lineStart(n),
  );
  return true;
}

/**
 * tree-sitter's recovery for a header it cannot parse wraps the file in one
 * ERROR node and spills the type's members as top-level siblings. Those
 * members must not be emitted as free functions, and the loss must be named:
 * a view missing from a 196-entry-point map is invisible unless the count
 * says so (review decision 3).
 */
function reportFlattened(ctx: FileContext, err: Node): number {
  const kids = err.namedChildren.filter((c): c is Node => c !== null);
  const spilled = kids.filter((c) =>
    [
      "function_declaration",
      "init_declaration",
      "property_declaration",
    ].includes(c.type),
  );
  if (spilled.length === 0) return 0;
  const firstSpill = kids.find((c) =>
    [
      "inheritance_specifier",
      "function_declaration",
      "init_declaration",
      "property_declaration",
    ].includes(c.type),
  );
  const spillIndex = firstSpill === undefined ? -1 : kids.indexOf(firstSpill);
  const before = spillIndex > 0 ? kids[spillIndex - 1] : undefined;
  const typeName =
    before !== undefined && before.type === "simple_identifier"
      ? before.text
      : (kids.find((c) => c.type === "simple_identifier")?.text ?? null);
  const first = spilled[0];
  const last = spilled[spilled.length - 1];
  diag(
    ctx,
    "error",
    "syntax_error",
    `grammar recovery flattened a type declaration${typeName === null ? "" : ` (probably \`${typeName}\`)`} starting near line ${String(firstSpill === undefined ? lineStart(err) : lineStart(firstSpill))}: the type node and its ${String(spilled.length)} member declaration(s) (lines ${String(first === undefined ? 0 : lineStart(first))}-${String(last === undefined ? 0 : lineEnd(last))}) are not emitted; SwiftUI handlers inside it cannot be attributed to a type`,
    firstSpill === undefined ? lineStart(err) : lineStart(firstSpill),
  );
  return spilled.length;
}

/** First pass: find every declaration, tracking nesting for qualified names. */
export function collectDeclarations(ctx: FileContext): void {
  const raw: RawOwner[] = [];
  // Pre-count functions per (prefix, member) so a nested declaration inside an
  // overloaded function can be named after the disambiguated function.
  const overloadCounts = new Map<string, number>();
  const overloadSeen = new Map<string, number>();
  const disambiguated = new Map<number, string>();
  const precount = (n: Node, prefix: string): void => {
    if (n.type === "class_declaration" || n.type === "protocol_declaration") {
      const keyword =
        n.type === "protocol_declaration"
          ? "protocol"
          : (anyChildrenOfType(n, DECLARATION_KEYWORDS)[0]?.text ?? "class");
      const name = n.childForFieldName("name")?.text ?? "<anonymous>";
      const q =
        keyword === "extension"
          ? name
          : prefix === ""
            ? name
            : `${prefix}.${name}`;
      const body = n.childForFieldName("body");
      if (body !== null)
        for (const c of body.namedChildren) if (c !== null) precount(c, q);
      return;
    }
    if (
      n.type === "function_declaration" ||
      n.type === "protocol_function_declaration" ||
      n.type === "init_declaration"
    ) {
      const member =
        n.type === "init_declaration"
          ? "init"
          : (n.childForFieldName("name")?.text ?? functionNameOf(n));
      const key = `${prefix} ${member}`;
      overloadCounts.set(key, (overloadCounts.get(key) ?? 0) + 1);
      const body = n.childForFieldName("body");
      if (body !== null)
        precount(body, prefix === "" ? member : `${prefix}.${member}`);
      return;
    }
    if (n.type === "property_declaration") {
      const computed = n.childForFieldName("computed_value");
      const names = fieldChildren(n, "name").flatMap((p) =>
        p.descendantsOfType("simple_identifier").map((i) => i.text),
      );
      if (computed !== null && names.length === 1)
        precount(computed, `${prefix}.${names[0] ?? ""}`);
      return;
    }
    for (const c of n.namedChildren) if (c !== null) precount(c, prefix);
  };
  precount(ctx.root, "");
  /** The name a function is known by, decided at first sight using the pre-count. */
  const functionName = (n: Node, prefix: string, member: string): string => {
    const key = `${prefix} ${member}`;
    const base = prefix === "" ? member : `${prefix}.${member}`;
    if ((overloadCounts.get(key) ?? 0) <= 1) return base;
    const labels = paramsOf(n)
      .map((p) => `${p.label ?? "_"}:`)
      .join("");
    const labelled = `${base}(${labels})`;
    const k = overloadSeen.get(labelled) ?? 0;
    overloadSeen.set(labelled, k + 1);
    return `${labelled}[${String(k)}]`;
  };

  const collectMembers = (decl: Node, t: TypeDecl, qualified: string): void => {
    const body = decl.childForFieldName("body");
    if (body === null) return;
    for (const m of body.namedChildren) {
      if (m === null) continue;
      if (m.type === "enum_entry") {
        for (const c of m.namedChildren) {
          if (c !== null && c.type === "simple_identifier")
            t.cases.push(c.text);
        }
        continue;
      }
      if (m.type === "protocol_property_declaration") {
        const ann = firstChildOfType(m, "type_annotation");
        const type = ann === null ? null : typeRef(ann);
        const id = m.descendantsOfType("simple_identifier")[0];
        if (id !== undefined) {
          t.properties.push({
            name: id.text,
            type,
            is_static: isStatic(m),
            is_stored: false,
            init: null,
            decl: m,
          });
        }
        continue;
      }
      if (m.type === "property_declaration") {
        if (skipWithSyntaxError(ctx, m, qualified)) continue;
        const props = propertyDecls(m);
        t.properties.push(...props);
        const computed = m.childForFieldName("computed_value");
        const only = props[0];
        // A stored property of closure type is a callable slot: the call
        // `parent.onProjectorExit()` targets it, and whatever was injected
        // into it runs.
        if (
          computed === null &&
          props.length === 1 &&
          only !== undefined &&
          only.type?.is_function === true
        ) {
          raw.push({
            decl: m,
            form: "slot",
            member: only.name,
            type: t,
            prefix: qualified,
          });
          continue;
        }
        if (computed !== null && props.length === 1 && only !== undefined) {
          raw.push({
            decl: m,
            form: "computed",
            member: only.name,
            type: t,
            prefix: qualified,
          });
          walk(computed, `${qualified}.${only.name}`, null);
        }
        continue;
      }
      walk(m, qualified, t);
    }
  };

  const walk = (
    n: Node,
    prefix: string,
    type: TypeDecl | null,
    inError = false,
  ): void => {
    if (n.type === "ERROR") {
      reportFlattened(ctx, n);
      for (const c of n.namedChildren)
        if (c !== null) walk(c, prefix, type, true);
      return;
    }
    if (n.type === "class_declaration" || n.type === "protocol_declaration") {
      // An error inside one member skips that member, not the type (§9 as
      // corrected: emit what was understood). Only a header that failed to
      // parse is absent, and that is reported by reportFlattened.
      const keyword =
        n.type === "protocol_declaration"
          ? "protocol"
          : (anyChildrenOfType(n, DECLARATION_KEYWORDS)[0]?.text ?? "class");
      const nameNode = n.childForFieldName("name");
      const name = nameNode === null ? "<anonymous>" : nameNode.text;
      if (keyword === "extension") {
        const t = newType(ctx, n, name, "extension", name);
        ctx.extensions.push(t);
        collectMembers(n, t, name);
        return;
      }
      const qualified = prefix === "" ? name : `${prefix}.${name}`;
      const t = newType(
        ctx,
        n,
        qualified,
        keyword as TypeDecl["declaration_kind"],
        null,
      );
      ctx.types.push(t);
      ctx.declared.set(qualified, t);
      collectMembers(n, t, qualified);
      return;
    }
    if (
      n.type === "function_declaration" ||
      n.type === "protocol_function_declaration" ||
      n.type === "init_declaration"
    ) {
      if (inError) return; // a member spilled out of a flattened type; reported above
      if (skipWithSyntaxError(ctx, n, prefix)) return;
      const member =
        n.type === "init_declaration"
          ? "init"
          : (n.childForFieldName("name")?.text ?? functionNameOf(n));
      raw.push({
        decl: n,
        form:
          n.type === "init_declaration"
            ? "init"
            : n.type === "protocol_function_declaration"
              ? "requirement"
              : "function",
        member,
        type,
        prefix,
      });
      const qualified = functionName(n, prefix, member);
      disambiguated.set(n.id, qualified);
      if (type !== null && n.type === "init_declaration") {
        type.has_explicit_init = true;
      }
      const body = n.childForFieldName("body");
      if (body !== null) {
        walk(body, qualified, null);
      }
      return;
    }
    if (inError && n.type === "property_declaration") return;
    for (const c of n.namedChildren) {
      if (c !== null) walk(c, prefix, type, inError);
    }
  };

  walk(ctx.root, "", null);

  const qualifiedFor = new Map<RawOwner, string>();
  for (const r of raw) {
    const known = disambiguated.get(r.decl.id);
    if (known !== undefined) {
      qualifiedFor.set(r, known);
      continue;
    }
    // Computed properties cannot be overloaded; their name is the plain form.
    qualifiedFor.set(r, r.prefix === "" ? r.member : `${r.prefix}.${r.member}`);
  }

  for (const r of raw) {
    const qualified = qualifiedFor.get(r) ?? r.member;
    const body =
      r.form === "computed"
        ? r.decl.childForFieldName("computed_value")
        : r.form === "requirement" || r.form === "slot"
          ? null
          : r.decl.childForFieldName("body");
    let returnType: TypeRef | null;
    if (r.form === "computed" || r.form === "slot") {
      const ann = firstChildOfType(r.decl, "type_annotation");
      returnType = ann === null ? null : typeRef(ann);
    } else {
      returnType = returnTypeOf(r.decl);
    }
    const owner: Owner = {
      node_id: codeId(ctx.repo, ctx.path, qualified),
      qualified,
      member: r.member,
      form: r.form,
      decl: r.decl,
      body,
      owner_type: r.type,
      is_static: isStatic(r.decl),
      params:
        r.form === "computed" || r.form === "slot" ? [] : paramsOf(r.decl),
      return_type: returnType,
      fact: null,
    };
    ctx.owners.push(owner);
    ctx.ownersByNode.set(r.decl.id, owner);
    if (r.type !== null) {
      const list = r.type.members.get(r.member);
      if (list === undefined) r.type.members.set(r.member, [owner]);
      else list.push(owner);
    }
  }

  // Same-file extensions merge into the declared type.
  for (const ext of ctx.extensions) {
    const target = ctx.declared.get(ext.extension_target ?? "");
    if (target === undefined) continue;
    ext.merged_into = target;
    target.properties.push(...ext.properties);
    if (ext.conformances.some((c) => CODABLE.has(c))) target.is_codable = true;
    for (const [name, owners] of ext.members) {
      const list = target.members.get(name);
      if (list === undefined) target.members.set(name, [...owners]);
      else list.push(...owners);
      for (const o of owners) o.owner_type = target;
    }
  }
}

function kindOfType(t: TypeDecl): NodeKind {
  return t.is_view ? "ui_view" : "class";
}

/** `= Foo()` or `= Foo.shared` names Foo; literals name their stdlib type. */
function inferredInitType(init: Node | null): string | null {
  if (init === null) return null;
  switch (init.type) {
    case "line_string_literal":
    case "multi_line_string_literal":
      return "String";
    case "integer_literal":
      return "Int";
    case "real_literal":
      return "Double";
    case "boolean_literal":
      return "Bool";
    case "call_expression": {
      const callee = init.namedChildren[0];
      if (
        callee !== null &&
        callee !== undefined &&
        callee.type === "simple_identifier" &&
        isCapitalized(callee.text)
      ) {
        return callee.text;
      }
      return null;
    }
    case "navigation_expression": {
      const target = init.childForFieldName("target");
      const suffix = init.childForFieldName("suffix");
      if (
        target !== null &&
        suffix !== null &&
        target.type === "simple_identifier" &&
        isCapitalized(target.text) &&
        suffix.text === ".shared"
      ) {
        return target.text;
      }
      return null;
    }
    default:
      return null;
  }
}

function fieldTypeText(p: PropertyDecl): string {
  if (p.type !== null) return p.type.text;
  return inferredInitType(p.init) ?? p.init?.text ?? "";
}

function schemaFor(ctx: FileContext, t: TypeDecl): PayloadSchema {
  const fields: Field[] = [];
  for (const p of t.properties) {
    if (p.is_static || !p.is_stored) continue;
    const base = p.type?.base ?? null;
    const ref = base === null ? undefined : ctx.declared.get(base);
    fields.push({
      name: p.name,
      type: fieldTypeText(p),
      optional: (p.type?.optional ?? false) || p.init !== null,
      classification: [],
      ref_schema_id:
        ref !== undefined && ref.is_codable
          ? schemaId(ctx.repo, ctx.path, ref.qualified)
          : null,
    });
  }
  return {
    id: schemaId(ctx.repo, ctx.path, t.qualified),
    name: t.qualified,
    source: {
      repo: ctx.repo,
      path: ctx.path,
      line_start: lineStart(t.decl),
      line_end: lineEnd(t.decl),
    },
    confidence: "certain",
    confidence_reason: null,
    fields,
  };
}

function propertyFacts(props: PropertyDecl[]): PropertyFact[] {
  return props.map((p) => ({
    name: p.name,
    type: p.type === null ? inferredInitType(p.init) : receiverTypeName(p.type),
    is_static: p.is_static,
    is_stored: p.is_stored,
  }));
}

export function ownerFact(o: Owner): FunctionFact {
  return {
    node_id: o.node_id,
    qualified: o.qualified,
    owner_type: o.owner_type?.qualified ?? null,
    member: o.member,
    is_static: o.is_static,
    form:
      o.form === "init"
        ? "init"
        : o.form === "computed"
          ? "computed"
          : o.form === "requirement"
            ? "requirement"
            : o.form === "slot"
              ? "slot"
              : "function",
    params: o.params.map((p) => ({
      label: p.label,
      name: p.name,
      type: p.type === null ? null : receiverTypeName(p.type),
    })),
    return_type:
      o.return_type === null ? null : receiverTypeName(o.return_type),
    url_constructions: [],
    forwards: [],
    sends_request: false,
    property_assignments: [],
  };
}

/** Second pass: emit nodes, provides, schemas and facts for what was collected. */
export function emitDeclarations(ctx: FileContext): void {
  const lines = ctx.content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  ctx.nodes.push({
    id: ctx.module_id,
    kind: "module",
    label: basename(ctx.path),
    tier: DEFAULT_TIER_BY_KIND.module ?? "domain",
    parent: null,
    sources: [
      {
        repo: ctx.repo,
        path: ctx.path,
        line_start: 1,
        line_end: Math.max(1, lines.length),
        hash: spanHash(ctx.content),
      },
    ],
    confidence: "certain",
    confidence_reason: null,
    is_entry_point: false,
    entry_point_kind: null,
    is_infrastructure: false,
    tags: [],
  });

  for (const t of ctx.types) {
    const kind = kindOfType(t);
    const spans = [span(ctx, t.decl)];
    for (const ext of ctx.extensions) {
      if (ext.merged_into === t) spans.push(span(ctx, ext.decl));
    }
    const dot = t.qualified.lastIndexOf(".");
    const parentQualified = dot < 0 ? null : t.qualified.slice(0, dot);
    const parentDecl =
      parentQualified === null
        ? null
        : (ctx.declared.get(parentQualified) ??
          ctx.owners.find((o) => o.qualified === parentQualified) ??
          null);
    const isMain = hasAttribute(t.decl, "main");
    ctx.nodes.push({
      id: t.node_id,
      kind,
      label: t.qualified,
      tier: DEFAULT_TIER_BY_KIND[kind] ?? "domain",
      parent: parentDecl === null ? ctx.module_id : parentDecl.node_id,
      sources: spans,
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: isMain,
      entry_point_kind: isMain ? "app_launch" : null,
      is_infrastructure: false,
      tags: [],
    });
    ctx.provides.push({
      name: t.qualified,
      node_id: t.node_id,
      alias_of: null,
      ref_kind: "symbol",
      visibility: visibilityOf(visibilityModifier(t.decl)),
      scope: "global",
      scope_path: null,
    });
    const isCodable = t.is_codable && t.declaration_kind !== "protocol";
    if (isCodable) ctx.schemas.push(schemaFor(ctx, t));
    t.fact = {
      qualified: t.qualified,
      node_id: t.node_id,
      declaration_kind:
        t.declaration_kind === "extension" ? "struct" : t.declaration_kind,
      conformances: t.conformances,
      cases: [...t.cases],
      properties: propertyFacts(t.properties),
      has_explicit_init: t.has_explicit_init,
      is_codable: isCodable,
      schema_id: isCodable ? schemaId(ctx.repo, ctx.path, t.qualified) : null,
    };
  }

  for (const o of ctx.owners) {
    if (o.form === "handler" || o.form === "type" || o.form === "module")
      continue;
    const type = o.owner_type;
    // A cross-file extension member has no parent yet: compose sets it (item 2).
    const parent =
      type === null
        ? ctx.module_id
        : type.declaration_kind === "extension"
          ? null
          : type.node_id;
    ctx.nodes.push({
      id: o.node_id,
      kind: "function",
      label:
        o.form === "requirement"
          ? `${o.qualified} (requirement)`
          : o.form === "slot"
            ? `${o.qualified} (closure property)`
            : o.qualified,
      tier: DEFAULT_TIER_BY_KIND.function ?? "domain",
      parent,
      sources: [span(ctx, o.decl)],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: o.is_entry_point === true,
      entry_point_kind: o.is_entry_point === true ? "ui_handler" : null,
      is_infrastructure: false,
      tags: [],
    });
    const visibility = visibilityOf(
      visibilityModifier(o.decl) ??
        (type === null ? null : visibilityModifier(type.decl)),
    );
    ctx.provides.push({
      name: o.qualified,
      node_id: o.node_id,
      alias_of: null,
      ref_kind: "symbol",
      visibility,
      scope: "global",
      scope_path: null,
    });
    // Overloads also answer to the plain `Type.member` name, so a reference
    // to it fans out to every candidate (parser §4.3) rather than picking one.
    const plain = type === null ? o.member : `${type.qualified}.${o.member}`;
    if (plain !== o.qualified) {
      ctx.provides.push({
        name: plain,
        node_id: o.node_id,
        alias_of: null,
        ref_kind: "symbol",
        visibility,
        scope: "global",
        scope_path: null,
      });
    }
    o.fact = ownerFact(o);
  }

  // Cross-file extensions: no type node here; record the fact for compose.
  for (const ext of ctx.extensions) {
    if (ext.merged_into !== null) continue;
    const members = ctx.owners
      .filter((o) => o.owner_type === ext && o.form !== "type")
      .sort((a, b) => a.decl.startIndex - b.decl.startIndex);
    ext.ext_fact = {
      type_name: ext.extension_target ?? ext.qualified,
      span: span(ctx, ext.decl),
      conformances: ext.conformances,
      member_ids: members.map((m) => m.node_id),
      functions: members.map((m) => m.fact ?? ownerFact(m)),
      properties: propertyFacts(ext.properties),
    };
  }
}

export function collectImports(ctx: FileContext): void {
  for (const imp of childrenOfType(ctx.root, "import_declaration")) {
    const id = firstChildOfType(imp, "identifier");
    if (id !== null) ctx.imports.push(id.text);
  }
  for (const ta of ctx.root.descendantsOfType("typealias_declaration")) {
    const names = fieldChildren(ta, "name");
    const alias = names.find((c) => c.type === "type_identifier");
    const target =
      names.find((c) => TYPE_NODE_KINDS.has(c.type)) ??
      ta.childForFieldName("value");
    if (alias !== undefined && target !== null && target !== undefined) {
      const targetName = typeRef(target).base;
      ctx.typealiases.set(alias.text, targetName);
      // A typealias is a name that forwards to another name (parser §3.4 alias_of).
      ctx.provides.push({
        name: alias.text,
        node_id: null,
        alias_of: targetName,
        ref_kind: "symbol",
        visibility: visibilityOf(visibilityModifier(ta)),
        scope: "global",
        scope_path: null,
      });
    }
  }
}
