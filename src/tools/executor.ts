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

/**
 * Validate and run one accepted tool call.
 * Unknown tools, invalid arguments, and thrown errors become model-visible
 * results instead of crashing the loop. Pre-aborted calls and execution errors
 * associated with cancellation yield cancelled results; a resolved tool result is kept.
 */
export async function executeToolCall(options: {
  registry?: ToolRegistry;
  call: ToolCallContent;
  workspace?: Workspace;
  signal?: AbortSignal;
  onOutput?: (chunk: ToolOutputChunk) => void;
  toolHooks?: ExtensionToolHooks;
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
  let executed: ExecutedToolCall;
  try {
    const output = await registered.definition.execute(args, {
      workspace: options.workspace,
      signal,
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
      return cancelled(options.call);
    }
    executed = failure(
      options.call,
      hooks ? hooks.safeText(messageOf(error)) : messageOf(error),
    );
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
