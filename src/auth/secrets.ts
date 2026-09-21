export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/** Header names whose values are treated as credentials. */
export const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
]);

export const MISSING_ANTHROPIC_API_KEY =
  "Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass --api-key.";
export const MISSING_OPENAI_API_KEY =
  "Missing OpenAI API key. Set OPENAI_API_KEY or pass --api-key.";

export type CredentialSource = "runtime" | "env";

export type ResolvedCredential =
  | { apiKey: string; source: CredentialSource }
  | { error: string };

/** Resolve an Anthropic API key from runtime override, then the environment. */
export function resolveAnthropicApiKey(input: {
  runtimeApiKey?: string;
  env: Record<string, string | undefined>;
}): ResolvedCredential {
  return resolveApiKey({
    runtimeApiKey: input.runtimeApiKey,
    envValue: input.env[ANTHROPIC_API_KEY_ENV],
    missing: MISSING_ANTHROPIC_API_KEY,
  });
}

/** Resolve an OpenAI API key from runtime override, then the environment. */
export function resolveOpenAIApiKey(input: {
  runtimeApiKey?: string;
  env: Record<string, string | undefined>;
}): ResolvedCredential {
  return resolveApiKey({
    runtimeApiKey: input.runtimeApiKey,
    envValue: input.env[OPENAI_API_KEY_ENV],
    missing: MISSING_OPENAI_API_KEY,
  });
}

function resolveApiKey(input: {
  runtimeApiKey?: string;
  envValue: string | undefined;
  missing: string;
}): ResolvedCredential {
  if (input.runtimeApiKey !== undefined) {
    const apiKey = input.runtimeApiKey.trim();
    if (!apiKey) {
      return { error: input.missing };
    }
    return { apiKey, source: "runtime" };
  }

  const apiKey = input.envValue?.trim() ?? "";
  if (!apiKey) {
    return { error: input.missing };
  }
  return { apiKey, source: "env" };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}
