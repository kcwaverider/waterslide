import picomatch from "picomatch";
import { byteCompare } from "../canonical.js";
import { DEFAULT_TIER_BY_KIND, FIXED_ID_SCOPES } from "../model/enums.js";
import type { Node } from "../model/graph.js";
import type { WaterslideConfig } from "./config.js";

/**
 * Stage 5, the parts that need only nodes: tiers, infrastructure and parents.
 * `skips_tiers` and edge ids need resolved edges and live with stage 4's
 * consumer.
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
 * Persisted-files §3.2, policy §5: `is_infrastructure` is set by a declared
 * glob and never inferred. A glob is matched against every span's
 * repo-relative path, so a definition split across files is still one node
 * and matches if ANY of its spans does. A node with no sources — everything
 * resolution mints: collections, external services, unknowns — can never
 * match. No kind is excluded on purpose: UI §5.3 names the user collection as
 * the canonical hub this flag exists for, so a pack that one day emits a
 * collection with a declaring span must stay eligible. With no markers every
 * node keeps the pack's value, which is always false.
 */
export function markInfrastructure(
  nodes: readonly Node[],
  config: WaterslideConfig,
): Node[] {
  const markers = config.infrastructure ?? [];
  if (markers.length === 0) return nodes.map((n) => ({ ...n }));
  const matchers = markers.map((m) => picomatch(m.glob, { dot: true }));
  return nodes.map((node) => {
    const hit = node.sources.some((s) => matchers.some((m) => m(s.path)));
    return hit ? { ...node, is_infrastructure: true } : { ...node };
  });
}

/**
 * Graph model §2.3: `parent` is the sole zoom mechanism and the hierarchy
 * derives from folder structure for the POC, so the chain runs function →
 * module → directory … → repo. The pack sets `parent` where it knows it and
 * core fills only null parents:
 *
 * - a `{repo}:{path}#name` node gets its module node `{repo}:{path}` when
 *   that node exists;
 * - a module with no parent gets the nearest minted directory above it;
 * - each directory level between a module and the repo root is minted as a
 *   `module` node `{repo}:{dir}` (§1: a directory is a path, so the module id
 *   form covers it) with empty `sources` (§2.4, synthetic), the §6.1 default
 *   tier, and the directory name as label;
 * - the repo root is `svc:{repo}`, kind `service`, `parent: null` — §1 says a
 *   locator is non-empty, so `{repo}:` is not an id, and §1's Service row is
 *   the top of §2.3's chain. It is minted only when no pack already did.
 *
 * A directory whose only child is a single directory adds a rung and no
 * information, so it is not minted and its child attaches to the nearest kept
 * ancestor: `iOS/Tapistree/Tapistree` hangs off the repo, not off `iOS`.
 *
 * Minted nodes are derived from the set of module ids alone and the result is
 * re-sorted byte-wise by id, so discovery order cannot reach the output. The
 * chain is a tree by construction: every parent set here is a strict prefix
 * of the child's path or the repo root.
 */
export function completeHierarchy(nodes: readonly Node[]): Node[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: Node[] = nodes.map((n) => ({ ...n }));

  // Modules that need a parent, and the directory tree they imply. A key is
  // `${repo}:${dir}` ("" for the repo root) — a repo name has no `:` (§1), so
  // the first colon splits it back; a value maps each child name to whether
  // it is a directory.
  const orphans: { node: Node; repo: string; path: string }[] = [];
  const children = new Map<string, Map<string, boolean>>();
  const key = (repo: string, dir: string): string => `${repo}:${dir}`;
  for (const node of out) {
    if (node.parent !== null || node.id.includes("#")) continue;
    const path = nodeIdPath(node.id);
    if (path === null) continue;
    const repo = node.id.slice(0, node.id.indexOf(":"));
    orphans.push({ node, repo, path });
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const k = key(repo, segments.slice(0, i).join("/"));
      let kids = children.get(k);
      if (kids === undefined) children.set(k, (kids = new Map()));
      const name = segments[i] as string;
      // A name seen as both a directory and a file (`a/b` and `a/b/c.py`)
      // counts as a directory: it has something under it.
      kids.set(name, (kids.get(name) ?? false) || i < segments.length - 1);
    }
  }

  const kept = (repo: string, dir: string): boolean => {
    if (dir === "") return true;
    const kids = children.get(key(repo, dir));
    if (kids === undefined) return false;
    return !(kids.size === 1 && kids.values().next().value === true);
  };
  const parentFor = (repo: string, path: string): string => {
    let dir = path;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      dir = slash === -1 ? "" : dir.slice(0, slash);
      if (dir === "") return `svc:${repo}`;
      if (kept(repo, dir)) return `${repo}:${dir}`;
    }
  };
  const mint = (
    id: string,
    kind: "module" | "service",
    label: string,
    parent: string | null,
  ): void => {
    if (ids.has(id)) return;
    ids.add(id);
    out.push({
      id,
      kind,
      label,
      tier: DEFAULT_TIER_BY_KIND[kind] ?? "domain",
      parent,
      sources: [],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [],
    });
  };

  for (const k of children.keys()) {
    const colon = k.indexOf(":");
    const repo = k.slice(0, colon);
    const dir = k.slice(colon + 1);
    if (dir === "") mint(`svc:${repo}`, "service", repo, null);
    else if (kept(repo, dir)) {
      const label = dir.slice(dir.lastIndexOf("/") + 1);
      mint(`${repo}:${dir}`, "module", label, parentFor(repo, dir));
    }
  }
  for (const o of orphans) o.node.parent = parentFor(o.repo, o.path);

  for (const node of out) {
    if (node.parent !== null) continue;
    const hash = node.id.indexOf("#");
    if (hash === -1 || nodeIdPath(node.id) === null) continue;
    const moduleId = node.id.slice(0, hash);
    if (ids.has(moduleId) && moduleId !== node.id) node.parent = moduleId;
  }

  return out.sort((a, b) => byteCompare(a.id, b.id));
}
