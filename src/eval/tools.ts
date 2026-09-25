import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { resolveToolPath } from "../tools/path.ts";
import { readTool } from "../tools/read.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";

/** Expose only the case's files and one verification command through real core tools. */
export function createEvalTools(project: string): ToolRegistry {
  const source = join(project, "src/math.ts");
  const testFile = join(project, "test/math.test.ts");
  const verifyPath = async (path: string, writable: boolean): Promise<void> => {
    const target = resolveToolPath(project, path);
    if (target !== source && (writable || target !== testFile)) {
      throw new Error("Eval tool path is outside the allowed case files");
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Eval tool path is not a regular case file");
  };
  const restrictedRead: typeof readTool = { ...readTool, async execute(input, ctx) {
    await verifyPath(input.path, false);
    return readTool.execute(input, ctx);
  } };
  const restrictedEdit: typeof editTool = { ...editTool, async execute(input, ctx) {
    await verifyPath(input.path, true);
    return editTool.execute(input, ctx);
  } };
  const restrictedWrite: typeof writeTool = { ...writeTool, async execute(input, ctx) {
    await verifyPath(input.path, true);
    return writeTool.execute(input, ctx);
  } };
  const restrictedBash: typeof bashTool = { ...bashTool, async execute(input, ctx) {
    if (input.command !== "bun test test/math.test.ts" || input.cwd !== undefined || (input.timeout !== undefined && input.timeout > 5000)) {
      throw new Error("Eval bash permits only the case verification command");
    }
    await verifyPath("test/math.test.ts", false);
    return bashTool.execute({ command: input.command, timeout: input.timeout ?? 5000 }, ctx);
  } };
  return createToolRegistry([restrictedRead, restrictedEdit, restrictedWrite, restrictedBash]);
}
