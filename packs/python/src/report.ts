import type { UnresolvedRef } from "@waterslide/core";
import type { PerFileResult } from "@waterslide/core";

/**
 * Handoff §6 item 6: every `UnresolvedRef` that left the pack, grouped by
 * `ref_kind` and then by value, so the summary reads as a coverage metric.
 * Callers subtract whatever stage 4 resolved before printing.
 */
export interface UnresolvedSummary {
  readonly total: number;
  readonly by_kind: Record<
    UnresolvedRef["ref_kind"],
    { count: number; values: Record<string, number> }
  >;
}

export function summarizeUnresolved(
  results: readonly PerFileResult[],
  isResolved: (ref: UnresolvedRef, at: PerFileResult) => boolean = () => false,
): UnresolvedSummary {
  // Null-prototype maps: a Python identifier named `constructor` or `__proto__`
  // must count like any other value.
  const bucket = (): { count: number; values: Record<string, number> } => ({
    count: 0,
    values: Object.create(null) as Record<string, number>,
  });
  const by_kind: UnresolvedSummary["by_kind"] = {
    symbol: bucket(),
    http: bucket(),
    topic: bucket(),
    datastore: bucket(),
    external: bucket(),
  };
  let total = 0;
  for (const file of results) {
    for (const edge of file.result.edges) {
      if (typeof edge.to === "string") continue;
      if (isResolved(edge.to, file)) continue;
      total += 1;
      const bucket = by_kind[edge.to.ref_kind];
      bucket.count += 1;
      bucket.values[edge.to.value] = (bucket.values[edge.to.value] ?? 0) + 1;
    }
  }
  return { total, by_kind };
}

export function formatUnresolved(
  summary: UnresolvedSummary,
  limitPerKind = 25,
): string {
  const lines = [`Unresolved references: ${String(summary.total)}`];
  for (const kind of [
    "symbol",
    "http",
    "topic",
    "datastore",
    "external",
  ] as const) {
    const bucket = summary.by_kind[kind];
    lines.push(`  ${kind}: ${String(bucket.count)}`);
    const entries = Object.entries(bucket.values).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    );
    for (const [value, count] of entries.slice(0, limitPerKind)) {
      lines.push(`    ${String(count).padStart(4)}  ${value}`);
    }
    if (entries.length > limitPerKind)
      lines.push(`    ... ${String(entries.length - limitPerKind)} more`);
  }
  return lines.join("\n");
}
