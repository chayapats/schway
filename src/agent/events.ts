import type { ToolCallStatus } from "../tools/types.ts";

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
  | { type: "tool.started"; toolCallId: string; name: string }
  | {
      type: "tool.finished";
      toolCallId: string;
      name: string;
      status: ToolCallStatus;
      content: string;
      details?: unknown;
    }
  | { type: "error"; message: string };
