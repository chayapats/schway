import { lstat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { EvalCase } from "./cases.ts";
import { dirname } from "node:path";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { DEFAULT_LS_DEPTH, MAX_LS_BYTES, lsTool, type LsDetails } from "../tools/ls.ts";
import { utf8ByteLength } from "../tools/output-budget.ts";
import { displayToolPath, resolveToolPath } from "../tools/path.ts";
import { readTool } from "../tools/read.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";

/** Expose seeded-file discovery, restricted file operations, and the selected verification command. */
export function createEvalTools(project: string, selected?: EvalCase): ToolRegistry {
  const root = resolveToolPath(project, ".");
  const allowed = new Set((selected ? Object.keys(selected.seed) : ["src/math.ts", "test/math.test.ts"]).map(path => resolveToolPath(root, path)));
  const writable = new Set((selected?.writable ?? ["src/math.ts"]).map(path => resolveToolPath(root, path)));
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
  const directories = new Set([root]);
  for (const file of allowed) {
    for (let directory = dirname(file); directory !== root && directory !== dirname(directory); directory = dirname(directory)) directories.add(directory);
  }
  const entries = [...allowed, ...directories].filter(path => path !== root).sort((a, b) => a.localeCompare(b));
  const restrictedLs: typeof lsTool = { ...lsTool,
    description: "List only selected seeded case files and their parent directories; other filesystem entries are hidden. Relative paths resolve from the workspace root. Omit path to list the root; depth defaults to 1.",
    async execute(input, ctx) {
      const path = input.path ?? ".";
      const resolvedPath = resolveToolPath(root, path);
      if (!directories.has(resolvedPath)) throw new Error("Eval listing path is outside the allowed case directories");
      const depth = input.depth ?? DEFAULT_LS_DEPTH;
      const lines: string[] = [];
      let bytes = 0;
      const walk = (directory: string, remaining: number): boolean => {
        ctx.signal?.throwIfAborted();
        for (const entry of entries.filter(target => dirname(target) === directory)) {
          const isDirectory = directories.has(entry);
          const line = displayToolPath(root, entry) + (isDirectory ? "/" : "");
          const extra = (lines.length === 0 ? 0 : 1) + utf8ByteLength(line);
          if (lines.length > 0 && bytes + extra > MAX_LS_BYTES) return true;
          lines.push(line);
          bytes += extra;
          if (isDirectory && remaining > 1 && walk(entry, remaining - 1)) return true;
        }
        return false;
      };
      const truncated = walk(resolvedPath, depth);
      let content = lines.length === 0 ? "(empty directory)" : lines.join("\n");
      if (truncated) content += "\n... truncated: output limited. Use a more specific path or lower depth.";
      return { content, details: { path, resolvedPath, depth, entryCount: lines.length, truncated } satisfies LsDetails };
    },
  };
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
  return createToolRegistry([restrictedRead, restrictedEdit, restrictedWrite, restrictedBash, restrictedLs]);
}
