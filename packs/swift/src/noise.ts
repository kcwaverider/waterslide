/**
 * The Swift noise table (data/noise.json): what a call on a typed value must
 * NOT be drawn as. Handoff §2: construct tables are data, not code. See the
 * table's own comments for the rules; this module only reads it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packRoot } from "./parser.js";
import type { TypeRef } from "./tree.js";

interface NoiseTable {
  collection_wrappers: Record<string, string>;
  synthesized_static_members: Record<string, string>;
  view_like_conformances: { names: string[] };
  view_modifiers: { names: string[] };
  stdlib_sequence_members: { names: string[] };
}

let table: NoiseTable | null = null;
function noise(): NoiseTable {
  if (table === null) {
    table = JSON.parse(
      readFileSync(join(packRoot(), "data", "noise.json"), "utf8"),
    ) as NoiseTable;
  }
  return table;
}

/**
 * The type a value of this declared type is really an instance of, for the
 * purpose of resolving a member call on it: `[Memory]` is an `Array`,
 * `[String: Memory]` a `Dictionary`. Optional is transparent. The wrapper
 * names come from the table so the mapping is data.
 */
export function receiverTypeName(t: TypeRef): string {
  const w = noise().collection_wrappers;
  if (t.array) return w.array ?? "Array";
  if (t.dictionary) return w.dictionary ?? "Dictionary";
  return t.base;
}

/** `allCases` → `Array`; null for a static member the compiler does not synthesize. */
export function synthesizedStaticType(member: string): string | null {
  const m = noise().synthesized_static_members;
  const t = Object.prototype.hasOwnProperty.call(m, member)
    ? m[member]
    : undefined;
  return t === undefined || member.startsWith("$") ? null : t;
}

export function isViewLike(conformances: readonly string[]): boolean {
  const names = noise().view_like_conformances.names;
  return conformances.some((c) => names.includes(c));
}

export function isViewModifier(member: string): boolean {
  return noise().view_modifiers.names.includes(member);
}

export function isStdlibSequenceMember(member: string): boolean {
  return noise().stdlib_sequence_members.names.includes(member);
}
