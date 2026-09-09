/**
 * Local scope, `self` context and receiver typing (parser §3.5 "Inside the
 * boundary"). Everything here is derivable from the one file; anything that
 * needs another file is returned as a `chain` for compose to finish.
 */
import type { Node } from "web-tree-sitter";
import type { FileContext, Owner, TypeDecl } from "../context.js";
import { receiverTypeName, synthesizedStaticType } from "../noise.js";
import type { ChainStep } from "../state.js";
import {
  TYPE_NODE_KINDS,
  fieldChildren,
  firstChildOfType,
  isCapitalized,
  typeRef,
  unwrapExpr,
  type TypeRef,
} from "../tree.js";

export interface Binding {
  kind: "local" | "param" | "lambda_param" | "property" | "loop";
  name: string;
  type: TypeRef | null;
  init: Node | null;
  is_static: boolean;
}

function patternNames(pattern: Node): string[] {
  return pattern.descendantsOfType("simple_identifier").map((n) => n.text);
}

/** `guard let x = expr` / `if let x = expr`: bound identifier → its expression. */
function conditionBindings(stmt: Node): Map<string, Node | null> {
  const out = new Map<string, Node | null>();
  const bound = fieldChildren(stmt, "bound_identifier");
  // The `=` token also carries the `condition` field; the value is the first
  // named condition after it. `if let x` with no `= expr` shadows an outer
  // `x`: keep the name, no init.
  const conditions = fieldChildren(stmt, "condition");
  for (const b of bound) {
    const eq = conditions.find(
      (c) => !c.isNamed && c.text === "=" && c.startIndex > b.startIndex,
    );
    const value =
      eq === undefined
        ? null
        : (conditions.find(
            (c) =>
              c.isNamed &&
              c.startIndex > eq.startIndex &&
              c.type !== "value_binding_pattern",
          ) ?? null);
    out.set(b.text, value);
  }
  return out;
}

/** Find what `name` refers to at position `at`, walking outward. */
export function resolveBinding(
  ctx: FileContext,
  name: string,
  at: Node,
  owner: Owner | null,
): Binding | null {
  let cur: Node | null = at;
  let prev: Node = at;
  while (cur !== null) {
    if (cur.type === "statements" || cur.type === "source_file") {
      for (const s of cur.namedChildren) {
        if (s === null || s.startIndex >= prev.startIndex) break;
        if (s.type === "property_declaration") {
          for (const pattern of fieldChildren(s, "name")) {
            if (patternNames(pattern).includes(name)) {
              const ann = firstChildOfType(s, "type_annotation");
              return {
                kind: "local",
                name,
                type: ann === null ? null : typeRef(ann),
                init: s.childForFieldName("value"),
                is_static: false,
              };
            }
          }
        } else if (s.type === "guard_statement") {
          const b = conditionBindings(s);
          if (b.has(name)) {
            return {
              kind: "local",
              name,
              type: null,
              init: b.get(name) ?? null,
              is_static: false,
            };
          }
        }
      }
    } else if (cur.type === "if_statement" || cur.type === "while_statement") {
      const b = conditionBindings(cur);
      if (b.has(name) && prev.type === "statements") {
        return {
          kind: "local",
          name,
          type: null,
          init: b.get(name) ?? null,
          is_static: false,
        };
      }
    } else if (cur.type === "for_statement") {
      const pattern = cur.namedChildren[0];
      if (
        pattern !== null &&
        pattern !== undefined &&
        pattern.type === "pattern" &&
        patternNames(pattern).includes(name)
      ) {
        return { kind: "loop", name, type: null, init: null, is_static: false };
      }
    } else if (cur.type === "lambda_literal") {
      for (const p of cur.descendantsOfType("lambda_parameter")) {
        if (!lambdaOwns(cur, p)) continue;
        const pname = p.childForFieldName("name")?.text ?? p.text;
        if (pname === name) {
          const t = fieldChildren(p, "type")[0] ?? null;
          return {
            kind: "lambda_param",
            name,
            type: t === null ? null : typeRef(t),
            init: null,
            is_static: false,
          };
        }
      }
    } else if (
      cur.type === "function_declaration" ||
      cur.type === "init_declaration"
    ) {
      const o = ctx.ownersByNode.get(cur.id);
      const params = o?.params ?? [];
      const p = params.find((x) => x.name === name);
      if (p !== undefined) {
        return {
          kind: "param",
          name,
          type: p.type,
          init: null,
          is_static: false,
        };
      }
    } else if (cur.type === "class_declaration") {
      const t = typeDeclFor(ctx, cur);
      if (t !== null) {
        const props = t.properties.filter((p) => p.name === name);
        const instance = props.find((p) => !p.is_static) ?? props[0];
        if (instance !== undefined) {
          return {
            kind: "property",
            name,
            type: instance.type,
            init: instance.init,
            is_static: instance.is_static,
          };
        }
      }
    }
    prev = cur;
    cur = cur.parent;
  }
  void owner;
  return null;
}

/** A lambda parameter belongs to the innermost lambda around it. */
function lambdaOwns(lambda: Node, param: Node): boolean {
  let cur = param.parent;
  while (cur !== null && cur !== lambda) {
    if (cur.type === "lambda_literal") return false;
    cur = cur.parent;
  }
  return true;
}

export function typeDeclFor(ctx: FileContext, decl: Node): TypeDecl | null {
  for (const t of ctx.types) if (t.decl.id === decl.id) return t;
  for (const e of ctx.extensions)
    if (e.decl.id === decl.id) return e.merged_into ?? e;
  return null;
}

export interface Receiver {
  /** Best-effort type name. Null when the chain must be finished by compose. */
  type_name: string | null;
  form: "instance" | "type";
  chain: ChainStep[];
  /** The declared type in this file, when fully resolved here. */
  in_file: TypeDecl | null;
  certain: boolean;
  reason: string | null;
}

function typeReceiver(ctx: FileContext, name: string): Receiver {
  const resolved = ctx.typealiases.get(name) ?? name;
  const decl = ctx.declared.get(resolved) ?? null;
  return {
    type_name: resolved,
    form: "type",
    chain: [{ kind: "type", name: resolved }],
    in_file: decl,
    certain: true,
    reason: null,
  };
}

function instanceReceiver(ctx: FileContext, name: string): Receiver {
  const resolved = ctx.typealiases.get(name) ?? name;
  return {
    type_name: resolved,
    form: "instance",
    chain: [{ kind: "instance", type_name: resolved }],
    in_file: ctx.declared.get(resolved) ?? null,
    certain: true,
    reason: null,
  };
}

/**
 * An instance of a declared type, seen through its collection wrapper: a
 * value typed `[Memory]` is an `Array`, and a call on it is a Standard
 * Library call, never a member of `Memory`. Optional is transparent.
 */
function instanceOf(ctx: FileContext, t: TypeRef): Receiver {
  return instanceReceiver(ctx, receiverTypeName(t));
}

/** The type an expression evaluates to, as far as this file can tell. */
export function typeOfExpr(
  ctx: FileContext,
  exprIn: Node,
  owner: Owner | null,
  depth = 0,
): Receiver | null {
  if (depth > 6) return null;
  const expr = unwrapExpr(exprIn);
  switch (expr.type) {
    case "self_expression":
      return selfReceiver(ctx, expr, owner);
    case "simple_identifier": {
      const name = expr.text;
      if (name === "self") return selfReceiver(ctx, expr, owner);
      if (name === "Self") {
        const self = selfReceiver(ctx, expr, owner);
        return self === null ? null : { ...self, form: "type" };
      }
      const b = resolveBinding(ctx, name, expr, owner);
      if (b !== null) {
        if (b.type !== null) return instanceOf(ctx, b.type);
        if (b.init !== null) return typeOfExpr(ctx, b.init, owner, depth + 1);
        return null;
      }
      if (
        ctx.typealiases.has(name) ||
        ctx.declared.has(name) ||
        isCapitalized(name)
      ) {
        return typeReceiver(ctx, name);
      }
      return null;
    }
    case "navigation_expression": {
      const target = expr.childForFieldName("target");
      const suffix = expr.childForFieldName("suffix");
      if (target === null || suffix === null) return null;
      const member =
        suffix.namedChildren[0]?.text ?? suffix.text.replace(/^\./, "");
      const r = typeOfExpr(ctx, target, owner, depth + 1);
      if (r === null) return null;
      if (member === "self") return { ...r, form: "type" };
      if (r.form === "type") {
        const nested =
          r.type_name === null
            ? undefined
            : ctx.declared.get(`${r.type_name}.${member}`);
        if (nested !== undefined) return typeReceiver(ctx, nested.qualified);
        if (r.in_file !== null) {
          const prop = r.in_file.properties.find(
            (p) => p.name === member && p.is_static,
          );
          if (prop !== undefined) {
            if (prop.type !== null) return instanceOf(ctx, prop.type);
            if (prop.init !== null) {
              const t = typeOfExpr(ctx, prop.init, owner, depth + 1);
              if (t !== null) return t;
            }
          }
          // Undeclared static member on a type declared here: only a
          // compiler-synthesized member has a knowable type. Anything else is
          // an unknown receiver, never assumed to be a singleton instance.
          const synthesized = synthesizedStaticType(member);
          return synthesized === null
            ? null
            : instanceReceiver(ctx, synthesized);
        }
        return {
          type_name: r.type_name,
          form: "instance",
          chain: [...r.chain, { kind: "member", name: member }],
          in_file: null,
          certain: false,
          reason: `receiver \`${expr.text}\` is static member \`${member}\` of ${r.type_name ?? "?"}, declared in another file`,
        };
      }
      // instance form
      if (r.in_file !== null) {
        const prop = r.in_file.properties.find(
          (p) => p.name === member && !p.is_static,
        );
        if (prop !== undefined) {
          if (prop.type !== null) return instanceOf(ctx, prop.type);
          if (prop.init !== null) {
            const t = typeOfExpr(ctx, prop.init, owner, depth + 1);
            if (t !== null) return t;
          }
        }
        return null;
      }
      return {
        type_name: null,
        form: "instance",
        chain: [...r.chain, { kind: "member", name: member }],
        in_file: null,
        certain: false,
        reason: `receiver \`${expr.text}\` reaches member \`${member}\` of ${r.type_name ?? "?"}, declared in another file`,
      };
    }
    case "call_expression": {
      const callee = expr.namedChildren[0];
      if (callee === null || callee === undefined) return null;
      if (callee.type === "simple_identifier") {
        const name = ctx.typealiases.get(callee.text) ?? callee.text;
        if (ctx.declared.has(name) || isCapitalized(name))
          return instanceReceiver(ctx, name);
        // A bare call to a method of the enclosing type, or a top-level
        // function declared here: its return type.
        const enclosing = owner?.owner_type ?? null;
        const declaredType =
          enclosing === null ? null : (enclosing.merged_into ?? enclosing);
        const method = (declaredType?.members.get(name) ?? []).find(
          (m) => m.return_type !== null,
        );
        if (method?.return_type) return instanceOf(ctx, method.return_type);
        const o = ctx.owners.find(
          (x) =>
            x.owner_type === null && x.member === name && x.form === "function",
        );
        if (o?.return_type) return instanceOf(ctx, o.return_type);
        return null;
      }
      if (callee.type === "navigation_expression") {
        const target = callee.childForFieldName("target");
        const suffix = callee.childForFieldName("suffix");
        if (target === null || suffix === null) return null;
        const member = suffix.namedChildren[0]?.text ?? "";
        const r = typeOfExpr(ctx, target, owner, depth + 1);
        if (r === null) return null;
        if (member === "init") return { ...r, form: "instance" };
        if (r.in_file !== null) {
          const owners = r.in_file.members.get(member) ?? [];
          const withReturn = owners.find((o) => o.return_type !== null);
          if (withReturn?.return_type)
            return instanceOf(ctx, withReturn.return_type);
        }
        return null;
      }
      return null;
    }
    case "as_expression": {
      const t = fieldChildren(expr, "name").find((c) =>
        TYPE_NODE_KINDS.has(c.type),
      );
      return t === undefined ? null : instanceOf(ctx, typeRef(t));
    }
    case "line_string_literal":
    case "multi_line_string_literal":
      return instanceReceiver(ctx, "String");
    case "constructor_expression": {
      const t = expr.namedChildren[0];
      return t === null || t === undefined ? null : instanceOf(ctx, typeRef(t));
    }
    default:
      return null;
  }
}

function selfReceiver(
  ctx: FileContext,
  at: Node,
  owner: Owner | null,
): Receiver | null {
  let t = owner?.owner_type ?? null;
  if (t === null) {
    let cur: Node | null = at;
    while (cur !== null && cur.type !== "class_declaration") cur = cur.parent;
    if (cur !== null) t = typeDeclFor(ctx, cur);
  }
  if (t === null) return null;
  const declared = t.merged_into ?? t;
  const name =
    declared.declaration_kind === "extension"
      ? (declared.extension_target ?? declared.qualified)
      : declared.qualified;
  return {
    type_name: name,
    form: "instance",
    chain: [{ kind: "instance", type_name: name }],
    in_file: declared.declaration_kind === "extension" ? null : declared,
    certain: true,
    reason: null,
  };
}
