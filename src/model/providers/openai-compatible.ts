import { CREDENTIAL_HEADER_NAMES, redactSecrets } from "../../auth/secrets.ts";
import type {
  AssistantContent,
  AssistantMessage,
} from "../../conversation/types.ts";
import { DEFAULT_MODEL_IDS, describeThinkingSupport, isThinkingSupported, COMPATIBLE_REASONING_BODY_KEYS } from "../catalog.ts";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
  ThinkingLevel,
} from "../model.ts";

/** Default Chat Completions model when the caller does not specify one. */
export const DEFAULT_OPENAI_COMPATIBLE_MODEL =
  DEFAULT_MODEL_IDS["openai-compatible"];

/** Control automatic bearer auth: require a key, send one if supplied, or omit automatic Authorization. */
export type OpenAICompatibleAuth = "required" | "optional" | "none";

/** Extra-body keys treated as reasoning controls; single source lives in the catalog for config validation. */
export { COMPATIBLE_REASONING_BODY_KEYS };

/** Name the first extra-body reasoning key present, if any, for single-source-of-truth errors. */
export function findCompatibleReasoningBodyKey(extraBody: Record<string, unknown> | undefined): string | undefined {
  if (!extraBody) {
    return undefined;
  }
  for (const key of COMPATIBLE_REASONING_BODY_KEYS) {
    if (extraBody[key] !== undefined) {
      return key;
    }
  }
  return undefined;
}

/** Validate compatible thinking without injecting a vendor field; off is a no-op, others need explicit extraBody. */
export function resolveCompatibleThinking(
  level: ThinkingLevel | undefined,
  modelId: string,
  extraBody: Record<string, unknown> | undefined,
): void {
  const bodyKey = findCompatibleReasoningBodyKey(extraBody);
  if (level !== undefined && bodyKey !== undefined) {
    throw new Error(
      `thinking "${level}" conflicts with extraBody.${bodyKey}; remove one to define a single source of truth for reasoning.`,
    );
  }
  if (level === undefined) {
    return;
  }
  if (!isThinkingSupported("openai-compatible", modelId, level)) {
    throw new Error(
      `Thinking level "${level}" is not supported for openai-compatible/${modelId}. ${describeThinkingSupport("openai-compatible", modelId)} Configure reasoning via extraBody instead or leave thinking unset.`,
    );
  }
  if (level !== "off") {
    throw new Error(
      `Thinking level "${level}" is not mapped for openai-compatible/${modelId}. Configure reasoning via extraBody instead or leave thinking unset; no vendor effort field is injected automatically.`,
    );
  }
}

/** Optional fetch override used by protocol tests. */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Create a Chat Completions fetch/SSE adapter that normalizes text and tool calls without automatic retries.
 * Streaming passes through cancellation and rejects missing required keys, HTTP failures, and malformed streams.
 */
export function createOpenAICompatibleModel(options: {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  auth?: OpenAICompatibleAuth;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  fetch?: FetchLike;
}): Model {
  const modelId = options.model?.trim() || DEFAULT_OPENAI_COMPATIBLE_MODEL;
  const fetchFn = options.fetch ?? fetch;
  const auth = options.auth ?? "optional";
  const defaultThinking = options.thinking;

  return {
    provider: "openai-compatible",
    id: modelId,
    /** Stream Schway events; tool-call JSON is assembled before message_complete. */
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      resolveCompatibleThinking(request.thinking ?? defaultThinking, modelId, options.extraBody);
      const apiKey = options.apiKey?.trim() ?? "";
      if (auth === "required" && apiKey.length === 0) {
        throw new Error(
          "Missing API key for OpenAI-compatible endpoint. Pass --api-key.",
        );
      }
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...options.headers,
      });
      if (auth !== "none" && apiKey.length > 0) {
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
      const secrets = secretsToRedact(apiKey, options.headers);
      const response = await fetchFn(completionsUrl(options.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(options.extraBody ?? {}),
          model: modelId,
          stream: true,
          ...(options.maxTokens !== undefined
            ? { max_tokens: options.maxTokens }
            : {}),
          messages: toChatMessages(request),
          ...(request.tools && request.tools.length > 0
            ? { tools: toChatTools(request.tools) }
            : {}),
        }),
        signal: request.signal,
      });
      const builder = createStreamBuilder();
      for await (const chunk of readSseJson(response, secrets, request.signal)) {
        const deltas = builder.accept(chunk);
        for (const delta of deltas) {
          yield delta;
        }
      }
      yield { type: "message_complete", message: builder.complete() };
    },
  };
}

/** Collect API key and credential-header values that must not appear in errors. */
function secretsToRedact(
  apiKey: string,
  headers: Record<string, string> | undefined,
): string[] {
  const secrets: string[] = [];
  if (apiKey.length > 0) {
    secrets.push(apiKey);
  }
  if (!headers) {
    return secrets;
  }
  for (const [name, value] of Object.entries(headers)) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) {
      continue;
    }
    secrets.push(trimmed);
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    const token = bearer?.[1]?.trim();
    if (token && token.length > 0 && token !== trimmed) {
      secrets.push(token);
    }
  }
  return secrets;
}

/** Join a custom base URL with the Chat Completions path. */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** Map Schway tool definitions onto Chat Completions function tools. */
function toChatTools(tools: readonly ModelTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Convert Schway conversation items to Chat Completions messages. */
function toChatMessages(request: ModelRequest): unknown[] {
  const sections = request.context.map(
    (section) => `<${section.name}>\n${section.content}\n</${section.name}>`,
  );
  const system = [request.systemPrompt, ...sections].join("\n\n");
  const messages: unknown[] = [{ role: "system", content: system }];
  for (const item of request.items) {
    if (item.type === "user") {
      messages.push({
        role: "user",
        content: item.content.map((block) => block.text).join(""),
      });
      continue;
    }
    if (item.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content: item.content,
      });
      continue;
    }
    messages.push(toAssistantChatMessage(item));
  }
  return messages;
}

/** Flatten assistant text and tool calls into one Chat Completions message. */
function toAssistantChatMessage(item: AssistantMessage) {
  let text = "";
  const toolCalls: unknown[] = [];
  for (const block of item.content) {
    if (block.type === "thinking") {
      continue;
    }
    if (block.type === "text") {
      text += block.text;
      continue;
    }
    toolCalls.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: toToolArgumentJson(block.arguments),
      },
    });
  }
  if (toolCalls.length > 0) {
    return {
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: toolCalls,
    };
  }
  return { role: "assistant", content: text };
}

/** JSON-stringify tool arguments. Strings are sent unchanged. */
function toToolArgumentJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** Yield parsed `data:` JSON objects from an SSE response body. */
async function* readSseJson(
  response: Response,
  secrets: readonly string[],
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  if (!response.ok) {
    throw await endpointError(response, secrets);
  }
  const body = response.body;
  if (!body) {
    throw new Error("Truncated SSE from OpenAI-compatible endpoint");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let drained = false;
  const abort = () => {
    void reader.cancel("aborted").catch(() => undefined);
  };
  if (signal?.aborted) {
    abort();
    throw abortError();
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw abortError();
      }
      if (done) {
        buffer += decoder.decode();
        drained = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const extracted = extractSseData(buffer);
      buffer = extracted.rest;
      for (const data of extracted.payloads) {
        if (data === "[DONE]") {
          return;
        }
        yield parseSseData(data);
      }
    }
    const extracted = extractSseData(buffer);
    buffer = extracted.rest;
    for (const data of extracted.payloads) {
      if (data === "[DONE]") {
        return;
      }
      yield parseSseData(data);
    }
    if (buffer.trim().length > 0) {
      throw new Error("Truncated SSE from OpenAI-compatible endpoint");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!drained) {
      try {
        await reader.cancel();
      } catch {
        // already cancelled by abort or a previous cancel()
      }
    } else {
      try {
        reader.releaseLock();
      } catch {
        // cancel() already released the lock
      }
    }
  }
}

/** Error used when AbortSignal stops fetch or SSE consumption. */
function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Parse one SSE data payload into a Chat Completions chunk object. */
function parseSseData(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Malformed SSE from OpenAI-compatible endpoint");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Malformed SSE from OpenAI-compatible endpoint"
    ) {
      throw error;
    }
    throw new Error("Malformed SSE from OpenAI-compatible endpoint");
  }
}

/** Turn a non-OK endpoint response into an actionable, redacted error. */
async function endpointError(
  response: Response,
  secrets: readonly string[],
): Promise<Error> {
  const text = await response.text();
  const serverMessage = errorMessageFromBody(text);
  const status = response.status;
  const detail = serverMessage ? `: ${serverMessage}` : "";
  const message =
    status === 401 || status === 403
      ? `OpenAI-compatible endpoint authentication failed${detail}`
      : `OpenAI-compatible endpoint error (${status})${detail}`;
  const error = new Error(redactSecrets(message, secrets)) as Error & {
    status: number;
    headers: Headers;
  };
  error.status = status;
  error.headers = response.headers;
  return error;
}

/** Read a provider error.message when the body is JSON. */
function errorMessageFromBody(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof value.error === "string" && value.error.length > 0) {
      return value.error;
    }
    if (
      value.error &&
      typeof value.error === "object" &&
      typeof value.error.message === "string" &&
      value.error.message.length > 0
    ) {
      return value.error.message;
    }
    if (typeof value.message === "string" && value.message.length > 0) {
      return value.message;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Split complete SSE events out of a streaming buffer. */
function extractSseData(buffer: string): {
  payloads: string[];
  rest: string;
} {
  const payloads: string[] = [];
  let rest = buffer;
  while (true) {
    const boundary = rest.indexOf("\n\n");
    const crBoundary = rest.indexOf("\r\n\r\n");
    let sep = -1;
    let sepLen = 0;
    if (boundary !== -1 && (crBoundary === -1 || boundary <= crBoundary)) {
      sep = boundary;
      sepLen = 2;
    } else if (crBoundary !== -1) {
      sep = crBoundary;
      sepLen = 4;
    }
    if (sep === -1) {
      break;
    }
    const rawEvent = rest.slice(0, sep);
    rest = rest.slice(sep + sepLen);
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) {
      payloads.push(dataLines.join("\n"));
    }
  }
  return { payloads, rest };
}

/** In-progress Chat Completions tool call assembled from streamed argument JSON. */
type PendingToolCall = {
  id: string;
  name: string;
  json: string;
};

/** Accumulate Chat Completions chunks into Schway deltas and a final message. */
function createStreamBuilder() {
  const id = crypto.randomUUID();
  let text = "";
  const toolCalls: PendingToolCall[] = [];

  return {
    /** Fold one chunk into text/tool JSON and emit Schway deltas. */
    accept(chunk: Record<string, unknown>): ModelStreamEvent[] {
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return [];
      }
      const choice = choices[0] as {
        delta?: { content?: unknown; tool_calls?: unknown };
      };
      const deltas: ModelStreamEvent[] = [];
      const content = choice.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        text += content;
        deltas.push({ type: "text_delta", text: content });
      }
      appendToolDeltas(toolCalls, choice.delta?.tool_calls);
      return deltas;
    },
    /** Build the Schway assistant message after the stream ends. */
    complete(): AssistantMessage {
      const content: AssistantContent[] = [];
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
      for (const call of toolCalls) {
        if (!call) {
          continue;
        }
        content.push({
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: parseToolArguments(call.json),
        });
      }
      return { type: "assistant", id, content };
    },
  };
}

/** Merge streamed tool_calls deltas into slots keyed by Chat Completions index. */
function appendToolDeltas(toolCalls: PendingToolCall[], raw: unknown): void {
  if (!Array.isArray(raw)) {
    return;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const delta = entry as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index = typeof delta.index === "number" ? delta.index : 0;
    const current = toolCalls[index] ?? { id: "", name: "", json: "" };
    if (typeof delta.id === "string" && delta.id.length > 0) {
      current.id = delta.id;
    }
    const fn = delta.function;
    if (fn && typeof fn === "object") {
      if (typeof fn.name === "string" && fn.name.length > 0) {
        current.name = fn.name;
      }
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        current.json += fn.arguments;
      }
    }
    toolCalls[index] = current;
  }
}

/** Parse assembled tool JSON. Malformed input is returned as the raw string. */
function parseToolArguments(json: string): unknown {
  if (json.length === 0) {
    return {};
  }
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
