/** Small helpers over web-tree-sitter nodes. Pure; no pack semantics. */
import type { Node } from "web-tree-sitter";

export const TYPE_NODE_KINDS = new Set([
  "user_type",
  "array_type",
  "optional_type",
  "dictionary_type",
  "tuple_type",
  "function_type",
  "opaque_type",
  "existential_type",
  "metatype",
  "protocol_composition_type",
]);

export function lineStart(n: Node): number {
  return n.startPosition.row + 1;
}

/** 1-based last line actually occupied by the node. */
export function lineEnd(n: Node): number {
  const end =
    n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row
      ? n.endPosition.row
      : n.endPosition.row + 1;
  return Math.max(end, lineStart(n));
}

export function childrenOfType(n: Node, type: string): Node[] {
  return n.namedChildren.filter(
    (c): c is Node => c !== null && c.type === type,
  );
}

export function firstChildOfType(
  n: Node,
  types: string | string[],
): Node | null {
  const set = typeof types === "string" ? [types] : types;
  for (const c of n.namedChildren) {
    if (c !== null && set.includes(c.type)) return c;
  }
  return null;
}

/** All children (named or anonymous) whose type is in `types`. */
export function anyChildrenOfType(n: Node, types: string[]): Node[] {
  return n.children.filter(
    (c): c is Node => c !== null && types.includes(c.type),
  );
}

export function fieldChildren(n: Node, field: string): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < n.childCount; i++) {
    if (n.fieldNameForChild(i) === field) {
      const c = n.child(i);
      if (c !== null) out.push(c);
    }
  }
  return out;
}

export function contains(outer: Node, inner: Node): boolean {
  return (
    outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex
  );
}

/**
 * Strip wrappers that do not change what expression is being evaluated:
 * try / await / force-unwrap / parentheses.
 */
export function unwrapExpr(n: Node): Node {
  let cur = n;
  for (;;) {
    if (cur.type === "try_expression" || cur.type === "await_expression") {
      const inner = cur.childForFieldName("expr");
      if (inner === null) return cur;
      cur = inner;
      continue;
    }
    if (cur.type === "postfix_expression") {
      const target = cur.childForFieldName("target");
      const op = cur.childForFieldName("operation");
      if (target !== null && op !== null && op.type === "bang") {
        cur = target;
        continue;
      }
      return cur;
    }
    if (cur.type === "tuple_expression" && cur.namedChildCount === 1) {
      const inner = cur.namedChildren[0];
      if (inner === null || inner === undefined) return cur;
      cur = inner;
      continue;
    }
    return cur;
  }
}

/**
 * Textual name of a type node with optional / array / opaque wrappers
 * removed, plus what was removed. `[Note]?` → { base: "Note", array: true,
 * optional: true }.
 */
export interface TypeRef {
  base: string;
  optional: boolean;
  array: boolean;
  dictionary: boolean;
  text: string;
}

export function typeRef(n: Node): TypeRef {
  let optional = false;
  let array = false;
  let dictionary = false;
  let cur: Node = n;
  const text = n.text;
  for (let guard = 0; guard < 8; guard++) {
    if (cur.type === "type_annotation") {
      const inner = cur.childForFieldName("name");
      if (inner === null) break;
      cur = inner;
      continue;
    }
    if (cur.type === "optional_type") {
      optional = true;
      const inner =
        cur.childForFieldName("wrapped") ?? cur.namedChildren[0] ?? null;
      if (inner === null) break;
      cur = inner;
      continue;
    }
    if (cur.type === "array_type") {
      array = true;
      const inner =
        cur.childForFieldName("name") ?? cur.namedChildren[0] ?? null;
      if (inner === null) break;
      cur = inner;
      continue;
    }
    if (cur.type === "dictionary_type") {
      dictionary = true;
      break;
    }
    if (cur.type === "opaque_type" || cur.type === "existential_type") {
      const inner = cur.namedChildren[0] ?? null;
      if (inner === null) break;
      cur = inner;
      continue;
    }
    break;
  }
  let base = cur.text;
  if (cur.type === "user_type") {
    // Drop generic arguments: `Result<Foo, Error>` → `Result`.
    base = cur.namedChildren
      .filter((c): c is Node => c !== null && c.type === "type_identifier")
      .map((c) => c.text)
      .join(".");
    if (base === "") base = cur.text;
  }
  return { base, optional, array, dictionary, text };
}

export function isCapitalized(s: string): boolean {
  const c = s.charCodeAt(0);
  return c >= 65 && c <= 90;
}
