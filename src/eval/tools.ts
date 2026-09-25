import { lstat } from "node:fs/promises";
import type { EvalCase } from "./cases.ts";
import { join } from "node:path";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { resolveToolPath } from "../tools/path.ts";
import { readTool } from "../tools/read.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";

/** Expose only seeded case files and the selected verification command through real core tools. */
export function createEvalTools(project: string, selected?: EvalCase): ToolRegistry {
  const allowed = new Set((selected ? Object.keys(selected.seed) : ["src/math.ts", "test/math.test.ts"]).map(path => join(project, path)));
  const writable = new Set((selected?.writable ?? ["src/math.ts"]).map(path => join(project, path)));
  const command = selected?.verifyCommand ?? (selected ? undefined : "bun test test/math.test.ts");
  const verifyPath = async (path: string, write: boolean): Promise<void> => {
    const target = resolveToolPath(project, path);
    if (!allowed.has(target) || (write && !writable.has(target))) {
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
    if (!command || input.command !== command || input.cwd !== undefined || (input.timeout !== undefined && input.timeout > 5000)) {
      throw new Error("Eval bash permits only the case verification command");
    }
    await verifyPath(selected?.verifyFile ?? "test/math.test.ts", false);
    return bashTool.execute({ command: input.command, timeout: input.timeout ?? 5000 }, ctx);
  } };
  return createToolRegistry([restrictedRead, restrictedEdit, restrictedWrite, restrictedBash]);
}
