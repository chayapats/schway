/** Actionable notice printed when configuration or the CLI names the removed Anthropic provider. */
export const ANTHROPIC_REMOVED_MESSAGE = [
  "The Anthropic provider was removed in 0.4.",
  "Use Claude through an OpenAI-compatible endpoint:",
  "  schway --provider openai-compatible --base-url <url> --model <id>",
  "See docs/configuration.md",
].join("\n");

/** Return the removal notice when the value names a removed provider, otherwise undefined. */
export function removedProviderMessage(value: unknown): string | undefined {
  return value === "anthropic" ? ANTHROPIC_REMOVED_MESSAGE : undefined;
}
