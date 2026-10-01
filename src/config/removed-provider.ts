/** Actionable notice printed when configuration or the CLI names the removed Anthropic provider. */
export const ANTHROPIC_REMOVED_MESSAGE = [
  "Anthropic support ended in 0.4",
  "Use Claude through a compatible endpoint:",
  "  schway --provider openai-compatible --base-url <url> --model <id>",
  "See docs/configuration.md",
].join("\n");

/** Return the removal notice when the value names a removed provider, otherwise undefined. */
export function removedProviderMessage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().toLowerCase() === "anthropic" ? ANTHROPIC_REMOVED_MESSAGE : undefined;
}
