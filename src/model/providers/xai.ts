import OpenAI from "openai";
import type { ModelCapability } from "../catalog.ts";
import { assertThinking } from "../thinking.ts";
import { lookupModel } from "../catalog.ts";
import type { Model, ModelCallOptions, ModelRequest, ThinkingLevel } from "../model.ts";
import { isPromptCacheKey } from "../prompt-cache-key.ts";
import { controlsFromBody, isRefusedRedirect, providerDispatch, redirectRefusedError, reportedEffort, type ProviderSendKind } from "../dispatch.ts";
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
  /** Static key, or a resolver that reports each renewal request it starts through `onRenewal`, with the renewal's settlement. */
  apiKey: string | ((signal?: AbortSignal, onRenewal?: (settled: Promise<void>) => void) => Promise<string>);
  /** Renew a rejected subscription token once without entering the agent retry loop, reporting its renewal like `apiKey`. */
  refreshCredential?: (rejectedToken: string, signal?: AbortSignal, onRenewal?: (settled: Promise<void>) => void) => Promise<string>;
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
  const clientFor = (token: string, fetchFn: FetchLike | undefined) => new OpenAI({
    apiKey: token,
    baseURL: options.baseUrl ?? XAI_BASE_URL,
    maxRetries: 0,
    logLevel: "off",
    fetch: fetchFn,
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
      const dispatch = providerDispatch(call);
      // The settlement must reach the dispatch hook: it keeps a stopped caller's sent renewal authorized until it settles.
      const onRenewal = dispatch ? (settled: Promise<void>) => dispatch.renewal(settled) : undefined;
      let token = typeof options.apiKey === "function" ? await options.apiKey(request.signal, onRenewal) : options.apiKey;
      const tokens = [token];
      const safeError = (error: unknown): unknown => {
        if (!options.refreshCredential) return error;
        const message = tokens.reduce((text, secret) => secret ? text.replaceAll(secret, "[redacted]") : text, error instanceof Error ? error.message : "Grok request failed.");
        return Object.assign(new Error(message), error instanceof OpenAI.APIError ? { status: error.status, headers: error.headers } : {});
      };
      // The SDK wraps fetch failures as connection errors, so a refusal is kept here and rethrown unchanged.
      let refusal: unknown;
      // Authorization runs inside the SDK's single fetch call: after every SDK await, on the exact serialized body.
      // Host route sends refuse redirects, authorizer or not, so a 3xx never becomes a second, uncounted send.
      // Controls come from the bytes the SDK actually sends, so no SDK transform can make them diverge from the hash.
      const authorizedFetch = (kind: ProviderSendKind): FetchLike | undefined => dispatch ? (input, init) => {
        try { dispatch.send(kind, init?.body, controlsFromBody(init?.body)); }
        catch (error) { refusal = error; throw error; }
        return (options.fetch ?? fetch)(input, { ...init, redirect: "error" });
      } : options.fetch;
      // The xAI catalog may advertise efforts beyond OpenAI SDK enums; preserve them exactly.
      const send = (kind: ProviderSendKind) => clientFor(token, authorizedFetch(kind)).responses.create(body as OpenAI.Responses.ResponseCreateParamsStreaming, { signal: request.signal, headers: { Authorization: `Bearer ${token}` } });
      // The SDK reports a refused redirect as a connection error; the server did answer, so it is not retried.
      const redirected = (error: unknown) => dispatch !== undefined && isRefusedRedirect(error);
      const label = options.authRoute === "grok" ? "Grok subscription" : "xAI API";
      let stream;
      try { stream = await send("initial"); }
      catch (error) {
        if (refusal !== undefined) throw refusal;
        if (redirected(error)) throw redirectRefusedError(label);
        if (error instanceof OpenAI.APIError && error.status === 401 && options.refreshCredential) {
          token = await options.refreshCredential(token, request.signal, onRenewal); tokens.push(token);
          try { stream = await send("auth-retry"); }
          catch (retryError) {
            if (refusal !== undefined) throw refusal;
            if (redirected(retryError)) throw redirectRefusedError(label);
            if (retryError instanceof OpenAI.APIError && [401, 403].includes(retryError.status ?? 0) && options.authError) throw options.authError(retryError.status!);
            throw safeError(retryError);
          }
        } else if (error instanceof OpenAI.APIError && error.status === 403 && options.authError) throw options.authError(403);
        else throw safeError(error);
      }
      try { yield* assembleResponsesStream({ stream, namespace: "xai", label: "xAI", ...(dispatch ? { onTerminal: (response: unknown) => dispatch.reported({ effort: reportedEffort(response) }) } : {}) }); }
      catch (error) { throw safeError(error); }
    },
  };
}
