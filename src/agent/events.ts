import type { CompactionReason } from "../context/compaction.ts";
import type { ModelUsage } from "../model/model.ts";
import type { ToolCallStatus } from "../tools/types.ts";

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
  | { type: "model.usage"; phase: "turn" | "compaction"; usage: ModelUsage; complete: boolean }
  | {
      type: "model.retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      message: string;
    }
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
      status: "failed" | "noop";
      message?: string;
    }
  | { type: "error"; message: string; origin?: "model" | "harness"; category?: "auth" | "credential-store" | "model" | "offline" | "rate-limit" | "provider" | "session-write" };
