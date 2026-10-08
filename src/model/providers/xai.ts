import OpenAI from "openai";
import type { ModelCapability } from "../catalog.ts";
import { assertThinking } from "../thinking.ts";
import { lookupModel } from "../catalog.ts";
import type { Model, ModelCallOptions, ModelRequest, ThinkingLevel } from "../model.ts";
import { isPromptCacheKey } from "../prompt-cache-key.ts";
import { assembleResponsesStream, buildResponsesRequest, type ResponsesReasoning } from "./responses-stream.ts";

/** Public xAI Responses API origin used when tests do not inject a base URL. */
export const XAI_BASE_URL = "https://api.x.ai/v1";

/** Public model-list endpoint for an xAI API key. */
export const XAI_MODELS_URL = "https://api.x.ai/v1/models";

/**
 * Per-route switch for replaying kept hosted items (such as `web_search_call`) on later requests.
 * xAI documents passing earlier output items back for stateless multi-turn use; a route whose live
 * check shows it rejects them on `store: false` turns this off, which keeps them stored but unsent.
 */
export const XAI_HOSTED_ITEM_REPLAY: Readonly<Record<"api-key" | "grok", boolean>> = { "api-key": true, grok: true };

/** Optional fetch override used by protocol tests. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Map a requested level onto xAI reasoning, sending `none` only when the list includes off. */
export function resolveXaiReasoning(
  level: ThinkingLevel | undefined,
  capability?: ModelCapability,
  modelId = capability?.id ?? "",
  authRoute: "api-key" | "grok" = "api-key",
): ResponsesReasoning | undefined {
  const policy = assertThinking({ provider: "xai", model: modelId, authRoute, capability: capability ?? null }, level);
  if (level === undefined || (level === "off" && !policy.supportsDisabling)) return undefined;
  return { effort: level === "off" ? "none" : level, summary: "auto" };
}

function requiredModelId(model: string | undefined): string {
  const modelId = model?.trim() ?? "";
  if (!modelId) throw new Error("A model ID is required.");
  return modelId;
}

/** Create an xAI Responses adapter with per-request credentials, namespaced reasoning and no SDK retries. */
export function createXaiModel(options: {
  apiKey: string | ((signal?: AbortSignal) => Promise<string>);
  /** Renew a rejected subscription token once without entering the agent retry loop. */
  refreshCredential?: (rejectedToken: string, signal?: AbortSignal) => Promise<string>;
  /** Map subscription authorization failures without changing API-key transport errors. */
  authError?: (status: number) => Error;
  model?: string;
  maxTokens?: number;
  thinking?: ThinkingLevel;
  modelCapability?: ModelCapability;
  authRoute?: "api-key" | "grok";
  fetch?: FetchLike;
  /** Test-only origin; production uses `XAI_BASE_URL`. */
  baseUrl?: string;
  /** Test-only override of `XAI_HOSTED_ITEM_REPLAY` for this adapter's route. */
  replayHostedItems?: boolean;
}): Model {
  const modelId = requiredModelId(options.model);
  const maxTokens = options.maxTokens ?? lookupModel("xai", modelId).maxOutput;
  const defaultThinking = options.thinking;
  const capability = options.modelCapability;
  const replayHostedItems = options.replayHostedItems ?? XAI_HOSTED_ITEM_REPLAY[options.authRoute ?? "api-key"];
  const clientFor = (token: string) => new OpenAI({
    apiKey: token,
    baseURL: options.baseUrl ?? XAI_BASE_URL,
    maxRetries: 0,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    provider: "xai",
    id: modelId,
    /** Stream Schway events; function-call JSON is assembled before message_complete. */
    async *stream(request: ModelRequest, call?: ModelCallOptions) {
      const reasoning = resolveXaiReasoning(request.thinking ?? defaultThinking, capability, modelId, options.authRoute);
      const cacheKey = call?.promptCacheKey;
      const body = {
        ...buildResponsesRequest({ model: modelId, maxOutputTokens: maxTokens, reasoning, request, namespace: "xai", hostedTools: request.hostedTools, replayHostedItems }),
        // xAI documents `prompt_cache_key` on POST /v1/responses, which both routes call; the
        // `x-grok-conv-id` header is documented only for Chat Completions and gRPC, so it is not sent.
        ...(isPromptCacheKey(cacheKey) ? { prompt_cache_key: cacheKey } : {}),
      };
      let token = typeof options.apiKey === "function" ? await options.apiKey(request.signal) : options.apiKey;
      const tokens = [token];
      const safeError = (error: unknown): unknown => {
        if (!options.refreshCredential) return error;
        const message = tokens.reduce((text, secret) => secret ? text.replaceAll(secret, "[redacted]") : text, error instanceof Error ? error.message : "Grok request failed.");
        return Object.assign(new Error(message), error instanceof OpenAI.APIError ? { status: error.status, headers: error.headers } : {});
      };
      // The xAI catalog may advertise efforts beyond OpenAI SDK enums; preserve them exactly.
      const send = () => clientFor(token).responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, { signal: request.signal, headers: { Authorization: `Bearer ${token}` } });
      let stream;
      try { stream = await send(); }
      catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 401 && options.refreshCredential) {
          token = await options.refreshCredential(token, request.signal); tokens.push(token);
          try { stream = await send(); }
          catch (retryError) { if (retryError instanceof OpenAI.APIError && [401, 403].includes(retryError.status ?? 0) && options.authError) throw options.authError(retryError.status!); throw safeError(retryError); }
        } else if (error instanceof OpenAI.APIError && error.status === 403 && options.authError) throw options.authError(403);
        else throw safeError(error);
      }
      try { yield* assembleResponsesStream({ stream, namespace: "xai", label: "xAI" }); }
      catch (error) { throw safeError(error); }
    },
  };
}
