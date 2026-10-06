import type { ApprovalMode } from "./approval.ts";
import type { CompactionReason } from "../context/compaction.ts";
import type { ModelUsage } from "../model/model.ts";
import type { ToolCallStatus } from "../tools/types.ts";

/**
 * Headless `--json` CLI preamble announcing the persisted session ID for
 * discoverability / `--resume`. Not part of the shared RuntimeEvent stream
 * observed by extensions or the TUI controller.
 */
export type HeadlessSessionReadyEvent = { type: "session.ready"; sessionId: string };

/**
 * Normalized runtime events for TUI, headless `--json`, and diagnostics.
 * This is not the durable session record.
 */
export type RuntimeEvent =
  | { type: "agent.started" }
  | {
      type: "agent.finished";
      reason: "completed" | "error" | "cancelled" | "max_turns";
    }
  | { type: "model.started"; provider: string; model: string }
  | {
      type: "model.delta";
      content: { type: "text"; text: string } | { type: "thinking"; text: string };
    }
  | { type: "model.finished" }
  | {
      type: "model.usage";
      phase: "turn" | "compaction";
      usage: ModelUsage;
      complete: boolean;
      /** ISO wall-clock start of this attempt; turn attempts only. */
      startedAt?: string;
      /** Milliseconds from this attempt's start to its first text or thinking delta; null when none arrived. Turn attempts only. */
      firstDeltaMs?: number | null;
      /** Milliseconds from this attempt's start to the end of its stream, including failed and cancelled attempts. Turn attempts only. */
      attemptMs?: number;
      /** Milliseconds of retry backoff actually waited after this failed attempt, including a backoff cut short by cancellation; absent when no backoff followed. */
      retryWaitMs?: number;
    }
  | {
      type: "model.retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      message: string;
      /** Why the failed attempt is retried, using `error.category` names: HTTP 429, HTTP 5xx, or a network failure with no HTTP status. Optional so events built without it stay valid. */
      cause?: "rate-limit" | "provider" | "offline";
    }
  | { type: "tool.denied"; toolCallId: string; name: string; mode: ApprovalMode; reason: string }
  | { type: "tool.started"; toolCallId: string; name: string }
  | {
      type: "tool.delta";
      toolCallId: string;
      name: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "tool.finished";
      toolCallId: string;
      name: string;
      status: ToolCallStatus;
      content: string;
      details?: unknown;
      /** ISO wall-clock time the scheduler started the call; absent when the call never ran. */
      startedAt?: string;
      /** Milliseconds from scheduler start to settlement, including any approval wait; absent when the call never ran. */
      durationMs?: number;
      /** Part of `durationMs` spent waiting for approval; absent when the call did not wait. */
      approvalWaitMs?: number;
    }
  | { type: "compaction.started"; reason: CompactionReason }
  | {
      type: "compaction.finished";
      reason: CompactionReason;
      status: "completed";
      recordId: string;
      firstKeptId: string;
    }
  | {
      type: "compaction.finished";
      reason: CompactionReason;
      status: "failed" | "noop" | "cancelled";
      message?: string;
    }
  | { type: "error"; message: string; origin?: "model" | "harness"; category?: "auth" | "credential-store" | "model" | "offline" | "rate-limit" | "provider" | "session-write" };

/** Cause of a transient provider failure carried by `model.retry`; it shares the `error` event's category names. */
export type ModelRetryCause = NonNullable<Extract<RuntimeEvent, { type: "model.retry" }>["cause"]>;
