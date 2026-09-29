import { preferenceRows, PREFERENCE_SCOPES, type PreferencesSnapshot } from "./preferences.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type { Model } from "../model/model.ts";
import { type ConfigLayer, type ResolvedSettings, describeEffectiveThinking } from "../config/config.ts";
import { EDITABLE_CONFIG_KEYS, type ConfigScope, type ConfigTransaction } from "../config/editing.ts";
import { isDeepStrictEqual } from "node:util";
import { sanitizeBaseUrl } from "./transcript-format.ts";
import { displaySetting } from "./controller-support.ts";
import { ChangesLayer } from "./controller-changes.ts";


/** Preferences, config commands and settings publication. */
export abstract class SettingsLayer extends ChangesLayer {
  /** Return the effective configured appearance before a launch environment override. */
  appearanceMode(): "auto" | "dark" | "light" { return this.configEditor?.settings.appearance ?? "auto"; }

  /** Report whether appearance can use the shared session and saved preferences. */
  hasAppearancePreferences(): boolean { return !!this.configEditor; }

  /** Open bounded preferences without changing the composer or any configuration layer. */
  openPreferences(): boolean {
    if (this.running || this.disposed || !this.configEditor || this.preferences || this.modelPicker || this.branchTreeOpen || this.loginChooserIndex !== undefined || this.loginApproval !== undefined) return false;
    this.closeModelPicker();
    this.preferences = { scope: "session", selectedIndex: 0, choiceIndex: 0, rows: preferenceRows(this.configEditor, "session", this.secrets, this.appearanceEnvironment) };
    return true;
  }

  /** Cancel a pending preview or close preferences without committing it. */
  closePreferences(): void {
    this.preferenceGeneration++;
    if (this.running) this.cancel();
    this.preferenceTransaction = undefined;
    if (this.preferences?.preview) this.preferences.preview = undefined;
    else this.preferences = undefined;
  }

  /** Move a bounded preference, value or explicit persistence scope and discard stale previews. */
  movePreference(delta: number, kind: "row" | "choice" | "scope" = "row"): void {
    const panel = this.preferences;
    if (!panel || this.running || !this.configEditor) return;
    this.preferenceGeneration++;
    this.preferenceTransaction = undefined; panel.preview = undefined; panel.error = undefined;
    const wrap = (index: number, count: number) => (index + delta + count) % count;
    if (kind === "scope") {
      const scopes = Object.keys(PREFERENCE_SCOPES) as PreferencesSnapshot["scope"][];
      panel.scope = scopes[wrap(scopes.indexOf(panel.scope), scopes.length)]!;
      panel.rows = preferenceRows(this.configEditor, panel.scope, this.secrets, this.appearanceEnvironment);
      panel.selectedIndex = 0; panel.choiceIndex = 0;
    } else if (kind === "row") {
      panel.selectedIndex = wrap(panel.selectedIndex, panel.rows.length); panel.choiceIndex = 0;
    } else panel.choiceIndex = wrap(panel.choiceIndex, panel.rows[panel.selectedIndex]!.choices.length);
  }

  /** Stage the selected action for confirmation, then apply that exact validated transaction atomically. */
  async selectPreference(): Promise<boolean> {
    const panel = this.preferences;
    if (!panel || this.running || !this.configEditor) return false;
    const row = panel.rows[panel.selectedIndex]!;
    if (row.key !== "appearance" && !this.stageSettings) return false;
    const choice = row.choices[panel.choiceIndex];
    if (panel.scope !== "memory" && typeof choice === "string" && choice.startsWith("open model")) {
      this.preferences = undefined;
      this.notice("Model + route picker activates and remembers a successful choice for this workspace; it does not write user or project config.");
      return this.openModelPicker();
    }
    if (this.preferenceTransaction && panel.preview) {
      const transaction = this.preferenceTransaction;
      const message = panel.preview.replace("Enter confirms; Esc cancels.", "Applied.");
      const applied = await this.changeSettings(async () => transaction, () => message, undefined, row.key !== "appearance", row.key === "appearance");
      if (this.preferences === panel) {
        if (applied) { panel.preview = undefined; this.preferenceTransaction = undefined; panel.rows = preferenceRows(this.configEditor, panel.scope, this.secrets, this.appearanceEnvironment); }
        else panel.error = `Not applied: ${this.settingsFailure ?? "previous settings retained"} Change selection to stage again, or Esc to cancel.`;
      }
      return applied;
    }
    const generation = ++this.preferenceGeneration;
    const abort = new AbortController();
    this.activeAbort = abort; this.status = "running";
    const task = (async () => {
      try {
        let transaction: ConfigTransaction;
        if (panel.scope === "memory") {
          const settings = this.configEditor!.settings;
          if (panel.choiceIndex === 0 && !this.model) throw new Error("Activate a model successfully before remembering its choice.");
          const choice = panel.choiceIndex === 0 ? { provider: settings.provider, model: settings.model,
            ...(settings.provider === "openai" ? { openaiAuth: this.model?.provider === "codex-subscription" ? "codex" as const : "api-key" as const } : {}),
            ...(settings.profile ? { profile: settings.profile } : {}), ...(settings.thinking ? { thinking: settings.thinking } : {}) } : undefined;
          transaction = await this.configEditor!.prepareMemory(choice);
        } else transaction = await this.configEditor!.prepare({ scope: panel.scope, key: row.key, value: row.key === "git" && choice !== undefined ? { changeTracking: choice } : choice });
        abort.signal.throwIfAborted();
        if (row.key !== "appearance") {
          const staged = await this.stageSettings!(transaction.settings, abort.signal, this.workspace, this.model, true);
          abort.signal.throwIfAborted();
          if (!staged.model) throw new Error("The selected model is unavailable; previous settings remain active.");
        }
        if (this.disposed || this.preferences !== panel || generation !== this.preferenceGeneration) return false;
        this.preferenceTransaction = transaction;
        const origin = row.key === "appearance" && this.appearanceEnvironment ? "environment" : transaction.origins[row.key as keyof ConfigLayer] ?? transaction.origins.model;
        const effective = panel.scope === "memory" ? `${transaction.settings.provider}/${transaction.settings.model} (${transaction.settings.openaiAuth ?? transaction.settings.auth}); thinking ${transaction.settings.thinking ?? "default"}` : row.key === "appearance" && this.appearanceEnvironment ? this.appearanceEnvironment : row.key === "git" ? transaction.settings.gitChangeTracking : transaction.settings[row.key as keyof ResolvedSettings];
        const expectedOrigin = { session: "current-session override", memory: "interactive memory", user: "user-global", project: "project" }[panel.scope];
        const shadowing = (panel.scope === "memory" ? panel.choiceIndex === 0 : choice !== undefined) && expectedOrigin !== origin ? ` Saved but not effective: shadowed by ${origin}.` : "";
        panel.preview = redactSecrets(`${PREFERENCE_SCOPES[panel.scope]} ${row.key}: ${choice === undefined ? "reset override" : String(choice)}. Effective after save: ${displaySetting(row.key, effective)} [${origin}].${shadowing} Enter confirms; Esc cancels.`, this.secrets);
        panel.error = undefined;
        return true;
      } catch (error) {
        if (this.preferences === panel) panel.error = abort.signal.aborted ? "Cancelled; nothing changed." : redactSecrets(error instanceof Error ? error.message : String(error), this.secrets);
        return false;
      } finally { if (this.activeAbort === abort) this.activeAbort = undefined; this.status = "idle"; }
    })();
    const tracked = task.then(() => {}); this.activeTurn = tracked;
    try { return await task; } finally { if (this.activeTurn === tracked) this.activeTurn = undefined; }
  }

  /** Inspect settings or apply one validated session or explicitly scoped persisted edit. */
  async configCommand(args: string): Promise<boolean> {
    if (args.trim() === "show") { this.notice(this.describeConfig()); return true; }
    if (!args.trim()) { if (this.configEditor) return this.openPreferences(); this.notice(this.describeConfig()); return true; }
    if (this.running) { this.notice("Busy: settings edits require an idle session. Press Esc to cancel first."); return false; }
    const scoped = args.trim().match(/\s+--scope\s+(\S+)$/);
    const scopeValue = scoped?.[1];
    if (scopeValue && !["user", "project", "session"].includes(scopeValue)) { this.fail("Config scope must be user, project or session."); return false; }
    const command = scoped ? args.trim().slice(0, scoped.index) : args.trim();
    const match = command.match(/^(set|reset)\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) { this.fail("Usage: /config set <key> <value> [--scope user|project] or /config reset <key> [--scope user|project]."); return false; }
    const [, action, key, raw] = match;
    if ((action === "set" && !raw?.trim()) || (action === "reset" && raw?.trim()) || raw?.includes("--scope")) { this.fail("Usage: /config set <key> <value> or /config reset <key>, optionally followed by --scope user|project."); return false; }
    const scope = (scopeValue ?? "session") as ConfigScope;
    let value: unknown = raw;
    if (action === "reset") value = undefined;
    else if (["maxTurns", "maxConcurrentTools", "contextWindow", "maxOutput"].includes(key!)) value = Number(raw);
    else if (key === "git" && raw?.trim()) { try { value = JSON.parse(raw); } catch { this.fail('Invalid git value. Use JSON like {"changeTracking":"snapshot"}.'); return false; } }
    else if (raw?.startsWith('"')) { try { value = JSON.parse(raw); } catch { this.fail("Invalid quoted config value."); return false; } }
    return this.changeSettings(() => this.configEditor!.prepare({ scope, key: key!, value }), () => {
      const origin = key === "appearance" && this.appearanceEnvironment ? "environment" : this.configEditor!.origins[key as keyof ConfigLayer];
      const rawEffective = key === "appearance" && this.appearanceEnvironment ? this.appearanceEnvironment : key === "git" ? this.configEditor!.settings.gitChangeTracking : this.configEditor!.settings[key as keyof ResolvedSettings];
      const effective = key === "model" && !rawEffective ? "unset" : displaySetting(key!, rawEffective);
      const saved = action === "reset" ? "removed override" : `saved ${displaySetting(key!, value)}`;
      const source = scope === "session" ? "current-session override" : scope === "user" ? "user-global" : "project";
      const providerSource = key === "model" ? this.configEditor!.modelFallbackSource : undefined;
      const shownOrigin = origin ?? (key === "model" && !rawEffective ? "not configured" : origin);
      const shadowingSource = providerSource ? `${providerSource} provider selection` : shownOrigin;
      const shadowed = action === "set" && source !== shownOrigin ? `; shadowed by ${shadowingSource}`
        : action === "reset" && providerSource ? `; ${providerSource} provider selection cleared the model` : "";
      return `${key} (${scope}): ${saved}. Effective: ${effective} [${shownOrigin}]${shadowed}.`;
    }, undefined, false, key === "appearance");
  }

  protected async changeSettings(prepare: () => Promise<ConfigTransaction>, message: () => string, failureMessage?: string, activate = false, appearanceOnly = false): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: settings edits require an idle session. Press Esc to cancel first."); return false; }
    if (!this.configEditor || (!appearanceOnly && !this.stageSettings)) { this.fail("Interactive settings are unavailable in this session."); return false; }
    this.settingsFailure = undefined;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      try {
        const transaction = await prepare();
        abort.signal.throwIfAborted();
        if (appearanceOnly && !isDeepStrictEqual(
          { ...this.configEditor!.settings, appearance: undefined },
          { ...transaction.settings, appearance: undefined },
        )) throw new Error("Other settings changed outside Schway. Reload before saving appearance.");
        const staged = appearanceOnly ? undefined : await this.stageSettings!(transaction.settings, abort.signal, this.workspace, this.model, activate);
        abort.signal.throwIfAborted();
        if (activate && !staged?.model) throw new Error("The selected provider is unavailable. Configure access with /login or choose another model.");
        if (this.disposed || this.activeAbort !== abort) return false;
        await transaction.commit(abort.signal);
        // Once the transaction commits, publish the matching runtime even if cancellation arrives at that boundary.
        if (appearanceOnly) this.onSettingsCommitted?.(transaction.settings, this.contextManager);
        else this.publishSettings(transaction.settings, staged!);
        this.closeModelPicker();
        this.status = "idle";
        this.notice(redactSecrets(message(), this.secrets));
        return true;
      } catch (error) {
        this.settingsFailure = abort.signal.aborted ? "Settings change cancelled. Previous settings remain active." : failureMessage ?? redactSecrets(error instanceof Error ? error.message : String(error), this.secrets);
        if (abort.signal.aborted) { this.notice("Settings change cancelled. Previous settings remain active."); this.status = "idle"; }
        else this.fail(failureMessage ?? redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
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

  protected publishSettings(next: ResolvedSettings, staged: { model?: Model; contextManager: ContextManager }): void {
    this.model = staged.model;
    this.contextManager.clearActiveSkill();
    this.contextManager = staged.contextManager;
    this.provider = next.provider; this.modelId = next.model;
    this.maxTurns = next.maxTurns; this.maxConcurrentTools = next.maxConcurrentTools;
    this.explicitContextWindow = next.explicitContextWindow; this.explicitMaxOutput = next.explicitMaxOutput;
    this.baseUrl = next.baseUrl; this.auth = next.auth; this.openaiAuth = next.openaiAuth; this.profile = next.profile;
    this.thinking = next.thinking;
    this.subscriptionReactivationRequired = false;
    if (next.openaiAuth !== "codex" || staged.model?.provider === "codex-subscription") this.subscriptionPending = false;
    this.onSettingsCommitted?.(next, staged.contextManager);
  }

  /** Render effective settings with active profile for `/config`, masking secrets and sanitizing URLs. */
  describeConfig(): string {
    const budgets = this.effectiveBudgets();
    const activeProfile = this.configEditor?.settings.profile ?? this.profile;
    const lines = [
      ...(activeProfile !== undefined ? [`Profile: ${activeProfile}`] : []),
      `Provider: ${this.provider}`,
      `Model: ${this.modelId}`,
      `Context window: ${budgets.contextWindow}`,
      `Max output: ${budgets.maxOutput}`,
    ];
    if (this.configEditor) {
      const settings = this.configEditor.settings;
      const origins = this.configEditor.origins;
      lines.splice(0, lines.length, ...EDITABLE_CONFIG_KEYS.filter(key => (settings as unknown as Record<string, unknown>)[key] !== undefined).map(key => {
        if (key === "appearance" && this.appearanceEnvironment) {
          return `appearance: ${this.appearanceEnvironment} [environment] (configured: ${settings.appearance} [${origins.appearance ?? "built-in default"}])`;
        }
        if (key === "thinking") {
          const requested = (settings as unknown as Record<string, unknown>)[key];
          const effective = this.codexThinkingSelected() ? this.describeThinking() : describeEffectiveThinking(this.provider, requested as never, settings.model);
          return `${key}: ${displaySetting(key, requested)} [${origins[key as keyof ConfigLayer]}] (effective: ${effective})`;
        }
        return `${key}: ${displaySetting(key, (settings as unknown as Record<string, unknown>)[key])} [${origins[key as keyof ConfigLayer]}${(key === "contextWindow" || key === "maxOutput") && origins[key as keyof ConfigLayer] !== "catalog" ? "; explicit limit" : ""}]`;
      }));
      const gitMode = settings.gitChangeTracking;
      const gitOrigin = origins.git !== undefined ? ` [${origins.git}]` : "";
      if (!lines.some((line) => line.startsWith("git:"))) {
        lines.push(`git: {"changeTracking":"${gitMode}"}${gitOrigin}`);
      }
      if (settings.thinking === undefined) {
        lines.push(`thinking: unset (effective: ${this.codexThinkingSelected() ? this.describeThinking() : describeEffectiveThinking(this.provider, undefined)})`);
      }
      if (settings.headers) lines.push(`headers: configured (values hidden) [${origins.headers}]`);
      if (settings.extraBody) lines.push(`extraBody: configured (values hidden) [${origins.extraBody}]`);
      if (settings.credentialEnv) lines.push(`credentialEnv: ${settings.credentialEnv} [profile "${settings.profile}"]`);
      if (settings.credentialIdentity) lines.push(`credentialIdentity: ${settings.credentialIdentity} [profile "${settings.profile}"]`);
    }
    if (!this.configEditor) {
      const thinking = this.thinking;
      lines.push(thinking !== undefined ? `Thinking: ${thinking} (effective: ${describeEffectiveThinking(this.provider, thinking as never, this.modelId)})` : `Thinking: unset (effective: ${describeEffectiveThinking(this.provider, undefined)})`);
      lines.push(`git: {"changeTracking":"${this.gitChangeTracking()}"}`);
    }
    if (!this.configEditor && this.maxTurns !== undefined) {
      lines.push(`Max turns: ${this.maxTurns}`);
    }
    if (!this.configEditor && this.maxConcurrentTools !== undefined) {
      lines.push(`Max concurrent tools: ${this.maxConcurrentTools}`);
    }
    if (!this.configEditor && this.provider === "openai-compatible") {
      if (this.baseUrl !== undefined) {
        lines.push(`Base URL: ${sanitizeBaseUrl(this.baseUrl)}`);
      }
      if (this.auth !== undefined) {
        lines.push(`Auth: ${this.auth}`);
      }
    }
    lines.push(`Session: ${this.sessionId}`);
    lines.push(`Branch: ${this.session.activeBranchId}`);
    if (this.workspace) {
      lines.push(`Workspace root: ${this.workspace.root}`, `Launch directory: ${this.workspace.launchCwd}`);
      lines.push(`Attached roots: ${this.workspace.extraRoots.join(", ") || "none"}`);
      const unavailable = this.session.metadata.extraRoots.filter(root => !this.workspace!.extraRoots.includes(root));
      if (unavailable.length) lines.push(`Unavailable saved roots: ${unavailable.join(", ")}`);
    }
    lines.push("Edits apply to this session only by default. Use --scope user or --scope project to save; /config reset removes that scope's override.");
    return redactSecrets(lines.join("\n"), this.secrets);
  }
}
