import type { SkillDiscovery } from "../skills/skills.ts";
import type { ExtensionCommandInfo } from "../extensions/host.ts";

/** One stable, safe command suggestion; unavailable entries are never inserted or dispatched. */
export interface CommandChoice { id: string; name: string; insertion: string; description: string; source: string; available: boolean; }

/** Built-in discovery labels, shared by completion and ephemeral help. */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  model: "Choose model or profile", thinking: "Set reasoning level", theme: "Choose appearance",
  "delete-session": "Delete a saved session and its draft",
  session: "Session and workspace details", new: "Start a session", sessions: "Browse recent sessions",
  resume: "Resume a saved session", branch: "Browse or fork conversation branches", changes: "Review changes and command evidence (Alt+R)",
  context: "Inspect context and summary", compact: "Summarize older context", skills: "List skills", "add-dir": "Attach a workspace",
  config: "Preferences (Alt+P)", login: "Sign in", logout: "Remove stored credential", help: "Search commands (Alt+H)", quit: "Exit Schway",
};

/** Combine public metadata without choosing an ambiguous command namespace. */
export function commandCatalog(extensions: readonly ExtensionCommandInfo[], skills?: SkillDiscovery): CommandChoice[] {
  const entries: CommandChoice[] = Object.entries(COMMAND_DESCRIPTIONS).map(([name, description]) => ({ id: `builtin:${name}`, name, insertion: `/${name} `, description, source: "built-in", available: true }));
  for (const command of extensions) entries.push({ id: `extension:${command.source}:${command.name}`, name: command.name, insertion: `/${command.name} `, description: command.description, source: `extension ${command.source}`, available: true });
  for (const skill of skills?.skills ?? []) entries.push({ id: `skill:${skill.skillFile}:${skill.name}`, name: skill.name, insertion: `/${skill.name} `, description: skill.description, source: `${skill.scope} skill${skill.userOnly ? " · user-only" : ""}`, available: true });
  for (const collision of skills?.collisions ?? []) entries.push({ id: `collision:${collision.source}`, name: collision.name, insertion: "", description: "Collision: rename skill", source: "skill", available: false });
  for (const ambiguous of skills?.ambiguous ?? []) entries.push({ id: `ambiguous:${ambiguous.name}`, name: ambiguous.name, insertion: "", description: "Ambiguous: rename duplicates", source: "skill", available: false });
  for (const entry of entries) if (entries.filter(other => other.name === entry.name).length > 1) { entry.available = false; entry.description = `Collision · ${entry.description}`; }
  for (const diagnostic of skills?.diagnostics ?? []) entries.push({ id: `diagnostic:${diagnostic.source}`, name: "unavailable", insertion: "", description: diagnostic.reason, source: diagnostic.source, available: false });
  return entries;
}
