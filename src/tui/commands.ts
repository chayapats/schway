import { RESERVED_SKILL_NAMES, splitSlashCommand } from "../skills/skills.ts";
import { removedProviderMessage } from "../config/removed-provider.ts";
import type { ExtensionCommandInfo } from "../extensions/host.ts";
import { PROFILE_NAME_PATTERN, isValidProfileName } from "../config/profile-name.ts";
import type { TuiController } from "./controller.ts";

/** Slash command requested from the TUI input editor. */
export type SlashCommandName =
  | "new"
  | "delete-session"
  | "sessions"
  | "resume"
  | "model"
  | "thinking"
  | "theme"
  | "session"
  | "branch"
  | "changes"
  | "context"
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
    case "delete-session":
    case "sessions":
    case "resume":
    case "model":
    case "thinking":
    case "theme":
    case "session":
    case "branch":
    case "changes":
    case "context":
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
    "/delete-session <id> - delete a saved conversation and its draft (switch away first)",
    "/sessions - browse recent sessions",
    "/resume <id> [branch-id] - resume a saved session on its active branch or one stable branch ID",
    "/model [provider/model-id | provider model-id | model-id | profile:<name>] - open searchable picker or switch the model or profile",
    "/thinking [off|low|medium|high|xhigh|max|ultra|reset] - show or switch reasoning level for future requests",
    "/theme [auto|dark|light] - choose appearance for this session; /config shows saved choices and overrides",
    "/session - show session ID, conversation branch, model, and workspace roots",
    "/context - inspect context estimate and active summary (read-only)",
    "/compact - summarize older turns to free context",
    "/branch list | tree | fork <entry-id> [name] | switch <branch-id> - browse the session tree or continue a saved conversation path",
    "/changes [review|status|diff [-- <path>]] - review changes and command evidence (Alt+R)",
    "/skills - list available skills",
    "/add-dir <directory> - attach project context (relative to the primary root; idle only)",
    "/<skill-name> [arguments] - invoke an available skill for this turn",
    "/config (Alt+P) - preferences: arrows select, Tab scope, Enter preview/confirm, Esc back",
    "/config show - print effective settings and their origins with secrets redacted",
    "/config set <key> <value> [--scope user|project] - edit settings (session only by default)",
    "/config reset <key> [--scope user|project] - remove an override and inherit its fallback",
    "/login - choose a provider and sign-in method",
    "/login <openai|openai-compatible> - enter an API key in a masked prompt",
    "/login codex [--device] [--code <callback-url-or-code>] - sign in with a ChatGPT Plus/Pro subscription",
    "/logout <openai|openai-compatible|codex> - remove the selected stored credential",
    "/help - show this help",
    "/quit - quit schway",
    ...commands.map((command) => `/${command.name}${command.arguments ? ` ${command.arguments}` : ""} - ${command.description} [extension: ${command.source}]`),
    "Esc cancels the running turn. With no selection, Ctrl+C cancels a turn or quits when idle.",
    "Drag conversation text to copy it. Ctrl+C copies a selection. Click a web link to open your browser.",
    "Enter sends. Shift+Enter or Ctrl+J inserts a newline. Up/Down recalls prompts at editor boundaries.",
    "Ctrl+O expands/collapses tool output; click a tool heading to toggle one result.",
    "PageUp/PageDown scroll. Ctrl+End returns to the latest message. Alt+M opens models without losing your draft.",
    "Ctrl+L resets terminal output if stale text remains; your draft and conversation are preserved.",
    "Type / for commands, Up/Down to select, Tab to complete, Esc to dismiss.",
    "In the branch tree: Up/Down browses, Enter switches or forks the highlight, Esc closes.",
  ].join("\n");
}

/** Dispatch editor input and report whether a prompt was durably appended or a command accepted. */
export async function dispatchEditorInput(
  input: string,
  controller: TuiController,
  builtin: (command: SlashCommand, accepted: () => void) => Promise<boolean>,
  accepted: () => void = () => {},
): Promise<boolean> {
  const text = input.trim();
  if (!text) return false;
  let notified = false;
  const accept = () => { if (!notified) { notified = true; accepted(); } };
  const slash = parseSlashCommand(text);
  const invocation = splitSlashCommand(text);
  if (controller.running) { controller.notice(invocation && controller.extensionCommands().some(command => command.name === invocation.name) ? `Busy: /${invocation.name} was not run. Press Esc to cancel the active operation, then retry.` : "Already running. Press Esc to cancel first, then retry the retained command."); return false; }
  if (invocation && await controller.commandCollision(invocation.name)) return false;
  if (invocation && controller.extensionCommands().some((command) => command.name === invocation.name)) {
    const executed = await controller.runExtensionCommand(invocation.name, invocation.args, accept);
    if (executed) accept();
    return notified || executed;
  }
  if (slash?.name === "unknown" && !controller.commandChoices(`/${invocation?.name ?? ""}`).some(entry => entry.name === invocation?.name && entry.available)) {
    const alternatives = controller.commandChoices(`/${invocation?.name.slice(0, 2) ?? ""}`).filter(entry => entry.available).slice(0, 3).map(entry => `/${entry.name}`);
    controller.notice(`Unknown command /${invocation?.name ?? ""}. ${alternatives.length ? `Try ${alternatives.join(", ")}, or ` : "Use "}/help to search commands and skills.`);
    return false;
  }
  if (slash) {
    if (controller.running) {
      controller.notice("Already running. Press Esc to cancel first.");
      return false;
    }
    const executed = await builtin(slash, accept);
    if (executed) accept();
    return notified || executed;
  }
  if (controller.running) {
    controller.notice("Already running. Press Esc to cancel first.");
    return false;
  }
  return controller.submit(input, accepted);
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
        error: removedProviderMessage(provider) ?? `Unknown provider: ${provider}. Valid providers: ${MODEL_PICKER_PROVIDERS.join(", ")}`,
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
  if (!isValidProfileName(name)) {
    return { error: `Invalid profile "${raw.trim()}". Profile names must match ${PROFILE_NAME_PATTERN}.` };
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

/** Provider-independent reasoning level accepted by /thinking and --thinking. */
export type ThinkingSelection = "off" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Parse `/thinking` arguments into a reasoning level or a reset/show request. */
export function parseThinkingArgs(args: string): ThinkingSelection | "show" | "reset" | { error: string } {
  const trimmed = args.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === "show" || trimmed === "status") {
    return "show";
  }
  if (trimmed === "reset" || trimmed === "clear" || trimmed === "unset" || trimmed === "default") {
    return "reset";
  }
  if (trimmed === "off" || trimmed === "low" || trimmed === "medium" || trimmed === "high" || trimmed === "xhigh" || trimmed === "max" || trimmed === "ultra") {
    return trimmed;
  }
  return { error: "Usage: /thinking [off|low|medium|high|xhigh|max|ultra|reset]. Shows requested and effective levels with provider/model." };
}

/** True when the value names a selectable model provider. */
function isPickerProvider(value: string): value is ModelPickerProvider {
  return (MODEL_PICKER_PROVIDERS as readonly string[]).includes(value);
}

/** Usage guidance for credential commands, keeping API keys out of slash arguments. */
export const LOGIN_USAGE =
  "Usage: /login to choose a method, /login <openai|openai-compatible>, or /login codex [--device] [--code <callback-url-or-code>]. Enter API keys only in the masked prompt.";

/** Requested credential action from /login or /logout arguments. */
export type LoginTarget =
  | { kind: "api-key"; provider: "openai" | "openai-compatible" }
  | { kind: "codex"; device: boolean; code?: string }
  | { error: string };

/** Parse /login and /logout arguments into an API-key provider or the ChatGPT subscription flow. */
export function parseLoginTarget(args: string): LoginTarget {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  const name = tokens[0]?.toLowerCase() ?? "";
  if (name === "openai" || name === "openai-compatible") {
    if (tokens.length > 1) {
      return { error: LOGIN_USAGE };
    }
    return { kind: "api-key", provider: name };
  }
  if (name === "codex") {
    let device = false;
    let code: string | undefined;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--device") {
        device = true;
        continue;
      }
      if (token === "--code") {
        const value = tokens[i + 1];
        if (!value) {
          return { error: LOGIN_USAGE };
        }
        i++;
        code = value;
        continue;
      }
      if (token.startsWith("--code=")) {
        const value = token.slice("--code=".length);
        if (!value) {
          return { error: LOGIN_USAGE };
        }
        code = value;
        continue;
      }
      return { error: LOGIN_USAGE };
    }
    if (device && code !== undefined) {
      return { error: "Usage: /login codex [--device] or /login codex --code <callback-url-or-code>. Device and pasted-code flows are separate attempts." };
    }
    return code !== undefined ? { kind: "codex", device, code } : { kind: "codex", device };
  }
  return { error: LOGIN_USAGE };
}
