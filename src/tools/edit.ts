import { Type, type Static } from "@sinclair/typebox";
import {
  abortError,
  filesystemFailure,
  isAbortError,
  observeFile,
  type FileObservation,
  writeFileAtomically,
} from "./fs.ts";
import { resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/**
 * Accept a file path and nonempty replacement list with nonempty old text, rejecting unknown keys during validation.
 * Compiled once when the tool is registered.
 */
export const editInputSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file. Relative paths resolve from the workspace root.",
    }),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String({
            minLength: 1,
            description:
              "Exact text to replace. Must match exactly once in the original file.",
          }),
          newText: Type.String({
            description: "Replacement text.",
          }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "Replacements matched against the original file. Overlapping edits are rejected.",
      },
    ),
  },
  { additionalProperties: false },
);

/** File path and exact old/new text replacements accepted by the edit schema. */
export type EditInput = Static<typeof editInputSchema>;

/** Applied replacement with its original one-based start line and old/new text for display outside model context. */
export interface EditHunk {
  startLine: number;
  oldText: string;
  newText: string;
}

/** Edit paths with applied hunks when successful, omitted when matching or filesystem work fails. */
export interface EditDetails {
  path: string;
  resolvedPath: string;
  hunks?: EditHunk[];
}

/** Exact-replacement definition that runs behind an exclusive scheduling barrier. */
export const editTool: ToolDefinition<EditInput> = {
  name: "edit",
  description:
    "Apply exact text replacements to an existing file. Each oldText must match exactly once in the original file. Multiple edits are matched against the original content, not sequentially. Overlapping edits are rejected and no partial changes are written. Prefer this over write for targeted changes.",
  inputSchema: editInputSchema,
  effect: "mutating",
  execution: "exclusive",
  execute: executeEdit,
};

/**
 * Apply exact replacements atomically.
 * Matches are computed against the original file. Failures leave the file untouched.
 * Relative paths resolve from the workspace root; missing, duplicate, or overlapping
 * matches and filesystem failures return error results, while detected cancellation rejects.
 */
export async function executeEdit(
  input: EditInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const resolvedPath = resolveToolPath(ctx.workspace.root, input.path);
  if (ctx.signal?.aborted) {
    throw abortError();
  }

  let original: string;
  let observed: FileObservation;
  try {
    const current = await observeFile(resolvedPath, ctx.signal);
    if (!current) throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    observed = current;
    original = current.bytes.toString("utf8");
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    return filesystemFailure(input.path, resolvedPath, error);
  }

  const applied = applyEdits(original, input.edits);
  if (!applied.ok) {
    return {
      content: applied.message,
      isError: true,
      details: { path: input.path, resolvedPath } satisfies EditDetails,
    };
  }

  try {
    await writeFileAtomically(resolvedPath, applied.content, ctx.signal, undefined, { observed });
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    return filesystemFailure(input.path, resolvedPath, error);
  }

  const hunks = applied.replacements.map((replacement) => ({
    startLine: lineNumberAt(original, replacement.start),
    oldText: replacement.oldText,
    newText: replacement.newText,
  }));

  return {
    content: `Edited ${input.path} (${hunks.length} ${hunks.length === 1 ? "replacement" : "replacements"})`,
    details: {
      path: input.path,
      resolvedPath,
      hunks,
    } satisfies EditDetails,
  };
}

interface Replacement {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

/** Match every edit against `original` and apply them all, or fail with no changes. */
export function applyEdits(
  original: string,
  edits: EditInput["edits"],
):
  | { ok: true; content: string; replacements: Replacement[] }
  | { ok: false; message: string } {
  const replacements: Replacement[] = [];
  for (const [index, edit] of edits.entries()) {
    const match = uniqueMatch(original, edit.oldText);
    if (match === "missing") {
      return {
        ok: false,
        message: `Edit ${index + 1} of ${edits.length} failed: oldText not found. Each oldText must match exactly once in the original file.`,
      };
    }
    if (match === "duplicate") {
      return {
        ok: false,
        message: `Edit ${index + 1} of ${edits.length} failed: oldText matched more than once. Each oldText must match exactly once; add more surrounding context.`,
      };
    }
    replacements.push({
      start: match,
      end: match + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText,
    });
  }

  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  for (let index = 0; index < ordered.length - 1; index++) {
    const current = ordered[index]!;
    const next = ordered[index + 1]!;
    if (current.end > next.start) {
      return {
        ok: false,
        message:
          "Edits overlap. All replacements are matched against the original file; overlapping or nested edits are rejected.",
      };
    }
  }

  let content = original;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    content =
      content.slice(0, replacement.start) +
      replacement.newText +
      content.slice(replacement.end);
  }
  return { ok: true, content, replacements };
}

/** Index of a unique `oldText` occurrence, or why uniqueness failed. */
function uniqueMatch(content: string, oldText: string): number | "missing" | "duplicate" {
  const first = content.indexOf(oldText);
  if (first === -1) {
    return "missing";
  }
  if (content.indexOf(oldText, first + 1) !== -1) {
    return "duplicate";
  }
  return first;
}

/** 1-indexed line number of a character offset, treating any newline as a break. */
function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, content.length);
  for (let index = 0; index < limit; index++) {
    if (content[index] === "\n") {
      line += 1;
    }
  }
  return line;
}
