import OpenAI from "openai";
import type { ModelCapability } from "../catalog.ts";
import { lookupModel } from "../catalog.ts";
import type { Model, ModelRequest, ThinkingLevel } from "../model.ts";
import { assembleResponsesStream, buildResponsesRequest, type ResponsesReasoning } from "./responses-stream.ts";

/** Public xAI Responses API origin used when tests do not inject a base URL. */
export const XAI_BASE_URL = "https://api.x.ai/v1";

/** Public model-list endpoint for an xAI API key. */
export const XAI_MODELS_URL = "https://api.x.ai/v1/models";

/** Optional fetch override used by protocol tests. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Map a requested level onto xAI reasoning, sending `none` only when the list includes off. */
export function resolveXaiReasoning(
  level: ThinkingLevel | undefined,
  capability?: ModelCapability,
): ResponsesReasoning | undefined {
  if (level === undefined) return undefined;
  if (level === "off") {
    if (capability?.supportsDisabling && capability.supportedThinking.includes("off")) {
      return { effort: "none", summary: "auto" };
    }
    return undefined;
  }
  if (level === "ultra") return undefined;
  return { effort: level, summary: "auto" };
}

function requiredModelId(model: string | undefined): string {
  const modelId = model?.trim() ?? "";
  if (!modelId) throw new Error("A model ID is required.");
  return modelId;
}

/**
 * Create an xAI Responses adapter that reuses OpenAI Responses assembly and never retries inside the SDK.
 * Encrypted reasoning is stored and replayed only under `providerMetadata.xai`.
 */
export function createXaiModel(options: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  modelCapability?: ModelCapability;
  fetch?: FetchLike;
  /** Test-only origin; production uses `XAI_BASE_URL`. */
  baseUrl?: string;
}): Model {
  const modelId = requiredModelId(options.model);
  const maxTokens = options.maxTokens ?? lookupModel("xai", modelId).maxOutput;
  const defaultThinking = options.thinking;
  const capability = options.modelCapability;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? XAI_BASE_URL,
    maxRetries: 0,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    provider: "xai",
    id: modelId,
    /** Stream Schway events; function-call JSON is assembled before message_complete. */
    async *stream(request: ModelRequest) {
      const reasoning = resolveXaiReasoning(request.thinking ?? defaultThinking, capability);
      const stream = await client.responses.create(
        buildResponsesRequest({ model: modelId, maxOutputTokens: maxTokens, reasoning, request, namespace: "xai" }),
        { signal: request.signal },
      );
      yield* assembleResponsesStream({ stream, namespace: "xai", label: "xAI" });
    },
  };
}
