import { lstat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
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
  const bashRestriction = command
    ? `Eval bash permits only the exact command ${JSON.stringify(command)}. Omit cwd; timeout is optional and must be an integer from 1 to 5000 ms (default 5000 ms).`
    : "Eval bash is disabled for this case; use the seeded file tools and let the independent grader verify the result.";
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
  const restrictedBash: typeof bashTool = { ...bashTool,
    description: `${bashRestriction} A non-zero exit code is ordinary result data, not a tool failure.`,
    inputSchema: command ? Type.Object({
      command: Type.Literal(command, { description: "The exact case verification command; other shell commands are forbidden." }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Optional timeout in milliseconds; omit to use 5000 ms." })),
    }, { additionalProperties: false }) : bashTool.inputSchema,
    async execute(input, ctx) {
    if (!command || input.command !== command || input.cwd !== undefined || (input.timeout !== undefined && input.timeout > 5000)) {
      throw new Error(bashRestriction);
    }
    await verifyPath(selected?.verifyFile ?? "test/math.test.ts", false);
    return bashTool.execute({ command: input.command, timeout: input.timeout ?? 5000 }, ctx);
  } };
  return createToolRegistry([restrictedRead, restrictedEdit, restrictedWrite, restrictedBash]);
}
