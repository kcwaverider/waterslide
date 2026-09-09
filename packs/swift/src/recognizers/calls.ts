/**
 * Swift language recognizer: call sites → edges (parser §3.5, §7).
 *
 * A call whose target is declared in this file becomes an edge with a string
 * `to`. A call whose receiver type or bare name lives elsewhere becomes a
 * Candidate in the per-file state; compose finishes it. A call whose receiver
 * type cannot be determined from the file is counted, not guessed.
 */
import type {
  HttpHints,
  PartialEdge,
  SymbolHints,
  UnresolvedRef,
} from "@waterslide/core";
import type { Node, Query } from "web-tree-sitter";
import { diag, ownerAt, type FileContext, type Owner } from "../context.js";
import type {
  ArgFact,
  ArgValue,
  Candidate,
  ChainStep,
  FunctionFact,
} from "../state.js";
import {
  childrenOfType,
  fieldChildren,
  isCapitalized,
  lineEnd,
  lineStart,
  TYPE_NODE_KINDS,
  typeRef,
  unwrapExpr,
} from "../tree.js";
import {
  HOP_CAP,
  describeParts,
  resolveThroughCallee,
  urlPartsOf,
  type FactsIndex,
  type HttpResolution,
} from "./network.js";
import { resolveBinding, typeOfExpr, type Receiver } from "./scope.js";

function rawArgs(call: Node): { label: string | null; value: Node }[] {
  const suffix = childrenOfType(call, "call_suffix")[0] ?? null;
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

function literalText(lit: Node): string | null {
  if (
    lit.namedChildren.some(
      (c) => c !== null && c.type === "interpolated_expression",
    )
  )
    return null;
  return lit.namedChildren
    .filter((c): c is Node => c !== null)
    .map((c) => c.text)
    .join("");
}

const BINARY_CALLEES = new Set([
  "additive_expression",
  "multiplicative_expression",
  "comparison_expression",
  "equality_expression",
  "conjunction_expression",
  "disjunction_expression",
  "nil_coalescing_expression",
  "bitwise_operation",
  "infix_expression",
  "range_expression",
]);

/**
 * Grammar quirk: `a * sin(x)` parses as call_expression(multiplicative_expression(a, sin), (x)),
 * so the real callee is the operator's right operand. `-f(x)` has its callee
 * under a prefix_expression; `.success(x)` (dot operator) is an implicit member
 * and is returned as-is for the caller to classify.
 */
function effectiveCallee(first: Node): Node {
  let callee: Node = first;
  for (let guard = 0; guard < 4; guard++) {
    if (BINARY_CALLEES.has(callee.type)) {
      const rhs: Node | null =
        callee.childForFieldName("rhs") ??
        callee.namedChildren[callee.namedChildCount - 1] ??
        null;
      if (rhs === null) return callee;
      callee = rhs;
      continue;
    }
    if (callee.type === "prefix_expression") {
      const op =
        callee.children.find((c): c is Node => c !== null && !c.isNamed)
          ?.text ?? "";
      const target: Node | null =
        callee.childForFieldName("target") ?? callee.namedChildren[0] ?? null;
      if (op === "." || target === null) return callee;
      callee = target;
      continue;
    }
    return callee;
  }
  return callee;
}

/** Marks constructions whose value feeds a call; they carry no edge of their own. */
export type Consumed = Set<number>;

function argValue(
  ctx: FileContext,
  owner: Owner,
  value: Node,
  consumed: Consumed,
  depth: number,
  urlParts: (n: Node) => ArgValue,
): ArgValue {
  const v = unwrapExpr(value);
  if (depth > 4) return { kind: "expr", text: v.text };
  switch (v.type) {
    case "line_string_literal":
    case "multi_line_string_literal": {
      const lit = literalText(v);
      return lit === null ? urlParts(v) : { kind: "literal", text: lit };
    }
    case "simple_identifier": {
      const b = resolveBinding(ctx, v.text, v, owner);
      if (b === null)
        return { kind: isCapitalized(v.text) ? "expr" : "ident", text: v.text };
      if (b.kind === "local" && b.init !== null) {
        const init = unwrapExpr(b.init);
        if (init.type === "call_expression")
          return callValue(ctx, owner, init, consumed, depth, urlParts);
        if (
          init.type === "line_string_literal" ||
          init.type === "additive_expression"
        ) {
          const lit =
            init.type === "line_string_literal" ? literalText(init) : null;
          return lit === null ? urlParts(init) : { kind: "literal", text: lit };
        }
      }
      return { kind: "ident", text: v.text };
    }
    case "call_expression":
      return callValue(ctx, owner, v, consumed, depth, urlParts);
    case "additive_expression":
      return urlParts(v);
    default:
      return { kind: "expr", text: v.text };
  }
}

function callValue(
  ctx: FileContext,
  owner: Owner,
  call: Node,
  consumed: Consumed,
  depth: number,
  urlParts: (n: Node) => ArgValue,
): ArgValue {
  const callee = call.namedChildren[0];
  if (callee === null || callee === undefined)
    return { kind: "call", text: call.text };
  if (callee.type === "simple_identifier") {
    const name = ctx.typealiases.get(callee.text) ?? callee.text;
    if (isCapitalized(name)) {
      consumed.add(call.id);
      return {
        kind: "construction",
        text: call.text,
        type_name: name,
        args: rawArgs(call).map((a) => ({
          label: a.label,
          value: argValue(ctx, owner, a.value, consumed, depth + 1, urlParts),
        })),
      };
    }
    return { kind: "call", text: call.text };
  }
  if (callee.type === "navigation_expression") {
    const member =
      callee.childForFieldName("suffix")?.namedChildren[0]?.text ?? "";
    if (member === "encode") {
      const first = rawArgs(call)[0];
      const t =
        first === undefined ? null : typeOfExpr(ctx, first.value, owner);
      if (t?.type_name)
        return { kind: "encoded", text: call.text, type_name: t.type_name };
    }
    const r = typeOfExpr(ctx, call, owner);
    return r?.type_name
      ? { kind: "call", text: call.text, type_name: r.type_name }
      : { kind: "call", text: call.text };
  }
  return { kind: "call", text: call.text };
}

/** `x as T`, or `let x: T = call` → T. */
function resultType(call: Node): string | null {
  let cur: Node | null = call;
  while (cur !== null) {
    const parent: Node | null = cur.parent;
    if (parent === null) return null;
    if (parent.type === "as_expression") {
      const t = fieldChildren(parent, "name").find((c) =>
        TYPE_NODE_KINDS.has(c.type),
      );
      return t === undefined ? null : typeRef(t).base;
    }
    if (parent.type === "property_declaration") {
      const ann = childrenOfType(parent, "type_annotation")[0];
      return ann === undefined ? null : typeRef(ann).base;
    }
    if (
      parent.type === "try_expression" ||
      parent.type === "await_expression" ||
      parent.type === "postfix_expression"
    ) {
      cur = parent;
      continue;
    }
    return null;
  }
  return null;
}

function baseEdge(
  ctx: FileContext,
  owner: Owner,
  call: Node,
  label: string,
): PartialEdge {
  return {
    from: owner.node_id,
    to: "",
    kind: "call",
    label,
    schema_id: null,
    response_schema_id: null,
    confidence: "certain",
    confidence_reason: null,
    condition: null,
    exclusive_group: null,
    branch_ordinal: null,
    is_error_path: false,
    source: {
      repo: ctx.repo,
      path: ctx.path,
      line_start: lineStart(call),
      line_end: lineEnd(call),
    },
  };
}

export function httpEdgeFrom(
  base: PartialEdge,
  res: HttpResolution,
  args: ArgFact[],
  boundLabel: string | null,
  line: number,
): PartialEdge {
  const method = res.method.startsWith("{") ? null : res.method.toUpperCase();
  const hints: HttpHints = {
    method,
    base_url_expr: res.rendered.base_url_expr,
    query: res.rendered.query,
  };
  const to: UnresolvedRef = {
    ref_kind: "http",
    value: res.rendered.no_literal ? "{unresolved}" : res.rendered.path,
    hints,
    source_line: line,
  };
  const bound = args.find((a) => a.label === boundLabel) ?? args[0];
  const argText =
    bound === undefined
      ? "the call's arguments"
      : `argument \`${bound.label ?? "_"}:\` (${bound.value.kind === "literal" ? `"${bound.value.text}"` : bound.value.text.replace(/\s+/g, " ")})`;
  let reason = `path reconstructed through ${res.via.join(" → ")}: ${argText} feeds a ${res.parts.some((p) => p.kind === "property") ? "stored property" : "parameter"} that builds the request from ${describeParts(res.parts)}`;
  if (res.rendered.base_url_expr !== null)
    reason += `; base URL expression \`${res.rendered.base_url_expr}\``;
  if (res.rendered.no_literal)
    reason += "; no literal path text could be recovered";
  else if (!res.rendered.complete)
    reason += `; segment(s) ${res.rendered.placeholders.map((p) => `{${p}}`).join(", ")} are computed at runtime`;
  return {
    ...base,
    to,
    kind: "http_request",
    label: `${method ?? "?"} ${to.value}`,
    confidence: "inferred",
    confidence_reason:
      base.confidence_reason === null
        ? reason
        : `${base.confidence_reason}; ${reason}`,
  };
}

/** The file's own facts, for in-file helper resolution. */
export function fileIndex(ctx: FileContext): FactsIndex {
  const facts: FunctionFact[] = [];
  for (const o of ctx.owners) if (o.fact !== null) facts.push(o.fact);
  return {
    functions: (typeName, member) =>
      facts.filter(
        (f) => f.member === member && (f.owner_type ?? null) === typeName,
      ),
    type: (typeName) => ctx.declared.get(typeName)?.fact ?? null,
  };
}

export function collectCalls(
  ctx: FileContext,
  q: Query,
  handled: Set<number>,
  consumed: Consumed,
): void {
  const index = fileIndex(ctx);
  const calls = q
    .captures(ctx.root)
    .map((c) => c.node)
    .sort((a, b) => a.startIndex - b.startIndex);
  for (const call of calls) {
    if (handled.has(call.id) || ctx.skipCalls.has(call.id)) continue;
    const owner = ownerAt(ctx, call);
    if (owner === null) continue;
    const firstChild = call.namedChildren[0] ?? null;
    if (firstChild === null) continue;
    const callee = effectiveCallee(firstChild);
    if (callee.type === "prefix_expression") {
      ctx.implicit_member_calls++;
      continue;
    }
    // `layout.branches[index]` parses as a call whose suffix is the subscript:
    // a subscript is a value access, not a call.
    const suffixNode = childrenOfType(call, "call_suffix")[0] ?? null;
    if (suffixNode !== null && suffixNode.text.startsWith("[")) continue;
    const urlParts = (n: Node): ArgValue => ({
      kind: "template",
      text: n.text,
      parts: urlPartsForArg(ctx, owner, n),
    });
    const args: ArgFact[] = rawArgs(call).map((a) => ({
      label: a.label,
      value: argValue(ctx, owner, a.value, consumed, 0, urlParts),
    }));

    if (callee.type === "simple_identifier") {
      const rawName = callee.text;
      if (rawName.startsWith("$")) {
        ctx.closure_calls++;
        continue;
      }
      const binding = resolveBinding(ctx, rawName, callee, owner);
      if (binding !== null && binding.kind !== "property") {
        ctx.closure_calls++;
        continue;
      }
      if (
        binding !== null &&
        binding.kind === "property" &&
        binding.type === null &&
        binding.init === null
      ) {
        // A stored closure property (`var onDone: (() -> Void)?`) is not a callee we can follow.
        ctx.closure_calls++;
        continue;
      }
      const name = ctx.typealiases.get(rawName) ?? rawName;
      const ownerType =
        owner.owner_type === null
          ? null
          : (owner.owner_type.merged_into ?? owner.owner_type);
      // `self.method()` written bare.
      if (ownerType !== null && ownerType.declaration_kind !== "extension") {
        const members = ownerType.members.get(name);
        if (members !== undefined && members.length > 0) {
          emitInFile(ctx, owner, call, members, args, index, name);
          continue;
        }
      }
      if (
        ownerType !== null &&
        ownerType.declaration_kind === "extension" &&
        ownerType.members.has(name)
      ) {
        emitInFile(
          ctx,
          owner,
          call,
          ownerType.members.get(name) ?? [],
          args,
          index,
          name,
        );
        continue;
      }
      const topLevel = ctx.owners.filter(
        (o) =>
          o.owner_type === null && o.member === name && o.form === "function",
      );
      if (topLevel.length > 0) {
        emitInFile(ctx, owner, call, topLevel, args, index, name);
        continue;
      }
      const declared = ctx.declared.get(name);
      if (declared !== undefined) {
        // Constructor of a type declared here.
        if (consumed.has(call.id)) continue;
        const e = baseEdge(ctx, owner, call, name);
        e.to = declared.node_id;
        ctx.sites.push({
          edge: e,
          call,
          owner,
          candidate: null,
          catch_default: false,
        });
        continue;
      }
      if (
        ownerType !== null &&
        ownerType.declaration_kind === "extension" &&
        !isCapitalized(name)
      ) {
        // Bare call inside a cross-file extension: probably a member of the extended type.
        pushCandidate(
          ctx,
          owner,
          call,
          args,
          "method",
          [
            {
              kind: "instance",
              type_name: ownerType.extension_target ?? ownerType.qualified,
            },
          ],
          name,
          null,
        );
        continue;
      }
      if (isCapitalized(name)) {
        pushCandidate(
          ctx,
          owner,
          call,
          args,
          "constructor",
          [{ kind: "type", name }],
          null,
          null,
        );
      } else {
        pushCandidate(ctx, owner, call, args, "free_function", [], name, null);
      }
      continue;
    }

    if (callee.type === "navigation_expression") {
      const target = callee.childForFieldName("target");
      const suffix = callee.childForFieldName("suffix");
      if (target === null || suffix === null) continue;
      const member =
        suffix.namedChildren[0]?.text ?? suffix.text.replace(/^\./, "");
      const r = typeOfExpr(ctx, target, owner);
      if (r === null) {
        const root = rootOf(target);
        if (
          root.type === "simple_identifier" ||
          root.type === "self_expression"
        )
          ctx.dropped_receivers++;
        else ctx.expression_receivers++;
        continue;
      }
      if (member === "init" && r.in_file !== null) {
        if (consumed.has(call.id)) continue;
        const e = baseEdge(ctx, owner, call, r.in_file.qualified);
        e.to = r.in_file.node_id;
        ctx.sites.push({
          edge: e,
          call,
          owner,
          candidate: null,
          catch_default: false,
        });
        continue;
      }
      if (r.in_file !== null) {
        // `APIError.networkError(error)`: an enum case with a payload is a value
        // construction, not a call. Dropped silently.
        if (
          r.in_file.declaration_kind === "enum" &&
          r.in_file.cases.includes(member)
        )
          continue;
        const members = r.in_file.members.get(member);
        if (members !== undefined && members.length > 0) {
          const wanted = members.filter(
            (m) => m.is_static === (r.form === "type") || m.form === "init",
          );
          emitInFile(
            ctx,
            owner,
            call,
            wanted.length > 0 ? wanted : members,
            args,
            index,
            member,
          );
          continue;
        }
        // Declared here, member elsewhere (cross-file extension) or unknown.
        pushCandidate(
          ctx,
          owner,
          call,
          args,
          r.form === "type" ? "static_method" : "method",
          r.chain,
          member,
          r,
        );
        continue;
      }
      pushCandidate(
        ctx,
        owner,
        call,
        args,
        r.form === "type" ? "static_method" : "method",
        r.chain,
        member,
        r,
      );
      continue;
    }

    bump(ctx, callee.type);
  }
}

function rootOf(n: Node): Node {
  let cur = unwrapExpr(n);
  while (cur.type === "navigation_expression") {
    const t = cur.childForFieldName("target");
    if (t === null) break;
    cur = unwrapExpr(t);
  }
  return cur;
}

function bump(ctx: FileContext, kind: string): void {
  ctx.unsupported.set(kind, (ctx.unsupported.get(kind) ?? 0) + 1);
}

function urlPartsForArg(
  ctx: FileContext,
  owner: Owner,
  n: Node,
): ArgValue["parts"] {
  return urlPartsOf(ctx, n, owner);
}

function emitInFile(
  ctx: FileContext,
  owner: Owner,
  call: Node,
  targetsIn: Owner[],
  args: ArgFact[],
  index: FactsIndex,
  label: string,
): void {
  let targets = targetsIn;
  // Helper resolution first (item 3): does any target build a URL from the
  // arguments, directly or through a forwarded parameter? A resolution through
  // one overload is a type-directed pick, so the other overloads are not drawn.
  const resolutions: { t: Owner; res: HttpResolution }[] = [];
  for (const t of targets) {
    if (
      t.fact === null ||
      (t.fact.url_constructions.length === 0 && t.fact.forwards.length === 0)
    )
      continue;
    const res = resolveThroughCallee(t.fact, args, index);
    if (res === null) continue;
    if ("hop_cap" in res) {
      diag(
        ctx,
        "warning",
        "url_reconstruction_hop_cap",
        `${owner.qualified}: URL reconstruction for \`${label}\` stopped at ${res.stopped_at} (hop cap ${String(HOP_CAP)}); emitted as a call edge`,
        lineStart(call),
      );
      continue;
    }
    if (
      !resolutions.some(
        (x) =>
          x.res.rendered.path === res.rendered.path &&
          x.res.method === res.method,
      )
    )
      resolutions.push({ t, res });
  }
  if (resolutions.length === 1 && resolutions[0] !== undefined) {
    const { t, res } = resolutions[0];
    const e = baseEdge(ctx, owner, call, label);
    const bound = t.fact?.params.find((p) =>
      res.parts.some((x) => x.kind === "param" && x.name === p.name),
    );
    ctx.sites.push({
      edge: httpEdgeFrom(e, res, args, bound?.label ?? null, lineStart(call)),
      call,
      owner,
      candidate: null,
      catch_default: false,
    });
    if (owner.owner_type !== null)
      ctx.http_types.add(
        (owner.owner_type.merged_into ?? owner.owner_type).node_id,
      );
    return;
  }
  if (resolutions.length > 1) {
    diag(
      ctx,
      "warning",
      "ambiguous_helper_resolution",
      `${owner.qualified}: \`${label}\` resolves to ${String(resolutions.length)} different paths through overloads (${resolutions.map((x) => x.res.rendered.path).join(", ")}); emitted as call edges rather than guessing`,
      lineStart(call),
    );
  }
  // Overloads: narrow by argument type where the file knows it (parser §4.3
  // fans out only when the ambiguity is real).
  if (targets.length > 1) {
    const argTypes = rawArgs(call).map((a) => ({
      label: a.label,
      type: typeOfExpr(ctx, a.value, owner)?.type_name ?? null,
    }));
    const matching = targets.filter(
      (t) =>
        t.params.length === argTypes.length &&
        t.params.every((p, i) => {
          const a = argTypes[i];
          if (a === undefined) return false;
          if ((p.label ?? null) !== (a.label ?? null)) return false;
          return a.type === null || p.type === null || p.type.base === a.type;
        }),
    );
    if (matching.length >= 1 && matching.length < targets.length)
      targets = matching;
  }
  const many = targets.length > 1;
  for (const t of targets) {
    const e = baseEdge(ctx, owner, call, label);
    if (many) {
      e.confidence = "inferred";
      e.confidence_reason = `\`${label}\` is overloaded (${String(targets.length)} definitions in this file); every candidate is drawn rather than one picked`;
    }
    e.to = t.node_id;
    ctx.sites.push({
      edge: e,
      call,
      owner,
      candidate: null,
      catch_default: false,
    });
  }
}

function pushCandidate(
  ctx: FileContext,
  owner: Owner,
  call: Node,
  args: ArgFact[],
  form: Candidate["form"],
  chain: ChainStep[],
  member: string | null,
  receiver: Receiver | null,
): void {
  const typeName =
    receiver?.type_name ??
    (chain[0]?.kind === "type"
      ? chain[0].name
      : chain[0]?.kind === "instance"
        ? chain[0].type_name
        : null);
  const value =
    member === null
      ? (typeName ?? "?")
      : typeName === null
        ? member
        : `${typeName}.${member}`;
  const e = baseEdge(ctx, owner, call, member ?? typeName ?? "?");
  const hints: SymbolHints = { arity: args.length, receiver_type: typeName };
  e.to = { ref_kind: "symbol", value, hints, source_line: lineStart(call) };
  if (receiver !== null && !receiver.certain && receiver.reason !== null) {
    e.confidence = "inferred";
    e.confidence_reason = receiver.reason;
  }
  const fromType =
    owner.owner_type === null
      ? null
      : (owner.owner_type.merged_into ?? owner.owner_type);
  const candidate: Candidate = {
    edge: e,
    form,
    chain,
    member,
    args,
    result_type: resultType(call),
    consumed: false,
    pending_fork: null,
    from_type:
      fromType === null || fromType.declaration_kind === "extension"
        ? null
        : fromType.node_id,
  };
  ctx.sites.push({ edge: e, call, owner, candidate, catch_default: false });
}
