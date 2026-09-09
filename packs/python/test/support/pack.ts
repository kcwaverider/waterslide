import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createPythonPack, type PythonPack } from "../../src/index.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

export const fixture = (...parts: string[]): string => join(FIXTURES, ...parts);

let shared: Promise<PythonPack> | null = null;

/** One pack per worker; options travel per call (addendum 2026-09-08). */
export function getPack(): Promise<PythonPack> {
  return (shared ??= createPythonPack());
}
