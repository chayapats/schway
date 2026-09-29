import { isOpenAIAuthPreference } from "../auth/credentials.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type { ModelCapability } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import { describeEffectiveThinking } from "../config/config.ts";
import { parseModelArgs, parseThinkingArgs } from "./commands.ts";
import type { ListedModel } from "../model/model-list.ts";
import { modelPickerEntries, modelPickerIdentity, type ModelPickerEntry, type ModelPickerSnapshot } from "./model-picker.ts";
import { loadModelPickerAccess } from "./model-access.ts";
import { CommandsLayer } from "./controller-commands.ts";


/** Model picker, auth-route selection, profiles and thinking-level actions. */
export abstract class ModelsLayer extends CommandsLayer {
  protected apiModels?: readonly ListedModel[];
  protected apiModelsUnavailable = false;
  protected compatibleModels?: readonly ListedModel[];
  protected compatibleModelsUnavailable = false;
  protected subscriptionListUnavailable = false;
  /** Replace the adapter and displayed provider/model ids without changing session history. */
  setModel(model: Model | undefined, provider: string, modelId: string, profile?: string): void {
    if (!this.recoveryRepair && (this.model !== model || this.provider !== provider || this.modelId !== modelId ||
      profile !== undefined && this.profile !== profile)) this.recovery = undefined;
    this.model = model;
    this.provider = provider;
    this.modelId = modelId;
    if (profile !== undefined) {
      this.profile = profile;
    }
  }

  /** Open model search while idle, selecting the currently active entry. */
  openModelPicker(): boolean {
    if (this.preferences) return false;
    if (this.running || this.disposed) { this.notice("Busy: model selection requires an idle session."); return false; }
    this.preferences = undefined; this.preferenceTransaction = undefined; this.preferenceGeneration++;
    this.closeModelPicker();
    this.pickerSelectionTouched = false;
    this.modelPicker = { query: "", selectedIndex: 0, entries: [], ...(this.subscriptionSelected() || this.credentials ? { loading: true, catalogState: "loading" } : {}),
      ...(this.credentials ? { accessLoading: true } : {}) };
    this.searchModels("");
    if (this.subscriptionSelected() || this.credentials) {
      const picker = this.modelPicker;
      const abort = new AbortController();
      this.modelCatalogAbort = abort;
      void this.refreshModelPicker(picker, abort);
    }
    return true;
  }

  /** Resolve configured access and account models for only the current picker instance. */
  protected async refreshModelPicker(picker: ModelPickerSnapshot, abort: AbortController): Promise<void> {
    const current = () => !this.disposed && !abort.signal.aborted && this.modelPicker === picker;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
    let discoveryStage: "access" | "catalog" = "access";
    try {
      if (this.credentials) {
        const settings = this.configEditor?.settings;
        const preference = settings?.openaiAuth ?? this.openaiAuth;
        const auth = settings?.auth ?? this.auth;
        const access = await this.boundedPickerTask(signal, loadModelPickerAccess({ ...this.credentials,
          openaiAuth: isOpenAIAuthPreference(preference) ? preference : undefined,
          baseUrl: settings?.baseUrl ?? this.baseUrl, auth: auth === "none" || auth === "optional" || auth === "required" ? auth : undefined,
          credentialEnv: settings?.credentialEnv, credentialIdentity: settings?.credentialIdentity,
          activeProfile: settings?.profile ?? this.profile, profiles: this.configEditor?.profiles,
        }));
        if (!current()) return;
        this.modelPickerAccess = access;
        picker.accessLoading = false;
        this.searchModels(picker.query, true);
      }
      discoveryStage = "catalog";
      if (this.subscriptionSelected() || this.modelPickerAccess?.subscription === "ChatGPT") {
        if (!this.credentials?.listSubscriptionCatalog && !this.credentials?.listSubscriptionModels) {
          throw new Error("ChatGPT model discovery is unavailable. Restart Schway.");
        }
        const models = await this.boundedPickerTask(signal, this.loadAccountCatalog(signal));
        if (!current()) return;
        this.subscriptionModels = models.map(model => model.id);
        this.subscriptionListUnavailable = false;
        picker.catalogState = models.length ? "ready" : "empty";
        if (!models.length) picker.error = "No ChatGPT models were returned for this account. Press Ctrl+R to retry or Esc to cancel.";
      } else {
        picker.catalogState = "empty";
      }
      await this.loadRouteModelLists(signal, current);
    } catch (error) {
      if (current()) {
        picker.accessLoading = false;
        if (discoveryStage === "catalog") this.subscriptionListUnavailable = true;
        const message = redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 350);
        picker.catalogState = /offline|network|fetch|timeout|aborted/i.test(message) ? "offline" : "failed";
        picker.error = `${discoveryStage === "access" ? "Model access discovery" : "ChatGPT catalog"} ${picker.catalogState}: ${message}. Press Ctrl+R to retry or Esc to cancel.`;
        if (discoveryStage === "catalog") await this.loadRouteModelLists(signal, current);
      }
    } finally {
      if (current()) {
        picker.loading = false;
        this.searchModels(picker.query, true);
      }
    }
  }

  /** Fill connected API and compatible rows from their model-list endpoints, marking static fallback on failure. */
  protected async loadRouteModelLists(signal: AbortSignal, current: () => boolean): Promise<void> {
    const load = this.credentials?.listRouteModels;
    if (!load || !current()) return;
    const settings = this.configEditor?.settings;
    if (this.modelPickerAccess?.openaiApiKey === "API key") {
      try {
        this.apiModels = await this.boundedPickerTask(signal, load("api-key", signal));
        this.apiModelsUnavailable = false;
      } catch {
        if (current()) { this.apiModels = undefined; this.apiModelsUnavailable = true; }
      }
    }
    const baseUrl = settings?.baseUrl ?? this.baseUrl;
    const compatibleAccess = settings?.profile ? this.modelPickerAccess?.profiles[settings.profile] : this.modelPickerAccess?.providers["openai-compatible"];
    if (baseUrl && compatibleAccess && compatibleAccess !== "Login required") {
      try {
        this.compatibleModels = await this.boundedPickerTask(signal, load("compatible", signal, { baseUrl }));
        this.compatibleModelsUnavailable = false;
      } catch {
        if (current()) { this.compatibleModels = undefined; this.compatibleModelsUnavailable = true; }
      }
    }
  }

  /** Enforce the picker deadline even when a credential store or catalog ignores cancellation. */
  protected async boundedPickerTask<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Model discovery timed out"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([task, cancelled]); }
    finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }

  /** Retry account discovery without losing the search or highlighted route. */
  retryModelPickerCatalog(): boolean {
    const picker = this.modelPicker;
    if (!picker || picker.loading || !this.credentials) return false;
    this.modelCatalogAbort?.abort();
    const abort = new AbortController();
    this.modelCatalogAbort = abort;
    picker.loading = true;
    picker.error = undefined;
    picker.catalogState = "loading";
    void this.refreshModelPicker(picker, abort);
    return true;
  }

  /** Read account metadata once and retain it only in this controller and its session config. */
  protected async loadAccountCatalog(signal: AbortSignal): Promise<readonly ModelCapability[]> {
    const load = this.credentials?.listSubscriptionCatalog;
    if (load) {
      const models = await load(signal);
      signal.throwIfAborted();
      this.configEditor?.setModelCapabilities(models);
      this.subscriptionCapabilities = models;
      this.subscriptionModels = models.map(model => model.id);
      return models;
    }
    const slugs = await this.credentials?.listSubscriptionModels?.(signal);
    signal.throwIfAborted();
    if (!slugs) throw new Error("ChatGPT model discovery is unavailable. Restart Schway.");
    return slugs.map(id => ({ id, supportedThinking: [] }));
  }

  /** Use account models when the active route or explicit preference selects a subscription. */
  protected subscriptionSelected(): boolean {
    return this.subscriptionPending || (this.provider === "openai" && this.model?.provider === "codex-subscription") || (this.configEditor?.settings.openaiAuth ?? this.openaiAuth) === "codex";
  }

  /** Use Codex thinking only for its adapter or a Codex session awaiting an adapter. */
  protected codexThinkingSelected(): boolean {
    return this.model?.provider === "codex-subscription" || (!this.model && this.provider === "openai" &&
      (this.subscriptionReactivationRequired || (this.configEditor?.settings.openaiAuth ?? this.openaiAuth) === "codex"));
  }

  /** Filter catalog and profile choices with fallback budgets for typed ids. */
  searchModels(query: string, refresh = false): void {
    if (!this.modelPicker || this.running) return;
    const picker = this.modelPicker;
    const selectedIdentity = this.pickerPreferredIdentity ?? (this.pickerSelectionTouched ? picker.entries[picker.selectedIndex]?.identity : undefined);
    if (!refresh && picker.query !== query) this.pickerSelectionTouched = true;
    picker.query = query;
    const settings = this.configEditor?.settings;
    picker.entries = modelPickerEntries(query, this.provider, this.modelId, { contextWindow: this.explicitContextWindow, maxOutput: this.explicitMaxOutput }, {
      profiles: this.configEditor?.profiles, activeProfile: settings?.profile ?? this.profile,
      activeRoute: this.model?.provider === "codex-subscription" || this.openaiAuth === "codex" ? "codex" : "api-key",
      baseUrl: settings?.baseUrl ?? this.baseUrl, credentialIdentity: settings?.credentialIdentity,
      subscriptionMode: this.subscriptionSelected(), subscriptionModels: this.subscriptionModels, subscriptionCapabilities: this.subscriptionCapabilities, access: this.modelPickerAccess,
      apiModels: this.apiModels, apiModelsUnavailable: this.apiModelsUnavailable, compatibleModels: this.compatibleModels,
      compatibleModelsUnavailable: this.compatibleModelsUnavailable, subscriptionUnavailable: this.subscriptionListUnavailable,
    });
    if (this.modelPickerAccess?.subscription === "Login required" && !this.subscriptionModels?.length &&
      "openai ChatGPT subscription connect".toLowerCase().includes(query.toLowerCase())) {
      picker.entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: "" }), provider: "openai", modelId: "", authRoute: "codex",
        contextWindow: 0, maxOutput: 0, active: false, custom: false, access: "Login required", connect: true });
    }
    picker.selectedIndex = selectedIdentity ? Math.max(0, picker.entries.findIndex(entry => entry.identity === selectedIdentity)) : 0;
    if (this.pickerPreferredIdentity && picker.entries.some(entry => entry.identity === this.pickerPreferredIdentity)) this.pickerPreferredIdentity = undefined;
  }

  /** Move the highlighted model with wraparound over the filtered choices. */
  moveModelPicker(delta: number): void {
    if (!this.modelPicker || this.running || !this.modelPicker.entries.length) return;
    this.pickerPreferredIdentity = undefined;
    this.pickerSelectionTouched = true;
    const count = this.modelPicker.entries.length;
    this.modelPicker.selectedIndex = ((this.modelPicker.selectedIndex + delta) % count + count) % count;
  }

  /** Start the selected route's sign-in while retaining its query and identity. */
  protected async connectPickerRoute(selection: ModelPickerEntry): Promise<boolean> {
    const picker = this.modelPicker;
    if (!picker || !this.credentials) { this.fail("Sign-in is unavailable in this session."); return false; }
    this.pickerReturn = { query: picker.query, identity: selection.identity };
    let started: boolean;
    if (selection.authRoute === "codex") {
      started = await this.login("codex");
      if (!started) this.pickerReturn = undefined;
      return started;
    }
    if (selection.profile) {
      const profile = this.configEditor?.profiles[selection.profile];
      started = !!profile && this.beginCredentialTarget({ provider: "openai-compatible", profile: selection.profile,
        baseUrl: profile.baseUrl, credentialIdentity: profile.credentialIdentity });
    } else started = this.beginLogin(selection.provider);
    if (!started) this.pickerReturn = undefined;
    return started;
  }

  /** Reopen search after a saved credential without activating a model. */
  protected restorePickerAfterConnection(): void {
    const returning = this.pickerReturn;
    this.pickerReturn = undefined;
    if (!returning || this.disposed) return;
    this.openModelPicker();
    this.pickerPreferredIdentity = returning.identity;
    this.searchModels(returning.query);
  }

  /** Close the picker without changing the active model or settings. */
  closeModelPicker(): void {
    this.modelCatalogAbort?.abort();
    this.modelCatalogAbort = undefined;
    this.modelPickerAccess = undefined;
    this.subscriptionModels = undefined;
    this.apiModels = undefined;
    this.apiModelsUnavailable = false;
    this.compatibleModels = undefined;
    this.compatibleModelsUnavailable = false;
    this.subscriptionListUnavailable = false;
    this.modelPicker = undefined;
    this.pickerPreferredIdentity = undefined;
    this.pickerSelectionTouched = false;
    if (this.recoveryRepair && this.recovery && !this.recoveryIdentityChanged(this.recovery)) this.recoveryRepair = false;
  }

  /** Stage and commit the highlighted model or profile, leaving the picker open on failure. */
  async selectPickerModel(): Promise<boolean> {
    if (this.modelPicker?.accessLoading) { this.notice("Checking configured credentials. Try again shortly."); return false; }
    const selection = this.modelPicker?.entries[this.modelPicker.selectedIndex];
    if (!selection) return false;
    if (selection.access === "Login required" || selection.connect) {
      return this.connectPickerRoute(selection);
    }
    let applied: boolean;
    if (selection.profile !== undefined) applied = await this.selectProfile(selection.profile);
    else if (selection.authRoute === "codex") {
      if (!selection.listUnavailable && !this.subscriptionModels?.includes(selection.modelId)) {
        this.fail("This ChatGPT model is not in the current account catalog. Press Ctrl+R to retry discovery.");
        return false;
      }
      applied = await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(selection.modelId),
        () => `Switched to openai/${this.modelId} via ChatGPT subscription.`, undefined, true);
    } else if (selection.authRoute === "api-key") {
      applied = await this.changeSettings(() => this.configEditor!.prepareOpenAIApiModel(selection.modelId),
        () => `Switched to openai/${this.modelId} via OpenAI API key.`, undefined, true);
    } else applied = await this.selectModel(`${selection.provider}/${selection.modelId}`);
    if (applied && (selection.authRoute === "codex" || selection.authRoute === "api-key")) await this.emitModelActivated(selection);
    return applied;
  }

  /** Notify persistence consumers only after the selected route has activated. */
  protected async emitModelActivated(choice: Pick<ModelPickerEntry, "provider" | "modelId" | "authRoute" | "profile">): Promise<void> {
    if (!this.model) return;
    try {
      if (await this.configEditor?.rememberChoice(choice.authRoute)) this.notice("Choice remembered for this workspace. Explicit config and CLI settings take precedence on restart; /model forget resets memory.");
      this.onModelActivated?.({ provider: choice.provider, modelId: choice.modelId, authRoute: choice.authRoute,
      ...(choice.profile ? { profile: choice.profile } : {}) }); }
    catch (error) { this.notice(`Model activated and usable, but its preference was not remembered. ${redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)} No additional login is needed.`); }
  }

  /** Switch the named compatible profile as one staged change, retaining previous on failure. */
  async selectProfile(name: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    const trimmed = name.trim();
    if (!trimmed) { this.fail("Usage: /model profile:<name>."); return false; }
    const applied = await this.changeSettings(() => this.configEditor!.prepareProfile(trimmed), () => {
      const active = this.configEditor!.settings.profile ?? trimmed;
      return `Switched to profile "${active}" (${this.provider}/${this.modelId}, ${this.effectiveBudgets().contextWindow} ctx, thinking ${this.describeThinking()}).`;
    }, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: "provider", profile: trimmed });
    return applied;
  }

  /** Forget workspace memory and expose inherited configuration even when its credentials need repair. */
  async forgetModelChoice(): Promise<boolean> {
    if (this.running || !this.configEditor || !this.stageSettings) { this.notice("Memory reset requires an idle configured session."); return false; }
    this.status = "running";
    try {
      const editor = await this.configEditor.forgetChoice();
      const next = editor.settings;
      this.configEditor = editor;
      const signal = new AbortController().signal;
      let staged: { model?: Model; contextManager: ContextManager };
      try { staged = await this.stageSettings(next, signal, this.workspace, this.model); }
      catch { staged = { model: undefined, contextManager: this.contextManager }; }
      this.publishSettings(next, staged);
      this.recovery = undefined;
      this.notice(`Forgot interactive memory for this workspace. Inherited configuration is active.${staged.model ? "" : " Configure access with /model or /login before submitting."}`);
      return true;
    } catch (error) { this.notice(`Could not forget interactive memory: ${redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)}`); return false; }
    finally { this.status = "idle"; }
  }

  /** Apply the textual model or profile form through the same atomic session settings path as the picker. */
  async selectModel(args: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    if (["forget", "reset"].includes(args.trim())) return this.forgetModelChoice();
    const selection = parseModelArgs(args, this.provider);
    if ("error" in selection) { this.fail(selection.error); return false; }
    if (selection.profile !== undefined) {
      return this.selectProfile(selection.profile);
    }
    if (this.subscriptionSelected() && selection.provider === "openai") {
      try {
        const available = this.subscriptionModels ?? (await this.loadAccountCatalog(AbortSignal.timeout(5_000))).map(model => model.id);
        if (!available?.includes(selection.modelId)) {
          this.fail(`Model "${selection.modelId}" is not in the ChatGPT subscription model catalog. Open /model to see available choices.`);
          return false;
        }
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    const applied = await this.changeSettings(() => selection.provider === "openai" && this.subscriptionSelected()
      ? this.configEditor!.prepareSubscriptionModel(selection.modelId)
      : this.configEditor!.prepareModel(selection.provider, selection.modelId),
      () => `Switched to ${this.provider}/${this.modelId} (${this.effectiveBudgets().contextWindow} ctx, ${this.describeThinking()}).`, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId,
      authRoute: this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" ? "api-key" : "provider" });
    return applied;
  }

  /** Show or switch the reasoning level for future requests without rewriting history. */
  async thinkingCommand(args: string): Promise<boolean> {
    const selection = parseThinkingArgs(args);
    if (typeof selection === "object") { this.fail(selection.error); return false; }
    if (selection !== "reset" && this.codexThinkingSelected() &&
      (this.configEditor?.settings.supportedThinking === undefined || this.model?.provider === "codex-subscription" && this.configEditor?.settings.openaiAuth !== "codex")) {
      try {
        const models = this.subscriptionCapabilities ?? await this.loadAccountCatalog(AbortSignal.timeout(5_000));
        if (!models.some(model => model.id === this.modelId)) {
          this.fail(`Model "${this.modelId}" is not available for this ChatGPT subscription. Open /model to choose an account-visible model.`);
          return false;
        }
        // Auto-selected Codex is an active subscription, but saved auth remains "auto".
        // Bind the verified choice to this session so config validation and the adapter agree.
        if (this.model?.provider === "codex-subscription" && this.configEditor?.settings.openaiAuth !== "codex" &&
          !(await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(this.modelId), () => `Verified subscription model ${this.modelId} for this session.`))) return false;
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    if (selection === "show") { this.notice(this.describeThinking()); return true; }
    let applied: boolean;
    if (selection === "reset") {
      applied = await this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: this.codexThinkingSelected() ? null : undefined }), () => `Thinking reset. ${this.describeThinking()}.`);
    }
    else applied = await this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: selection }), () => `Thinking ${selection}. ${this.describeThinking()}.`, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" ? "api-key" : "provider" });
    return applied;
  }

  /** Requested and effective reasoning with provider/model for truthful display. */
  describeThinking(): string {
    const requested = this.configEditor?.settings.thinking ?? this.thinking;
    const effective = this.configEditor?.settings.effectiveThinking ?? (requested as never);
    const origin = this.configEditor?.origins.thinking;
    const capability = this.codexThinkingSelected() ? this.configEditor?.settings : undefined;
    if (capability?.supportedThinking !== undefined) {
      const supported = capability.supportedThinking.join("/") || "none advertised";
      const defaultLevel = capability.defaultThinking ?? "unspecified";
      return requested === undefined
        ? `Thinking: provider default (${defaultLevel}; no explicit control sent). Supported: ${supported} with ${this.provider}/${this.modelId}`
        : `Thinking: ${requested}${origin ? ` [${origin}]` : ""} (supported: ${supported}; provider default: ${defaultLevel}) with ${this.provider}/${this.modelId}`;
    }
    if (this.codexThinkingSelected()) {
      return `Thinking: ${requested ?? "unset"} (subscription capability not yet verified; open /model) with ${this.provider}/${this.modelId}`;
    }
    const effectiveDesc = describeEffectiveThinking(this.provider, (effective ?? requested) as never, this.modelId);
    if (requested === undefined) {
      return `Thinking: unset (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
    }
    return `Thinking: ${requested}${origin ? ` [${origin}]` : ""} (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
  }
}
