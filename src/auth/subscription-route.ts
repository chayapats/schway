import { selectOpenAITransport } from "./credentials.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, createNativeCredentialStore, type CredentialStore } from "./store.ts";
import type { FetchLike, ProviderLoaderInput } from "../model/loader.ts";

/** Resolve a stored subscription without interactive login or API-key fallback, optionally persisting a preflight refresh. */
export async function resolveSubscriptionRoute(options: {
  provider: "codex" | "grok";
  model: string;
  maxTokens: number;
  store?: CredentialStore;
  env?: Record<string, string | undefined>;
  refresh?: boolean;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ input: ProviderLoaderInput } | { reason: "missing_subscription" | "credential_store_unavailable" | "integration_unavailable" | "subscription_requires_login" }> {
  const store = options.store ?? createNativeCredentialStore();
  const codex = options.provider === "codex";
  if (codex) {
    const selected = await selectOpenAITransport({ openaiAuth: "codex", env: options.env ?? {}, store });
    if ("error" in selected) return { reason: selected.error.startsWith("No ChatGPT") ? "missing_subscription" : "credential_store_unavailable" };
  }
  let raw: string | null;
  try { raw = await store.get(codex ? codexSubscriptionIdentity() : grokSubscriptionIdentity()); }
  catch { return { reason: "credential_store_unavailable" }; }
  if (!raw?.trim()) return { reason: "missing_subscription" };
  let integration;
  try { integration = codex ? inspectIntegration(await import("../model/providers/codex-subscription.ts")) : inspectIntegration(await import("../model/providers/grok-subscription.ts")); }
  catch { return { reason: "integration_unavailable" }; }
  try {
    if (integration.requiresLogin(raw)) return { reason: "subscription_requires_login" };
    if (options.refresh) await integration.createSubscriptionTokenRefresher({ store, fetch: options.fetch }).getValidAccessToken(options.signal);
  } catch { return { reason: "subscription_requires_login" }; }
  return { input: codex
    ? { provider: "openai", openaiAuth: "codex", model: options.model, maxTokens: options.maxTokens, codexStore: store }
    : { provider: "xai", xaiAuth: "grok", model: options.model, maxTokens: options.maxTokens, grokStore: store } };
}

/** Bind token parsing and expiry checks to their own adapter while exposing only credential-free readiness. */
function inspectIntegration<T extends { refreshToken?: string }>(integration: {
  parseSubscriptionTokens(raw: string): T;
  subscriptionAccessExpired(tokens: T): boolean;
  createSubscriptionTokenRefresher(input: { store: CredentialStore; fetch?: FetchLike }): { getValidAccessToken(signal?: AbortSignal): Promise<unknown> };
}) {
  return {
    /** Reject expired credentials that cannot be renewed without login. */
    requiresLogin(raw: string): boolean {
      const tokens = integration.parseSubscriptionTokens(raw);
      return integration.subscriptionAccessExpired(tokens) && !tokens.refreshToken;
    },
    createSubscriptionTokenRefresher: integration.createSubscriptionTokenRefresher,
  };
}
