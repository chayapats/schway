import type { Model, ThinkingLevel } from "./model.ts";
import type { CliAuthMode, CliProvider } from "../cli/args.ts";

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
