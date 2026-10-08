/** Name users type and read for the ChatGPT subscription route; Schway resolves and stores it as `codex`. */
export const CHATGPT_ROUTE = "chatgpt";

/** OpenAI auth values named in help and errors; `codex` stays accepted as input but is not listed. */
export const OPENAI_AUTH_CHOICES = ["auto", CHATGPT_ROUTE, "api-key"] as const;

/** Return `codex` for the `chatgpt` alias (case-insensitive, surrounding spaces ignored); return any other input unchanged. */
export function canonicalOpenAIAuth<T>(value: T): T | "codex" {
  return typeof value === "string" && value.trim().toLowerCase() === CHATGPT_ROUTE ? "codex" : value;
}
