import type { Node } from "web-tree-sitter";
import type { ErrorPathConstruct, ErrorPathTable } from "../data.js";
import {
  attributeChain,
  keywordArguments,
  lineStart,
  unwrapExpression,
} from "../tree-sitter/runtime.js";
import type { Definition, FileContext } from "./model.js";

/**
 * Branch detection (parser §6). A limb is one alternative at a branch point:
 * an `if`/`elif`/`else` body, a `try` body or `except` handler, one side of a
 * ternary, a `case`. Edges inside a limb share an `exclusive_group`; the
 * innermost limb wins when branches nest.
 */
export interface Limb {
  /** The statement that owns the fork (`if_statement`, `try_statement`, ...). */
  readonly statement: Node;
  /** Position of this limb among its siblings, in source order, from 0. */
  readonly index: number;
  readonly kind:
    | "if"
    | "elif"
    | "else"
    | "try"
    | "except"
    | "ternary_true"
    | "ternary_false"
    | "case";
  /** `condition.expr`, verbatim from source where there is a condition. */
  readonly expr: string;
  readonly conditionLine: number;
  /** The limb's body: the block (or expression, for a ternary). */
  readonly body: Node;
}

/** Walk up from `node` to the owner's body and return the innermost limb containing it. */
export function innermostLimb(
  node: Node,
  owner: Definition | null,
): Limb | null {
  let child: Node = node;
  let n: Node | null = node.parent;
  while (n) {
    if (owner ? n.id === owner.node.id : n.type === "module") return null;
    if (n.type === "function_definition" || n.type === "lambda") return null;
    const limb = limbOf(n, child);
    if (limb) return limb;
    child = n;
    n = n.parent;
  }
  return null;
}

/** If `child` is a limb body of `parent`, describe it. */
function limbOf(parent: Node, child: Node): Limb | null {
  switch (parent.type) {
    case "if_statement": {
      const consequence = parent.childForFieldName("consequence");
      if (consequence && consequence.id === child.id) {
        const cond = parent.childForFieldName("condition");
        return {
          statement: parent,
          index: 0,
          kind: "if",
          expr: `if ${cond?.text ?? ""}`,
          conditionLine: lineStart(parent),
          body: child,
        };
      }
      return null;
    }
    case "elif_clause": {
      const consequence = parent.childForFieldName("consequence");
      const stmt = parent.parent;
      if (
        !consequence ||
        consequence.id !== child.id ||
        !stmt ||
        stmt.type !== "if_statement"
      )
        return null;
      const cond = parent.childForFieldName("condition");
      return {
        statement: stmt,
        index: alternativeIndex(stmt, parent),
        kind: "elif",
        expr: `elif ${cond?.text ?? ""}`,
        conditionLine: lineStart(parent),
        body: child,
      };
    }
    case "else_clause": {
      const body = parent.childForFieldName("body");
      const stmt = parent.parent;
      if (!body || body.id !== child.id || !stmt) return null;
      if (stmt.type === "if_statement") {
        return {
          statement: stmt,
          index: alternativeIndex(stmt, parent),
          kind: "else",
          expr: "else",
          conditionLine: lineStart(parent),
          body: child,
        };
      }
      if (stmt.type === "try_statement") {
        // try/else runs when the body raised nothing: same alternative as the body.
        return {
          statement: stmt,
          index: 0,
          kind: "try",
          expr: "try",
          conditionLine: lineStart(stmt),
          body: child,
        };
      }
      return null;
    }
    case "try_statement": {
      const body = parent.childForFieldName("body");
      if (body && body.id === child.id) {
        return {
          statement: parent,
          index: 0,
          kind: "try",
          expr: "try",
          conditionLine: lineStart(parent),
          body: child,
        };
      }
      return null;
    }
    case "except_clause":
    case "except_group_clause": {
      const stmt = parent.parent;
      if (!stmt || stmt.type !== "try_statement") return null;
      const block = parent.namedChildren.find((c) => c.type === "block");
      if (!block || block.id !== child.id) return null;
      const handlers = stmt.namedChildren.filter(
        (c) => c.type === "except_clause" || c.type === "except_group_clause",
      );
      const idx = handlers.findIndex((h) => h.id === parent.id);
      const caught = parent.namedChildren.find((c) => c.type !== "block");
      const expr = caught ? `except ${caught.text}` : "except";
      return {
        statement: stmt,
        index: 1 + idx,
        kind: "except",
        expr,
        conditionLine: lineStart(parent),
        body: child,
      };
    }
    case "conditional_expression": {
      const [whenTrue, cond, whenFalse] = parent.namedChildren;
      if (!whenTrue || !cond || !whenFalse) return null;
      if (whenTrue.id === child.id)
        return {
          statement: parent,
          index: 0,
          kind: "ternary_true",
          expr: `if ${cond.text}`,
          conditionLine: lineStart(parent),
          body: child,
        };
      if (whenFalse.id === child.id)
        return {
          statement: parent,
          index: 1,
          kind: "ternary_false",
          expr: "else",
          conditionLine: lineStart(parent),
          body: child,
        };
      return null;
    }
    case "case_clause": {
      const stmt = parent.parent?.parent; // case_clause → block → match_statement
      const body = parent.childForFieldName("consequence");
      if (
        !body ||
        body.id !== child.id ||
        !stmt ||
        stmt.type !== "match_statement"
      )
        return null;
      const cases =
        parent.parent?.namedChildren.filter((c) => c.type === "case_clause") ??
        [];
      const idx = cases.findIndex((c) => c.id === parent.id);
      const patterns = parent.namedChildren
        .filter((c) => c.type === "case_pattern")
        .map((c) => c.text)
        .join(", ");
      const guard = parent.childForFieldName("guard");
      return {
        statement: stmt,
        index: idx,
        kind: "case",
        expr: `case ${patterns}${guard ? ` ${guard.text}` : ""}`,
        conditionLine: lineStart(parent),
        body: child,
      };
    }
    default:
      return null;
  }
}

/** 0 for the `if` body, then 1.. for each `elif`/`else` in order. */
function alternativeIndex(ifStatement: Node, clause: Node): number {
  const alternatives = ifStatement.childrenForFieldName("alternative");
  return 1 + alternatives.findIndex((a) => a.id === clause.id);
}

export function groupIdFor(
  file: FileContext,
  owner: Definition | null,
  limb: Limb,
  suffix = "",
): string {
  const scope = owner ? owner.qualifiedName : "<module>";
  return `${file.path}:${scope}:L${String(lineStart(limb.statement))}${suffix}`;
}

export interface ErrorPathVerdict {
  readonly is_error_path: boolean;
  readonly construct: ErrorPathConstruct;
  /** Set when the data table marks the deciding rule uncertain (the `except` default). */
  readonly uncertain: boolean;
}

/** Apply the data-file rules (parser §6.2) to a limb, first match wins. */
export function limbErrorPath(
  limb: Limb,
  table: ErrorPathTable,
): ErrorPathVerdict {
  const errorCallees = new Set(table.error_response_callees);
  for (const rule of table.rules) {
    if (matches(rule.construct, limb, errorCallees)) {
      return {
        is_error_path: rule.is_error_path,
        construct: rule.construct,
        uncertain: rule.uncertain === true,
      };
    }
  }
  // The table must end in a catch-all; refusing to guess is the point.
  throw new Error(
    "pack-python: error-path table has no matching rule for a limb",
  );
}

function matches(
  construct: ErrorPathConstruct,
  limb: Limb,
  errorCallees: ReadonlySet<string>,
): boolean {
  switch (construct) {
    case "raise":
      return containsStatement(limb.body, "raise_statement");
    case "return_error_response":
      return returnsErrorResponse(limb.body, errorCallees);
    case "except_clause":
      return limb.kind === "except";
    case "early_return":
      return endsInReturn(limb.body) && hasStatementsAfter(limb.statement);
    case "continues":
      return true;
  }
}

/** Descendant search that does not enter nested function definitions. */
function containsStatement(body: Node, type: string): boolean {
  if (body.type === type) return true;
  for (const c of body.namedChildren) {
    if (
      c.type === "function_definition" ||
      c.type === "lambda" ||
      c.type === "class_definition"
    )
      continue;
    if (containsStatement(c, type)) return true;
  }
  return false;
}

function returnsErrorResponse(
  body: Node,
  errorCallees: ReadonlySet<string>,
): boolean {
  const returns: Node[] = [];
  const visit = (n: Node): void => {
    if (n.type === "return_statement") returns.push(n);
    for (const c of n.namedChildren) {
      if (
        c.type === "function_definition" ||
        c.type === "lambda" ||
        c.type === "class_definition"
      )
        continue;
      visit(c);
    }
  };
  visit(body);
  for (const r of returns) {
    const expr = r.namedChildren[0]
      ? unwrapExpression(r.namedChildren[0])
      : null;
    if (!expr || expr.type !== "call") continue;
    const fn = expr.childForFieldName("function");
    const chain = fn ? attributeChain(fn) : null;
    const name = chain ? chain[chain.length - 1] : undefined;
    if (!name || !errorCallees.has(name)) continue;
    if (name === "HTTPException") return true;
    const status = keywordArguments(expr.childForFieldName("arguments")).get(
      "status_code",
    );
    if (status && status.type === "integer") {
      const code = Number(status.text);
      if (code >= 400) return true;
    } else if (status && /HTTP_[45]\d\d/.test(status.text)) {
      return true;
    }
  }
  return false;
}

function endsInReturn(body: Node): boolean {
  if (body.type !== "block") return body.type === "return_statement";
  const statements = body.namedChildren.filter((c) => c.type !== "comment");
  const last = statements[statements.length - 1];
  return last !== undefined && last.type === "return_statement";
}

function hasStatementsAfter(statement: Node): boolean {
  let sibling = statement.nextNamedSibling;
  while (sibling) {
    if (sibling.type !== "comment") return true;
    sibling = sibling.nextNamedSibling;
  }
  return false;
}
