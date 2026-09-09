import { z } from "zod";
import { makeToyPack } from "./toy-pack.js";

/**
 * The toy pack in the shape the CLI loads: a module exporting `pack`, plus an
 * `optionsSchema` so `--pack-option` can coerce and validate values the way a
 * real pack's schema would. Used by the CLI tests through `--pack`.
 */
export const pack = makeToyPack({ compose: true });

export const optionsSchema = z.strictObject({
  source_roots: z.array(z.string()).default([]),
});
