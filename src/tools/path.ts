import { isAbsolute, resolve } from "node:path";

export function resolveToolPath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
}
