import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a tool path against the primary workspace root.
 *
 * Relative paths always mean `<workspaceRoot>/<path>`. Absolute paths are
 * used as-is when the OS permits them. The workspace is not a security
 * boundary.
 */
export function resolveToolPath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}

/**
 * Path shown to the model: workspace-relative with `/` separators, or the
 * absolute path when the target is outside the workspace.
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
