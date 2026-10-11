import { MISSING_OPENAI_API_KEY, MISSING_XAI_API_KEY, XAI_API_KEY_ENV } from "./secrets.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, credentialIdentity, credentialStoreError, type CredentialStore, type CredentialTarget } from "./store.ts";

/** Dedicated environment override for the selected compatible endpoint, separate from native OpenAI. */
export const COMPATIBLE_API_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

/** Origin of the key selected for provider construction, or no automatic authentication. */
export type ProviderCredentialSource = "runtime" | "env" | "stored" | "none";

/** Selected credential and its source, or safe recovery guidance without the secret. */
export type ProviderCredential = { apiKey?: string; source: ProviderCredentialSource } | { error: string };

/** Resolve one selected provider's key, consulting secure storage only after usable overrides are absent. */
export async function resolveProviderCredential(input: CredentialTarget & {
  runtimeApiKey?: string;
  env: Record<string, string | undefined>;
  auth?: "required" | "optional" | "none";
  credentialEnv?: string;
  store: CredentialStore;
}): Promise<ProviderCredential> {
  const profileSuffix = input.profile?.trim() ? ` for profile "${input.profile.trim()}"` : "";
  const missing = input.provider === "openai" ? MISSING_OPENAI_API_KEY
    : input.provider === "xai" ? MISSING_XAI_API_KEY
    : `Missing API key for OpenAI-compatible endpoint${profileSuffix}. Pass --api-key${input.credentialEnv ? `, set ${input.credentialEnv}` : ", set OPENAI_COMPATIBLE_API_KEY"}, or save a key in interactive mode.`;
  if (input.runtimeApiKey !== undefined && !input.runtimeApiKey.trim()) {
    return { error: "Explicit API key is empty. Supply a nonempty --api-key or omit the override." };
  }
  if (input.runtimeApiKey !== undefined) return { apiKey: input.runtimeApiKey.trim(), source: "runtime" };
  if (input.provider === "openai-compatible" && input.auth === "none") return { source: "none" };
  if (input.provider === "openai-compatible" && input.credentialEnv) {
    const profileKey = input.env[input.credentialEnv]?.trim();
    if (profileKey) return { apiKey: profileKey, source: "env" };
  } else {
    const environmentKey = input.env[credentialEnvironmentVariable(input.provider)]?.trim();
    if (environmentKey) return { apiKey: environmentKey, source: "env" };
  }
  let identity;
  try { identity = credentialIdentity(input); }
  catch { return { error: "Select a valid HTTP(S) base URL before resolving OpenAI-compatible credentials." }; }
  let stored: string | null;
  try { stored = await input.store.get(identity); }
  catch {
    if (input.provider === "openai-compatible" && (input.auth ?? "optional") === "optional") {
      return { source: "none" };
    }
    return { error: credentialStoreError("read") };
  }
  const apiKey = stored?.trim();
  if (apiKey) return { apiKey, source: "stored" };
  if (input.provider === "openai-compatible" && (input.auth ?? "optional") === "optional") return { source: "none" };
  return { error: missing };
}

/** Return the environment variable explicitly scoped to the selected provider family. */
export function credentialEnvironmentVariable(provider: CredentialTarget["provider"]): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "xai") return XAI_API_KEY_ENV;
  return COMPATIBLE_API_KEY_ENV;
}

/** OpenAI credential preference: subscription login, API key, or automatic headless-safe selection. */
export type OpenAIAuthPreference = "auto" | "codex" | "api-key";

/** True when the value names a supported OpenAI auth preference. */
export function isOpenAIAuthPreference(value: unknown): value is OpenAIAuthPreference {
  return value === "auto" || value === "codex" || value === "api-key";
}

/** Guidance returned when the explicit ChatGPT subscription route has no stored subscription login. */
export const MISSING_CODEX_SUBSCRIPTION =
  "No ChatGPT subscription login found. Sign in in interactive mode with /login chatgpt (or /login chatgpt --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache.";

/** Selected OpenAI transport, or actionable guidance that never silently changes billing. */
export type OpenAITransport =
  | { transport: "api-key"; notice?: string }
  | { transport: "codex"; notice?: string }
  | { error: string };

/** Select the OpenAI transport without starting any interactive flow; explicit preference always wins. */
export async function selectOpenAITransport(input: {
  openaiAuth?: OpenAIAuthPreference;
  /** Discovery stops once subscription precedence selects an identity. Execution retains its existing checks. */
  minimalLookup?: boolean;
  runtimeApiKey?: string;
  env: Record<string, string | undefined>;
  store: CredentialStore;
}): Promise<OpenAITransport> {
  const preference = input.openaiAuth ?? "auto";
  if (!isOpenAIAuthPreference(preference)) {
    return { error: `Unknown OpenAI auth preference: ${String(input.openaiAuth)}. Use auto, chatgpt, or api-key.` };
  }
  if (input.runtimeApiKey !== undefined && !input.runtimeApiKey.trim()) {
    return { error: "Explicit API key is empty. Supply a nonempty --api-key or omit the override." };
  }
  const runtimeKey = input.runtimeApiKey?.trim() ? input.runtimeApiKey.trim() : undefined;
  const envKey = input.env["OPENAI_API_KEY"]?.trim() ? input.env["OPENAI_API_KEY"]!.trim() : undefined;
  if (preference === "codex") {
    let stored: string | null;
    try {
      stored = await input.store.get(codexSubscriptionIdentity());
    } catch {
      return { error: credentialStoreError("read") };
    }
    if (!stored?.trim()) {
      return { error: MISSING_CODEX_SUBSCRIPTION };
    }
    const notice = runtimeKey !== undefined || envKey !== undefined
      ? "Explicit chatgpt selection ignores the runtime/environment API key; subscription billing applies."
      : undefined;
    return notice !== undefined ? { transport: "codex", notice } : { transport: "codex" };
  }
  if (preference === "api-key") {
    return { transport: "api-key" };
  }
  if (runtimeKey !== undefined || envKey !== undefined) {
    return { transport: "api-key" };
  }
  let subscription: string | null;
  let storedApiKey: string | null;
  try {
    if (input.minimalLookup) {
      subscription = await input.store.get(codexSubscriptionIdentity());
      if (subscription?.trim()) return { transport: "codex" };
      storedApiKey = await input.store.get(credentialIdentity({ provider: "openai" }));
    } else [subscription, storedApiKey] = await Promise.all([
      input.store.get(codexSubscriptionIdentity()),
      input.store.get(credentialIdentity({ provider: "openai" })),
    ]);
  } catch {
    return { error: credentialStoreError("read") };
  }
  if (subscription?.trim()) {
    return { transport: "codex" };
  }
  if (storedApiKey?.trim()) {
    return { transport: "api-key" };
  }
  return {
    error:
      `${MISSING_OPENAI_API_KEY} No stored subscription login was found either; sign in in interactive mode with /login chatgpt, or stay on API-key billing.`,
  };
}

/** xAI billing preference, with automatic selection restricted to existing credentials. */
export type XaiAuthPreference = "auto" | "grok" | "api-key";
/** True when a value names one supported xAI billing preference. */
export function isXaiAuthPreference(value: unknown): value is XaiAuthPreference { return value === "auto" || value === "grok" || value === "api-key"; }
/** Headless-safe guidance when the selected subscription has not been connected. */
export const MISSING_GROK_SUBSCRIPTION = "No Grok subscription login found. Sign in in interactive mode with /login grok (or /login grok --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache.";
/** Selected xAI billing transport or an actionable credential error. */
export type XaiTransport = { transport: "grok" | "api-key" } | { error: string };
/** Select only the requested billing identity without starting login or reading other credential caches. */
export async function selectXaiTransport(input: { xaiAuth?: XaiAuthPreference; runtimeApiKey?: string; env: Record<string, string | undefined>; store: CredentialStore }): Promise<XaiTransport> {
  const preference = input.xaiAuth ?? "auto";
  if (!isXaiAuthPreference(preference)) return { error: `Unknown xAI auth preference: ${String(preference)}. Use auto, grok, or api-key.` };
  if (preference === "api-key") return { transport: "api-key" };
  if (preference === "grok") {
    try { return (await input.store.get(grokSubscriptionIdentity()))?.trim() ? { transport: "grok" } : { error: MISSING_GROK_SUBSCRIPTION }; }
    catch { return { error: credentialStoreError("read") }; }
  }
  if (input.runtimeApiKey !== undefined || input.env.XAI_API_KEY?.trim()) return { transport: "api-key" };
  try {
    if ((await input.store.get(grokSubscriptionIdentity()))?.trim()) return { transport: "grok" };
    if ((await input.store.get(credentialIdentity({ provider: "xai" })))?.trim()) return { transport: "api-key" };
  } catch { return { error: credentialStoreError("read") }; }
  return { error: MISSING_XAI_API_KEY };
}
