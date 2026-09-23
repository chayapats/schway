import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  MessageStreamEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  AssistantContent,
  AssistantMessage,
  ConversationItem,
  ProviderMetadata,
} from "../../conversation/types.ts";
import { ANTHROPIC_THINKING_BUDGETS, DEFAULT_MODEL_IDS, describeThinkingSupport, getThinkingSupport, isThinkingSupported } from "../catalog.ts";

/** Numeric Anthropic thinking budgets shared with resolve-time config validation; re-exported to preserve the provider import path. */
export { ANTHROPIC_THINKING_BUDGETS };
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
  ThinkingLevel,
} from "../model.ts";

/** Default Claude model when the caller does not specify one. */
export const DEFAULT_ANTHROPIC_MODEL = DEFAULT_MODEL_IDS.anthropic;
/** Default max_tokens for Anthropic Messages requests. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_384;

/** Resolve a provider-independent level to an Anthropic thinking param, leaving defaults untouched when unset or off without disabling support. */
export function resolveAnthropicThinking(
  level: ThinkingLevel | undefined,
  modelId: string,
  maxTokens: number,
): { type: "disabled" } | { type: "enabled"; budget_tokens: number } | undefined {
  if (level === undefined) {
    return undefined;
  }
  if (!isThinkingSupported("anthropic", modelId, level)) {
    throw new Error(
      `Thinking level "${level}" is not supported for anthropic/${modelId}. ${describeThinkingSupport("anthropic", modelId)}`,
    );
  }
  if (level === "off") {
    if (!getThinkingSupport("anthropic", modelId).supportsDisabling) {
      return undefined;
    }
    return { type: "disabled" };
  }
  const budget = ANTHROPIC_THINKING_BUDGETS[level];
  if (budget >= maxTokens) {
    throw new Error(
      `Thinking level "${level}" needs budget ${budget} < max output ${maxTokens} for anthropic/${modelId}. Increase --max-output or choose a lower level.`,
    );
  }
  return { type: "enabled", budget_tokens: budget };
}

/** Optional fetch override used by protocol tests. */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Create an Anthropic Messages adapter with SDK retries disabled and Schway-owned conversation records.
 * Streaming forwards request cancellation and provider failures, and assembles tool_use JSON before exposing a call.
 */
export function createAnthropicModel(options: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  fetch?: FetchLike;
}): Model {
  const modelId = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const defaultThinking = options.thinking;
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    provider: "anthropic",
    id: modelId,
    /** Stream Schway events; tool_use JSON is assembled before message_complete. */
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const thinking = resolveAnthropicThinking(request.thinking ?? defaultThinking, modelId, maxTokens);
      const stream = client.messages.stream(
        {
          model: modelId,
          max_tokens: maxTokens,
          stream: true,
          ...(thinking !== undefined ? { thinking } : {}),
          system: toAnthropicSystem(request),
          messages: toAnthropicMessages(request.items),
          ...(request.tools && request.tools.length > 0
            ? { tools: toAnthropicTools(request.tools) }
            : {}),
        },
        { signal: request.signal },
      );
      const builder = createStreamBuilder();
      for await (const event of stream) {
        const deltas = builder.accept(event);
        for (const delta of deltas) {
          yield delta;
        }
      }
      yield { type: "message_complete", message: builder.complete() };
    },
  };
}

/** Stable system prompt plus dynamic context as Anthropic text blocks. */
function toAnthropicSystem(request: ModelRequest): TextBlockParam[] {
  return [
    { type: "text", text: request.systemPrompt },
    ...request.context.map((section) => ({
      type: "text" as const,
      text: `<${section.name}>\n${section.content}\n</${section.name}>`,
    })),
  ];
}

/** Map Schway tool definitions onto Anthropic `tools` entries. */
function toAnthropicTools(tools: readonly ModelTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as {
      type: "object";
      [key: string]: unknown;
    },
  }));
}

/**
 * Convert Schway conversation items to Anthropic messages.
 * Consecutive tool results become a single user message.
 */
function toAnthropicMessages(items: readonly ConversationItem[]): MessageParam[] {
  const messages: MessageParam[] = [];
  let pendingToolResults: ToolResultBlockParam[] = [];

  /** Flush buffered tool_result blocks as one user message. */
  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const item of items) {
    if (item.type === "tool_result") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: item.content,
        ...(item.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (item.type === "user") {
      messages.push({
        role: "user",
        content: item.content.map((block) => ({
          type: "text" as const,
          text: block.text,
        })),
      });
      continue;
    }
    const content = toAnthropicAssistantContent(item.content);
    if (content.length === 0) {
      continue;
    }
    messages.push({ role: "assistant", content });
  }
  flushToolResults();
  return messages;
}

/** Convert assistant content, including tool_use, into Anthropic blocks. */
function toAnthropicAssistantContent(
  content: readonly AssistantContent[],
): Array<TextBlockParam | ThinkingBlockParam | ToolUseBlockParam> {
  const blocks: Array<TextBlockParam | ThinkingBlockParam | ToolUseBlockParam> =
    [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      const signature = anthropicField(block.providerMetadata, "signature");
      if (typeof signature !== "string" || signature.length === 0) {
        continue;
      }
      blocks.push({
        type: "thinking",
        thinking: block.text,
        signature,
      });
      continue;
    }
    blocks.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: toAnthropicToolInput(block.arguments),
    });
  }
  return blocks;
}

/** Anthropic requires tool_use.input to be an object. Non-objects become {}. */
function toAnthropicToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Read an opaque field from `providerMetadata.anthropic`. */
function anthropicField(
  metadata: ProviderMetadata | undefined,
  key: string,
): unknown {
  const anthropic = metadata?.anthropic;
  if (!anthropic || typeof anthropic !== "object" || Array.isArray(anthropic)) {
    return undefined;
  }
  return (anthropic as Record<string, unknown>)[key];
}

/** In-progress content block while assembling an Anthropic SSE stream. */
type StreamBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; json: string; input: unknown };

/** Accumulate Anthropic stream events into Schway deltas and a final message. */
function createStreamBuilder() {
  const id = crypto.randomUUID();
  let anthropicMessageId: string | undefined;
  let stopReason: string | undefined;
  const blocks: StreamBlock[] = [];

  return {
    /** Fold one SSE event into blocks and emit Schway deltas. */
    accept(event: MessageStreamEvent): ModelStreamEvent[] {
      switch (event.type) {
        case "message_start":
          anthropicMessageId = event.message.id;
          return [];
        case "content_block_start":
          if (event.content_block.type === "text") {
            blocks[event.index] = {
              type: "text",
              text: event.content_block.text,
            };
          } else if (event.content_block.type === "thinking") {
            blocks[event.index] = {
              type: "thinking",
              text: event.content_block.thinking,
              signature: event.content_block.signature || undefined,
            };
          } else if (event.content_block.type === "tool_use") {
            blocks[event.index] = {
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
              input: event.content_block.input,
            };
          }
          return [];
        case "content_block_delta":
          return applyDelta(blocks, event);
        case "message_delta":
          stopReason = event.delta.stop_reason ?? undefined;
          return [];
        default:
          return [];
      }
    },
    /** Build the Schway assistant message after the stream ends. */
    complete(): AssistantMessage {
      const content: AssistantContent[] = [];
      for (const block of blocks) {
        if (!block) {
          continue;
        }
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
          continue;
        }
        if (block.type === "thinking") {
          content.push({
            type: "thinking",
            text: block.text,
            ...(block.signature
              ? { providerMetadata: { anthropic: { signature: block.signature } } }
              : {}),
          });
          continue;
        }
        content.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: parseToolArguments(block.json, block.input),
        });
      }
      const anthropic: Record<string, unknown> = {};
      if (anthropicMessageId) {
        anthropic.message_id = anthropicMessageId;
      }
      if (stopReason) {
        anthropic.stop_reason = stopReason;
      }
      return {
        type: "assistant",
        id,
        content,
        ...(Object.keys(anthropic).length > 0
          ? { providerMetadata: { anthropic } }
          : {}),
      };
    },
  };
}

/** Parse assembled tool JSON. Malformed input is returned as the raw string. */
function parseToolArguments(json: string, fallback: unknown): unknown {
  if (json.length === 0) {
    return fallback ?? {};
  }
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Apply a content_block_delta to the in-progress stream blocks. */
function applyDelta(
  blocks: StreamBlock[],
  event: Extract<MessageStreamEvent, { type: "content_block_delta" }>,
): ModelStreamEvent[] {
  const delta = event.delta;
  if (delta.type === "text_delta") {
    const current = blocks[event.index];
    if (!current || current.type !== "text") {
      blocks[event.index] = { type: "text", text: delta.text };
    } else {
      current.text += delta.text;
    }
    return [{ type: "text_delta", text: delta.text }];
  }
  if (delta.type === "thinking_delta") {
    const current = blocks[event.index];
    if (!current || current.type !== "thinking") {
      blocks[event.index] = { type: "thinking", text: delta.thinking };
    } else {
      current.text += delta.thinking;
    }
    return [{ type: "thinking_delta", text: delta.thinking }];
  }
  if (delta.type === "signature_delta") {
    const current = blocks[event.index];
    if (current && current.type === "thinking") {
      current.signature = delta.signature;
    }
    return [];
  }
  if (delta.type === "input_json_delta") {
    const current = blocks[event.index];
    if (current && current.type === "tool_use") {
      current.json += delta.partial_json;
    }
  }
  return [];
}
