export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export const MISSING_ANTHROPIC_API_KEY =
  "Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass --api-key.";

export type CredentialSource = "runtime" | "env";

export type ResolvedCredential =
  | { apiKey: string; source: CredentialSource }
  | { error: string };

export function resolveAnthropicApiKey(input: {
  runtimeApiKey?: string;
  env: Record<string, string | undefined>;
}): ResolvedCredential {
  if (input.runtimeApiKey !== undefined) {
    const apiKey = input.runtimeApiKey.trim();
    if (!apiKey) {
      return { error: MISSING_ANTHROPIC_API_KEY };
    }
    return { apiKey, source: "runtime" };
  }

  const apiKey = input.env[ANTHROPIC_API_KEY_ENV]?.trim() ?? "";
  if (!apiKey) {
    return { error: MISSING_ANTHROPIC_API_KEY };
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
