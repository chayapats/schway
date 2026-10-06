import type { ApprovalPolicy } from "./approval.ts";
import type { UndoStore, UndoTurn } from "../undo/store.ts";
import { DEFAULT_MAX_CONCURRENT_TOOLS } from "../config/defaults.ts";
import type { ToolCallContent, ToolTelemetry } from "../conversation/types.ts";
import type { ExtensionToolHooks } from "../extensions/tool-hooks.ts";
import {
  executeToolCall,
  type ExecutedToolCall,
} from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolExecutionMode } from "../tools/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";
import { elapsedMs, monotonicNow, systemClock, type AgentClock } from "./retry.ts";

/** Default cap on consecutive parallel-safe tool calls. */
export { DEFAULT_MAX_CONCURRENT_TOOLS };

/** Stream parallel-safe tool work around exclusive barriers, settling cancellation and returning outcomes in source order; each call that ran carries its measured telemetry. */
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
  /** Time source for per-call durations and approval waits. */
  clock?: AgentClock;
}): AsyncGenerator<RuntimeEvent, ExecutedToolCall[]> {
  const { calls, registry, workspace, toolHooks } = options;
  const signal = toolHooks?.active ? AbortSignal.any([toolHooks.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  const maxConcurrentTools =
    options.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS;
  const results: Array<ExecutedToolCall | undefined> = Array.from({
    length: calls.length,
  });
  const approvalGates = calls.map(() => {
    let release = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
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

  const clock = options.clock ?? systemClock();
  const start = (index: number): void => {
    const call = calls[index]!;
    const startedMono = monotonicNow(clock);
    const startedAt = new Date(clock.now()).toISOString();
    let approvalWaitMs: number | undefined;
    /** Attach measured telemetry unless the call settled before it passed validation. */
    const measured = (executed: ExecutedToolCall): { executed: ExecutedToolCall; timing: Partial<ToolTelemetry> } => {
      if (executed.neverRan) return { executed, timing: {} };
      const durationMs = elapsedMs(startedMono, monotonicNow(clock));
      const telemetry: ToolTelemetry = { startedAt, durationMs, ...(approvalWaitMs !== undefined ? { approvalWaitMs: Math.min(approvalWaitMs, durationMs) } : {}) };
      return { executed: { ...executed, result: { ...executed.result, telemetry } }, timing: telemetry };
    };
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
      index,
      onApprovalSettled: approvalGates[index]!.release,
      approval: options.approval && { interactive: options.approval.interactive, mode: () => options.approval!.mode(),
        ...(options.approval.ask ? { ask: async (request, approvalSignal) => {
          await Promise.all(approvalGates.slice(0, index).map(gate => gate.promise));
          approvalSignal.throwIfAborted();
          return options.approval!.ask!(request, approvalSignal);
        } } : {}),
      },
      undo: options.undo,
      undoTurn: options.undoTurn,
      monotonicNow: () => monotonicNow(clock),
      onApprovalWait(ms) { approvalWaitMs = (approvalWaitMs ?? 0) + ms; },
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
      .then((settled) => {
        const { executed, timing } = measured(settled);
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
          ...timing,
        });
      })
      .catch((error) => {
        const { executed, timing } = measured(unexpectedFailure(call, error));
        results[index] = executed;
        emit({
          type: "tool.finished",
          toolCallId: call.id,
          name: call.name,
          status: executed.status,
          content: executed.result.content,
          ...timing,
        });
      })
      .finally(() => {
        approvalGates[index]!.release();
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
