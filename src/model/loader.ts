import type { Model, ThinkingLevel } from "./model.ts";
import type { CliAuthMode, CliOpenAIAuth, CliProvider } from "../cli/args.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { CodexTokens } from "./providers/codex-subscription.ts";

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
  /** Stored subscription tokens for the codex transport when no store-backed refresher is used. */
  codexTokens?: CodexTokens;
  /** Secure-store renewal channel for the codex transport; enables serialized pre-expiry refresh. */
  codexStore?: CredentialStore;
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
  if (input.provider === "openai") {
    if (input.openaiAuth === "codex") {
      const { createCodexSubscriptionModel } = await import("./providers/codex-subscription.ts");
      return createCodexSubscriptionModel({
        model: input.model,
        maxTokens: input.maxTokens,
        thinking: input.thinking,
        tokens: input.codexTokens,
        store: input.codexStore,
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
  const { createAnthropicModel } = await import("./providers/anthropic.ts");
  return createAnthropicModel({
    apiKey: input.apiKey ?? "",
    model: input.model,
    maxTokens: input.maxTokens,
    thinking: input.thinking,
    fetch: fetchFn,
  });
}
