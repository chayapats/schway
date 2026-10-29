import type { AssistantMessage, ConversationItem } from "../conversation/types.ts";
import type { ContextSection } from "../context/manager.ts";

/** User-facing reasoning level shared by all providers without assuming identical wire semantics. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Valid thinking levels in increasing reasoning strength, with off disabling reasoning. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** True when the value names a supported provider-independent thinking level. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/** Tool description sent to a provider adapter. No execute function. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider-hosted read-only lookup a model may run inside one response; a closed union that adapters may ignore. */
export type HostedTool = "web_search";

/** Provider-independent model request built by the agent loop. */
export interface ModelRequest {
  systemPrompt: string;
  context: readonly ContextSection[];
  items: readonly ConversationItem[];
  /** Transient, freshly resolved image bytes keyed by SHA-256; never part of durable conversation data. */
  imageData?: ReadonlyMap<string, Uint8Array>;
  tools?: readonly ModelTool[];
  /** Hosted tools Schway chose for this session after extension hooks ran; an adapter that cannot honor an entry ignores it. */
  hostedTools?: readonly HostedTool[];
  signal?: AbortSignal;
  /** Requested reasoning level; adapters fall back to their construction default when unset. */
  thinking?: ThinkingLevel;
}

/** Reported token counts for one provider attempt; null or absent means that dimension was not reported, while 0 means the provider reported none. */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Part of `inputTokens` the provider reports as served from its prompt cache; a subset, never added to the total. */
  cachedInputTokens?: number | null;
  /** Part of `outputTokens` the provider reports as reasoning; a subset, never added to the total. */
  reasoningTokens?: number | null;
  /** Hosted web searches the response returned as items Schway kept; absent when the response returned none. */
  hostedSearchCalls?: number;
  /** Hosted web searches the provider's server-side tool counter reported, 0 included; absent when the provider sent no such counter. */
  reportedHostedSearchCalls?: number;
}

/** Normalize nonnegative integer provider counters without inventing consumption. */
export function reportedTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Incremental stream events plus the assembled assistant message. */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; usage: ModelUsage }
  | { type: "message_complete"; message: AssistantMessage };

/** Schway-owned per-call settings kept outside the extension-editable request; an adapter may ignore any of them. */
export interface ModelCallOptions {
  /** Opaque conversation affinity key from `promptCacheKey`; absent on requests outside a conversation, such as compaction summaries. */
  readonly promptCacheKey?: string;
}

/** Provider adapter contract using Schway conversation records while leaving retries and tool execution to the harness. */
export interface Model {
  readonly provider: string;
  readonly id: string;
  /** Stream normalized deltas and a completed assistant message, forwarding request cancellation and provider failures. */
  stream(request: ModelRequest, call?: ModelCallOptions): AsyncIterable<ModelStreamEvent>;
}
