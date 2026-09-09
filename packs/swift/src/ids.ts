/**
 * Identity helpers. Node ids follow graph model §1. `spanHash` is core's
 * export (decisions item 6c): one implementation, every pack calls it.
 */
import { spanHash, type Visibility } from "@waterslide/core";

export { spanHash };

export function moduleId(repo: string, path: string): string {
  return `${repo}:${path}`;
}

export function codeId(repo: string, path: string, qualified: string): string {
  return `${repo}:${path}#${qualified}`;
}

export function schemaId(
  repo: string,
  path: string,
  qualified: string,
): string {
  return `sch:${repo}:${path}#${qualified}`;
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Decisions item 5: open/public → public, private/fileprivate → private,
 * everything else → module. No module boundary is modeled; which target a
 * file belongs to is not visible from the file (parser §10 open question:
 * "Where does provides visibility come from in Swift, given module targets
 * aren't visible from a single file?"). project.pbxproj is deliberately not
 * read.
 */
export function visibilityOf(modifierText: string | null): Visibility {
  switch (modifierText) {
    case "open":
    case "public":
      return "public";
    case "private":
    case "fileprivate":
      return "private";
    default:
      return "module";
  }
}
