/**
 * @waterslide/pack-swift: Swift language pack with SwiftUI and URLSession
 * framework recognizers (parser pipeline §3, §7).
 */
import {
  GRAPH_SCHEMA_VERSION,
  assertPackCompatible,
  type LanguagePack,
  type PackManifest,
  type PackOptions,
  type PackPatch,
  type PackResult,
  type PerFileResult,
} from "@waterslide/core";
import { analyzeFile, type FileAnalysis } from "./analyze.js";
import { compose } from "./compose.js";
import { rePath } from "./repath.js";

export const manifest: PackManifest = {
  id: "swift",
  version: "0.1.0",
  graph_schema_version: GRAPH_SCHEMA_VERSION,
  extensions: [".swift"],
  frameworks: ["swiftui", "urlsession"],
};

export class SwiftPack implements LanguagePack {
  readonly manifest = manifest;

  constructor() {
    assertPackCompatible(manifest);
  }

  /** The contract: five returns, never throws. */
  async parse(
    repo_name: string,
    path: string,
    content: string,
    options: PackOptions,
  ): Promise<PackResult> {
    void options; // Swift declares no options yet; they arrive per call and are never stored
    return (await analyzeFile(repo_name, path, content)).result;
  }

  /** The five returns plus the per-file state `compose` needs, cached together. */
  analyze(
    repo_name: string,
    path: string,
    content: string,
  ): Promise<FileAnalysis> {
    return analyzeFile(repo_name, path, content);
  }

  /** Cross-file pass (decisions item 1). `results` must arrive sorted by (repo, path). */
  compose(results: PerFileResult[], options: PackOptions): PackPatch {
    void options;
    return compose(results);
  }

  /** Cache hit for a moved file (amendment B3): recompute every path-derived field. */
  rePath(
    result: PerFileResult,
    repo: string,
    path: string,
    options: PackOptions,
  ): PerFileResult {
    void options;
    return rePath(result, repo, path);
  }
}

/** The pack module export fixed for all tracks (amendment B2). */
export const pack: LanguagePack = new SwiftPack();

export { analyzeFile } from "./analyze.js";
export type { FileAnalysis } from "./analyze.js";
export { applyPatch, compose, composeWithReport } from "./compose.js";
export { PACK_DATA_KEY, stateOf } from "./compose.js";
export type { ComposeReport } from "./compose.js";
export { spanHash } from "./ids.js";
export { rePath } from "./repath.js";
export { formatSummary } from "./summary.js";
export { STATE_VERSION, SwiftFileStateSchema } from "./state.js";
export type { SwiftFileState } from "./state.js";
