import OpenAI from "openai";
import { lookupModel } from "../catalog.ts";
import { assertThinking } from "../thinking.ts";
import type { Model, ModelRequest, ThinkingLevel } from "../model.ts";
import { assembleResponsesStream, buildResponsesRequest } from "./responses-stream.ts";

/** Named effort per level. `none` disables; `xhigh` and `max` match current reasoning-capable models. */
export const OPENAI_THINKING_EFFORTS = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/** Resolve a provider-independent level to an OpenAI reasoning param, leaving defaults untouched when unset or off without disabling support. */
export function resolveOpenAIReasoning(
  level: ThinkingLevel | undefined,
  modelId: string,
): { effort: "none" } | { effort: "low" | "medium" | "high" | "xhigh" | "max"; summary: "auto" } | undefined {
  const policy = assertThinking({ provider: "openai", model: modelId }, level);
  if (level === undefined || (level === "off" && !policy.supportsDisabling)) return undefined;
  if (level === "off") return { effort: "none" };
  // The policy only admits documented API levels; wire types stay inside this adapter.
  return { effort: level as "low" | "medium" | "high" | "xhigh" | "max", summary: "auto" };
}

/** Optional fetch override used by protocol tests. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requiredModelId(model: string | undefined): string {
  const modelId = model?.trim() ?? "";
  if (!modelId) throw new Error("A model ID is required.");
  return modelId;
}

/**
 * Create an OpenAI Responses adapter with SDK retries disabled and Schway-owned conversation records.
 * Streaming forwards request cancellation and provider failures, and assembles function-call JSON before exposing a call.
 */
export function createOpenAIModel(options: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  fetch?: FetchLike;
}): Model {
  const modelId = requiredModelId(options.model);
  const maxTokens = options.maxTokens ?? lookupModel("openai", modelId).maxOutput;
  const defaultThinking = options.thinking;
  const client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: 0,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    provider: "openai",
    id: modelId,
    /** Stream Schway events; function-call JSON is assembled before message_complete. */
    async *stream(request: ModelRequest) {
      const reasoning = resolveOpenAIReasoning(request.thinking ?? defaultThinking, modelId);
      const stream = await client.responses.create(
        buildResponsesRequest({ model: modelId, maxOutputTokens: maxTokens, reasoning, request, namespace: "openai" }),
        { signal: request.signal },
      );
      yield* assembleResponsesStream({ stream, namespace: "openai", label: "OpenAI" });
    },
  };
}
