import { resolveProviderCredential, selectOpenAITransport, selectXaiTransport, type OpenAIAuthPreference } from "../auth/credentials.ts";
import type { CredentialStore, CredentialTarget } from "../auth/store.ts";
import type { CompatibleProfile } from "../config/config.ts";
import type { StandaloneEndpointConnection } from "../config/editing.ts";

/** Credential configuration for a picker row, without claiming remote authorization was verified. */
export type ModelAccess = "ChatGPT" | "Grok" | "API key" | "No key required" | "Login required";

/** Secret-free access metadata for native providers, endpoints, and named profiles. */
export interface ModelPickerAccess {
  providers: Record<string, ModelAccess>;
  profiles: Record<string, ModelAccess>;
  openaiTransport?: "codex" | "api-key";
  /** Independently configured subscription route, regardless of the current preference. */
  subscription: ModelAccess;
  /** Independently configured API route, regardless of the current preference. */
  openaiApiKey: ModelAccess;
  /** Independently configured xAI API-key route. */
  xaiApiKey: ModelAccess;
  /** Independently configured Grok subscription route. */
  grok?: ModelAccess;
}

/** Resolve picker access using the same credential precedence as model creation without contacting providers. */
export async function loadModelPickerAccess(input: {
  store: CredentialStore;
  env: Record<string, string | undefined>;
  runtimeApiKey?: string;
  /** Provider the runtime key was supplied for. Other routes ignore that key. */
  runtimeProvider?: string;
  openaiAuth?: OpenAIAuthPreference;
  baseUrl?: string;
  auth?: "required" | "optional" | "none";
  credentialEnv?: string;
  credentialIdentity?: string;
  activeProfile?: string;
  profiles?: Record<string, CompatibleProfile>;
  /** Resolve this primary endpoint independently of the active profile; an empty object means none is configured. */
  standaloneEndpoint?: StandaloneEndpointConnection;
}): Promise<ModelPickerAccess> {
  const access: ModelPickerAccess = { providers: {}, profiles: {}, subscription: "Login required", openaiApiKey: "Login required", xaiApiKey: "Login required" };
  const runtimeKeyFor = (provider: string) => input.runtimeProvider === undefined || input.runtimeProvider === provider ? input.runtimeApiKey : undefined;
  const resolve = async (target: CredentialTarget & { auth?: "required" | "optional" | "none"; credentialEnv?: string }): Promise<ModelAccess> => {
    const result = await resolveProviderCredential({ ...target, store: input.store, env: input.env, runtimeApiKey: runtimeKeyFor(target.provider) });
    return "error" in result ? "Login required" : result.source === "none" ? "No key required" : "API key";
  };
  await Promise.all([
    (async () => {
      const openaiKey = runtimeKeyFor("openai");
      const [transport, subscription, apiKey] = await Promise.all([
        selectOpenAITransport({ ...input, runtimeApiKey: openaiKey }),
        selectOpenAITransport({ ...input, openaiAuth: "codex", runtimeApiKey: openaiKey }),
        resolve({ provider: "openai" }),
      ]);
      access.subscription = "error" in subscription ? "Login required" : "ChatGPT";
      access.openaiApiKey = apiKey;
      if ("error" in transport) { access.providers.openai = "Login required"; return; }
      access.openaiTransport = transport.transport;
      access.providers.openai = transport.transport === "codex" ? access.subscription : apiKey;
    })(),
    (async () => {
      access.providers.xai = await resolve({ provider: "xai" });
      access.xaiApiKey = access.providers.xai;
      const selected = await selectXaiTransport({ xaiAuth: "grok", env: {}, store: input.store });
      access.grok = "error" in selected ? "Login required" : "Grok";
    })(),
    (async () => {
      const endpoint = input.standaloneEndpoint ?? (!input.activeProfile ? {
        baseUrl: input.baseUrl, auth: input.auth, credentialEnv: input.credentialEnv, credentialIdentity: input.credentialIdentity,
      } : undefined);
      access.providers["openai-compatible"] = endpoint?.baseUrl
        ? await resolve({ provider: "openai-compatible", ...endpoint })
        : "Login required";
    })(),
    ...Object.entries(input.profiles ?? {}).map(async ([name, profile]) => {
      access.profiles[name] = await resolve({ provider: "openai-compatible", profile: name, baseUrl: profile.baseUrl,
        auth: profile.auth, credentialEnv: profile.credentialEnv, credentialIdentity: profile.credentialIdentity });
    }),
  ]);
  return access;
}
