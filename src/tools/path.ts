import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a tool path against the primary workspace root.
 *
 * Relative paths always mean `<workspaceRoot>/<path>`; absolute paths are normalized independently.
 * Resolution is lexical, with no filesystem access or symlink canonicalization;
 * callers supply the canonical workspace root, which is not a security boundary.
 */
export function resolveToolPath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}

/**
 * Return a workspace-relative display path with `/` separators, or the supplied path when it lies outside.
 * The root itself displays as `.`; relative names beginning with `..` also retain the supplied path.
 */
export function displayToolPath(workspaceRoot: string, resolvedPath: string): string {
  const rel = relative(workspaceRoot, resolvedPath);
  if (rel === "") {
    return ".";
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return resolvedPath;
  }
  return rel.split(sep).join("/");
}
