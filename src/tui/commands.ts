/** Slash command requested from the TUI input editor. */
export type SlashCommandName =
  | "new"
  | "sessions"
  | "resume"
  | "model"
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
    "/model - show the current provider and model",
    "/help - show this help",
    "/quit - quit schway",
    "Esc cancels the running turn. Ctrl+C quits when idle.",
  ].join("\n");
}
