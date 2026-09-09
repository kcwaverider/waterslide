import type { Emitter } from "../emitter.js";
import type { FileModel } from "../language/model.js";

/**
 * A framework recognizer runs after the language layer on the same file and may
 * only add to or annotate what it found (parser §3.2). It reads the `FileModel`
 * and writes through the `Emitter`; it never re-parses and never changes an id.
 * Adding Django means adding a directory here and one entry in the registry.
 */
export interface FrameworkRecognizer {
  readonly id: string;
  run(model: FileModel, em: Emitter): void;
}
