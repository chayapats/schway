import type { ApprovalPolicy } from "./approval.ts";
import type { UndoStore, UndoTurn } from "../undo/store.ts";
import { DEFAULT_MAX_CONCURRENT_TOOLS } from "../config/defaults.ts";
import type { ToolCallContent } from "../conversation/types.ts";
import type { ExtensionToolHooks } from "../extensions/tool-hooks.ts";
import {
  executeToolCall,
  type ExecutedToolCall,
} from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolExecutionMode } from "../tools/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";

/** Default cap on consecutive parallel-safe tool calls. */
export { DEFAULT_MAX_CONCURRENT_TOOLS };

/** Stream parallel-safe tool work around exclusive barriers, settling cancellation and returning outcomes in source order. */
export async function* scheduleToolCalls(options: {
  calls: readonly ToolCallContent[];
  registry?: ToolRegistry;
  workspace?: Workspace;
  signal?: AbortSignal;
  maxConcurrentTools?: number;
  env?: NodeJS.ProcessEnv;
  toolHooks?: ExtensionToolHooks;
  approval?: ApprovalPolicy;
  undo?: UndoStore;
  undoTurn?: UndoTurn;
}): AsyncGenerator<RuntimeEvent, ExecutedToolCall[]> {
  const { calls, registry, workspace, toolHooks } = options;
  const signal = toolHooks?.active ? AbortSignal.any([toolHooks.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  const maxConcurrentTools =
    options.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS;
  const results: Array<ExecutedToolCall | undefined> = Array.from({
    length: calls.length,
  });
  const running = new Set<number>();
  const queue: RuntimeEvent[] = [];
  let nextIndex = 0;
  let wake: (() => void) | undefined;

  const emit = (event: RuntimeEvent): void => {
    queue.push(event);
    wake?.();
  };

  const executionMode = (call: ToolCallContent): ToolExecutionMode =>
    // Unknown tools have no declaration, so they run as exclusive barriers.
    registry?.get(call.name)?.definition.execution ?? "exclusive";

  const exclusiveRunning = (): boolean => {
    for (const index of running) {
      if (executionMode(calls[index]!) === "exclusive") {
        return true;
      }
    }
    return false;
  };

  const canStart = (call: ToolCallContent): boolean => {
    if (signal?.aborted) {
      return false;
    }
    if (running.size === 0) {
      return true;
    }
    if (executionMode(call) === "exclusive" || exclusiveRunning()) {
      return false;
    }
    return running.size < maxConcurrentTools;
  };

  const start = (index: number): void => {
    const call = calls[index]!;
    running.add(index);
    emit({
      type: "tool.started",
      toolCallId: call.id,
      name: call.name,
    });
    void executeToolCall({
      registry,
      call,
      workspace,
      signal,
      env: options.env,
      toolHooks,
      approval: options.approval,
      undo: options.undo,
      undoTurn: options.undoTurn,
      onOutput(chunk) {
        if (chunk.text.length === 0) {
          return;
        }
        emit({
          type: "tool.delta",
          toolCallId: call.id,
          name: call.name,
          stream: chunk.stream,
          text: chunk.text,
        });
      },
    })
      .then((executed) => {
        results[index] = executed;
        if (executed.denied) emit({ type: "tool.denied", toolCallId: call.id, name: call.name, ...executed.denied });
        emit({
          type: "tool.finished",
          toolCallId: call.id,
          name: call.name,
          status: executed.status,
          content: executed.result.content,
          ...(executed.details !== undefined
            ? { details: executed.details }
            : {}),
        });
      })
      .catch((error) => {
        const executed = unexpectedFailure(call, error);
        results[index] = executed;
        emit({
          type: "tool.finished",
          toolCallId: call.id,
          name: call.name,
          status: executed.status,
          content: executed.result.content,
        });
      })
      .finally(() => {
        running.delete(index);
        wake?.();
      });
  };

  while (nextIndex < calls.length || running.size > 0 || queue.length > 0) {
    if (signal?.aborted) {
      if (running.size === 0) {
        while (nextIndex < calls.length) {
          start(nextIndex);
          nextIndex += 1;
        }
      }
    } else {
      while (nextIndex < calls.length && canStart(calls[nextIndex]!)) {
        start(nextIndex);
        nextIndex += 1;
      }
    }

    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }

    if (nextIndex >= calls.length && running.size === 0) {
      break;
    }

    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }

  return results.map((executed, index) => {
    if (!executed) {
      throw new Error(
        `Tool scheduler missing result for call ${calls[index]?.id ?? index}`,
      );
    }
    return executed;
  });
}

/** Last-resort result when `executeToolCall` rejects despite its own guards. */
function unexpectedFailure(
  call: ToolCallContent,
  error: unknown,
): ExecutedToolCall {
  return {
    result: {
      type: "tool_result",
      id: crypto.randomUUID(),
      toolCallId: call.id,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    },
    status: "error",
  };
}
