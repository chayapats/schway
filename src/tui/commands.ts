import { RESERVED_SKILL_NAMES, splitSlashCommand } from "../skills/skills.ts";
import type { ExtensionCommandInfo } from "../extensions/host.ts";
import type { TuiController } from "./controller.ts";

/** Slash command requested from the TUI input editor. */
export type SlashCommandName =
  | "new"
  | "sessions"
  | "resume"
  | "model"
  | "branch"
  | "compact"
  | "skills"
  | "add-dir"
  | "config"
  | "login"
  | "logout"
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
    case "branch":
    case "compact":
    case "skills":
    case "add-dir":
    case "config":
    case "login":
    case "logout":
    case "help":
    case "quit":
      return { name, raw: trimmed, args };
    default:
      return { name: "unknown", raw: trimmed, args };
  }
}

/** Short interactive help shown for /help and unknown commands. */
export function helpText(commands: readonly ExtensionCommandInfo[] = []): string {
  return [
    "Commands:",
    "/new - start a new session",
    "/sessions - list saved sessions",
    "/resume <id> - resume a saved session",
    "/model [provider/model-id | provider model-id | model-id | profile:<name>] - open searchable picker or switch the model or profile",
    "/compact - summarize older turns to free context",
    "/branch list | fork <entry-id> [name] | switch <branch-id> - continue a saved conversation path",
    "/skills - list available skills",
    "/add-dir <directory> - attach project context (relative to the primary root; idle only)",
    "/<skill-name> [arguments] - invoke an available skill for this turn",
    "/config - show effective settings and their origins with secrets redacted",
    "/config set <key> <value> [--scope user|project] - edit settings (session only by default)",
    "/config reset <key> [--scope user|project] - remove an override and inherit its fallback",
    "/login <anthropic|openai|openai-compatible> - enter an API key in a masked prompt",
    "/logout <anthropic|openai|openai-compatible> - remove the selected stored API key",
    "/help - show this help",
    "/quit - quit schway",
    ...commands.map((command) => `/${command.name}${command.arguments ? ` ${command.arguments}` : ""} - ${command.description} [extension: ${command.source}]`),
    "Esc cancels the running turn. Ctrl+C quits when idle.",
  ].join("\n");
}

/** Dispatch the shared editor input, returning whether the editor may clear it; busy extension commands retain input. */
export async function dispatchEditorInput(
  input: string,
  controller: TuiController,
  builtin: (command: SlashCommand) => Promise<void>,
  accepted: () => void = () => {},
): Promise<boolean> {
  const text = input.trim();
  if (!text) return true;
  const slash = parseSlashCommand(text);
  const invocation = splitSlashCommand(text);
  if (invocation && controller.extensionCommands().some((command) => command.name === invocation.name)) {
    const wasBusy = controller.running;
    if (!wasBusy) accepted();
    await controller.runExtensionCommand(invocation.name, invocation.args);
    return !wasBusy;
  }
  if (slash) {
    accepted();
    await builtin(slash);
    return true;
  }
  if (controller.running) {
    controller.notice("Already running. Press Esc to cancel first.");
    return false;
  }
  accepted();
  await controller.submit(text);
  return true;
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

/** Resolved model or profile selection from `/model` arguments. */
export interface ModelSelection {
  provider: string;
  modelId: string;
  /** Named compatible profile selection, when the arguments choose a profile. */
  profile?: string;
}

/** Parse `/model` arguments into a provider/model id or a named profile, allowing unknown ids. */
export function parseModelArgs(
  args: string,
  currentProvider: string,
): ModelSelection | { error: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { error: "Usage: /model [provider/model-id | provider model-id | model-id | profile:<name>]" };
  }
  const profileSelection = parseProfileSelection(trimmed);
  if (profileSelection !== undefined) {
    return profileSelection;
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
  return { error: "Usage: /model [provider/model-id | provider model-id | model-id | profile:<name>]" };
}

/** Parse `profile:<name>` or `profile <name>` into a named profile selection. */
export function parseProfileSelection(args: string): ModelSelection | { error: string } | undefined {
  const colon = /^profile\s*:\s*(.+)$/i.exec(args);
  const space = /^profile\s+(.+)$/i.exec(args);
  const raw = colon?.[1] ?? space?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const name = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return { error: `Invalid profile "${raw.trim()}". Profile names must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.` };
  }
  return { provider: "openai-compatible", modelId: "", profile: name };
}

/** Format the interactive model picker with current selection, known budgets, and named profiles. */
export function formatModelPicker(
  currentProvider: string,
  currentModelId: string,
  catalog: ReadonlyArray<{ id: string; provider: string; contextWindow: number }>,
  profiles?: Readonly<Record<string, { model?: string }>>,
  activeProfile?: string,
): string {
  const lines = [
    activeProfile ? `Current: ${currentProvider}/${currentModelId} [profile ${activeProfile}]` : `Current: ${currentProvider}/${currentModelId}`,
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
  lines.push("Select with /model <model-id>, /model <provider>/<model-id>, /model <provider> <model-id>, or /model profile:<name>.");
  lines.push("Unknown ids are allowed and use conservative defaults.");
  if (profiles && Object.keys(profiles).length > 0) {
    lines.push("Profiles:");
    for (const name of Object.keys(profiles).sort()) {
      const marker = name === activeProfile ? "* " : "  ";
      lines.push(`${marker}profile:${name}`);
    }
  }
  return lines.join("\n");
}

/** True when the value names a selectable model provider. */
function isPickerProvider(value: string): value is ModelPickerProvider {
  return (MODEL_PICKER_PROVIDERS as readonly string[]).includes(value);
}
