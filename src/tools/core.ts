import { confinedAccess, type CoreToolOptions, type ExecutionBackend } from "./backend.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import type { ToolDefinition } from "./types.ts";
import { createWriteTool } from "./write.ts";

/** Build `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls` over one backend, confined to its workspace root. */
export function createCoreToolDefinitions(
  backend: ExecutionBackend,
  options: CoreToolOptions = {},
): readonly ToolDefinition[] {
  const access = confinedAccess(backend, options);
  return Object.freeze([
    createReadTool(access),
    createWriteTool(access),
    createEditTool(access),
    createBashTool(access),
    createGrepTool(access),
    createFindTool(access),
    createLsTool(access),
  ] as ToolDefinition[]);
}
