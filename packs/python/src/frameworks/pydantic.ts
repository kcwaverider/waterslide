import type { Field, PayloadSchema } from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type { Emitter } from "../emitter.js";
import type { ClassInfo, FileModel } from "../language/model.js";
import {
  attributeChain,
  keywordArguments,
  lineEnd,
  lineStart,
  positionalArguments,
  stringLiteral,
  unwrapExpression,
} from "../tree-sitter/runtime.js";
import type { FrameworkRecognizer } from "./types.js";

/** Graph model §4: one Pydantic model → one Schema, fields in declaration order. */

const MODEL_BASES = new Set([
  "pydantic.BaseModel",
  "pydantic.main.BaseModel",
  "pydantic.v1.BaseModel",
  "sqlmodel.SQLModel",
  "beanie.Document",
]);

export function schemaIdFor(model: FileModel, className: string): string {
  return `sch:${model.file.repo}:${model.file.path}#${className}`;
}

/** Class name → schema id for every Pydantic model defined in this file. Pure; FastAPI calls it too. */
export function pydanticModels(model: FileModel): Map<string, string> {
  const out = new Map<string, string>();
  const memo = new Map<string, boolean>();
  const isModel = (name: string, stack: Set<string>): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    if (stack.has(name)) return false;
    const info = model.classes.get(name);
    if (!info) return false;
    stack.add(name);
    let result = false;
    for (const base of info.bases) {
      const resolved = model.resolveChain(base, model.moduleScope, null);
      if (resolved.kind === "symbol" && MODEL_BASES.has(resolved.value)) {
        result = true;
        break;
      }
      if (
        resolved.kind === "in_file" &&
        resolved.def.kind === "class" &&
        isModel(resolved.def.name, stack)
      ) {
        result = true;
        break;
      }
    }
    stack.delete(name);
    memo.set(name, result);
    return result;
  };
  for (const name of model.classes.keys()) {
    if (isModel(name, new Set())) out.set(name, schemaIdFor(model, name));
  }
  return out;
}

export const pydanticRecognizer: FrameworkRecognizer = {
  id: "pydantic",
  run(model, em) {
    const models = pydanticModels(model);
    for (const [name, id] of models) {
      const info = model.classes.get(name) as ClassInfo;
      em.addSchema(schemaFor(model, info, id, models));
    }
  },
};

function schemaFor(
  model: FileModel,
  info: ClassInfo,
  id: string,
  models: Map<string, string>,
): PayloadSchema {
  const fields: Field[] = [];
  const body = info.def.node.childForFieldName("body");
  for (const stmt of body?.namedChildren ?? []) {
    if (stmt.type !== "expression_statement") continue;
    const a = stmt.namedChildren[0];
    if (!a || a.type !== "assignment") continue;
    const left = a.childForFieldName("left");
    const type = a.childForFieldName("type");
    if (!left || left.type !== "identifier" || !type) continue;
    if (left.text === "model_config" || left.text.startsWith("_")) continue;
    const right = a.childForFieldName("right");
    const typeText = type.text;
    fields.push({
      name: left.text,
      type: typeText,
      optional: hasDefault(right),
      classification: classificationOf(right),
      ref_schema_id: refSchemaId(typeText, models),
    });
  }
  return {
    id,
    name: info.def.name,
    source: {
      repo: model.file.repo,
      path: model.file.path,
      line_start: lineStart(info.def.outer),
      line_end: lineEnd(info.def.outer),
    },
    confidence: "certain",
    confidence_reason: null,
    fields,
  };
}

/**
 * A field may be absent only when it has a default. `Field(...)` — the ellipsis
 * default — and a bare `Field()` are required; `Field(default=...)`,
 * `Field(default_factory=...)` and any plain value are defaults. Nullability
 * (`Optional[str]` with no default) is not absence.
 */
function hasDefault(right: Node | null): boolean {
  if (!right) return false;
  const expr = unwrapExpression(right);
  if (expr.type === "ellipsis") return false;
  if (expr.type === "call") {
    const fn = expr.childForFieldName("function");
    const chain = fn ? attributeChain(fn) : null;
    if (chain && chain[chain.length - 1] === "Field") {
      const args = expr.childForFieldName("arguments");
      const first = positionalArguments(args)[0];
      if (first && first.type !== "ellipsis") return true;
      const kwargs = keywordArguments(args);
      const dflt = kwargs.get("default");
      if (dflt && dflt.type !== "ellipsis") return true;
      return kwargs.has("default_factory");
    }
  }
  return true;
}

/**
 * Graph model §4.1: the preferred source of truth is a `Field(...)` annotation
 * next to the type — `Field(..., classification=[...])` or
 * `Field(..., json_schema_extra={"classification": [...]})`.
 */
function classificationOf(right: Node | null): string[] {
  if (!right || right.type !== "call") return [];
  const fn = right.childForFieldName("function");
  const chain = fn ? attributeChain(fn) : null;
  if (!chain || chain[chain.length - 1] !== "Field") return [];
  const kwargs = keywordArguments(right.childForFieldName("arguments"));
  let list: Node | undefined = kwargs.get("classification");
  const extra = kwargs.get("json_schema_extra");
  if (!list && extra && extra.type === "dictionary") {
    for (const pair of extra.namedChildren) {
      if (pair.type !== "pair") continue;
      if (stringLiteral(pair.childForFieldName("key")) === "classification") {
        list = pair.childForFieldName("value") ?? undefined;
      }
    }
  }
  if (!list || list.type !== "list") return [];
  const labels = list.namedChildren
    .map((n) => stringLiteral(n))
    .filter((s): s is string => s !== null);
  return [...new Set(labels)].sort();
}

/**
 * KNOWN LIMITATION: regex over the field's type text, the wrong mechanism for
 * the same reason as `annotationChain` in language/analyze.ts — a dotted or
 * aliased `Optional`/`List`/`Dict` is not unwrapped and the field loses its
 * `ref_schema_id`. Graceful (a missing link, never a wrong one). The fix is the
 * same: resolve the wrapper's head Node through the import table.
 */
function refSchemaId(
  typeText: string,
  models: Map<string, string>,
): string | null {
  let t = typeText.trim().replace(/^["']|["']$/g, "");
  for (;;) {
    const m =
      /^(Optional|List|list|Sequence|Set|set|Dict|dict|Annotated)\[(.*)\]$/s.exec(
        t,
      );
    if (!m) break;
    const inner = splitTopLevel(m[2] as string);
    t =
      (m[1] === "Dict" || m[1] === "dict"
        ? inner[inner.length - 1]
        : inner[0]
      )?.trim() ?? "";
  }
  t = t.replace(/\s*\|\s*None$/, "").replace(/^None\s*\|\s*/, "");
  return models.get(t) ?? null;
}

/** Split type arguments on top-level commas only: `Dict[str, Dict[str, Item]]` keeps its nesting. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
