import type { Model, ThinkingLevel } from "./model.ts";
import type { CliAuthMode, CliOpenAIAuth, CliProvider } from "../cli/args.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { CodexTokens } from "./providers/codex-subscription.ts";
import type { ModelCapability } from "./catalog.ts";

const grokModels = new WeakSet<Model>();
/** Mark an activated model as subscription-backed without changing its xAI conversation namespace. */
export function bindGrokModel(model: Model): Model { grokModels.add(model); return model; }
/** Identify an active Grok billing route even when the configured preference is automatic. */
export function isGrokModel(model: Model | undefined): boolean { return model !== undefined && grokModels.has(model); }

/** Optional fetch override used by protocol fixture tests. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Explicit provider construction inputs; credential resolution stays with callers. */
export interface ProviderLoaderInput {
  provider: CliProvider;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: CliAuthMode;
  /** Provider-independent reasoning level mapped inside each adapter without shared wire semantics. */
  thinking?: ThinkingLevel;
  /** OpenAI credential preference; codex loads the isolated subscription adapter. */
  openaiAuth?: CliOpenAIAuth;
  /** Explicit xAI billing transport; Grok uses only its secure-store login. */
  xaiAuth?: "auto" | "grok" | "api-key";
  /** Secure-store renewal channel for the Grok transport. */
  grokStore?: CredentialStore;
  /** Stored subscription tokens for the codex transport when no store-backed refresher is used. */
  codexTokens?: CodexTokens;
  /** Secure-store renewal channel for the codex transport; enables serialized pre-expiry refresh. */
  codexStore?: CredentialStore;
  /** Verified list capabilities used by Codex and xAI, not by the OpenAI API-key transport. */
  modelCapability?: ModelCapability;
}

/**
 * Construct only the selected provider adapter via lazy dynamic imports.
 * Headless and interactive callers share this so provider bundling stays lazy.
 */
export async function loadProviderModel(
  input: ProviderLoaderInput,
  fetchFn?: FetchLike,
): Promise<Model> {
  if (input.provider === "openai-compatible") {
    const { createOpenAICompatibleModel } = await import("./providers/openai-compatible.ts");
    return createOpenAICompatibleModel({
      baseUrl: input.baseUrl ?? "",
      apiKey: input.apiKey,
      model: input.model,
      maxTokens: input.maxTokens,
      headers: input.headers,
      extraBody: input.extraBody,
      auth: input.auth,
      thinking: input.thinking,
      fetch: fetchFn,
    });
  }
  if (input.provider === "xai") {
    const { createXaiModel } = await import("./providers/xai.ts");
    if (input.xaiAuth === "grok") {
      const grok = await import("./providers/grok-subscription.ts");
      if (!input.grokStore) throw new Error("Grok subscription storage is unavailable.");
      const refresher = grok.createSubscriptionTokenRefresher({ store: input.grokStore, fetch: fetchFn });
      return bindGrokModel(createXaiModel({
        apiKey: signal => refresher.getValidAccessToken(signal),
        refreshCredential: (token, signal) => refresher.getValidAccessToken(signal, token),
        authError: status => new Error(status === 403 ? grok.GROK_PLAN_ERROR : grok.grokRevokedSessionError()),
        model: input.model, maxTokens: input.maxTokens, thinking: input.thinking, modelCapability: input.modelCapability, fetch: fetchFn,
      }));
    }
    return createXaiModel({
      apiKey: input.apiKey ?? "",
      model: input.model,
      maxTokens: input.maxTokens,
      thinking: input.thinking,
      modelCapability: input.modelCapability,
      fetch: fetchFn,
    });
  }
  if (input.provider === "openai") {
    if (input.openaiAuth === "codex") {
      const { createCodexSubscriptionModel } = await import("./providers/codex-subscription.ts");
      return createCodexSubscriptionModel({
        model: input.model,
        maxTokens: input.maxTokens,
        thinking: input.thinking,
        tokens: input.codexTokens,
        store: input.codexStore,
        modelCapability: input.modelCapability,
        fetch: fetchFn,
      });
    }
    const { createOpenAIModel } = await import("./providers/openai.ts");
    return createOpenAIModel({
      apiKey: input.apiKey ?? "",
      model: input.model,
      maxTokens: input.maxTokens,
      thinking: input.thinking,
      fetch: fetchFn,
    });
  }
  throw new Error(`Unsupported provider: ${String(input.provider)}`);
}
