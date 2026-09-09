/**
 * SwiftUI framework recognizer (parser §7 "UI handlers", decisions items 8
 * and 9). Runs after the language recognizer on the same file and only adds:
 * a `ui_handler` node per handler closure, marked as an entry point.
 *
 * Ids follow `{View}.{modifier}[{n}]`, n zero-based in source order and
 * always present, so adding a second `.task` never renames the first. Button
 * labels go in `label`, never in the id.
 */
import { DEFAULT_TIER_BY_KIND } from "@waterslide/core";
import type { Node, Query } from "web-tree-sitter";
import { diag, typeAt, type FileContext, type Owner } from "../context.js";
import { codeId } from "../ids.js";
import { childrenOfType, lineStart } from "../tree.js";
import { span } from "./declarations.js";

/** Approved entry-point modifiers: the five in parser §7 plus item 9's additions. */
export const HANDLER_MODIFIERS: Readonly<Record<string, string>> = {
  onTapGesture: "tap",
  onSubmit: "submit",
  task: "task",
  onAppear: "on appear",
  refreshable: "pull to refresh",
  onChange: "on change",
  onDisappear: "on disappear",
  onReceive: "on receive",
  onOpenURL: "on open URL",
};

interface HandlerSite {
  call: Node;
  closure: Node;
  modifier: string;
  label: string;
}

function buttonAction(call: Node): Node | null {
  const suffix = childrenOfType(call, "call_suffix")[0] ?? null;
  if (suffix === null) return null;
  for (const va of childrenOfType(suffix, "value_arguments")) {
    for (const a of childrenOfType(va, "value_argument")) {
      if (a.childForFieldName("name")?.text === "action") {
        const v = a.childForFieldName("value");
        if (v !== null && v.type === "lambda_literal") return v;
      }
    }
  }
  // Trailing closure form: the first trailing closure is the action.
  return childrenOfType(suffix, "lambda_literal")[0] ?? null;
}

function buttonLabel(call: Node): string {
  const suffix = childrenOfType(call, "call_suffix")[0] ?? null;
  if (suffix !== null) {
    for (const va of childrenOfType(suffix, "value_arguments")) {
      const first = childrenOfType(va, "value_argument")[0];
      const v = first?.childForFieldName("value") ?? null;
      if (
        first !== undefined &&
        first.childForFieldName("name") === null &&
        v !== null &&
        v.type === "line_string_literal"
      ) {
        const text = childrenOfType(v, "line_str_text")
          .map((t) => t.text)
          .join("");
        if (text !== "") return `"${text}" button`;
      }
    }
  }
  return "button";
}

export function collectHandlers(ctx: FileContext, q: Query): void {
  const sites: HandlerSite[] = [];
  const seen = new Set<number>();
  for (const m of q.matches(ctx.root)) {
    const byName = new Map(m.captures.map((c) => [c.name, c.node] as const));
    const modifierCall = byName.get("modifier_call");
    const modifier = byName.get("modifier");
    const buttonCall = byName.get("button_call");
    if (modifierCall !== undefined && modifier !== undefined) {
      if (!(modifier.text in HANDLER_MODIFIERS) || seen.has(modifierCall.id))
        continue;
      const suffix = childrenOfType(modifierCall, "call_suffix")[0] ?? null;
      const closure =
        suffix === null
          ? null
          : (childrenOfType(suffix, "lambda_literal")[0] ?? null);
      if (closure === null) continue;
      seen.add(modifierCall.id);
      const phrase = HANDLER_MODIFIERS[modifier.text] ?? modifier.text;
      let label = phrase;
      if (modifier.text === "onChange" && suffix !== null) {
        const of = suffix
          .descendantsOfType("value_argument")
          .find((a) => a.childForFieldName("name")?.text === "of");
        const v = of?.childForFieldName("value")?.text;
        if (v !== undefined) label = `on change of ${v}`;
      }
      sites.push({
        call: modifierCall,
        closure,
        modifier: modifier.text,
        label,
      });
    } else if (buttonCall !== undefined && !seen.has(buttonCall.id)) {
      const closure = buttonAction(buttonCall);
      if (closure === null) continue;
      seen.add(buttonCall.id);
      sites.push({
        call: buttonCall,
        closure,
        modifier: "Button",
        label: buttonLabel(buttonCall),
      });
    }
  }
  sites.sort((a, b) => a.call.startIndex - b.call.startIndex);

  const counters = new Map<string, number>();
  for (const s of sites) {
    const type = typeAt(ctx, s.call);
    if (type === null) {
      diag(
        ctx,
        "warning",
        "unsupported_construct",
        `SwiftUI handler .${s.modifier} at line ${String(lineStart(s.call))} is not inside a type declaration; no entry point emitted`,
        lineStart(s.call),
      );
      continue;
    }
    const declared = type.merged_into ?? type;
    const typeName =
      declared.declaration_kind === "extension"
        ? (declared.extension_target ?? declared.qualified)
        : declared.qualified;
    ctx.skipCalls.add(s.call.id);
    const key = `${declared.decl.id} ${s.modifier}`;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const qualified = `${typeName}.${s.modifier}[${String(n)}]`;
    const owner: Owner = {
      node_id: codeId(ctx.repo, ctx.path, qualified),
      qualified,
      member: s.modifier,
      form: "handler",
      decl: s.closure,
      body: s.closure,
      owner_type: declared,
      is_static: false,
      params: [],
      return_type: null,
      fact: null,
    };
    ctx.owners.push(owner);
    ctx.nodes.push({
      id: owner.node_id,
      kind: "ui_handler",
      label:
        s.modifier === "Button"
          ? `${typeName} ${s.label}`
          : `${typeName} ${s.label}`,
      tier: DEFAULT_TIER_BY_KIND.ui_handler ?? "ui",
      parent:
        declared.declaration_kind === "extension" ? null : declared.node_id,
      sources: [span(ctx, s.closure)],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: true,
      entry_point_kind: "ui_handler",
      is_infrastructure: false,
      tags: [],
    });
  }
}
