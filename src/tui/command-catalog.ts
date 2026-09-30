import { basename } from "node:path";
import type { SkillDiscovery } from "../skills/skills.ts";
import type { ExtensionCommandInfo } from "../extensions/host.ts";
import type { SlashCommandName } from "./commands.ts";

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
  "model", "new", "sessions", "changes", "compact", "resume", "branch", "thinking", "context", "skills",
  "add-dir", "config", "theme", "session", "login", "logout", "help", "quit", "delete-session",
] as const satisfies readonly SlashCommandName[];

/** Built-in discovery labels, shared by completion and ephemeral help. */
export const COMMAND_DESCRIPTIONS: Record<SlashCommandName, string> = {
  model: "Choose model", thinking: "Set reasoning level", theme: "Choose appearance",
  "delete-session": "Delete a saved session",
  session: "Session and workspace details", new: "Start a new conversation", sessions: "Open saved work",
  resume: "Resume a saved session", branch: "Browse or fork conversation branches", changes: "Review changes",
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
