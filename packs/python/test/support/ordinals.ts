import type { PerFileResult } from "@waterslide/core";

/**
 * A6 item 2: within an `exclusive_group`, every edge that shares a
 * `branch_ordinal` must originate from the same limb. The dropped uniqueness
 * clause of invariant 15 approximated this badly; the pack records the limb in
 * `pack_data.python.limb` on every fork edge so the property is checkable on
 * the pre-strip output. Returns one line per violation; empty means the
 * property holds.
 */
export function ordinalLimbViolations(
  results: readonly PerFileResult[],
): string[] {
  const out: string[] = [];
  for (const file of results) {
    const limbByOrdinal = new Map<string, Map<number, number>>();
    for (const e of file.result.edges) {
      if (e.exclusive_group === null || e.branch_ordinal === null) continue;
      const py = (e.pack_data as { python?: { limb?: unknown } } | undefined)
        ?.python;
      if (typeof py?.limb !== "number") continue; // dispatch tables carry no limb
      const seen = limbByOrdinal.get(e.exclusive_group) ?? new Map();
      limbByOrdinal.set(e.exclusive_group, seen);
      const prior = seen.get(e.branch_ordinal);
      if (prior === undefined) seen.set(e.branch_ordinal, py.limb);
      else if (prior !== py.limb)
        out.push(
          `${file.path} ${e.exclusive_group}: ordinal ${String(e.branch_ordinal)} from limbs ${String(prior)} and ${String(py.limb)}`,
        );
    }
  }
  return out;
}
