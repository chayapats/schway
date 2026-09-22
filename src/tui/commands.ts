import { RESERVED_SKILL_NAMES, splitSlashCommand } from "../skills/skills.ts";

/** Slash command requested from the TUI input editor. */
export type SlashCommandName =
  | "new"
  | "sessions"
  | "resume"
  | "model"
  | "compact"
  | "skills"
  | "config"
  | "help"
  | "quit";

/** Parsed slash command with raw trailing arguments. */
export interface SlashCommand {
  name: SlashCommandName | "unknown";
  raw: string;
  args: string;
}

/**
 * Parse TUI input as a slash command. Returns null for ordinary prompts.
 * Unknown slash names return `unknown` so the UI can suggest /help.
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const space = trimmed.indexOf(" ");
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
  switch (name) {
    case "new":
    case "sessions":
    case "resume":
    case "model":
    case "compact":
    case "skills":
    case "config":
    case "help":
    case "quit":
      return { name, raw: trimmed, args };
    default:
      return { name: "unknown", raw: trimmed, args };
  }
}

/** Short interactive help shown for /help and unknown commands. */
export function helpText(): string {
  return [
    "Commands:",
    "/new - start a new session",
    "/sessions - list saved sessions",
    "/resume <id> - resume a saved session",
    "/model [provider/model-id | provider model-id | model-id] - show or switch the model",
    "/compact - summarize older turns to free context",
    "/skills - list available skills",
    "/<skill-name> [arguments] - invoke an available skill for this turn",
    "/config - show effective basic settings with secrets redacted",
    "/help - show this help",
    "/quit - quit schway",
    "Esc cancels the running turn. Ctrl+C quits when idle.",
  ].join("\n");
}

/** Built-in slash names; a skill using one collides and is never invoked silently. */
export const BUILT_IN_COMMAND_NAMES: readonly string[] = RESERVED_SKILL_NAMES;

/** Parse "/<skill-name> [arguments]" for non-builtin names; null for ordinary text or builtins. */
export function parseSkillInvocation(input: string): { name: string; args: string; raw: string } | null {
  const split = splitSlashCommand(input);
  if (!split || BUILT_IN_COMMAND_NAMES.includes(split.name)) {
    return null;
  }
  return split;
}

/** Provider families selectable from the interactive model picker. */
export const MODEL_PICKER_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-compatible",
] as const;

/** Provider name accepted by the interactive model picker. */
export type ModelPickerProvider = (typeof MODEL_PICKER_PROVIDERS)[number];

/** Resolved model selection from `/model` arguments. */
export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** Parse `/model` arguments into a provider and model id, allowing unknown ids. */
export function parseModelArgs(
  args: string,
  currentProvider: string,
): ModelSelection | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /model [provider/model-id | provider model-id | model-id]" };
  }
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    const provider = trimmed.slice(0, slash).trim().toLowerCase();
    const modelId = trimmed.slice(slash + 1).trim();
    if (!isPickerProvider(provider)) {
      return {
        error: `Unknown provider: ${provider}. Valid providers: ${MODEL_PICKER_PROVIDERS.join(", ")}`,
      };
    }
    if (modelId.length === 0) {
      return { error: "Usage: /model [provider/model-id | provider model-id | model-id]" };
    }
    return { provider, modelId };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && isPickerProvider(parts[0]!.toLowerCase())) {
    return { provider: parts[0]!.toLowerCase(), modelId: parts[1]! };
  }
  if (parts.length === 1) {
    return { provider: currentProvider, modelId: parts[0]! };
  }
  return { error: "Usage: /model [provider/model-id | provider model-id | model-id]" };
}

/** Format the interactive model picker with current selection and known budgets. */
export function formatModelPicker(
  currentProvider: string,
  currentModelId: string,
  catalog: ReadonlyArray<{ id: string; provider: string; contextWindow: number }>,
): string {
  const lines = [
    `Current: ${currentProvider}/${currentModelId}`,
    "Known models:",
  ];
  for (const provider of MODEL_PICKER_PROVIDERS) {
    const known = catalog.filter((entry) => entry.provider === provider);
    if (known.length === 0) {
      continue;
    }
    lines.push(`${provider}:`);
    for (const entry of known) {
      const marker =
        entry.provider === currentProvider && entry.id === currentModelId ? "* " : "  ";
      lines.push(`${marker}${entry.id} (${entry.contextWindow} ctx)`);
    }
  }
  lines.push("Select with /model <model-id>, /model <provider>/<model-id>, or /model <provider> <model-id>.");
  lines.push("Unknown ids are allowed and use conservative defaults.");
  return lines.join("\n");
}

/** True when the value names a selectable model provider. */
function isPickerProvider(value: string): value is ModelPickerProvider {
  return (MODEL_PICKER_PROVIDERS as readonly string[]).includes(value);
}
