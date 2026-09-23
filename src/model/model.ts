import type { AssistantMessage, ConversationItem } from "../conversation/types.ts";
import type { ContextSection } from "../context/manager.ts";

/** User-facing reasoning level shared by all providers without assuming identical wire semantics. */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Valid thinking levels in increasing reasoning strength, with off disabling reasoning. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"] as const;

/** True when the value names a supported provider-independent thinking level. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

/** Tool description sent to a provider adapter. No execute function. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider-independent model request built by the agent loop. */
export interface ModelRequest {
  systemPrompt: string;
  context: readonly ContextSection[];
  items: readonly ConversationItem[];
  tools?: readonly ModelTool[];
  signal?: AbortSignal;
  /** Requested reasoning level; adapters fall back to their construction default when unset. */
  thinking?: ThinkingLevel;
}

/** Incremental stream events plus the assembled assistant message. */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "message_complete"; message: AssistantMessage };

/** Provider adapter contract using Schway conversation records while leaving retries and tool execution to the harness. */
export interface Model {
  readonly provider: string;
  readonly id: string;
  /** Stream normalized deltas and a completed assistant message, forwarding request cancellation and provider failures. */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
