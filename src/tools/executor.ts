import { ASK_HEADLESS_DENIAL, READ_ONLY_DENIAL, READ_ONLY_HEADLESS_DENIAL, type ApprovalMode, type ApprovalPolicy } from "../agent/approval.ts";
import { toolEffect } from "./types.ts";
import { undoFailureReason } from "../undo/errors.ts";
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
  /** Approval denial emitted immediately before settlement. */
  denied?: { mode: ApprovalMode; reason: string };
}

/** Validate, hook and approve before undo capture and execution, settling a bounded outcome through cancellation. */
export async function executeToolCall(options: {
  registry?: ToolRegistry;
  call: ToolCallContent;
  workspace?: Workspace;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: ToolOutputChunk) => void;
  toolHooks?: ExtensionToolHooks;
  approval?: ApprovalPolicy;
  index?: number;
  /** Release source-order approval waiting once this call has a decision. */
  onApprovalSettled?: () => void;
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

  const mode = options.approval?.mode() ?? "auto";
  const effect = toolEffect(registered.definition);
  try {
    if (effect === "mutating") {
      if (mode === "read-only") {
        const reason = options.approval?.interactive ? READ_ONLY_DENIAL : READ_ONLY_HEADLESS_DENIAL;
        return { ...failure(options.call, reason), denied: { mode, reason } };
      }
      if (mode === "ask") {
        const ask = options.approval?.ask;
        const decision = ask ? await waitForApproval(() => ask.call(options.approval, { toolCallId: options.call.id, toolName: options.call.name,
          arguments: structuredClone(args), effect, index: options.index ?? 0 }, signal ?? new AbortController().signal), signal)
          : { kind: "deny" as const, reason: ASK_HEADLESS_DENIAL };
        if (signal?.aborted) return cancelled(options.call);
        if (decision.kind === "deny") {
          const reason = decision.reason ?? "Denied by the user.";
          return { ...failure(options.call, reason), denied: { mode, reason } };
        }
      }
    }
  } catch (error) {
    return signal?.aborted ? cancelled(options.call) : failure(options.call, hooks ? hooks.safeText(messageOf(error)) : messageOf(error));
  } finally { options.onApprovalSettled?.(); }
  if (signal?.aborted) return cancelled(options.call);

  // Keep invocation arguments for afterTool independent of tool-side input mutation.
  let executedArgs: unknown;
  try { executedArgs = hooks ? structuredClone(args) : args; }
  catch (error) { return failure(options.call, hooks ? hooks.safeText(messageOf(error)) : messageOf(error)); }
  // Approval has already completed before pre-image capture.
  let capture: { path: string; created: boolean } | undefined;
  if (options.undo && options.undoTurn && (options.call.name === "edit" || options.call.name === "write")) {
    const path = resolveToolPath(options.workspace.root, (args as { path: string }).path);
    try { capture = { path, ...await options.undo.capture(options.undoTurn, path) }; }
    catch (error) {
      return { ...failure(options.call, `Could not save undo data for ${displayToolPath(options.workspace.root, path)}: ${undoFailureReason(error)}. The file was not changed.`),
        details: { undoError: hooks ? hooks.safeText(messageOf(error)) : messageOf(error) } };
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
    catch (error) { executed = { ...failure(options.call, `Could not save undo data after changing ${displayToolPath(options.workspace.root, capture.path)}: ${undoFailureReason(error)}`),
      details: { undoError: hooks ? hooks.safeText(messageOf(error)) : messageOf(error) } }; }
  }
  return hooks ? hooks.finish(options.call, registered.definition, executedArgs, executed, signal!) : executed;
}

/** Race an approval provider against cancellation and remove the listener after either settles. */
function waitForApproval<T>(ask: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("Tool call cancelled")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return ask(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
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
