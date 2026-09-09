/**
 * URLSession / Foundation network recognizer and URL reconstruction
 * (parser §7 "HTTP calls", handoff §6.1, decisions items 3, 10, 11).
 *
 * Finding `URLSession...data(for:)` is the easy part. The path was built
 * somewhere else from a base-URL expression and an interpolated string, often
 * inside a helper. This module (a) records, per function, every URL or
 * URLRequest construction as a list of parts naming which parameters and
 * properties feed it, and which parameters are forwarded where; (b) turns the
 * parts plus a caller's arguments into a path template, bounded to two hops;
 * and (c) emits direct http edges for sends whose request is built in the
 * same body. A path that cannot be rebuilt is never guessed: the ref carries
 * `{unresolved}` plus a reason naming what stopped it.
 */
import type { HttpHints, PartialEdge, UnresolvedRef } from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import { diag, ownerAt, type FileContext, type Owner } from "../context.js";
import type {
  ArgFact,
  ArgValue,
  FunctionFact,
  TypeFact,
  UrlConstruction,
  UrlPart,
} from "../state.js";
import { childrenOfType, lineEnd, lineStart, unwrapExpr } from "../tree.js";
import { resolveBinding, typeOfExpr } from "./scope.js";

export const HOP_CAP = 2;

/** URLSession members whose labelled argument is the request or URL being sent. */
const SEND_METHODS = new Set([
  "data",
  "upload",
  "download",
  "bytes",
  "dataTask",
  "uploadTask",
  "downloadTask",
]);
const SEND_LABELS = new Set(["for", "from", "with"]);

// ---------------------------------------------------------------------------
// Parts of a string expression
// ---------------------------------------------------------------------------

/**
 * Break a string-valued expression into literal text and the parameters,
 * properties or opaque expressions interpolated into it.
 */
export function urlPartsOf(
  ctx: FileContext,
  exprIn: Node,
  owner: Owner,
  depth = 0,
): UrlPart[] {
  const expr = unwrapExpr(exprIn);
  if (depth > 5) return [{ kind: "expr", text: expr.text }];
  switch (expr.type) {
    case "additive_expression": {
      const lhs = expr.childForFieldName("lhs");
      const rhs = expr.childForFieldName("rhs");
      const op = expr.children.find(
        (c): c is Node => c !== null && !c.isNamed && c.text.trim() !== "",
      );
      if (
        lhs === null ||
        rhs === null ||
        (op !== undefined && op.text !== "+")
      ) {
        return [{ kind: "expr", text: expr.text }];
      }
      return [
        ...urlPartsOf(ctx, lhs, owner, depth + 1),
        ...urlPartsOf(ctx, rhs, owner, depth + 1),
      ];
    }
    case "line_string_literal":
    case "multi_line_string_literal": {
      const parts: UrlPart[] = [];
      for (const c of expr.namedChildren) {
        if (c === null) continue;
        if (
          c.type === "line_str_text" ||
          c.type === "multi_line_str_text" ||
          c.type === "str_escaped_char"
        ) {
          parts.push({ kind: "literal", text: c.text });
        } else if (c.type === "interpolated_expression") {
          const value =
            c.childForFieldName("value") ?? c.namedChildren[0] ?? null;
          if (value === null) continue;
          parts.push(...interpolatedParts(ctx, value, owner, depth + 1));
        }
      }
      return parts;
    }
    case "simple_identifier":
      return identifierParts(ctx, expr, owner, depth);
    case "navigation_expression":
      return (
        selfPropertyParts(ctx, expr, owner) ?? [
          { kind: "expr", text: expr.text },
        ]
      );
    default:
      return [{ kind: "expr", text: expr.text }];
  }
}

function interpolatedParts(
  ctx: FileContext,
  value: Node,
  owner: Owner,
  depth: number,
): UrlPart[] {
  const v = unwrapExpr(value);
  if (v.type === "simple_identifier") {
    const b = resolveBinding(ctx, v.text, v, owner);
    // A local assembled from a `?`-prefixed literal is a query string, not a
    // path segment. Recorded as a literal `?{name}` so the renderer splits it.
    if (b?.kind === "local" && b.init !== null && /"\?/.test(b.init.text)) {
      return [{ kind: "literal", text: `?{${v.text}}` }];
    }
    return identifierParts(ctx, v, owner, depth);
  }
  if (v.type === "navigation_expression") {
    return selfPropertyParts(ctx, v, owner) ?? [{ kind: "expr", text: v.text }];
  }
  if (v.type === "line_string_literal" || v.type === "additive_expression") {
    return urlPartsOf(ctx, v, owner, depth);
  }
  return [{ kind: "expr", text: v.text }];
}

function identifierParts(
  ctx: FileContext,
  id: Node,
  owner: Owner,
  depth: number,
): UrlPart[] {
  const b = resolveBinding(ctx, id.text, id, owner);
  if (b === null) return [{ kind: "expr", text: id.text }];
  switch (b.kind) {
    case "param":
      return [{ kind: "param", name: id.text }];
    case "property":
      return [{ kind: "property", name: id.text }];
    case "local":
      if (b.init !== null) {
        const init = unwrapExpr(b.init);
        if (
          init.type === "line_string_literal" ||
          init.type === "additive_expression" ||
          init.type === "simple_identifier" ||
          init.type === "navigation_expression"
        ) {
          return urlPartsOf(ctx, init, owner, depth + 1);
        }
      }
      return [{ kind: "expr", text: id.text }];
    default:
      return [{ kind: "expr", text: id.text }];
  }
}

/** `self.path` / `self.baseURL` as a property part; anything else → null. */
function selfPropertyParts(
  ctx: FileContext,
  nav: Node,
  owner: Owner,
): UrlPart[] | null {
  const target = nav.childForFieldName("target");
  const suffix = nav.childForFieldName("suffix");
  if (target === null || suffix === null) return null;
  if (target.type !== "self_expression" && target.text !== "self") return null;
  const member = suffix.namedChildren[0]?.text ?? null;
  if (member === null || owner.owner_type === null) return null;
  return [{ kind: "property", name: member }];
}

// ---------------------------------------------------------------------------
// Rendering parts into a path template
// ---------------------------------------------------------------------------

export interface Rendered {
  path: string;
  query: string | null;
  base_url_expr: string | null;
  /** True when every path segment is literal or a simple placeholder. */
  complete: boolean;
  /** Names of parameters/properties/expressions left as placeholders. */
  placeholders: string[];
  /** No literal path text at all: the ref must not be template-matched. */
  no_literal: boolean;
}

export type Binder = (part: UrlPart) => ArgValue | null;

export function placeholderName(text: string): string {
  // `\(try await self.digest(of: data))` → `self.digest`: effect keywords and
  // the surrounding call are not the name.
  const stripped = text.trim().replace(/^(?:(?:try[?!]?|await)\s+)+/, "");
  const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(stripped);
  return m === null ? "expr" : m[0].replace(/\.$/, "");
}

export function renderUrl(parts: UrlPart[], bind: Binder): Rendered {
  const base: string[] = [];
  let path = "";
  let started = false;
  let query: string | null = null;
  let complete = true;
  let literal = false;
  const placeholders: string[] = [];

  const pushText = (text: string): void => {
    if (query !== null) {
      query += text;
      return;
    }
    const q = text.indexOf("?");
    if (q >= 0) {
      path += text.slice(0, q);
      query = text.slice(q + 1);
    } else {
      path += text;
    }
  };
  const pushLiteral = (text: string): void => {
    if (!started) {
      if (text.startsWith("/")) {
        started = true;
        literal = true;
        pushText(text);
        return;
      }
      if (/^https?:\/\//.test(text)) {
        const m = /^(https?:\/\/[^/?]+)(.*)$/.exec(text);
        if (m !== null) {
          base.push(JSON.stringify(m[1]));
          started = true;
          if ((m[2] ?? "") !== "") {
            literal = true;
            pushText(m[2] ?? "");
          }
          return;
        }
      }
      if (text.startsWith("?")) {
        started = true;
        pushText(text);
        return;
      }
      // Literal text that neither starts a path nor names an origin: treat as
      // path text, emitted exactly as written. Never add a separator.
      started = true;
      literal = true;
      pushText(text);
      return;
    }
    if (text.replace(/[/?{}]/g, "") !== "") literal = true;
    pushText(text);
  };
  const pushPlaceholder = (name: string, opaque: boolean): void => {
    if (!started) {
      base.push(name);
      return;
    }
    placeholders.push(name);
    if (opaque) complete = false;
    pushText(`{${name}}`);
  };
  const pushValue = (v: ArgValue, fallback: string): void => {
    switch (v.kind) {
      case "literal":
        pushLiteral(v.text);
        return;
      case "template":
        for (const p of v.parts ?? []) {
          if (p.kind === "literal") pushLiteral(p.text);
          else if (p.kind === "param" || p.kind === "property")
            pushPlaceholder(p.name, false);
          else pushPlaceholder(placeholderName(p.text), true);
        }
        return;
      case "ident":
        pushPlaceholder(placeholderName(v.text), false);
        return;
      default:
        pushPlaceholder(
          fallback === "" ? placeholderName(v.text) : fallback,
          true,
        );
    }
  };

  for (const part of parts) {
    switch (part.kind) {
      case "literal":
        pushLiteral(part.text);
        break;
      case "param":
      case "property": {
        const v = bind(part);
        if (v === null) pushPlaceholder(part.name, false);
        else pushValue(v, part.name);
        break;
      }
      case "expr": {
        const v = bind(part);
        if (v === null)
          pushPlaceholder(
            started ? placeholderName(part.text) : part.text,
            started,
          );
        else pushValue(v, placeholderName(part.text));
        break;
      }
    }
  }
  return {
    path: path === "" && !literal ? "{unresolved}" : path,
    query: query === null || query === "" ? null : query,
    base_url_expr: base.length === 0 ? null : base.join(" + "),
    complete: complete && literal,
    placeholders,
    no_literal: !literal,
  };
}

// ---------------------------------------------------------------------------
// Per-function facts: constructions, forwards, property assignments
// ---------------------------------------------------------------------------

function callee(call: Node): Node | null {
  return call.namedChildren[0] ?? null;
}

function calleeName(call: Node): string | null {
  const c = callee(call);
  return c !== null && c.type === "simple_identifier" ? c.text : null;
}

function args(call: Node): { label: string | null; value: Node }[] {
  const suffix =
    call.childForFieldName("call_suffix") ??
    childrenOfType(call, "call_suffix")[0] ??
    null;
  if (suffix === null) return [];
  const out: { label: string | null; value: Node }[] = [];
  for (const va of childrenOfType(suffix, "value_arguments")) {
    for (const a of childrenOfType(va, "value_argument")) {
      const value = a.childForFieldName("value");
      if (value === null) continue;
      const name = a.childForFieldName("name");
      out.push({ label: name === null ? null : name.text, value });
    }
  }
  return out;
}

/** Call expressions inside `body` that belong to `owner` (not to a nested owner). */
export function ownedCalls(ctx: FileContext, owner: Owner, body: Node): Node[] {
  return body
    .descendantsOfType("call_expression")
    .filter((c) => ownerAt(ctx, c) === owner);
}

function methodPart(
  ctx: FileContext,
  owner: Owner,
  body: Node,
  local: string,
): UrlPart | null {
  for (const a of body.descendantsOfType("assignment")) {
    if (ownerAt(ctx, a) !== owner) continue;
    const target = a.childForFieldName("target");
    const result = a.childForFieldName("result");
    if (target === null || result === null) continue;
    if (
      target.text !== `${local}.httpMethod` &&
      target.text !== `self.${local}.httpMethod`
    )
      continue;
    const parts = urlPartsOf(ctx, result, owner);
    const single = parts[0];
    if (parts.length === 1 && single !== undefined) return single;
    return { kind: "expr", text: result.text };
  }
  return null;
}

interface Construction {
  call: Node;
  form: "URL" | "URLRequest";
  parts: UrlPart[];
  method: UrlPart | null;
  /** Local the value was bound to, if any. */
  local: string | null;
}

/** The `URL(string:)` expression a `URLRequest(url:)` argument leads back to. */
function urlExprFor(ctx: FileContext, owner: Owner, value: Node): Node | null {
  const v = unwrapExpr(value);
  if (v.type === "call_expression" && calleeName(v) === "URL") return v;
  if (v.type === "simple_identifier") {
    const b = resolveBinding(ctx, v.text, v, owner);
    if (b?.init) {
      const init = unwrapExpr(b.init);
      if (init.type === "call_expression" && calleeName(init) === "URL")
        return init;
    }
  }
  return null;
}

function boundLocal(call: Node): string | null {
  let cur: Node | null = call.parent;
  while (cur !== null) {
    if (cur.type === "property_declaration") {
      return cur.descendantsOfType("simple_identifier")[0]?.text ?? null;
    }
    if (cur.type === "guard_statement" || cur.type === "if_statement") {
      // guard let x = URL(...) : the bound identifier precedes this condition.
      let bound: string | null = null;
      for (let i = 0; i < cur.childCount; i++) {
        const c = cur.child(i);
        if (c === null) continue;
        if (cur.fieldNameForChild(i) === "bound_identifier") bound = c.text;
        if (c.startIndex <= call.startIndex && call.endIndex <= c.endIndex)
          return bound;
      }
      return null;
    }
    if (cur.type === "statements" || cur.type === "call_expression")
      return null;
    cur = cur.parent;
  }
  return null;
}

function constructionsIn(
  ctx: FileContext,
  owner: Owner,
  body: Node,
): Construction[] {
  const out: Construction[] = [];
  const consumedUrls = new Set<number>();
  const calls = ownedCalls(ctx, owner, body);
  for (const c of calls) {
    if (calleeName(c) !== "URLRequest") continue;
    const urlArg = args(c).find((a) => a.label === "url") ?? args(c)[0];
    if (urlArg === undefined) continue;
    const urlExpr = urlExprFor(ctx, owner, urlArg.value);
    const local = boundLocal(c);
    let parts: UrlPart[];
    if (urlExpr === null) {
      parts = [{ kind: "expr", text: urlArg.value.text }];
    } else {
      consumedUrls.add(urlExpr.id);
      const s =
        args(urlExpr).find((a) => a.label === "string") ?? args(urlExpr)[0];
      parts =
        s === undefined
          ? [{ kind: "expr", text: urlExpr.text }]
          : urlPartsOf(ctx, s.value, owner);
    }
    out.push({
      call: c,
      form: "URLRequest",
      parts,
      method: local === null ? null : methodPart(ctx, owner, body, local),
      local,
    });
  }
  for (const c of calls) {
    if (calleeName(c) !== "URL" || consumedUrls.has(c.id)) continue;
    const s = args(c).find((a) => a.label === "string");
    if (s === undefined) continue; // URL(fileURLWithPath:) and friends are not network
    out.push({
      call: c,
      form: "URL",
      parts: urlPartsOf(ctx, s.value, owner),
      method: null,
      local: boundLocal(c),
    });
  }
  out.sort((a, b) => a.call.startIndex - b.call.startIndex);
  return out;
}

/**
 * Fill `url_constructions`, `forwards`, `property_assignments` and
 * `sends_request` on every owner fact, then emit direct http edges for sends
 * whose request was built in the same body.
 */
export function analyzeNetwork(ctx: FileContext): Set<number> {
  const handled = new Set<number>();
  for (const owner of ctx.owners) {
    if (owner.body === null || owner.fact === null) continue;
    const body = owner.body;
    const fact = owner.fact;
    const constructions = constructionsIn(ctx, owner, body);
    for (const c of constructions) {
      fact.url_constructions.push({
        line: lineStart(c.call),
        form: c.form,
        parts: c.parts,
        method: c.method,
      });
    }
    collectForwards(ctx, owner, body, fact);
    if (owner.form === "init")
      collectPropertyAssignments(ctx, owner, body, fact);

    // Direct sends.
    for (const call of ownedCalls(ctx, owner, body)) {
      const cal = callee(call);
      if (cal === null || cal.type !== "navigation_expression") continue;
      const member =
        cal.childForFieldName("suffix")?.namedChildren[0]?.text ?? "";
      if (!SEND_METHODS.has(member)) continue;
      const sendArg = args(call).find(
        (a) => a.label !== null && SEND_LABELS.has(a.label),
      );
      if (sendArg === undefined) continue;
      handled.add(call.id);
      fact.sends_request = true;
      emitDirectSend(ctx, owner, call, sendArg.value, constructions);
    }
  }
  return handled;
}

function emitDirectSend(
  ctx: FileContext,
  owner: Owner,
  call: Node,
  requestExpr: Node,
  constructions: Construction[],
): void {
  const v = unwrapExpr(requestExpr);
  let construction: Construction | null = null;
  if (v.type === "simple_identifier") {
    construction = constructions.find((c) => c.local === v.text) ?? null;
  } else if (v.type === "call_expression") {
    construction = constructions.find((c) => c.call.id === v.id) ?? null;
  }
  const line = lineStart(call);
  let ref: UnresolvedRef;
  let confidence: PartialEdge["confidence"] = "certain";
  let reason: string | null = null;
  let method: string | null = "GET"; // URLRequest's default; null only when a helper leaves it to callers
  if (construction === null) {
    const origin = describeOrigin(ctx, owner, v);
    const hints: HttpHints = { method, base_url_expr: null, query: null };
    ref = { ref_kind: "http", value: "{unresolved}", hints, source_line: line };
    confidence = "inferred";
    reason = `URL passed to \`${call.text.split("(")[0] ?? call.text}\` is a runtime value: ${origin}; no path literal in local scope (expression: \`${requestExpr.text.replace(/\s+/g, " ")}\`)`;
    diag(
      ctx,
      "warning",
      "url_unresolved",
      `${owner.qualified}: ${reason}`,
      line,
    );
  } else {
    const rendered = renderUrl(construction.parts, () => null);
    const m = methodText(construction.method);
    method = m === null ? "GET" : m.startsWith("{") ? null : m.toUpperCase();
    const hints: HttpHints = {
      method,
      base_url_expr: rendered.base_url_expr,
      query: rendered.query,
    };
    if (rendered.no_literal) {
      confidence = "inferred";
      const fromCallers = construction.parts.some((p) => p.kind === "param");
      const template =
        rendered.path === "{unresolved}"
          ? ""
          : ` (template \`${rendered.path}\`)`;
      reason = fromCallers
        ? `the path is ${describeParts(construction.parts)} of ${owner.qualified}, not a literal here; each caller's path is drawn as its own edge from the caller${template}`
        : `the URL is ${describeParts(construction.parts)}, a value computed at runtime, with no literal path text in local scope${template}`;
      diag(
        ctx,
        "warning",
        "url_unresolved",
        `${owner.qualified}: ${reason}`,
        line,
      );
    } else if (!rendered.complete || rendered.placeholders.length > 0) {
      if (
        rendered.placeholders.some((p) =>
          construction.parts.some(
            (x) => x.kind !== "literal" && x.kind !== "expr" && x.name === p,
          ),
        )
      ) {
        // Parameter/property placeholders: the template is partial until a caller binds them.
        confidence = "inferred";
        reason = `path segment(s) ${rendered.placeholders.map((p) => `{${p}}`).join(", ")} come from ${describeParts(construction.parts)}; the literal part was read at line ${String(lineStart(construction.call))}`;
      } else if (!rendered.complete) {
        confidence = "inferred";
        reason = `path segment(s) ${rendered.placeholders.map((p) => `{${p}}`).join(", ")} are computed expressions; the literal part was read at line ${String(lineStart(construction.call))}`;
      }
    }
    if (
      construction.parts.some(
        (p) => p.kind === "literal" && p.text.startsWith("?{"),
      )
    ) {
      confidence = "inferred";
      reason = `${reason === null ? "" : `${reason}; `}query string \`${rendered.query ?? ""}\` inferred from a local built with a \`?\`-prefixed literal`;
    }
    ref = {
      ref_kind: "http",
      value: rendered.no_literal ? "{unresolved}" : rendered.path,
      hints,
      source_line: line,
    };
  }
  const edge: PartialEdge = {
    from: owner.node_id,
    to: ref,
    kind: "http_request",
    label: `${method ?? "?"} ${ref.value}`,
    schema_id: null,
    response_schema_id: null,
    confidence,
    confidence_reason: reason,
    condition: null,
    exclusive_group: null,
    branch_ordinal: null,
    is_error_path: false,
    source: {
      repo: ctx.repo,
      path: ctx.path,
      line_start: line,
      line_end: lineEnd(call),
    },
  };
  ctx.sites.push({ edge, call, owner, candidate: null, catch_default: false });
  if (owner.owner_type !== null)
    ctx.http_types.add(
      (owner.owner_type.merged_into ?? owner.owner_type).node_id,
    );
}

function describeOrigin(ctx: FileContext, owner: Owner, v: Node): string {
  if (v.type === "simple_identifier") {
    const b = resolveBinding(ctx, v.text, v, owner);
    if (b?.init) {
      // A local copied from a parameter (`var request = urlRequest`) is the
      // parameter for the reader's purposes: callers supply it.
      const init = unwrapExpr(b.init);
      if (init.type === "simple_identifier") {
        const inner = resolveBinding(ctx, init.text, init, owner);
        if (inner?.kind === "param") {
          return `\`${v.text}\` is a copy of parameter \`${init.text}\` of ${owner.qualified}; each caller's request is drawn as its own edge from the caller`;
        }
      }
      return `\`${v.text}\` is bound to \`${b.init.text.replace(/\s+/g, " ")}\`, a value computed at runtime`;
    }
    if (b?.kind === "param")
      return `\`${v.text}\` is a parameter of ${owner.qualified}; each caller's request is drawn as its own edge from the caller`;
    if (b?.kind === "property") return `\`${v.text}\` is a stored property`;
  }
  return `\`${v.text.replace(/\s+/g, " ")}\``;
}

export function describeParts(parts: UrlPart[]): string {
  const names = parts
    .filter((p) => p.kind !== "literal")
    .map((p) =>
      p.kind === "expr" ? `\`${p.text}\`` : `${p.kind} \`${p.name}\``,
    );
  return names.length === 0 ? "literal text" : names.join(", ");
}

export function methodText(part: UrlPart | null): string | null {
  if (part === null) return null;
  if (part.kind === "literal") return part.text;
  return `{${part.kind === "expr" ? placeholderName(part.text) : part.name}}`;
}

function collectForwards(
  ctx: FileContext,
  owner: Owner,
  body: Node,
  fact: FunctionFact,
): void {
  for (const call of ownedCalls(ctx, owner, body)) {
    const cal = callee(call);
    if (cal === null) continue;
    let calleeType: string | null = null;
    let calleeMember: string;
    if (cal.type === "simple_identifier") {
      calleeMember = cal.text;
      calleeType =
        owner.owner_type === null
          ? null
          : (owner.owner_type.merged_into ?? owner.owner_type).qualified;
      if (
        owner.owner_type !== null &&
        !(owner.owner_type.merged_into ?? owner.owner_type).members.has(
          cal.text,
        )
      ) {
        calleeType = null;
      }
    } else if (cal.type === "navigation_expression") {
      const target = cal.childForFieldName("target");
      calleeMember =
        cal.childForFieldName("suffix")?.namedChildren[0]?.text ?? "";
      if (target === null) continue;
      const r = typeOfExpr(ctx, target, owner);
      calleeType = r?.type_name ?? null;
    } else {
      continue;
    }
    for (const a of args(call)) {
      const v = unwrapExpr(a.value);
      let root: Node = v;
      let via: string | null = null;
      if (v.type === "navigation_expression") {
        const t = v.childForFieldName("target");
        const s = v.childForFieldName("suffix");
        if (t === null || s === null) continue;
        root = unwrapExpr(t);
        via = s.namedChildren[0]?.text ?? null;
      }
      if (root.type !== "simple_identifier") continue;
      const b = resolveBinding(ctx, root.text, root, owner);
      if (b === null || (b.kind !== "param" && b.kind !== "property")) continue;
      fact.forwards.push({
        source: b.kind === "param" ? "param" : "property",
        name: root.text,
        via_member: via,
        callee_type: calleeType,
        callee_member: calleeMember,
      });
    }
  }
}

function collectPropertyAssignments(
  ctx: FileContext,
  owner: Owner,
  body: Node,
  fact: FunctionFact,
): void {
  for (const a of body.descendantsOfType("assignment")) {
    if (ownerAt(ctx, a) !== owner) continue;
    const target = a.childForFieldName("target");
    const result = a.childForFieldName("result");
    if (target === null || result === null) continue;
    const m = /^self\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(target.text);
    if (m === null || m[1] === undefined) continue;
    const r = unwrapExpr(result);
    if (r.type !== "simple_identifier") continue;
    if (owner.params.some((p) => p.name === r.text)) {
      fact.property_assignments.push({ property: m[1], from_param: r.text });
    }
  }
}

// ---------------------------------------------------------------------------
// Helper resolution: caller arguments → callee construction → path
// ---------------------------------------------------------------------------

export interface FactsIndex {
  /** Functions named `member` on `typeName` (null → top level), across every file this index covers. */
  functions(typeName: string | null, member: string): FunctionFact[];
  type(typeName: string): TypeFact | null;
}

/**
 * Whether following `fact`'s forwards (unbounded, memoized) can reach a URL
 * construction at all. The hop cap is only worth a diagnostic on such a trail;
 * a logger call that forwards its argument three levels deep is not a URL.
 */
export function buildsUrlDownstream(
  fact: FunctionFact,
  index: FactsIndex,
  memo = new Map<string, boolean>(),
  depth = 0,
): boolean {
  const key = fact.node_id;
  const known = memo.get(key);
  if (known !== undefined) return known;
  memo.set(key, false); // cycle guard
  let result = fact.url_constructions.length > 0;
  if (!result && depth < 8) {
    for (const fw of fact.forwards) {
      if (fw.via_member !== null) {
        const t = fact.params.find((p) => p.name === fw.name)?.type ?? null;
        const members = t === null ? [] : index.functions(t, fw.via_member);
        if (
          members.some((m) => buildsUrlDownstream(m, index, memo, depth + 1))
        ) {
          result = true;
          break;
        }
        continue;
      }
      if (
        index
          .functions(fw.callee_type, fw.callee_member)
          .some((m) => buildsUrlDownstream(m, index, memo, depth + 1))
      ) {
        result = true;
        break;
      }
    }
  }
  memo.set(key, result);
  return result;
}

export interface HttpResolution {
  rendered: Rendered;
  method: string;
  via: string[];
  parts: UrlPart[];
}

export interface HopCap {
  hop_cap: true;
  stopped_at: string;
}

function bindArgs(
  params: FunctionFact["params"],
  callArgs: ArgFact[],
): Map<string, ArgValue> {
  const bound = new Map<string, ArgValue>();
  const unlabeled = callArgs.filter((a) => a.label === null);
  let u = 0;
  for (const p of params) {
    const byLabel =
      p.label === null ? undefined : callArgs.find((a) => a.label === p.label);
    if (byLabel !== undefined) {
      bound.set(p.name, byLabel.value);
    } else if (p.label === null) {
      const next = unlabeled[u++];
      if (next !== undefined) bound.set(p.name, next.value);
    }
  }
  return bound;
}

function constructionsThatDepend(
  fact: FunctionFact,
  on: (p: UrlPart) => boolean,
): UrlConstruction[] {
  return fact.url_constructions.filter(
    (uc) => uc.parts.some(on) || (uc.method !== null && on(uc.method)),
  );
}

/**
 * Resolve a call to `fact` with `callArgs` into a path, following at most
 * HOP_CAP callee levels. Returns null when the callee's constructions do not
 * depend on its arguments (the call is then an ordinary call edge).
 */
export function resolveThroughCallee(
  fact: FunctionFact,
  callArgs: ArgFact[],
  index: FactsIndex,
  hop = 1,
): HttpResolution | HopCap | null {
  if (hop > HOP_CAP) {
    return buildsUrlDownstream(fact, index)
      ? { hop_cap: true, stopped_at: fact.qualified }
      : null;
  }
  const bound = bindArgs(fact.params, callArgs);
  const dependent = constructionsThatDepend(
    fact,
    (p) => p.kind === "param" && bound.has(p.name),
  );
  const first = dependent[0];
  if (first !== undefined) {
    const binder: Binder = (p) =>
      p.kind === "param" ? (bound.get(p.name) ?? null) : null;
    const rendered = renderUrl(first.parts, binder);
    const method =
      first.method === null
        ? "GET"
        : (methodText(bindPart(first.method, binder)) ?? "GET");
    return { rendered, method, via: [fact.qualified], parts: first.parts };
  }
  for (const fw of fact.forwards) {
    if (fw.source !== "param") continue;
    const v = bound.get(fw.name);
    if (v === undefined) continue;
    if (fw.via_member !== null) {
      // `request(endpoint.request)`: the argument's type has a member that builds the request.
      const typeName =
        v.type_name ??
        fact.params.find((p) => p.name === fw.name)?.type ??
        null;
      if (typeName === null) continue;
      const r = resolveThroughMember(
        typeName,
        fw.via_member,
        v,
        index,
        hop + 1,
      );
      if (r !== null) return prependVia(r, fact.qualified);
      continue;
    }
    const callees = index.functions(fw.callee_type, fw.callee_member);
    for (const c of callees) {
      const r = resolveThroughCallee(
        c,
        [{ label: null, value: v }],
        index,
        hop + 1,
      );
      if (r !== null) return prependVia(r, fact.qualified);
    }
  }
  return null;
}

function prependVia(
  r: HttpResolution | HopCap,
  q: string,
): HttpResolution | HopCap {
  if ("hop_cap" in r) return r;
  return { ...r, via: [q, ...r.via] };
}

function bindPart(p: UrlPart, binder: Binder): UrlPart {
  const v = binder(p);
  if (v === null) return p;
  if (v.kind === "literal") return { kind: "literal", text: v.text };
  return { kind: "expr", text: v.text };
}

/**
 * A member (computed property or method) of `typeName` that builds a URL
 * from the type's stored properties, bound from a construction's arguments.
 */
export function resolveThroughMember(
  typeName: string,
  member: string,
  instance: ArgValue,
  index: FactsIndex,
  hop: number,
): HttpResolution | HopCap | null {
  const facts = index.functions(typeName, member);
  if (hop > HOP_CAP) {
    return facts.some((f) => buildsUrlDownstream(f, index))
      ? { hop_cap: true, stopped_at: `${typeName}.${member}` }
      : null;
  }
  const type = index.type(typeName);
  const ctorArgs =
    instance.kind === "construction" ? (instance.args ?? []) : [];
  const propertyValues = new Map<string, ArgValue>();
  if (type !== null) {
    if (type.has_explicit_init) {
      for (const init of index.functions(typeName, "init")) {
        const bound = bindArgs(init.params, ctorArgs);
        for (const pa of init.property_assignments) {
          const v = bound.get(pa.from_param);
          if (v !== undefined) propertyValues.set(pa.property, v);
        }
      }
    } else {
      // Memberwise initializer: argument labels are the stored property names.
      for (const a of ctorArgs) {
        if (a.label !== null) propertyValues.set(a.label, a.value);
      }
    }
  }
  const binder: Binder = (p) =>
    p.kind === "property" ? (propertyValues.get(p.name) ?? null) : null;
  for (const f of facts) {
    const dependent = constructionsThatDepend(
      f,
      (p) => p.kind === "property" && propertyValues.has(p.name),
    );
    const first = dependent[0];
    if (first === undefined) continue;
    const rendered = renderUrl(first.parts, binder);
    const method =
      first.method === null
        ? "GET"
        : (methodText(bindPart(first.method, binder)) ?? "GET");
    return { rendered, method, via: [f.qualified], parts: first.parts };
  }
  return null;
}
