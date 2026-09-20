import { isAbsolute, resolve } from "node:path";

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
