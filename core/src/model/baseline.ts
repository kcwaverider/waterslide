import { z } from "zod";
import { TierSchema } from "./enums.js";

// Persisted files §1.5 — `baseline.json`. Machine-written, gitignored, personal.
// Parsing reads it and never writes it (§1.6). Included in M0 because the
// tombstone kind (graph model §5.1) is reconstructed from this record.

/**
 * Deliberately narrower than graph model §7's repo record, and a separate type
 * so that adding `path` or `dirty` to the baseline later is a baseline change,
 * not a graph contract change.
 */
export const BaselineRepoSchema = z.strictObject({
  name: z.string(),
  commit: z.string(),
});
export type BaselineRepo = z.infer<typeof BaselineRepoSchema>;

export const BaselineNodeRecordSchema = z.strictObject({
  baseline_hash: z.string(),
  label: z.string(),
  tier: TierSchema,
});
export type BaselineNodeRecord = z.infer<typeof BaselineNodeRecordSchema>;

export const BaselineSchema = z.strictObject({
  schema_version: z.int(),
  captured_at: z.iso.datetime(),
  repos: z.array(BaselineRepoSchema),
  nodes: z.record(z.string(), BaselineNodeRecordSchema),
  edges: z.array(z.string()),
});
export type Baseline = z.infer<typeof BaselineSchema>;
