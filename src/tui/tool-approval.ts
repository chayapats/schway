import { redactSecrets } from "../auth/secrets.ts";
import { readFile } from "node:fs/promises";
import type { ApprovalRequest } from "../agent/approval.ts";
import { applyEdits, type EditInput } from "../tools/edit.ts";
import { displayToolPath, resolveToolPath } from "../tools/path.ts";
import { buildEditDiff, diffLines, type TextDiff } from "../text/diff.ts";

/** Renderable final-argument preview with ephemeral selection and reason-entry state. */
export interface ToolApproval {
  request: Pick<ApprovalRequest, "toolCallId" | "toolName" | "index">;
  selected: number;
  enteringReason: boolean;
  loading: boolean;
  content: string;
  path?: string;
  diff?: TextDiff;
}

/** Preview the exact edit matcher or whole-file write diff without changing files. */
export async function approvalPreview(request: ApprovalRequest, root: string, secrets: readonly string[] = []): Promise<Pick<ToolApproval, "content" | "path" | "diff">> {
  const args = request.arguments as Record<string, unknown>;
  if (request.toolName === "bash" && typeof args?.command === "string") return { content: args.command };
  if ((request.toolName === "edit" || request.toolName === "write") && typeof args?.path === "string") {
    const resolved = resolveToolPath(root, args.path);
    const path = displayToolPath(root, resolved);
    try {
      let original: string;
      try { original = await readFile(resolved, "utf8"); }
      catch (error) {
        if (request.toolName === "write" && (error as NodeJS.ErrnoException).code === "ENOENT") original = "";
        else return { content: "", path };
      }
      if (request.toolName === "write" && typeof args.content === "string") return { content: "", path, diff: diffLines(original, args.content) };
      if (request.toolName === "edit" && Array.isArray(args.edits)) {
        const applied = applyEdits(original, (args as unknown as EditInput).edits);
        if (applied.ok) return { content: "", path, diff: buildEditDiff(applied.replacements.map(replacement => ({
          startLine: original.slice(0, replacement.start).split("\n").length, oldText: replacement.oldText, newText: replacement.newText,
        }))) };
      }
    } catch { /* Failed matching still asks, showing only the target path. */ }
    return { content: "", path };
  }
  return { content: `${request.toolName}\n${JSON.stringify(maskArguments(request.arguments, secrets), null, 2)}` };
}

/** Mask JSON strings and keys before encoding so escaped credentials remain hidden. */
function maskArguments(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map(item => maskArguments(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key, secrets), maskArguments(item, secrets)]));
  return value;
}
