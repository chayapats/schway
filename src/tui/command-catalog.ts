import { basename } from "node:path";
import type { SkillDiscovery } from "../skills/skills.ts";
import type { ExtensionCommandInfo } from "../extensions/host.ts";
import type { SlashCommandName } from "./commands.ts";
import { fuzzyRank } from "./fuzzy.ts";

/** One stable, safe command suggestion; unavailable entries are never inserted or dispatched. */
export interface CommandChoice {
  id: string; name: string; insertion: string; description: string; source: string; available: boolean;
  /** Palette section; omitted for argument suggestions supplied by existing consumers. */
  group?: "built-in" | "skills" | "extensions" | "destructive";
  /** True only for commands that delete saved data. */
  destructive?: boolean;
  /** Displayable extension owner, separate from the searchable canonical source. */
  provenance?: string;
}

/** Curated discovery order containing every built-in once, with saved-data deletion last. */
export const BUILT_IN_COMMAND_ORDER = [
  "model", "new", "clear", "sessions", "changes", "undo", "compact", "resume", "branch", "thinking", "context", "skills",
  "add-dir", "config", "theme", "session", "login", "logout", "help", "quit", "delete-session",
] as const satisfies readonly SlashCommandName[];

/** Built-in discovery labels, shared by completion and ephemeral help. */
export const COMMAND_DESCRIPTIONS: Record<SlashCommandName, string> = {
  model: "Choose model", thinking: "Set reasoning level", theme: "Choose appearance",
  "delete-session": "Delete a saved session",
  session: "Session and workspace details", new: "Start a new conversation", sessions: "Open saved work",
  clear: "Start a new conversation",
  resume: "Resume a saved session", branch: "Browse or fork conversation branches", changes: "Review changes", undo: "Undo the last turn's file edits",
  context: "Inspect context and summary", compact: "Summarize to free context", skills: "List skills", "add-dir": "Attach a workspace",
  config: "Preferences (Alt+P)", login: "Sign in", logout: "Remove stored credential", help: "Search commands (Alt+H)", quit: "Exit Schway",
};

/** Return curated built-ins, skills, extensions and destructive commands without resolving ambiguous owners. */
export function commandCatalog(extensions: readonly ExtensionCommandInfo[], skills?: SkillDiscovery): CommandChoice[] {
  const builtins: CommandChoice[] = BUILT_IN_COMMAND_ORDER.map(name => ({ id: `builtin:${name}`, name, insertion: `/${name} `, description: COMMAND_DESCRIPTIONS[name], source: "built-in", available: true, group: name === "delete-session" ? "destructive" : "built-in", destructive: name === "delete-session" }));
  const entries = builtins.filter(entry => !entry.destructive);
  for (const skill of skills?.skills ?? []) entries.push({ id: `skill:${skill.skillFile}:${skill.name}`, name: skill.name, insertion: `/${skill.name} `, description: skill.description, source: `${skill.scope} skill${skill.userOnly ? " · user-only" : ""}`, available: true, group: "skills" });
  for (const collision of skills?.collisions ?? []) entries.push({ id: `collision:${collision.source}`, name: collision.name, insertion: "", description: "Collision: rename skill", source: "skill", available: false, group: "skills" });
  for (const ambiguous of skills?.ambiguous ?? []) entries.push({ id: `ambiguous:${ambiguous.name}`, name: ambiguous.name, insertion: "", description: "Ambiguous: rename duplicates", source: "skill", available: false, group: "skills" });
  const diagnostics = (skills?.diagnostics ?? []).map((diagnostic): CommandChoice => ({ id: `diagnostic:${diagnostic.source}`, name: "unavailable", insertion: "", description: diagnostic.reason, source: diagnostic.source, available: false, group: "skills" }));
  entries.push(...diagnostics);
  for (const command of extensions) entries.push({ id: `extension:${command.source}:${command.name}`, name: command.name, insertion: `/${command.name} `, description: command.description, source: `extension ${command.source}`, available: true, group: "extensions", provenance: command.packageName ?? basename(command.source) });
  entries.push(...builtins.filter(entry => entry.destructive));
  const commands = entries.filter(entry => !entry.id.startsWith("diagnostic:"));
  const nameCounts = new Map<string, number>();
  for (const entry of commands) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  for (const entry of commands) if (nameCounts.get(entry.name)! > 1) {
    entry.available = false; entry.description = `Collision · ${entry.description}`;
    if (!entry.destructive) entry.group = "skills";
  }
  const groupOrder = { "built-in": 0, skills: 1, extensions: 2, destructive: 3 };
  return entries.sort((left, right) => groupOrder[left.group!] - groupOrder[right.group!]
    || Number(left.id.startsWith("diagnostic:")) - Number(right.id.startsWith("diagnostic:")));
}

const KEYBOARD_GUIDES = {
  newline: {
    label: "Insert a newline", shortcut: "Shift+Enter or Ctrl+J", description: "Continue your draft on another line",
    guidance: "Return to the composer, then press Shift+Enter or Ctrl+J. Enter sends the draft.",
    aliases: ["newline", "line break", "ctrl+j", "control j", "shift+enter"],
  },
  "inspect-copy": {
    label: "Copy code or a result", shortcut: "Alt+I, then C", description: "Inspect a block before copying it",
    guidance: "Return to the conversation and press Alt+I. Use ↑↓ to select a code block or tool result, then C to copy the highlighted block. Enter copies code; it does not copy tool results.",
    aliases: ["copy", "copy code", "copy result", "inspect", "alt+i"],
  },
  "copy-selection": {
    label: "Copy selected text", shortcut: "Ctrl+C", description: "Copy selected conversation text",
    guidance: "Select conversation text, then press Ctrl+C. Without selected text, Ctrl+C cancels a running turn or quits when idle.",
    aliases: ["copy selection", "clipboard", "ctrl+c"],
  },
  "approval-mode": {
    label: "Change approval mode", shortcut: "Shift+Tab", description: "Cycle auto, ask and read-only",
    guidance: "Return to the composer and close panels, inspection, conversation search and command suggestions. When mode changes are available, press Shift+Tab.",
    aliases: ["approval", "mode", "shift+tab"],
  },
  shortcuts: {
    label: "Find keyboard shortcuts", shortcut: "Alt+H", description: "Browse commands and keyboard guidance",
    guidance: "From the composer, press Alt+H to open help. Finish or leave credential entry and approval prompts using their own controls first.",
    aliases: ["shortcuts", "keyboard", "help", "alt+h"],
  },
  details: {
    label: "Inspect details", shortcut: "Ctrl+I", description: "Read details for the current context",
    guidance: "Return to the notice, recovery, change review or model panel showing a Ctrl+I details hint, then press Ctrl+I. The available details depend on that context.",
    aliases: ["details", "diagnostics", "ctrl+i"],
  },
  review: {
    label: "Review changes", shortcut: "Alt+R", description: "Inspect changed files and command results",
    guidance: "When the turn is idle, return to the conversation and close any panel. Press Alt+R to open change review.",
    aliases: ["review", "changes", "diff", "alt+r"],
  },
  cancel: {
    label: "Cancel running work", shortcut: "Esc; Ctrl+C without selected text", description: "Stop the active turn",
    guidance: "Return to the conversation, then press Esc to stop a running turn. Esc first closes search, inspection or a panel. Ctrl+C copies selected text; without a selection it cancels a turn or quits when idle.",
    aliases: ["cancel", "stop", "escape", "esc"],
  },
} as const;

/** Stable keyboard guidance identities, independent of shortcut spelling or search order. */
export type KeyboardGuideId = keyof typeof KEYBOARD_GUIDES;

/** The caller observes the action's return context; unavailable actions still allow reading guidance. */
export type KeyboardGuideAvailability = { available: true } | { available: false; reason: string };

/** Presentation-only keyboard guidance, with no insertion or execution capability. */
export type KeyboardGuideChoice = {
  kind: "keyboard"; id: `keyboard:${KeyboardGuideId}`; label: string; shortcut: string;
  description: string; guidance: string; aliases: readonly string[];
} & KeyboardGuideAvailability;

/** Commands retain slash authority metadata; keyboard rows can only explain an action. */
export type PaletteChoice = (CommandChoice & { kind: "command" }) | KeyboardGuideChoice;

/** Build searchable presentation rows from resolved commands and observed availability without dispatch or discovery. */
export function paletteChoices(commands: readonly CommandChoice[], availability: Readonly<Record<KeyboardGuideId, KeyboardGuideAvailability>>, query = ""): PaletteChoice[] {
  const rows: PaletteChoice[] = commands.map(command => ({ ...command, kind: "command" }));
  const guides = (Object.keys(KEYBOARD_GUIDES) as KeyboardGuideId[]).map((id): KeyboardGuideChoice => {
    const observed = availability[id];
    const state: KeyboardGuideAvailability = observed.available ? { available: true } : { available: false, reason: observed.reason };
    return { ...KEYBOARD_GUIDES[id], ...state, kind: "keyboard", id: `keyboard:${id}`, aliases: [...KEYBOARD_GUIDES[id].aliases] };
  });
  const destructive = rows.findIndex(row => row.kind === "command" && (row.destructive || row.group === "destructive"));
  rows.splice(destructive < 0 ? rows.length : destructive, 0, ...guides);
  const needle = query.trim().normalize("NFC").toLowerCase();
  if (!needle) return rows;
  return rows.flatMap((row, order) => {
    const rank = paletteRank(row, needle);
    return rank === undefined ? [] : [{ row, rank, order }];
  }).sort((left, right) => left.rank - right.rank || left.order - right.order).map(({ row }) => row);
}

function paletteRank(row: PaletteChoice, query: string): number | undefined {
  const fields = row.kind === "command"
    ? [[row.name, row.insertion.trim()], [row.description, row.source, row.provenance ?? ""]]
    : [[row.label, row.shortcut, ...row.aliases], [row.description]];
  let best = Infinity;
  for (const [priority, values] of fields.entries()) for (const value of values) {
    const rank = fuzzyRank(query, value.normalize("NFC"));
    if (rank !== undefined) best = Math.min(best, rank * 2 + priority);
  }
  return best === Infinity ? undefined : best;
}
