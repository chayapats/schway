import { isOpenRouterEndpoint, resolveThinkingSelection } from "../model/thinking.ts";
import { openRouterModelCapabilities } from "../model/model-list.ts";
import { isOpenAIAuthPreference } from "../auth/credentials.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type { ModelCapability } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import { describeEffectiveThinking } from "../config/config.ts";
import { parseModelArgs, parseThinkingArgs } from "./commands.ts";
import { filterXaiModels, type ListedModel } from "../model/model-list.ts";
import { modelPickerEntries, modelPickerIdentity, presentModelPicker, rememberedPickerModels, type ModelPickerEntry, type ModelPickerSnapshot } from "./model-picker.ts";
import { ModelPreferences, type ModelPreferencesSnapshot } from "../config/model-preferences.ts";
import { loadModelPickerAccess } from "./model-access.ts";
import { CommandsLayer } from "./controller-commands.ts";


/** Model picker, auth-route selection, profiles and thinking-level actions. */
export abstract class ModelsLayer extends CommandsLayer {
  private pickerPreferences: ModelPreferencesSnapshot = { favorites: [], recents: [] };
  private pickerCacheKey?: string;
  private pickerCachedAccess?: typeof this.modelPickerAccess;
  private pickerReturnView?: { browsing?: boolean; connecting?: boolean };
  private pickerModelQuery = "";
  private pickerBrowseQuery = "";

  /** Use user-wide storage only when an explicit home is available. */
  private preferenceStore(): ModelPreferences | undefined { return this.home ? new ModelPreferences(this.home) : undefined; }

  /** Hide unverified routes while access discovery is pending or has failed. */
  private unavailablePickerAccess(): NonNullable<typeof this.modelPickerAccess> {
    return { providers: { openai: "Login required", xai: "Login required", "openai-compatible": "Login required" },
      profiles: Object.fromEntries(Object.keys(this.configEditor?.profiles ?? {}).map(name => [name, "Login required" as const])),
      subscription: "Login required", grok: "Login required", openaiApiKey: "Login required", xaiApiKey: "Login required" };
  }

  /** Toggle the highlighted exact route's user-wide favorite independently of discovery. */
  togglePickerFavorite(): boolean {
    const picker = this.modelPicker;
    const entry = picker?.entries[picker.selectedIndex];
    if (!picker || entry?.kind !== "model") return false;
    try {
      const pinned = !this.pickerPreferences.favorites.includes(entry.identity);
      this.pickerPreferences = this.preferenceStore()?.pin(entry.identity, pinned, entry) ?? { ...this.pickerPreferences,
        favorites: pinned ? [entry.identity, ...this.pickerPreferences.favorites] : this.pickerPreferences.favorites.filter(id => id !== entry.identity),
        models: { ...this.pickerPreferences.models, [entry.identity]: { modelId: entry.modelId, groupIdentity: entry.groupIdentity } } };
      if (picker.error === "Favorite not saved · Ctrl+P retry · Esc back") picker.error = undefined;
      this.pickerSelectionTouched = true;
      this.searchModels(picker.query, true);
      return true;
    } catch (error) { picker.error = "Favorite not saved · Ctrl+P retry · Esc back"; this.notice(picker.error, String(error)); return false; }
  }

  /** Open the complete connected catalog, restoring the previous search when returning. */
  browsePickerModels(): void {
    const picker = this.modelPicker;
    if (!picker) return;
    if (!picker.browsing) this.pickerBrowseQuery = picker.query;
    picker.browsing = !picker.browsing;
    picker.selectedIndex = -1;
    this.pickerPreferredIdentity = undefined;
    this.pickerSelectionTouched = false;
    this.searchModels(picker.browsing ? "" : this.pickerBrowseQuery);
  }

  /** Reveal exact connection targets, including configured endpoints and profiles. */
  connectPickerProviders(): void {
    if (!this.modelPicker) return;
    this.pickerModelQuery = this.modelPicker.query;
    this.modelPicker.connecting = true;
    this.searchModels("");
  }

  /** Reveal the selected model's exact ID and capacity on demand. */
  togglePickerDetails(): void { if (this.modelPicker) this.modelPicker.details = !this.modelPicker.details; }

  /** Return from browsing before closing and restoring the composer draft. */
  backModelPicker(): void {
    if (this.modelPicker?.connecting) { this.modelPicker.connecting = false; this.searchModels(this.pickerModelQuery); }
    else if (this.modelPicker?.browsing) this.browsePickerModels();
    else this.closeModelPicker();
  }
  protected apiModels?: readonly ListedModel[];
  protected apiModelsUnavailable = false;
  protected compatibleModels?: readonly ListedModel[];
  protected compatibleModelsUnavailable = false;
  protected xaiModels?: readonly ListedModel[];
  protected xaiModelsUnavailable = false;
  protected subscriptionListUnavailable = false;
  /** Replace the adapter and displayed provider/model ids without changing session history. */
  setModel(model: Model | undefined, provider: string, modelId: string, profile?: string): void {
    if (!this.recoveryRepair && (this.model !== model || this.provider !== provider || this.modelId !== modelId ||
      profile !== undefined && this.profile !== profile)) this.recovery = undefined;
    if (this.provider !== provider || this.modelId !== modelId || (profile !== undefined && this.profile !== profile)) this.selectionGeneration += 1;
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
    if (this.running || this.disposed) { this.notice("Wait for this turn · Esc stop"); return false; }
    this.preferences = undefined; this.preferenceTransaction = undefined; this.preferenceGeneration++;
    this.closeModelPicker();
    const cacheKey = JSON.stringify([this.configEditor?.settings, this.configEditor?.profiles, this.configEditor?.standaloneEndpoint, this.provider, this.baseUrl]);
    if (cacheKey === this.pickerCacheKey) this.modelPickerAccess = this.pickerCachedAccess;
    else {
      this.subscriptionModels = undefined; this.apiModels = undefined; this.compatibleModels = undefined;
      this.xaiModels = undefined; this.grokModels = undefined;
      this.pickerCachedAccess = undefined;
    }
    this.pickerCacheKey = cacheKey;
    try { this.pickerPreferences = this.preferenceStore()?.read() ?? this.pickerPreferences; }
    catch (error) { this.notice("Favorites unavailable · /model retry · Ctrl+I details", String(error)); }
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
          standaloneEndpoint: this.configEditor?.standaloneEndpoint,
          activeProfile: settings?.profile ?? this.profile, profiles: this.configEditor?.profiles,
        }));
        if (!current()) return;
        this.modelPickerAccess = access;
        this.pickerCachedAccess = access;
        picker.accessLoading = false;
        this.searchModels(picker.query, true);
      }
      discoveryStage = "catalog";
      const routeLists = this.loadRouteModelLists(signal, current);
      try {
        if (this.subscriptionSelected() || this.modelPickerAccess?.subscription === "ChatGPT") {
          if (!this.credentials?.listSubscriptionCatalog && !this.credentials?.listSubscriptionModels) {
            throw new Error("ChatGPT model discovery is unavailable. Restart Schway.");
          }
          const models = await this.boundedPickerTask(signal, this.loadAccountCatalog(signal));
          if (!current()) return;
          this.subscriptionModels = models.map(model => model.id);
          this.subscriptionListUnavailable = false;
          picker.catalogState = models.length ? "ready" : "empty";
          if (!models.length) picker.error = "No ChatGPT models found · Ctrl+R retry · Esc back";
        } else {
          picker.catalogState = "empty";
        }
      } finally { await routeLists; }
    } catch (error) {
      if (current()) {
        picker.accessLoading = false;
        if (discoveryStage === "access") { this.modelPickerAccess = this.unavailablePickerAccess(); this.pickerCachedAccess = undefined; }
        if (discoveryStage === "catalog") this.subscriptionListUnavailable = true;
        const message = redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 350);
        picker.catalogState = /offline|network|fetch|timeout|aborted/i.test(message) ? "offline" : "failed";
        picker.error = `${discoveryStage === "access" ? "Connections" : "Models"} unavailable · Ctrl+R retry · Esc back`;
      }
    } finally {
      if (current()) {
        picker.loading = false;
        if (!picker.error && (this.apiModelsUnavailable || this.compatibleModelsUnavailable || this.xaiModelsUnavailable || this.grokModelsUnavailable)) {
          picker.error = "Some models unavailable · Ctrl+R retry · Esc back"; picker.catalogState = "failed";
        }
        this.searchModels(picker.query, true);
      }
    }
  }

  /** Fill connected routes together so one slow list cannot consume another's deadline. */
  protected async loadRouteModelLists(signal: AbortSignal, current: () => boolean): Promise<void> {
    const load = this.credentials?.listRouteModels;
    if (!current()) return;
    const tasks: Promise<void>[] = [];
    if (load && this.modelPickerAccess?.openaiApiKey === "API key") {
      tasks.push((async () => {
        try {
          const models = await this.boundedPickerTask(signal, load("api-key", signal));
          if (current()) { this.apiModels = models; this.apiModelsUnavailable = false; }
        } catch {
          if (current()) { this.apiModels = undefined; this.apiModelsUnavailable = true; }
        }
      })());
    }
    const baseUrl = this.configEditor ? this.configEditor.standaloneEndpoint.baseUrl : this.baseUrl;
    const compatibleAccess = this.modelPickerAccess?.providers["openai-compatible"];
    if (load && baseUrl && compatibleAccess && compatibleAccess !== "Login required") {
      tasks.push((async () => {
        try {
          const models = await this.boundedPickerTask(signal, load("compatible", signal, { baseUrl, standalone: true }));
          if (current()) {
            this.compatibleModels = models;
            this.compatibleModelsUnavailable = false;
            if (isOpenRouterEndpoint(baseUrl)) this.configEditor?.setEndpointCapabilities("https://openrouter.ai/api/v1", openRouterModelCapabilities(this.compatibleModels));
          }
        } catch {
          if (current()) { this.compatibleModels = undefined; this.compatibleModelsUnavailable = true; }
        }
      })());
    }
    if (load && this.modelPickerAccess?.xaiApiKey === "API key") {
      tasks.push((async () => {
        try {
          const listed = filterXaiModels(await this.boundedPickerTask(signal, load("xai", signal)));
          if (!listed.length) throw new Error("xAI model list returned no selectable models.");
          if (!current()) return;
          this.xaiModels = listed;
          this.xaiModelsUnavailable = false;
          if (!this.grokSelected()) this.installXaiCapabilities(listed);
        } catch {
          if (current()) {
            this.xaiModels = undefined;
            this.xaiModelsUnavailable = true;
            if (!this.grokSelected()) this.clearXaiCapabilities("api-key");
          }
        }
      })());
    }
    if (this.modelPickerAccess?.grok === "Grok" && this.credentials?.listGrokModels) {
      tasks.push((async () => {
        try { const models = filterXaiModels(await this.boundedPickerTask(signal, this.credentials!.listGrokModels!(signal))); if (current()) { this.grokModels = models; this.grokModelsUnavailable = false; } }
        catch (error) { if (current()) { this.grokModels = undefined; this.grokModelsUnavailable = true; if (error instanceof Error && error.message.startsWith("Your Grok plan")) this.fail(error.message); } }
      })());
    }
    await Promise.all(tasks.map(task => task.finally(() => {
      if (current() && this.modelPicker) this.searchModels(this.modelPicker.query, true);
    })));
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
    picker.accessLoading = true;
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
    const queryChanged = !refresh && picker.query !== query;
    if (queryChanged) { this.pickerPreferredIdentity = undefined; this.pickerSelectionTouched = false; }
    const selected = picker.entries[picker.selectedIndex];
    const selectedIdentity = queryChanged ? selected?.kind === "model" ? selected.identity : undefined : this.pickerPreferredIdentity ??
      (!refresh || this.pickerSelectionTouched || selected?.active || query.trim() && selected?.kind === "model" ? selected?.identity : undefined);
    picker.query = query;
    const settings = this.configEditor?.settings;
    const endpoint = this.configEditor?.standaloneEndpoint;
    const options = {
      profiles: this.configEditor?.profiles, activeProfile: settings?.profile ?? this.profile,
      activeRoute: this.grokSelected() ? "grok" : this.model?.provider === "codex-subscription" || this.openaiAuth === "codex" ? "codex" : "api-key",
      baseUrl: endpoint ? endpoint.baseUrl : this.baseUrl, credentialIdentity: endpoint?.credentialIdentity,
      subscriptionMode: this.subscriptionSelected(), subscriptionModels: this.subscriptionModels, subscriptionCapabilities: this.subscriptionCapabilities, access: this.modelPickerAccess ?? (this.credentials ? this.unavailablePickerAccess() : undefined),
      apiModels: this.apiModels, apiModelsUnavailable: this.apiModelsUnavailable, compatibleModels: this.compatibleModels,
      compatibleModelsUnavailable: this.compatibleModelsUnavailable, subscriptionUnavailable: this.subscriptionListUnavailable,
      grokModels: this.grokModels, grokModelsUnavailable: this.grokModelsUnavailable,
      xaiModels: this.xaiModels, xaiModelsUnavailable: this.xaiModelsUnavailable,
    } satisfies NonNullable<Parameters<typeof modelPickerEntries>[4]>;
    const limits = { contextWindow: this.explicitContextWindow, maxOutput: this.explicitMaxOutput };
    const entries = modelPickerEntries(query, this.provider, this.modelId, limits, options);
    const routes = query && this.pickerPreferences.models ? modelPickerEntries("", this.provider, this.modelId, limits, options) : entries;
    picker.entries = presentModelPicker(rememberedPickerModels(entries, this.pickerPreferences.models, query, routes, limits), { query, browsing: picker.browsing, connecting: picker.connecting, ...this.pickerPreferences });
    const preferred = this.pickerPreferredRoute;
    const connectedIndex = preferred ? picker.entries.findIndex(entry => entry.kind === "model" &&
      entry.provider === preferred.provider && entry.authRoute === preferred.authRoute && entry.profile === preferred.profile) : -1;
    const identityIndex = selectedIdentity ? picker.entries.findIndex(entry => entry.kind !== "header" && entry.identity === selectedIdentity) : -1;
    if (refresh && selectedIdentity && identityIndex < 0) this.pickerPreferredIdentity = selectedIdentity;
    const activeIndex = !query && !this.pickerSelectionTouched ? picker.entries.findIndex(entry => entry.kind === "model" && entry.active) : -1;
    const firstIndex = picker.entries.findIndex(entry => entry.kind !== "header");
    picker.selectedIndex = connectedIndex >= 0 ? connectedIndex : identityIndex >= 0 ? identityIndex : refresh && selectedIdentity ? -1 : activeIndex >= 0 ? activeIndex : Math.max(0, firstIndex);
    if (connectedIndex >= 0 && !picker.loading) {
      this.pickerPreferredRoute = undefined;
      this.pickerSelectionTouched = true;
    }
    if (this.pickerPreferredIdentity && identityIndex >= 0) this.pickerPreferredIdentity = undefined;
  }

  /** Move the highlighted choice with wraparound, skipping informational route headers. */
  moveModelPicker(delta: number): void {
    const picker = this.modelPicker;
    if (!picker || this.running || !picker.entries.length || !delta) return;
    this.pickerPreferredIdentity = undefined;
    this.pickerPreferredRoute = undefined;
    this.pickerSelectionTouched = true;
    const count = picker.entries.length;
    let index = ((picker.selectedIndex + delta) % count + count) % count;
    while (picker.entries[index]?.kind === "header") index = (index + (delta > 0 ? 1 : -1) + count) % count;
    picker.selectedIndex = index;
  }

  /** Start the selected route's sign-in while retaining its query and identity. */
  protected async connectPickerRoute(selection: ModelPickerEntry): Promise<boolean> {
    const picker = this.modelPicker;
    if (!picker || !this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return false; }
    const returning = { query: picker.query, identity: selection.identity, route: { provider: selection.provider, authRoute: selection.authRoute, profile: selection.profile }, access: this.modelPickerAccess };
    this.pickerReturnView = { browsing: picker.browsing, connecting: picker.connecting };
    this.pickerReturn = returning;
    let started: boolean;
    if (selection.authRoute === "grok" || selection.authRoute === "codex") {
      started = await this.login(selection.authRoute);
      if (!started && this.pickerReturn === returning && !this.running && !this.loginChooserState) this.restorePickerAfterConnection(false);
      return started;
    }
    if (selection.profile) {
      const profile = this.configEditor?.profiles[selection.profile];
      started = !!profile && this.beginCredentialTarget({ provider: "openai-compatible", profile: selection.profile,
        baseUrl: profile.baseUrl, credentialIdentity: profile.credentialIdentity });
    } else if (selection.provider === "openai-compatible") {
      const endpoint = this.configEditor?.standaloneEndpoint ?? { baseUrl: this.baseUrl };
      started = endpoint.baseUrl ? this.beginCredentialTarget({ provider: "openai-compatible", baseUrl: endpoint.baseUrl, credentialIdentity: endpoint.credentialIdentity }) : this.beginEndpointLogin();
    } else started = this.beginLogin(selection.provider);
    if (!started) this.pickerReturn = undefined;
    return started;
  }

  /** Reopen search after a saved credential without activating a model. */
  protected restorePickerAfterConnection(connected = true): void {
    const returning = this.pickerReturn;
    this.pickerReturn = undefined;
    if (!returning || this.disposed) return;
    this.loginChooserState = undefined;
    this.openModelPicker();
    if (this.modelPicker) Object.assign(this.modelPicker, { browsing: this.pickerReturnView?.browsing, connecting: connected ? false : this.pickerReturnView?.connecting });
    this.pickerReturnView = undefined;
    if (connected) this.pickerPreferredRoute = returning.route;
    else { this.pickerPreferredIdentity = returning.identity; this.modelPickerAccess = returning.access; }
    this.searchModels(returning.query);
  }

  /** Close the picker without changing the active model or settings. */
  closeModelPicker(): void {
    this.modelCatalogAbort?.abort();
    this.modelCatalogAbort = undefined;
    this.modelPickerAccess = undefined;
    this.apiModelsUnavailable = false;
    this.compatibleModelsUnavailable = false;
    this.xaiModelsUnavailable = false;
    this.grokModelsUnavailable = false;
    this.subscriptionListUnavailable = false;
    this.modelPicker = undefined;
    this.pickerPreferredIdentity = undefined;
    this.pickerPreferredRoute = undefined;
    this.pickerSelectionTouched = false;
    if (this.recoveryRepair && this.recovery && !this.recoveryIdentityChanged(this.recovery)) this.recoveryRepair = false;
  }

  /** Return fetched list budgets for this activation; explicit config still outranks them. */
  protected listedBudgets(selection: ModelPickerEntry): { contextWindow?: number; maxOutput?: number } | undefined {
    if (selection.listUnavailable || selection.kind !== "model" || !selection.contextWindow && !selection.maxOutput) return undefined;
    return { contextWindow: selection.contextWindow, maxOutput: selection.maxOutput };
  }

  /** Stage and commit the highlighted model or profile, leaving the picker open on failure. */
  async selectPickerModel(): Promise<boolean> {
    const selection = this.modelPicker?.entries[this.modelPicker.selectedIndex];
    if (!selection || selection.kind === "header") return false;
    if (selection.kind === "browse") { this.browsePickerModels(); return true; }
    if (selection.kind === "connect") { this.connectPickerProviders(); return true; }
    if (this.modelPicker?.accessLoading) { this.notice("Checking sign-in · Wait or Esc back"); return false; }
    if (selection.kind === "sign-in") {
      return this.connectPickerRoute(selection);
    }
    let applied: boolean;
    if (selection.profile !== undefined) applied = await this.selectProfile(selection.profile);
    else if (selection.authRoute === "codex") {
      if (!selection.listUnavailable && !this.subscriptionModels?.includes(selection.modelId)) {
        this.fail("Model unavailable · Ctrl+R refresh models");
        return false;
      }
      applied = await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(selection.modelId),
        () => `Using ${this.modelId} · ChatGPT subscription · Enter send`, undefined, true);
    } else if (selection.authRoute === "grok") {
      this.installXaiCapabilities(this.grokModels ?? [], "grok");
      applied = await this.changeSettings(() => this.configEditor!.prepareGrokModel(selection.modelId), () => `Using ${this.modelId} · Grok subscription · Enter send`, undefined, true, false, this.listedBudgets(selection));
    } else if (selection.provider === "xai") {
      applied = await this.changeSettings(() => this.configEditor!.prepareXaiModel(selection.modelId),
        () => `Using ${this.modelId} · xAI API key · Enter send`, undefined, true, false, this.listedBudgets(selection));
    } else if (selection.authRoute === "api-key") {
      applied = await this.changeSettings(() => this.configEditor!.prepareOpenAIApiModel(selection.modelId),
        () => `Using ${this.modelId} · OpenAI API key · Enter send`, undefined, true, false, this.listedBudgets(selection));
    } else {
      applied = await this.selectModel(`${selection.provider}/${selection.modelId}`, this.listedBudgets(selection));
    }
    if (applied && (selection.authRoute === "codex" || selection.authRoute === "grok" || selection.authRoute === "api-key")) await this.emitModelActivated(selection);
    return applied;
  }

  /** Remember an activated route and notify consumers, retaining warnings when success notices are suppressed. */
  protected async emitModelActivated(choice: Pick<ModelPickerEntry, "provider" | "modelId" | "authRoute" | "profile">, notifySuccess = true): Promise<void> {
    if (!this.model) return;
    try {
      const settings = this.configEditor?.settings;
      const endpoint = choice.provider === "openai-compatible" ? settings?.baseUrl ?? this.baseUrl : undefined;
      const credential = choice.provider === "openai-compatible" ? settings?.credentialIdentity : undefined;
      const identity = modelPickerIdentity(choice, endpoint, credential);
      const model = { modelId: choice.modelId, groupIdentity: modelPickerIdentity({ ...choice, modelId: "" }, endpoint, credential) };
      this.pickerPreferences = this.preferenceStore()?.used(identity, model) ?? { ...this.pickerPreferences,
        models: { ...this.pickerPreferences.models, [identity]: model },
        recents: [identity, ...this.pickerPreferences.recents.filter(id => id !== identity)].slice(0, 32) };
    } catch (error) { this.notice("Recent choice not saved · Ctrl+I details", String(error)); }
    try {
      if (await this.configEditor?.rememberChoice(choice.authRoute) && notifySuccess) this.notice("Choice remembered · /model forget reset");
      this.onModelActivated?.({ provider: choice.provider, modelId: choice.modelId, authRoute: choice.authRoute,
      ...(choice.profile ? { profile: choice.profile } : {}) }); }
    catch (error) { this.notice("Choice not remembered · Enter use model · Ctrl+I details", `Model activated and usable, but its preference was not remembered. ${redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)} No additional login is needed.`); }
  }

  /** Switch the named compatible profile as one staged change, retaining previous on failure. */
  async selectProfile(name: string): Promise<boolean> {
    if (this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    const trimmed = name.trim();
    if (!trimmed) { this.fail("Usage: /model profile:<name>."); return false; }
    const applied = await this.changeSettings(() => this.configEditor!.prepareProfile(trimmed), () => {
      const active = this.configEditor!.settings.profile ?? trimmed;
      return `Profile selected · Enter send · ${active}`;
    }, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: "provider", profile: trimmed });
    return applied;
  }

  /** Forget workspace memory and expose inherited configuration even when its credentials need repair. */
  async forgetModelChoice(): Promise<boolean> {
    if (this.running || !this.configEditor || !this.stageSettings) { this.notice("Wait before resetting · Esc stop"); return false; }
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
      this.notice(`Workspace choice forgotten · ${staged.model ? "Enter send" : "Alt+L sign in · /model choose model"}`);
      return true;
    } catch (error) { this.notice("Choice not forgotten · /model forget retry · Ctrl+I details", error instanceof Error ? error.message : String(error)); return false; }
    finally { this.status = "idle"; }
  }

  /** Apply the textual model or profile form through the same atomic session settings path as the picker. */
  async selectModel(args: string, budgets?: { contextWindow?: number; maxOutput?: number }): Promise<boolean> {
    if (this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    if (["forget", "reset"].includes(args.trim())) return this.forgetModelChoice();
    const selection = parseModelArgs(args, this.provider);
    if ("error" in selection) { this.fail(selection.error); return false; }
    if (selection.profile !== undefined) {
      return this.selectProfile(selection.profile);
    }
    if (this.subscriptionSelected() && selection.provider === "openai") {
      try {
        const available = (this.modelPicker ? this.subscriptionModels : undefined) ?? (await this.loadAccountCatalog(AbortSignal.timeout(5_000))).map(model => model.id);
        if (!available?.includes(selection.modelId)) {
          this.fail(`Model unavailable: ${selection.modelId} · /model choose another`);
          return false;
        }
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    const applied = await this.changeSettings(() => selection.provider === "openai" && this.subscriptionSelected()
      ? this.configEditor!.prepareSubscriptionModel(selection.modelId)
      : selection.provider === "xai" ? this.grokSelected() ? this.configEditor!.prepareGrokModel(selection.modelId) : this.configEditor!.prepareXaiModel(selection.modelId)
      : this.configEditor!.prepareModel(selection.provider, selection.modelId),
      () => `Switched to ${this.provider}/${this.modelId} (${this.effectiveBudgets().contextWindow} ctx, ${this.describeThinking()}).`, undefined, true, false, budgets);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId,
      authRoute: this.grokSelected() ? "grok" : this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" || this.provider === "xai" ? "api-key" : "provider" });
    return applied;
  }

  /** Show or switch the reasoning level for future requests without rewriting history. */
  async thinkingCommand(args: string): Promise<boolean> {
    const selection = parseThinkingArgs(args);
    if (typeof selection === "object") { this.fail(selection.error); return false; }
    const settings = this.configEditor?.settings;
    if (this.provider === "openai-compatible" && isOpenRouterEndpoint(settings?.baseUrl ?? this.baseUrl) && selection !== "reset" && !settings?.reasoningCapability && this.credentials?.listRouteModels) {
      try {
        const models = await this.credentials.listRouteModels("compatible", AbortSignal.timeout(5_000), { baseUrl: settings?.baseUrl ?? this.baseUrl });
        this.configEditor?.setEndpointCapabilities("https://openrouter.ai/api/v1", openRouterModelCapabilities(models));
      } catch (error) { this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)); return false; }
    }
    if (this.provider === "xai" && selection !== "show" && selection !== "reset" && this.configEditor?.modelCapability(this.modelId) === undefined && (this.grokSelected() ? this.credentials?.listGrokModels : this.credentials?.listRouteModels)) {
      try {
        const models = filterXaiModels(await (this.grokSelected() ? this.credentials!.listGrokModels!(AbortSignal.timeout(5_000)) : this.credentials!.listRouteModels!("xai", AbortSignal.timeout(5_000))));
        if (!models.length) throw new Error("xAI model list returned no selectable models.");
        this.installXaiCapabilities(models, this.grokSelected() ? "grok" : "api-key");
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    if (selection !== "reset" && this.codexThinkingSelected() &&
      (this.configEditor?.settings.supportedThinking === undefined || this.model?.provider === "codex-subscription" && this.configEditor?.settings.openaiAuth !== "codex")) {
      try {
        const models = this.subscriptionCapabilities ?? await this.loadAccountCatalog(AbortSignal.timeout(5_000));
        if (!models.some(model => model.id === this.modelId)) {
          this.fail(`Model unavailable: ${this.modelId} · /model choose another`);
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
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: this.grokSelected() ? "grok" : this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" || this.provider === "xai" ? "api-key" : "provider" });
    return applied;
  }

  /** Bind the runtime route to the shared selector without reusing another model's evidence. */
  protected thinkingSelection(): ReturnType<typeof resolveThinkingSelection> {
    const settings = this.configEditor?.settings;
    const capability = settings?.provider === this.provider && settings.model === this.modelId ? settings.reasoningCapability : undefined;
    return resolveThinkingSelection({ provider: this.provider, model: this.modelId,
      openaiAuth: this.codexThinkingSelected() ? "codex" : "api-key", xaiAuth: this.grokSelected() ? "grok" : "api-key", baseUrl: settings?.baseUrl ?? this.baseUrl,
      capability, extraBody: settings?.extraBody });
  }

  /** Reuse the selected evidence for effective reasoning descriptions. */
  protected thinkingContext(): ReturnType<typeof resolveThinkingSelection>["context"] {
    return this.thinkingSelection().context;
  }

  /** Requested and effective reasoning with provider/model for truthful display. */
  describeThinking(): string {
    const requested = this.configEditor ? this.configEditor.settings.thinking : this.thinking;
    const origin = this.configEditor?.origins.thinking;
    const context = this.thinkingContext();
    const effective = describeEffectiveThinking(this.provider, requested as never, this.modelId, context);
    const supported = this.configEditor?.settings.supportedThinking;
    return `Thinking: ${requested ?? "unset"}${requested && origin ? ` [${origin}]` : ""} (effective: ${effective})${supported ? `; ${requested === undefined ? "Supported" : "supported"}: ${supported.join("/") || "none advertised"}` : ""} with ${this.provider}/${this.modelId}`;
  }

}
