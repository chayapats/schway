import { MISSING_ANTHROPIC_API_KEY, MISSING_OPENAI_API_KEY } from "./secrets.ts";
import { credentialIdentity, credentialStoreError, type CredentialStore, type CredentialTarget } from "./store.ts";

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
  const missing = input.provider === "anthropic" ? MISSING_ANTHROPIC_API_KEY
    : input.provider === "openai" ? MISSING_OPENAI_API_KEY
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
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : COMPATIBLE_API_KEY_ENV;
}
