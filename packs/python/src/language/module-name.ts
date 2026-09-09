/**
 * Path → importable module name (parser §3.4). `server/api/endpoints/memory.py`
 * with source root `server` is `api.endpoints.memory`; `__init__.py` names its
 * package. A file under no configured root is named from the repo root.
 */
export function moduleNameForPath(
  path: string,
  sourceRoots: readonly string[],
): { module: string; package: string } {
  const normalizedRoots = sourceRoots
    .map((r) => r.replace(/^\.\/|^\/|\/$/g, ""))
    .filter((r) => r !== "" && r !== ".");
  // Longest matching root wins so nested roots behave.
  const root = normalizedRoots
    .filter((r) => path.startsWith(r + "/"))
    .sort((a, b) => b.length - a.length)[0];
  const relative = root ? path.slice(root.length + 1) : path;
  const withoutExt = relative.replace(/\.pyi?$/, "");
  const parts = withoutExt.split("/").filter((p) => p !== "");
  const isInit = parts[parts.length - 1] === "__init__";
  if (isInit) parts.pop();
  const module = parts.join(".");
  const pkg = isInit ? module : parts.slice(0, -1).join(".");
  return { module, package: pkg };
}

/**
 * Resolve a `from` target to a qualified module name. `level` is the count of
 * leading dots; `name` the dotted part after them (may be empty for `from . import x`).
 */
export function resolveRelativeModule(
  currentPackage: string,
  level: number,
  name: string,
): string | null {
  if (level === 0) return name;
  const parts = currentPackage === "" ? [] : currentPackage.split(".");
  const up = level - 1;
  if (up > parts.length) return null;
  const base = parts.slice(0, parts.length - up);
  if (name !== "") base.push(...name.split("."));
  return base.join(".");
}
