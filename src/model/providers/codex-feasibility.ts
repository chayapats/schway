import type {
  AssistantContent,
  AssistantMessage,
} from "../../conversation/types.ts";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
} from "../model.ts";

/** Default model id reported by the Codex subscription feasibility replay. */
export const CODEX_FEASIBILITY_MODEL = "codex-feasibility-replay";

/** Single normalized tool call requested by the replayed model turn. */
export interface CodexFeasibilityToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** One scripted model turn for the offline feasibility replay. */
export interface CodexFeasibilityTurn {
  chunks?: string[];
  toolCalls?: CodexFeasibilityToolCall[];
  error?: string;
  waitForAbort?: boolean;
}

/** Normalized wire-equivalent request observed at the Schway-owned boundary. */
export interface CodexFeasibilityWireRequest {
  model: string;
  instructions: string;
  input: unknown[];
  tools: Array<{ name: string; description: string }>;
}

/** Options for the isolated Codex subscription feasibility model. */
export interface CodexFeasibilityOptions {
  model?: string;
  turns: CodexFeasibilityTurn[];
  secrets?: string[];
  onRequest?: (request: CodexFeasibilityWireRequest) => void;
}

/** Create an offline replay model proving Schway-owned tool execution without delegating the run. */
export function createCodexFeasibilityModel(
  options: CodexFeasibilityOptions,
): Model & { readonly requestCount: number; readonly executedTools: number } {
  const modelId = options.model?.trim() || CODEX_FEASIBILITY_MODEL;
  const secrets = (options.secrets ?? []).filter((s) => s.length > 0);
  let requestCount = 0;
  // The replay transport never executes tools; Schway always executes them.
  const executedTools = 0;

  return {
    provider: "codex-feasibility",
    id: modelId,
    get requestCount(): number {
      return requestCount;
    },
    get executedTools(): number {
      return executedTools;
    },
    /** Stream replayed deltas then a complete message, honoring cancellation without retries. */
    async *stream(
      request: ModelRequest,
    ): AsyncIterable<ModelStreamEvent> {
      const turn = options.turns[requestCount];
      if (turn === undefined) {
        throw new Error(redact("codex-feasibility replay has no more turns", secrets));
      }
      requestCount += 1;
      options.onRequest?.(toWireRequest(modelId, request));
      throwIfAborted(request.signal, secrets);
      if (turn.error && !turn.waitForAbort) {
        throw new Error(redact(turn.error, secrets));
      }
      for (const chunk of turn.chunks ?? []) {
        throwIfAborted(request.signal, secrets);
        yield { type: "text_delta", text: chunk };
      }
      if (turn.waitForAbort) {
        await waitForAbort(request.signal);
        throwIfAborted(request.signal, secrets);
        if (turn.error) {
          throw new Error(redact(turn.error, secrets));
        }
      } else if (turn.error) {
        throw new Error(redact(turn.error, secrets));
      }
      yield {
        type: "message_complete",
        message: toAssistantMessage(turn, modelId),
      };
    },
  };
}

/** Map a Schway request onto the normalized model-only boundary observed by the replay. */
export function toWireRequest(
  modelId: string,
  request: ModelRequest,
): CodexFeasibilityWireRequest {
  const sections = request.context.map(
    (section) => `<${section.name}>\n${section.content}\n</${section.name}>`,
  );
  const instructions = [request.systemPrompt, ...sections].join("\n\n");
  const input: unknown[] = [];
  for (const item of request.items) {
    if (item.type === "user") {
      input.push({
        role: "user",
        content: item.content.map((block) => block.text).join(""),
      });
    } else if (item.type === "assistant") {
      input.push({
        role: "assistant",
        content: item.content
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(""),
        toolCalls: item.content
          .filter((block) => block.type === "tool_call")
          .map((block) =>
            block.type === "tool_call"
              ? { id: block.id, name: block.name, arguments: block.arguments }
              : undefined,
          ),
      });
    } else {
      input.push({
        role: "tool",
        toolCallId: item.toolCallId,
        content: item.content,
        isError: item.isError,
      });
    }
  }
  return {
    model: modelId,
    instructions,
    input,
    tools: (request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  };
}

/** Assemble the completed assistant message for one replayed turn. */
function toAssistantMessage(
  turn: CodexFeasibilityTurn,
  modelId: string,
): AssistantMessage {
  const content: AssistantContent[] = [];
  const text = (turn.chunks ?? []).join("");
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const call of turn.toolCalls ?? []) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return {
    type: "assistant",
    id: `asst-${modelId}-${crypto.randomUUID()}`,
    content,
  };
}

/** Throw an AbortError when the Schway-owned cancellation signal fires. */
function throwIfAborted(signal: AbortSignal | undefined, secrets: string[]): void {
  if (signal?.aborted) {
    throw redactError(new DOMException("Aborted", "AbortError"), secrets);
  }
}

/** Wait until the caller cancels; rejects immediately when no signal is supplied. */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return Promise.reject(new Error("codex-feasibility waitForAbort requires a signal"));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Redact configured secrets from an error while preserving its name. */
function redactError(error: DOMException, secrets: string[]): DOMException {
  if (secrets.length === 0) {
    return error;
  }
  const redacted = redact(error.message, secrets);
  const out = new DOMException(redacted, error.name);
  return out;
}

/** Replace secret substrings so replay failures never leak credentials. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
