import { z } from "zod";

/**
 * The `packs.python` block of `config.yaml`. Core reads it at stage 3, hashes
 * it into the cache key (a source-root change renames every `provides` entry),
 * and hands the validated value to `createPythonPack`.
 */
export const PythonPackOptionsSchema = z.strictObject({
  /**
   * Repo-relative directories that are Python import roots, e.g. `["server"]`.
   * A file under a root gets its module name relative to that root; a file
   * under no root is named from the repo root. Default: the repo root only.
   */
  source_roots: z.array(z.string()).default([]),
});
export type PythonPackOptions = z.infer<typeof PythonPackOptionsSchema>;
export type PythonPackOptionsInput = z.input<typeof PythonPackOptionsSchema>;
