import { resolveProviderCredential, selectOpenAITransport, type OpenAIAuthPreference } from "../auth/credentials.ts";
import type { CredentialStore, CredentialTarget } from "../auth/store.ts";
import type { CompatibleProfile } from "../config/config.ts";

/** Credential configuration for a picker row, without claiming remote authorization was verified. */
export type ModelAccess = "ChatGPT" | "API key" | "No key required" | "Login required";

/** Secret-free access metadata for native providers, endpoints, and named profiles. */
export interface ModelPickerAccess {
  providers: Record<string, ModelAccess>;
  profiles: Record<string, ModelAccess>;
  openaiTransport?: "codex" | "api-key";
}

/** Resolve picker access using the same credential precedence as model creation without contacting providers. */
export async function loadModelPickerAccess(input: {
  store: CredentialStore;
  env: Record<string, string | undefined>;
  runtimeApiKey?: string;
  openaiAuth?: OpenAIAuthPreference;
  baseUrl?: string;
  auth?: "required" | "optional" | "none";
  credentialEnv?: string;
  credentialIdentity?: string;
  activeProfile?: string;
  profiles?: Record<string, CompatibleProfile>;
}): Promise<ModelPickerAccess> {
  const access: ModelPickerAccess = { providers: {}, profiles: {} };
  const resolve = async (target: CredentialTarget & { auth?: "required" | "optional" | "none"; credentialEnv?: string }): Promise<ModelAccess> => {
    const result = await resolveProviderCredential({ ...target, store: input.store, env: input.env, runtimeApiKey: input.runtimeApiKey });
    return "error" in result ? "Login required" : result.source === "none" ? "No key required" : "API key";
  };
  await Promise.all([
    resolve({ provider: "anthropic" }).then(value => { access.providers.anthropic = value; }),
    (async () => {
      const transport = await selectOpenAITransport(input);
      if ("error" in transport) { access.providers.openai = "Login required"; return; }
      access.openaiTransport = transport.transport;
      access.providers.openai = transport.transport === "codex" ? "ChatGPT" : await resolve({ provider: "openai" });
    })(),
    (async () => {
      access.providers["openai-compatible"] = input.baseUrl && !input.activeProfile
        ? await resolve({ provider: "openai-compatible", baseUrl: input.baseUrl, auth: input.auth, credentialEnv: input.credentialEnv, credentialIdentity: input.credentialIdentity })
        : "Login required";
    })(),
    ...Object.entries(input.profiles ?? {}).map(async ([name, profile]) => {
      access.profiles[name] = await resolve({ provider: "openai-compatible", profile: name, baseUrl: profile.baseUrl,
        auth: profile.auth, credentialEnv: profile.credentialEnv, credentialIdentity: profile.credentialIdentity });
    }),
  ]);
  return access;
}
