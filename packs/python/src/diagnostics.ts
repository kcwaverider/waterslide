import type { Diagnostic, DiagnosticSeverity } from "@waterslide/core";

export const PACK_ID = "python";

export interface DiagnosticSite {
  readonly repo: string;
  readonly path: string;
}

export function diagnostic(
  site: DiagnosticSite,
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  line: number | null,
): Diagnostic {
  return {
    severity,
    code,
    message,
    repo: site.repo,
    path: site.path,
    line,
    pack: PACK_ID,
  };
}
