/**
 * The Swift noise table (data/noise.json): what a call on a typed value must
 * NOT be drawn as. Handoff §2: construct tables are data, not code. See the
 * table's own comments for the rules; this module only reads it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { packRoot } from "./parser.js";
import type { TypeRef } from "./tree.js";

const NameList = z.object({ names: z.array(z.string()) });
const NoiseTableSchema = z.object({
  collection_wrappers: z.record(z.string(), z.string()),
  synthesized_static_members: z.record(z.string(), z.string()),
  view_like_conformances: NameList,
  view_modifiers: NameList,
  stdlib_sequence_members: NameList,
});
type NoiseTable = z.infer<typeof NoiseTableSchema>;

let table: NoiseTable | null = null;

/**
 * Load and validate the table once. A malformed table is a pack packaging
 * error and is reported by name; the per-file pass turns the throw into a
 * `recognizer_failure` diagnostic rather than a TypeError deep in a lookup.
 */
function noise(): NoiseTable {
  if (table === null) {
    const path = join(packRoot(), "data", "noise.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(
        `swift pack: ${path} is not readable as JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = NoiseTableSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `swift pack: ${path} does not match the noise table schema: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    table = parsed.data;
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

/** Whether these conformances make a type a SwiftUI view, per the table. */
export function isViewLike(conformances: readonly string[]): boolean {
  const names = noise().view_like_conformances.names;
  return conformances.some((c) => names.includes(c));
}

/** Whether `member` is a SwiftUI View-extension modifier, per the table. */
export function isViewModifier(member: string): boolean {
  return noise().view_modifiers.names.includes(member);
}

/** Whether `member` is a Standard Library sequence or collection operation, per the table. */
export function isStdlibSequenceMember(member: string): boolean {
  return noise().stdlib_sequence_members.names.includes(member);
}
