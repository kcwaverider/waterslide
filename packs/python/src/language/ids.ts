/** Graph model §1: `{repo}:{path}` for a module, `{repo}:{path}#{qualified_name}` for a code node. */
export function moduleNodeId(repo: string, path: string): string {
  return `${repo}:${path}`;
}

export function codeNodeId(
  repo: string,
  path: string,
  qualifiedName: string,
): string {
  return `${repo}:${path}#${qualifiedName}`;
}
