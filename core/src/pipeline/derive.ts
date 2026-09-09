import picomatch from "picomatch";
import { FIXED_ID_SCOPES } from "../model/enums.js";
import type { Node } from "../model/graph.js";
import type { WaterslideConfig } from "./config.js";

/**
 * Stage 5, the parts that need only nodes: tiers and parents. `skips_tiers`
 * and edge ids need resolved edges and live with stage 4's consumer.
 */

/** For a repo-scoped id, the declaring path; null for fixed-scope ids. */
export function nodeIdPath(id: string): string | null {
  const colon = id.indexOf(":");
  if (colon === -1) return null;
  const scope = id.slice(0, colon);
  if (FIXED_ID_SCOPES.has(scope)) return null;
  const locator = id.slice(colon + 1);
  const hash = locator.indexOf("#");
  return hash === -1 ? locator : locator.slice(0, hash);
}

/**
 * Graph model §6: declared always wins. A config glob is matched against the
 * node's declaring path, first match wins. With no match the pack's tier
 * stands — the pack emits every node with a tier already, applying the §6.1
 * kind default where it knows nothing better, and core does not second-guess
 * it. Synthetic nodes have no path and are never matched by a glob.
 */
export function assignTiers(
  nodes: readonly Node[],
  config: WaterslideConfig,
): Node[] {
  const assign = config.tiers?.assign ?? [];
  if (assign.length === 0) return nodes.map((n) => ({ ...n }));
  const matchers = assign.map((a) => ({
    match: picomatch(a.glob, { dot: true }),
    tier: a.tier,
  }));
  return nodes.map((node) => {
    const path = nodeIdPath(node.id);
    if (path === null) return { ...node };
    const hit = matchers.find((m) => m.match(path));
    return hit === undefined ? { ...node } : { ...node, tier: hit.tier };
  });
}

/**
 * Graph model §2.3: the hierarchy derives from folder structure for the POC.
 * The pack sets `parent` where it knows it; core fills a null parent on a
 * `{repo}:{path}#name` node with its module node `{repo}:{path}` when that
 * node exists. Core mints no folder or service nodes.
 */
export function fillParents(nodes: readonly Node[]): Node[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes.map((node) => {
    if (node.parent !== null) return { ...node };
    const hash = node.id.indexOf("#");
    if (hash === -1 || nodeIdPath(node.id) === null) return { ...node };
    const moduleId = node.id.slice(0, hash);
    return ids.has(moduleId) && moduleId !== node.id
      ? { ...node, parent: moduleId }
      : { ...node };
  });
}
