import { makeToyPack } from "./toy-pack.js";

/**
 * The toy pack in the shape the CLI loads: a module exporting `pack`. Used by
 * the CLI tests through `--pack`, so the command line is exercised end to end
 * without a real language pack.
 */
export const pack = makeToyPack({ compose: true });
