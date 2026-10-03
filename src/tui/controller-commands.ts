import { redactSecrets } from "../auth/secrets.ts";
import { commandCatalog, type CommandChoice } from "./command-catalog.ts";
import { fuzzyRank } from "./fuzzy.ts";
import type { Session } from "../session/session.ts";
import { addWorkspaceRoots, type Workspace } from "../workspace/workspace.ts";
import { discoverSkills } from "../skills/skills.ts";
import { CredentialsLayer } from "./controller-credentials.ts";


/** Slash-command discovery, extension commands and workspace directory actions. */
export abstract class CommandsLayer extends CredentialsLayer {
  /** Capture this conversation's checkpoint target so delayed writes cannot materialize a different session. */
  draftCheckpointTarget(): { sessionId: string; workspaceRoot?: string; ensurePersisted: () => void; persisted: () => boolean; deferredSession: () => { path: string; header: unknown } | undefined } {
    const session = this.session as Session & { ensurePersisted?: () => void; persisted?: boolean; deferredCheckpoint?: () => { path: string; header: unknown } | undefined };
    return { sessionId: this.sessionId, workspaceRoot: this.workspace?.root,
      ensurePersisted: () => session.ensurePersisted?.(), persisted: () => session.persisted ?? session.items.length > 0, deferredSession: () => session.deferredCheckpoint?.() };
  }

  /** Return a copy of the currently usable root identities for discovery and status. */
  workspaceIdentity(): Workspace | undefined {
    return this.workspace ? { ...this.workspace, extraRoots: [...this.workspace.extraRoots] } : undefined;
  }

  /** Validate and persist attachments while owning the idle boundary, publishing nothing on failure or cancellation. */
  async addDirectories(directories: readonly string[]): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) {
      this.notice("Directory not attached · Esc stop · /add-dir retry");
      return false;
    }
    if (!this.workspace || directories.length === 0) {
      this.fail("Usage: /add-dir <directory>. Relative paths use the primary workspace root.");
      return false;
    }
    const workspace = this.workspace;
    const session = this.session;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      try {
        const next = await addWorkspaceRoots(workspace, directories, abort.signal);
        abort.signal.throwIfAborted();
        if (this.disposed || this.activeAbort !== abort || this.session !== session) return false;
        // Saved unavailable roots remain metadata even though the runtime excludes them.
        session.setExtraRoots([...new Set([...session.metadata.extraRoots, ...next.extraRoots])]);
        workspace.extraRoots = next.extraRoots;
        this.contextManager.clearActiveSkill();
        this.notice(`Workspace root: ${workspace.root}\nAttached roots: ${workspace.extraRoots.join(", ") || "none"}`);
        this.status = "idle";
        return true;
      } catch (error) {
        if (!this.disposed && this.activeAbort === abort) {
          if (abort.signal.aborted) {
            this.notice("Attachment cancelled · /add-dir retry");
            this.status = "idle";
          } else this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
        }
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** Open searchable command help without appending to the conversation. */
  openCommandHelp(): boolean { if (this.preferences || this.modelPicker || this.branchTreeOpen || this.loginChooserState !== undefined || this.loginApproval || this.credentialEntry || this.loginCallbackValue !== undefined) return false; this.commandHelpOpen = true; return true; }

  /** Refresh only skill frontmatter; stale workspace/session results cannot replace current choices. */
  async refreshCommands(): Promise<boolean> {
    const generation = ++this.commandDiscoveryGeneration;
    const workspace = this.workspace;
    const session = this.session;
    if (!workspace) return true;
    const skills = await discoverSkills({ workspaceRoot: workspace.root, extraRoots: workspace.extraRoots, home: this.home, metadataOnly: true, diagnosticContext: { secrets: this.secrets } });
    if (this.disposed || generation !== this.commandDiscoveryGeneration || workspace !== this.workspace || session !== this.session) return false;
    this.discoveredCommands = skills;
    return true;
  }

  /** Return curated discovery or name-first fuzzy results without loading providers or activating skills. */
  commandChoices(input = "/", help = false): CommandChoice[] {
    const commands = commandCatalog(this.extensionCommands(), this.discoveredCommands);
    if (help) {
      const query = input.trim().toLowerCase();
      return rankCommands(commands, query, true);
    }
    const match = /^\/(thinking|theme|login|logout)\s+([^\s]*)$/.exec(input);
    if (match) {
      const name = match[1]!;
      if (commands.some(entry => entry.name === name && !entry.available)) return commands.filter(entry => entry.name === name);
      const applicable = this.thinkingSelection().choices;
      const values = name === "thinking" ? ["reset", ...applicable] : name === "theme" ? ["auto", "dark", "light"] : ["openai", "xai", "openai-compatible", "codex", "grok"];
      return values.filter(value => value.startsWith(match[2]!)).map(value => ({ id: `${name}:${value}`, name: `${name} ${value}`, insertion: `/${name} ${value}`, source: "argument", description: name === "thinking" && value === "reset" ? "Inherit configured default" : value, available: true }));
    }
    if (!/^\/[^\s]*$/.test(input)) return [];
    return rankCommands(commands, input.slice(1));
  }

  /** Revalidate command collisions immediately before explicit dispatch. */
  async commandCollision(name: string): Promise<boolean> {
    const generation = ++this.commandDiscoveryGeneration;
    const workspace = this.workspace;
    const session = this.session;
    const skills = workspace ? await discoverSkills({ workspaceRoot: workspace.root, extraRoots: workspace.extraRoots, home: this.home, metadataOnly: true, diagnosticContext: { secrets: this.secrets } }) : undefined;
    if (this.disposed || generation !== this.commandDiscoveryGeneration || workspace !== this.workspace || session !== this.session) { this.notice("Commands changed · Enter retry"); return true; }
    this.discoveredCommands = skills;
    const choices = commandCatalog(this.extensionCommands(), skills).filter(entry => entry.name === name);
    if (choices.some(entry => !entry.available)) { this.notice("Command conflicts with skill · /help inspect sources · F2 details", `/${name} conflicts with skill or command sources: ${choices.map(entry => entry.source).join(", ")}. Rename the skill or extension.`); return true; }
    return false;
  }

  /** Return active extension command metadata for help and editor dispatch. */
  extensionCommands() { return this.extensions?.commandList() ?? []; }

  /** Start an idle extension command after preparation and notify when its input is accepted. */
  async runExtensionCommand(name: string, args: string, accepted: () => void = () => {}): Promise<boolean> {
    const command = this.extensions?.command(name);
    if (!command || this.disposed) return false;
    if (this.running) {
      this.notice(`Command not run · Esc stop · /${name} retry`);
      return false;
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = this.executeExtensionCommand(command, args, abort, accepted);
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  protected async executeExtensionCommand(
    command: { name: string; source: string; description: string }, args: string, abort: AbortController, accepted: () => void,
  ): Promise<boolean> {
    let prompt: string | undefined;
    let accepting = true;
    let executed = false;
    let succeeded = false;
    const current = () => this.activeAbort === abort && !this.disposed;
    try {
      if (this.workspace) {
        const skills = await discoverSkills({ workspaceRoot: this.workspace.root, extraRoots: this.workspace.extraRoots, home: this.home, signal: abort.signal, diagnosticContext: { secrets: this.secrets } });
        this.extensions!.assertNoSkillCollision(command, skills);
      }
      abort.signal.throwIfAborted();
      if (!current()) return false;
      executed = true;
      try { accepted(); } catch { /* Presentation cannot cancel an accepted command. */ }
      const result = await this.extensions!.executeCommand(command.name, args, {
        signal: abort.signal,
        submitPrompt: (text) => {
          if (!accepting || !current() || abort.signal.aborted || this.extensions!.signal.aborted) throw new Error("Command prompt capability is closed");
          if (typeof text !== "string" || !text.trim()) throw new Error("Command prompt must be nonempty text");
          if (prompt !== undefined) throw new Error("A command may submit only one prompt");
          prompt = text;
        },
      });
      if (current() && !abort.signal.aborted) {
        if (result) this.notice(result);
        this.status = "idle";
        succeeded = true;
      }
    } catch (error) {
      if (current()) {
        const detail = abort.signal.aborted ? "Cancelled. Retry the command when ready." : error instanceof Error ? error.message : String(error);
        const prefix = `Extension "${command.source}" command /${command.name}: `;
        this.notice(redactSecrets(detail.startsWith(prefix) ? detail : `${prefix}${detail}`, this.secrets).slice(0, 50_000));
        this.status = "idle";
      }
    } finally {
      accepting = false;
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
    if (succeeded && prompt !== undefined && !this.disposed && !abort.signal.aborted) await this.submit(prompt);
    return executed;
  }
}

/** Keep curated ties stable and put metadata-only help matches after every matching command name. */
function rankCommands(commands: CommandChoice[], query: string, help = false): CommandChoice[] {
  if (!query) return commands;
  return commands.flatMap((entry, order) => {
    const nameRank = fuzzyRank(query, entry.name);
    const metadataRank = help ? fuzzyRank(query, `${entry.description} ${entry.source} ${entry.provenance ?? ""}`) : undefined;
    const rank = nameRank ?? (metadataRank === undefined ? undefined : 5 + metadataRank);
    return rank === undefined ? [] : [{ entry, order, rank }];
  }).sort((left, right) => left.rank - right.rank || left.order - right.order).map(({ entry }) => entry);
}
