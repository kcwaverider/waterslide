/**
 * The per-run summary (handoff §6 item 6): every unresolved reference the
 * pack emitted, grouped by ref_kind, plus the coverage figures that say how
 * much of Stage 3's join can work. Printed every run; this is a metric.
 */
import type { PackResult, PartialEdge, UnresolvedRef } from "@waterslide/core";
import type { ComposeReport } from "./compose.js";

const byteCmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function unresolved(e: PartialEdge): UnresolvedRef | null {
  return typeof e.to === "string" ? null : e.to;
}

export function formatSummary(
  merged: PackResult,
  report: ComposeReport | null,
): string {
  const lines: string[] = [];
  const nodesByKind = new Map<string, number>();
  let entryPoints = 0;
  for (const n of merged.nodes) {
    nodesByKind.set(n.kind, (nodesByKind.get(n.kind) ?? 0) + 1);
    if (n.is_entry_point) entryPoints++;
  }
  lines.push(
    `nodes: ${String(merged.nodes.length)} (${[...nodesByKind.entries()]
      .sort((a, b) => byteCmp(a[0], b[0]))
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ")})`,
  );
  lines.push(
    `entry points: ${String(entryPoints)}; edges: ${String(merged.edges.length)}; schemas: ${String(merged.schemas.length)}; provides: ${String(merged.provides.length)}`,
  );

  const http = merged.edges.filter((e) => e.kind === "http_request");
  const httpResolved = http.filter(
    (e) => unresolved(e)?.value !== "{unresolved}",
  );
  const httpCertain = http.filter((e) => e.confidence === "certain");
  lines.push("");
  lines.push(
    `outbound HTTP call sites: ${String(http.length)}; with a resolved path: ${String(httpResolved.length)} (${http.length === 0 ? "n/a" : `${String(Math.round((100 * httpResolved.length) / http.length))}%`}); read directly (certain): ${String(httpCertain.length)}; via helper (inferred): ${String(report?.http_via_helper ?? 0)}`,
  );
  lines.push("  resolved paths:");
  const paths = new Map<string, number>();
  for (const e of httpResolved) {
    const ref = unresolved(e);
    if (ref === null) continue;
    const hints = ref.ref_kind === "http" ? ref.hints : undefined;
    const method = hints?.method ?? "?";
    const key = `${method} ${ref.value}${hints?.query === undefined || hints.query === null ? "" : `?${hints.query}`}`;
    paths.set(key, (paths.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...paths.entries()].sort((a, b) => byteCmp(a[0], b[0])))
    lines.push(`    ${k}${v > 1 ? `  ×${String(v)}` : ""}`);
  const httpUnresolved = http.filter((e) => !httpResolved.includes(e));
  lines.push(`  unresolved paths: ${String(httpUnresolved.length)}`);
  for (const e of httpUnresolved) {
    lines.push(
      `    ${e.from} @${String(e.source?.line_start ?? 0)}: ${e.confidence_reason ?? "(no reason)"}`,
    );
  }

  lines.push("");
  lines.push("UnresolvedRef by ref_kind (handed to stage 4):");
  const byKind = new Map<string, Map<string, number>>();
  for (const e of merged.edges) {
    const ref = unresolved(e);
    if (ref === null) continue;
    const m = byKind.get(ref.ref_kind) ?? new Map<string, number>();
    m.set(ref.value, (m.get(ref.value) ?? 0) + 1);
    byKind.set(ref.ref_kind, m);
  }
  for (const [kind, m] of [...byKind.entries()].sort((a, b) =>
    byteCmp(a[0], b[0]),
  )) {
    const total = [...m.values()].reduce((s, v) => s + v, 0);
    lines.push(
      `  ${kind}: ${String(total)} ref(s), ${String(m.size)} distinct`,
    );
    if (kind === "symbol") {
      for (const [v, n] of [...m.entries()].sort((a, b) => byteCmp(a[0], b[0])))
        lines.push(`    ${v}${n > 1 ? `  ×${String(n)}` : ""}`);
    }
  }
  const inFile = merged.edges.filter((e) => typeof e.to === "string").length;
  lines.push(`  resolved within a file (string targets): ${String(inFile)}`);

  if (report !== null) {
    lines.push("");
    lines.push(
      `not drawn: ${String([...report.external_refs.values()].reduce((s, v) => s + v, 0))} call site(s) on types not declared in the pack, ${String([...report.external_functions.values()].reduce((s, v) => s + v, 0))} free-function call(s) not declared in the pack`,
    );
    const top = [...report.external_refs.entries()]
      .sort((a, b) => b[1] - a[1] || byteCmp(a[0], b[0]))
      .slice(0, 15);
    lines.push(
      `  top types: ${top.map(([k, v]) => `${k} ${String(v)}`).join(", ")}`,
    );
    const topF = [...report.external_functions.entries()]
      .sort((a, b) => b[1] - a[1] || byteCmp(a[0], b[0]))
      .slice(0, 10);
    lines.push(
      `  top functions: ${topF.map(([k, v]) => `${k} ${String(v)}`).join(", ")}`,
    );
    lines.push(
      `extensions: ${String(report.extensions_merged)} merged into a declared type, ${String(report.extensions_minted)} minted at the extension file (declaring file not in pack); hop-cap stops: ${String(report.hop_cap_hits)}`,
    );
  }

  lines.push("");
  const diagByCode = new Map<string, number>();
  for (const d of merged.diagnostics)
    diagByCode.set(
      `${d.severity} ${d.code}`,
      (diagByCode.get(`${d.severity} ${d.code}`) ?? 0) + 1,
    );
  lines.push(
    `diagnostics: ${String(merged.diagnostics.length)}${
      diagByCode.size === 0
        ? ""
        : ` (${[...diagByCode.entries()]
            .sort((a, b) => byteCmp(a[0], b[0]))
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(", ")})`
    }`,
  );
  return lines.join("\n");
}
