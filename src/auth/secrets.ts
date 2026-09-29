/** Environment variable consulted when no runtime OpenAI key is supplied. */
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

/** Guidance returned when OpenAI credential resolution yields an empty key. */
export const MISSING_OPENAI_API_KEY =
  "Missing OpenAI API key. Set OPENAI_API_KEY or pass --api-key.";

/** Origin of a resolved key: an explicit runtime override or the supplied environment map. */
export type CredentialSource = "runtime" | "env";

/** Trimmed nonempty API key with its origin, or actionable missing-key guidance. */
export type ResolvedCredential =
  | { apiKey: string; source: CredentialSource }
  | { error: string };

/** Resolve a trimmed OpenAI key from runtime override or environment; an empty override returns an error. */
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

/** Replace exact occurrences of supplied nonempty secrets with `***`; arbitrary secrets are not detected. */
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
