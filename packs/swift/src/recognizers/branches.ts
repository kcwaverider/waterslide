/**
 * Branch detection (parser §6). For each branch point whose limbs gate
 * different outgoing edges: one exclusive_group, a branch_ordinal per limb in
 * source order, the condition verbatim, and is_error_path from the construct
 * table in data/error-paths.json. Branch points gating no edges produce
 * nothing; a branch point with edges in only one limb labels those edges
 * with its condition but forms no group.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "web-tree-sitter";
import {
  diag,
  type CallSite,
  type FileContext,
  type Owner,
} from "../context.js";
import { packRoot } from "../parser.js";
import { childrenOfType, contains, lineStart } from "../tree.js";

interface ErrorPathTable {
  constructs: Record<string, { is_error_path: boolean; note?: string }>;
}

let table: ErrorPathTable | null = null;
export function errorPathTable(): ErrorPathTable {
  if (table === null) {
    table = JSON.parse(
      readFileSync(join(packRoot(), "data", "error-paths.json"), "utf8"),
    ) as ErrorPathTable;
  }
  return table;
}

interface Limb {
  construct: string;
  /** Byte range the limb covers. */
  start: number;
  end: number;
  /** Nodes to scan for exits (throw / return). */
  scan: Node[];
  condition: string;
  condition_line: number;
}

interface BranchPoint {
  node: Node;
  limbs: Limb[];
  /** Statements follow this branch point in its block: a `return` inside is early. */
  continues_below: boolean;
}

function textBetween(ctx: FileContext, from: number, to: number): string {
  return ctx.content.slice(from, to).replace(/\s+/g, " ").trim();
}

function conditionText(
  ctx: FileContext,
  stmt: Node,
  keyword: string,
  stopAt: Node | null,
): string {
  const start = stmt.startIndex + keyword.length;
  const end = stopAt === null ? stmt.endIndex : stopAt.startIndex;
  return textBetween(ctx, start, end)
    .replace(/\s*\{$/, "")
    .trim();
}

function continuesBelow(node: Node): boolean {
  const parent = node.parent;
  if (parent === null || parent.type !== "statements") return false;
  return parent.namedChildren.some(
    (c) => c !== null && c.startIndex > node.endIndex,
  );
}

function branchPointsOf(
  ctx: FileContext,
  owner: Owner,
  body: Node,
): BranchPoint[] {
  const out: BranchPoint[] = [];
  const nodes = body
    .descendantsOfType([
      "if_statement",
      "guard_statement",
      "switch_statement",
      "do_statement",
      "ternary_expression",
    ])
    .filter((n) => ownerFor(ctx, n) === owner)
    .sort((a, b) => a.startIndex - b.startIndex);
  for (const n of nodes) {
    // else-if chains are flattened into the outermost if's limbs.
    if (n.type === "if_statement" && n.parent?.type === "if_statement")
      continue;
    const limbs = limbsOf(ctx, n);
    if (limbs.length > 0)
      out.push({ node: n, limbs, continues_below: continuesBelow(n) });
  }
  return out;
}

function ownerFor(ctx: FileContext, n: Node): Owner | null {
  let best: Owner | null = null;
  for (const o of ctx.owners) {
    if (
      contains(o.decl, n) &&
      (best === null || o.decl.startIndex >= best.decl.startIndex)
    )
      best = o;
  }
  return best;
}

function limbsOf(ctx: FileContext, n: Node): Limb[] {
  const limbs: Limb[] = [];
  switch (n.type) {
    case "if_statement": {
      let cur: Node | null = n;
      let first = true;
      while (cur !== null) {
        const stmts = childrenOfType(cur, "statements");
        const then = stmts[0];
        if (then === undefined) break;
        limbs.push({
          construct: "if_limb",
          start: then.startIndex,
          end: then.endIndex,
          scan: [then],
          condition:
            (first ? "" : "else ") +
            `if ${conditionText(ctx, cur, "if", then)}`,
          condition_line: lineStart(cur),
        });
        first = false;
        const elseIf: Node | null =
          childrenOfType(cur, "if_statement")[0] ?? null;
        const elseBlock = stmts[1];
        if (elseIf !== null) {
          cur = elseIf;
          continue;
        }
        if (elseBlock !== undefined) {
          limbs.push({
            construct: "else_limb",
            start: elseBlock.startIndex,
            end: elseBlock.endIndex,
            scan: [elseBlock],
            condition: "else",
            condition_line: lineStart(elseBlock),
          });
        }
        cur = null;
      }
      return limbs;
    }
    case "guard_statement": {
      const elseBlock = childrenOfType(n, "statements")[0] ?? null;
      const parent = n.parent;
      const elseToken =
        n.children.find((c): c is Node => c !== null && c.type === "else") ??
        null;
      const cond = conditionText(ctx, n, "guard", elseToken);
      if (elseBlock !== null) {
        limbs.push({
          construct: "guard_else",
          start: elseBlock.startIndex,
          end: elseBlock.endIndex,
          scan: [elseBlock],
          condition: `guard ${cond} else`,
          condition_line: lineStart(n),
        });
      }
      if (parent !== null && parent.type === "statements") {
        const after = parent.namedChildren.filter(
          (c): c is Node => c !== null && c.startIndex >= n.endIndex,
        );
        if (after.length > 0) {
          limbs.push({
            construct: "guard_continue",
            start: n.endIndex,
            end: parent.endIndex,
            scan: after,
            condition: `guard ${cond}`,
            condition_line: lineStart(n),
          });
        }
      }
      return limbs;
    }
    case "switch_statement": {
      for (const entry of childrenOfType(n, "switch_entry")) {
        const stmts = childrenOfType(entry, "statements")[0] ?? null;
        limbs.push({
          construct: "switch_case",
          start: entry.startIndex,
          end: entry.endIndex,
          scan: stmts === null ? [] : [stmts],
          condition: textBetween(
            ctx,
            entry.startIndex,
            stmts === null ? entry.endIndex : stmts.startIndex,
          ).replace(/:$/, ""),
          condition_line: lineStart(entry),
        });
      }
      return limbs;
    }
    case "do_statement": {
      const body = childrenOfType(n, "statements")[0] ?? null;
      if (body !== null) {
        limbs.push({
          construct: "do_body",
          start: body.startIndex,
          end: body.endIndex,
          scan: [body],
          condition: "do",
          condition_line: lineStart(n),
        });
      }
      for (const c of childrenOfType(n, "catch_block")) {
        const stmts = childrenOfType(c, "statements")[0] ?? null;
        limbs.push({
          construct: "catch",
          start: c.startIndex,
          end: c.endIndex,
          scan: stmts === null ? [] : [stmts],
          condition: textBetween(
            ctx,
            c.startIndex,
            stmts === null ? c.endIndex : stmts.startIndex,
          ).replace(/\s*\{$/, ""),
          condition_line: lineStart(c),
        });
      }
      return limbs;
    }
    case "ternary_expression": {
      const cond = n.childForFieldName("condition");
      const t = n.childForFieldName("if_true");
      const f = n.childForFieldName("if_false");
      if (cond === null || t === null || f === null) return [];
      limbs.push({
        construct: "ternary_limb",
        start: t.startIndex,
        end: t.endIndex,
        scan: [t],
        condition: `${cond.text} ?`,
        condition_line: lineStart(n),
      });
      limbs.push({
        construct: "ternary_limb",
        start: f.startIndex,
        end: f.endIndex,
        scan: [f],
        condition: `${cond.text} : (else)`,
        condition_line: lineStart(n),
      });
      return limbs;
    }
    default:
      return [];
  }
}

const FATAL = new Set(["fatalError", "preconditionFailure", "exit", "abort"]);

/** Which error-path constructs the limb contains, excluding nested closures. */
function constructsIn(limb: Limb, bp: BranchPoint, owner: Owner): Set<string> {
  const found = new Set<string>([limb.construct]);
  const visit = (n: Node): void => {
    if (n.type === "lambda_literal") return;
    if (n.type === "throw_keyword") found.add("throw");
    if (
      n.type === "control_transfer_statement" &&
      n.text.startsWith("return")
    ) {
      const result = n.childForFieldName("result");
      if (
        result !== null &&
        result.text === "nil" &&
        owner.return_type?.optional === true
      )
        found.add("return_nil");
      else if (bp.continues_below || limb.construct === "guard_else")
        found.add("early_return");
    }
    if (n.type === "call_expression") {
      const callee = n.namedChildren[0];
      if (
        callee !== null &&
        callee !== undefined &&
        callee.type === "simple_identifier" &&
        FATAL.has(callee.text)
      )
        found.add("fatal_error");
    }
    for (const c of n.namedChildren) if (c !== null) visit(c);
  };
  for (const s of limb.scan) visit(s);
  return found;
}

function isErrorPath(constructs: Set<string>): {
  value: boolean;
  from: string[];
} {
  const t = errorPathTable().constructs;
  const from: string[] = [];
  for (const c of constructs) {
    if (t[c]?.is_error_path === true) from.push(c);
  }
  return { value: from.length > 0, from };
}

/** Diagnostic code for the property the dropped uniqueness clause approximated. */
export const SAME_LIMB_VIOLATION = "branch_ordinal_limb_mismatch";

/**
 * Assign fork fields to every call site of every owner.
 *
 * Invariant checked at emit time (review, second pass): within an
 * exclusive_group, every edge sharing a branch_ordinal originates from the
 * same limb. A violation is a numbering bug in this file and is reported as an
 * error diagnostic naming the group, ordinal and the two limbs.
 */
export function assignBranches(ctx: FileContext): void {
  const limbsByOrdinal = new Map<string, { limb: Limb; line: number }>();
  for (const owner of ctx.owners) {
    if (owner.body === null) continue;
    const sites = ctx.sites.filter((s) => s.owner === owner);
    if (sites.length === 0) continue;
    const points = branchPointsOf(ctx, owner, owner.body);
    if (points.length === 0) continue;

    // Which limbs hold sites; a branch point qualifies with two or more.
    const qualifying = new Map<BranchPoint, Limb[]>();
    for (const bp of points) {
      const occupied = bp.limbs.filter((l) => sites.some((s) => within(s, l)));
      if (occupied.length >= 2) qualifying.set(bp, occupied);
    }

    for (const site of sites) {
      // Innermost branch point containing the site decides its condition;
      // innermost *qualifying* one decides its group.
      type Hit = { bp: BranchPoint; limb: Limb; k: number; ordinal: number };
      let chosen: Hit | null = null;
      let g: Hit | null = null;
      for (let k = 0; k < points.length; k++) {
        const bp = points[k];
        if (bp === undefined) continue;
        const limb = bp.limbs.find((l) => within(site, l));
        if (limb === undefined) continue;
        if (chosen === null || bp.node.startIndex >= chosen.bp.node.startIndex)
          chosen = { bp, limb, k, ordinal: 0 };
        const occupied = qualifying.get(bp);
        if (
          occupied !== undefined &&
          (g === null || bp.node.startIndex >= g.bp.node.startIndex)
        ) {
          g = { bp, limb, k, ordinal: occupied.indexOf(limb) };
        }
      }
      if (chosen === null) continue;
      const edge = site.edge;
      edge.condition = {
        expr: chosen.limb.condition,
        source_line: chosen.limb.condition_line,
      };
      // Every edge in a limb carries the group and the limb's ordinal: two edges
      // from one limb are the same alternative (settled ordinal rule).
      if (g !== null) {
        edge.exclusive_group = `${owner.node_id}/branch[${String(g.k)}]`;
        edge.branch_ordinal = g.ordinal;
        const key = `${edge.exclusive_group} ${String(g.ordinal)}`;
        const seen = limbsByOrdinal.get(key);
        if (seen === undefined) {
          limbsByOrdinal.set(key, { limb: g.limb, line: lineStart(site.call) });
        } else if (seen.limb !== g.limb) {
          diag(
            ctx,
            "error",
            SAME_LIMB_VIOLATION,
            `edges at lines ${String(seen.line)} and ${String(lineStart(site.call))} share ${edge.exclusive_group} ordinal ${String(g.ordinal)} but come from different limbs (\`${seen.limb.condition}\` vs \`${g.limb.condition}\`)`,
            lineStart(site.call),
          );
        }
      }
      const ep = isErrorPath(constructsIn(chosen.limb, chosen.bp, owner));
      edge.is_error_path = ep.value;
      if (ep.value && ep.from.length === 1 && ep.from[0] === "catch") {
        // Parser §10 / handoff §6.1: a catch that retries is arguably the happy
        // path. Default to true, say so, rather than guess confidently.
        site.catch_default = true;
        edge.confidence = "inferred";
        const note =
          "is_error_path defaulted to true for a catch block; a handler that retries may be the happy path";
        edge.confidence_reason =
          edge.confidence_reason === null
            ? note
            : `${edge.confidence_reason}; ${note}`;
      }
    }
  }
}

function within(site: CallSite, limb: Limb): boolean {
  return limb.start <= site.call.startIndex && site.call.endIndex <= limb.end;
}
