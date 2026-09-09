import { z } from "zod";
import { TierSchema } from "../model/enums.js";
import { PackOptionsSchema, type PackOptions } from "../model/pack.js";
import { canonicalJson, sha256Hex } from "./hash.js";

/**
 * In-memory config types — persisted-files §3, as the pipeline sees them.
 * Reading `config.yaml` from disk is M3; nothing here touches a file. Stage 5
 * (tiers) and stage 3 (pack options) consume these shapes.
 */

export const TierAssignSchema = z.strictObject({
  glob: z.string(),
  tier: TierSchema,
});
export type TierAssign = z.infer<typeof TierAssignSchema>;

/** Persisted-files §3.1. `assign` is matched first-match-wins against a node's declaring path. */
export const TierConfigSchema = z.strictObject({
  order: z.array(TierSchema).optional(),
  external_column: z.enum(["left", "right"]).optional(),
  assign: z.array(TierAssignSchema),
});
export type TierConfig = z.infer<typeof TierConfigSchema>;

export const WaterslideConfigSchema = z.strictObject({
  tiers: TierConfigSchema.optional(),
  /** Per-pack options blocks, keyed by pack id (parser §3.3). */
  packs: z.record(z.string(), PackOptionsSchema).optional(),
  /** Parser §1.3: tests are excluded by default. */
  include_tests: z.boolean().optional(),
});
export type WaterslideConfig = z.infer<typeof WaterslideConfigSchema>;

export const EMPTY_CONFIG: WaterslideConfig = {};

const HASH_PREFIX = "sha256:";
const HASH_CHARS = 16;

/**
 * Graph model §7: `tier_config_hash` invalidates layout when tiers change.
 * `sha256:` + first 16 hex over the canonical JSON of the tiers block. No
 * tiers block, or one with nothing in it, hashes the empty string — which is
 * the value the committed fixtures carry.
 */
export function tierConfigHash(config: WaterslideConfig): string {
  const tiers = config.tiers;
  const empty =
    tiers === undefined ||
    (tiers.assign.length === 0 &&
      tiers.order === undefined &&
      tiers.external_column === undefined);
  const text = empty ? "" : canonicalJson(tiers);
  return HASH_PREFIX + sha256Hex(text).slice(0, HASH_CHARS);
}

/**
 * The pack's resolved options block. Core passes this on every pack call
 * (parser §3.3). Defaults are the pack's to declare; until the manifest
 * carries them, an absent block resolves to `{}`.
 */
export function resolvePackOptions(
  config: WaterslideConfig,
  packId: string,
): PackOptions {
  return config.packs?.[packId] ?? {};
}

/** Part of the cache key (parser §2.1): a change to options must miss the cache. */
export function packOptionsHash(options: PackOptions): string {
  return sha256Hex(canonicalJson(options));
}
