import type { UndoStore, UndoTurn } from "../undo/store.ts";
import { resolveToolPath, displayToolPath } from "./path.ts";
import type { ToolCallContent, ToolResult } from "../conversation/types.ts";
import type { ExtensionToolHooks } from "../extensions/tool-hooks.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ToolCallStatus, ToolOutputChunk } from "./types.ts";

const CANCELLED_CONTENT = "Tool call cancelled";
const MAX_RESULT_CHARS = 50_000;
const TRUNCATED_RESULT = "\n[Tool output truncated; narrow the request or use pagination.]";

/** Conversation tool result plus the status used in runtime events. */
export interface ExecutedToolCall {
  result: ToolResult;
  status: ToolCallStatus;
  details?: unknown;
}

/** Validate, hook, capture and settle an accepted tool call as a bounded model-visible outcome, preserving resolved results through cancellation. */
export async function executeToolCall(options: {
  registry?: ToolRegistry;
  call: ToolCallContent;
  workspace?: Workspace;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: ToolOutputChunk) => void;
  toolHooks?: ExtensionToolHooks;
  undo?: UndoStore;
  undoTurn?: UndoTurn;
}): Promise<ExecutedToolCall> {
  const hooks = options.toolHooks?.active ? options.toolHooks : undefined;
  const signal = hooks ? AbortSignal.any([hooks.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  if (signal?.aborted) {
    return cancelled(options.call);
  }

  const registered = options.registry?.get(options.call.name);
  if (!registered) {
    return failure(options.call, `Unknown tool: ${options.call.name}`);
  }

  const validated = registered.validate(options.call.arguments);
  if (!validated.ok) {
    return failure(
      options.call,
      `Invalid arguments for tool ${options.call.name}: ${validated.message}`,
    );
  }

  if (!options.workspace) {
    return failure(options.call, "Workspace is not available");
  }

  let args = validated.value;
  if (hooks) {
    try {
      args = await hooks.prepare(options.call, registered, signal!);
      const transformed = registered.validate(args);
      if (!transformed.ok) return failure(options.call, hooks.safeText(`Invalid transformed arguments for tool ${options.call.name}: ${transformed.message}`));
      args = transformed.value;
    } catch (error) {
      return signal?.aborted ? cancelled(options.call) : failure(options.call, hooks.safeText(messageOf(error)));
    }
  }
  if (signal?.aborted) return cancelled(options.call);

  // Keep invocation arguments for afterTool independent of tool-side input mutation.
  let executedArgs: unknown;
  try { executedArgs = hooks ? structuredClone(args) : args; }
  catch (error) { return failure(options.call, hooks ? hooks.safeText(messageOf(error)) : messageOf(error)); }
  // Approval decisions belong here, before pre-image capture (#155/#156).
  let capture: { path: string; created: boolean } | undefined;
  if (options.undo && options.undoTurn && (options.call.name === "edit" || options.call.name === "write")) {
    const path = resolveToolPath(options.workspace.root, (args as { path: string }).path);
    try { capture = { path, ...await options.undo.capture(options.undoTurn, path) }; }
    catch (error) {
      return failure(options.call, `Could not save undo data for ${displayToolPath(options.workspace.root, path)}: ${undoFailureReason(error).replace(/\.$/, "")}. The file was not changed.`);
    }
  }
  let executed: ExecutedToolCall;
  try {
    const output = await registered.definition.execute(args, {
      workspace: options.workspace,
      signal,
      env: options.env,
      onOutput: options.onOutput,
    });
    executed = {
      result: toolResult(options.call, output.content, output.isError === true),
      status: output.isError === true ? "error" : "success",
      details: output.details,
    };
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      executed = cancelled(options.call);
    } else executed = failure(
      options.call,
      hooks ? hooks.safeText(messageOf(error)) : messageOf(error),
    );
  }
  if (capture) {
    try { await options.undo!.settle(options.undoTurn!, capture.path, capture.created); }
    catch (error) { executed = failure(options.call, `Could not save undo data after changing ${displayToolPath(options.workspace.root, capture.path)}: ${undoFailureReason(error)}`); }
  }
  return hooks ? hooks.finish(options.call, registered.definition, executedArgs, executed, signal!) : executed;
}

/** Render unexpected execution failures without allowing unprintable values to prevent settlement. */
function messageOf(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "Unprintable tool failure"; }
}

/** Build a cancelled result for an accepted call that did not run. */
function cancelled(call: ToolCallContent): ExecutedToolCall {
  return {
    result: toolResult(call, CANCELLED_CONTENT, true),
    status: "cancelled",
  };
}

/** Build a model-visible error result without throwing. */
function failure(call: ToolCallContent, content: string): ExecutedToolCall {
  const bounded = content.length <= MAX_RESULT_CHARS
    ? content
    : content.slice(0, MAX_RESULT_CHARS - TRUNCATED_RESULT.length) + TRUNCATED_RESULT;
  return {
    result: toolResult(call, bounded, true),
    status: "error",
  };
}

/** Session item matching one accepted tool call. */
function toolResult(
  call: ToolCallContent,
  content: string,
  isError: boolean,
): ToolResult {
  return {
    type: "tool_result",
    id: crypto.randomUUID(),
    toolCallId: call.id,
    content,
    isError,
  };
}

/** Keep storage internals out of model-visible file-tool failures. */
function undoFailureReason(error: unknown): string {
  const reasons: Record<string, string> = {
    EACCES: "Permission denied", EPERM: "Permission denied", ENOSPC: "No space left on device",
    EROFS: "Read-only filesystem", ENOENT: "Directory not found", ENOTDIR: "Path is not a directory",
  };
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return reasons[code] ?? messageOf(error);
}
