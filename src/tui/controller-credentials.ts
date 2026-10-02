import { formatCount } from "../text/format.ts";
import { MaskedCredentialEntry, removeStoredCredential } from "../auth/management.ts";
import { codexSubscriptionIdentity, credentialIdentity, credentialStoreError, type CredentialIdentity, type CredentialTarget } from "../auth/store.ts";
import { credentialEnvironmentVariable } from "../auth/credentials.ts";
import { filterXaiModels, reliableListedModel, xaiModelCapabilities, type ListedModel } from "../model/model-list.ts";
import { validateThinking } from "../model/thinking.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { parseLoginTarget, LOGIN_USAGE } from "./commands.ts";
import { isValidProfileBaseUrl } from "../config/profile-name.ts";
import type { LoginChooserSnapshot } from "./controller-types.ts";
import { ControllerCore } from "./controller-core.ts";

/** Ordered payment groups define each primary sign-in action and its optional alternates. */
export const LOGIN_GROUPS = [
  { label: "Subscription", rows: [
    { id: "chatgpt", label: "ChatGPT", detail: "recommended · browser", action: { kind: "codex", device: false }, more: [
      { id: "chatgpt-device", label: "Device approval", action: { kind: "codex", device: true } },
      { id: "chatgpt-callback", label: "Paste browser callback", action: { kind: "callback" } },
    ] },
    { id: "grok", label: "Grok", detail: "browser", action: { kind: "grok", device: false }, more: [
      { id: "grok-device", label: "Device code", action: { kind: "grok", device: true } },
    ] },
  ] },
  { label: "API key", rows: [
    { id: "openai", label: "OpenAI", action: { kind: "api-key", provider: "openai" } },
    { id: "xai", label: "xAI", action: { kind: "api-key", provider: "xai" } },
  ] },
  { label: "Custom endpoint", rows: [
    { id: "compatible", label: "OpenAI-compatible", detail: "URL + key", action: { kind: "endpoint" } },
  ] },
] as const;

/** Sign-in, credential entry, logout and subscription login actions. */
export abstract class CredentialsLayer extends ControllerCore {
  /** Route login input and notify when an explicit subscription sign-in starts. */
  async login(args: string, accepted: () => void = () => {}): Promise<boolean> {
    if (!args.trim()) return this.openLoginChooser();
    this.loginReturn = undefined;
    const routed = parseLoginTarget(args);
    if ("error" in routed) {
      this.fail(routed.error);
      return false;
    }
    if (routed.kind === "grok") return this.runGrokLogin(routed, accepted);
    if (routed.kind === "codex") {
      return this.runCodexLogin(routed, accepted);
    }
    return this.beginLogin(routed.provider);
  }

  /** Show grouped sign-in choices while retaining the ordinary composer draft. */
  openLoginChooser(): boolean {
    if (this.preferences) return false;
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    this.closeModelPicker();
    this.loginReturn = undefined;
    this.loginChooserState = { level: "main", selectedId: "chatgpt" };
    return true;
  }

  /** Return ordered nonselectable headers and selectable actions for the active chooser level. */
  protected loginChooserSnapshot(): LoginChooserSnapshot | undefined {
    const state = this.loginChooserState;
    if (!state) return;
    const rows: LoginChooserSnapshot["rows"] = state.level === "main"
      ? LOGIN_GROUPS.flatMap(group => [{ kind: "group" as const, label: group.label }, ...group.rows.map(row => ({
        kind: "choice" as const, id: row.id, label: row.label, hasMore: "more" in row,
        ...("detail" in row ? { detail: row.detail } : {}),
      }))])
      : LOGIN_GROUPS[0].rows.find(row => row.id === state.level)!.more.map(row => ({ kind: "choice" as const, id: row.id, label: row.label, hasMore: false }));
    return { ...state, rows };
  }

  /** Move between selectable identities only, wrapping without starting a sign-in action. */
  moveLoginChooser(delta: number): void {
    const panel = this.loginChooserSnapshot();
    if (!panel || !this.loginChooserState) return;
    const choices = panel.rows.filter(row => row.kind === "choice");
    const index = choices.findIndex(row => row.id === panel.selectedId);
    this.loginChooserState.selectedId = choices[((index + delta) % choices.length + choices.length) % choices.length]!.id;
  }

  /** Open a subscription's alternate methods with its first action selected. */
  openLoginMoreOptions(): boolean {
    const state = this.loginChooserState;
    if (!state || state.level !== "main" || (state.selectedId !== "chatgpt" && state.selectedId !== "grok")) return false;
    this.loginChooserState = { level: state.selectedId, selectedId: `${state.selectedId}-device` };
    return true;
  }

  /** Restore the chooser origin of an entry or approval, or return a direct command to the composer. */
  protected restoreLoginOrigin(): void {
    this.loginChooserState = this.loginReturn;
    this.loginReturn = undefined;
  }

  /** Start only the selected action and remember its chooser level for cancellation. */
  async selectLoginChoice(): Promise<boolean> {
    if (this.loginSaving) { this.notice("Saving credential · Wait for secure storage"); return false; }
    const state = this.loginChooserState;
    if (!state) return false;
    const primary = LOGIN_GROUPS.flatMap<(typeof LOGIN_GROUPS)[number]["rows"][number]>(group => group.rows).find(row => row.id === state.selectedId);
    const choice = state.level === "main" ? primary : LOGIN_GROUPS[0].rows.find(row => row.id === state.level)!.more.find(row => row.id === state.selectedId);
    if (!choice) return false;
    this.loginChooserState = undefined;
    if (this.loginAbort) {
      if (this.pickerReturn) this.abortPickerLogin();
      else { this.loginAbort.abort(); await this.activeTurn; }
    }
    this.loginReturn = { ...state };
    if (choice.action.kind === "callback") { this.loginCallbackValue = ""; return true; }
    if (choice.action.kind === "endpoint") return this.beginEndpointLogin();
    if (choice.action.kind === "grok") return this.runGrokLogin({ device: choice.action.device });
    if (choice.action.kind === "codex") return this.runCodexLogin({ device: choice.action.device });
    return this.beginLogin(choice.action.provider);
  }

  /** Detach a picker-owned OAuth wait before credential saving so late callbacks cannot consume a retry or restored picker. */
  protected abortPickerLogin(): void {
    const abort = this.loginAbort;
    if (!abort || this.loginSaving) return;
    this.loginGeneration++;
    abort.abort();
    this.loginAbort = undefined;
    if (this.activeAbort === abort) this.activeAbort = undefined;
    this.activeTurn = undefined;
    this.credentialMutation = false;
    this.loginApproval = undefined;
    this.loginApprovalData = undefined;
    this.status = "idle";
  }

  /** Open ephemeral URL entry for a compatible endpoint, retaining a valid configured URL only. */
  beginEndpointLogin(): boolean {
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    if (!this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return false; }
    if (!this.configEditor || !this.stageSettings) { this.fail("Endpoint setup unavailable · Restart Schway · Alt+L sign in"); return false; }
    this.closeModelPicker();
    this.loginChooserState = undefined;
    const current = this.configEditor?.settings.baseUrl ?? this.baseUrl;
    this.endpointUrlEntry = { value: current && isValidProfileBaseUrl(current) ? current : "" };
    this.endpointInputUrl = undefined;
    return true;
  }

  /** Append URL text to the ephemeral field without entering prompt recall or conversation state. */
  enterEndpointUrlText(text: string): void {
    if (!this.endpointUrlEntry) return;
    this.endpointUrlEntry.value += text.replace(/[\r\n]+$/, "");
    this.endpointUrlEntry.error = undefined;
  }

  /** Remove one URL character and clear the field's previous validation message. */
  backspaceEndpointUrl(): void {
    if (!this.endpointUrlEntry) return;
    this.endpointUrlEntry.value = [...this.endpointUrlEntry.value].slice(0, -1).join("");
    this.endpointUrlEntry.error = undefined;
  }

  /** Validate a complete endpoint URL before opening its masked key step, without saving settings. */
  submitEndpointUrl(): boolean {
    const entry = this.endpointUrlEntry;
    if (!entry) return false;
    const value = entry.value.trim();
    let error: string | undefined;
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* The field explains malformed input below. */ }
    if (!value) error = "Enter an endpoint URL · Use http:// or https://";
    else if (!url || !["http:", "https:"].includes(url.protocol)) error = "Enter a full URL · Use http:// or https://";
    else if (url.username || url.password) error = "Remove credentials from the URL · Enter the key next";
    else if (url.href.split("#", 1)[0]!.includes("?")) error = "Remove the URL query · Enter retry";
    else if (!isValidProfileBaseUrl(value)) error = "Enter a full URL · Use http:// or https://";
    if (error) { entry.error = error; return false; }
    const baseUrl = value.split("#", 1)[0]!;
    if (!this.beginCredentialTarget({ provider: "openai-compatible", baseUrl })) return false;
    this.endpointInputUrl = entry.value;
    this.endpointUrlEntry = undefined;
    return true;
  }

  /** Append a pasted callback to masked input without entering history or a notice. */
  enterLoginCallbackText(text: string): void {
    if (this.loginCallbackValue === undefined) return;
    const value = text.replace(/[\r\n]+$/, "");
    if (/[\x00-\x1f\x7f]/.test(value) || this.loginCallbackValue.length + value.length > 16_384) {
      this.loginCallbackValue = "";
      this.fail("Invalid callback · Paste the complete redirect");
      return;
    }
    this.loginCallbackValue += value;
  }

  /** Remove one character from masked callback input. */
  backspaceLoginCallback(): void {
    if (this.loginCallbackValue !== undefined) this.loginCallbackValue = [...this.loginCallbackValue].slice(0, -1).join("");
  }

  /** Exchange the masked callback without copying it into conversation state. */
  async submitLoginCallback(): Promise<boolean> {
    const code = this.loginCallbackValue?.trim();
    if (code === undefined) return false;
    this.loginCallbackValue = undefined;
    if (!code) { this.fail("Paste the callback · Enter continue"); return false; }
    return this.runCodexLogin({ device: false, code });
  }

  /** Start masked entry for one explicit provider only while the conversation is idle. */
  beginLogin(args: string): boolean {
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    const target = this.parseCredentialTarget(args);
    if (!target || !this.credentials) return false;
    return this.beginCredentialTarget(target);
  }

  /** Open masked entry for the route identity chosen by the picker. */
  protected beginCredentialTarget(target: CredentialTarget): boolean {
    if (!this.credentials) return false;
    let identity: CredentialIdentity;
    try { identity = credentialIdentity(target); }
    catch { this.fail("Choose an endpoint · /model choose connection"); return false; }
    this.closeModelPicker();
    this.loginChooserState = undefined;
    this.credentialTarget = target;
    this.credentialEntry = new MaskedCredentialEntry({ identity, store: this.credentials.store,
      rememberSecret: key => {
        if (!this.secrets.includes(key)) this.secrets.push(key);
        this.credentials?.rememberSecret?.(key);
      },
    });
    return true;
  }

  /** Route secret text directly to the masked buffer without creating a transcript or session item. */
  enterCredentialText(text: string): void { this.credentialEntry?.insert(text); }

  /** Remove the last secret character without involving normal editor undo or recall. */
  backspaceCredential(): void { this.credentialEntry?.backspace(); }

  /** Save one key, preserving usable choices or completing first-connection activation. */
  async submitCredential(): Promise<boolean> {
    const entry = this.credentialEntry;
    const target = this.credentialTarget;
    if (!entry || !target || this.credentialMutation) return false;
    const initialConnection = this.isNotConnected();
    const endpointUrl = this.endpointInputUrl !== undefined ? target.baseUrl : undefined;
    const preserveSelection = !!this.model;
    const selectDefault = !this.modelId.trim() || !!endpointUrl || target.provider !== this.provider || target.profile !== this.profile;
    let savedNotice: string | undefined;
    this.credentialMutation = true;
    const task = (async () => {
      const result = await entry.submit();
      if (!result.ok) { this.fail("Key not saved · Alt+L retry · /model choose model", result.message); return false; }
      this.notice(result.message);
      savedNotice = this.transcript.at(-1)?.id;
      if (endpointUrl && preserveSelection) {
        await this.refreshCredentialModel(credentialIdentity(target));
        this.notice(`Sign-in saved · /config set baseUrl ${endpointUrl} to choose this endpoint · /model choose model`);
        return true;
      }
      if (endpointUrl && this.configEditor) {
        const previous = this.configEditor.settings;
        await this.resetUnsupportedEndpointThinking(endpointUrl, previous.model);
        const endpoint = await this.configEditor.prepare({ scope: "session", key: "baseUrl", value: endpointUrl });
        await endpoint.commit();
        const provider = previous.model
          ? await this.configEditor.prepareModel("openai-compatible", previous.model)
          : await this.configEditor.prepare({ scope: "session", key: "provider", value: "openai-compatible" });
        await provider.commit();
        if (!previous.model) {
          const profile = await this.configEditor.prepare({ scope: "session", key: "profile", value: null });
          await profile.commit();
        }
        this.provider = "openai-compatible";
        this.baseUrl = endpointUrl;
        this.auth = this.configEditor.settings.auth;
        this.thinking = this.configEditor.settings.thinking;
        this.profile = undefined;
        // The previous adapter may target another host; it must not survive failed activation.
        this.model = undefined;
        this.selectionGeneration += 1;
        this.notice(`Endpoint ready for this session · /config set baseUrl ${endpointUrl} --scope user to keep it`);
      }
      const source = this.credentialOverrideNotice(target);
      if (source) this.notice(source);
      if (!endpointUrl && (this.modelId.trim() || !this.stageSettings || !this.configEditor)) await this.refreshCredentialModel(credentialIdentity(target));
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    let saved: boolean;
    try { saved = await task; } finally {
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.endpointInputUrl = undefined;
      this.loginReturn = undefined;
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
    if (saved && !preserveSelection && !this.model && selectDefault) {
      const activated = await this.activateSignedInModel(target.provider === "openai" ? "api-key" : target.provider === "xai" ? "xai" : "compatible", target, initialConnection, !!endpointUrl || !!this.modelId.trim());
      // The ready empty state confirms setup; retain earlier history and credential override warnings.
      if (activated) {
        this.pickerReturn = undefined;
        if (initialConnection) this.transcript = this.transcript.filter(entry => entry.id !== savedNotice);
      }
    }
    if (this.pickerReturn) this.restorePickerAfterConnection(saved);
    return saved;
  }

  /** Clear only effort unsupported by the target endpoint/model, keeping capability evidence bound to its host. */
  private async resetUnsupportedEndpointThinking(baseUrl: string, model: string): Promise<void> {
    if (!this.configEditor) return;
    const settings = this.configEditor.settings;
    const known = this.configEditor.modelCapability(model);
    const capability = known?.baseUrl === baseUrl.replace(/\/+$/, "") ? known : undefined;
    if (!settings.thinking || !validateThinking("openai-compatible", model, settings.thinking, settings.extraBody, capability, baseUrl)) return;
    const thinking = await this.configEditor.prepare({ scope: "session", key: "thinking", value: null });
    await thinking.commit();
    this.thinking = this.configEditor.settings.thinking;
  }

  /** Select the route's recommended model after sign-in and remember it for the next interactive launch. */
  protected async activateSignedInModel(route: "api-key" | "compatible" | "xai", target: CredentialTarget, suppressSuccessNotice = false, replaceActive = false): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.configEditor || !this.stageSettings) { this.notice("Sign-in saved · /model choose model"); return false; }
    const generation = this.selectionGeneration;
    const provider = this.provider;
    const profile = this.profile;
    const listing = new AbortController();
    this.signInListAbort = listing;
    let modelId: string;
    let listed: { contextWindow?: number; maxOutput?: number } | undefined;
    try {
      const listedModels = await this.credentials?.listRouteModels?.(route, AbortSignal.any([listing.signal, AbortSignal.timeout(5_000)]), { baseUrl: target.baseUrl });
      const models = route === "xai" && listedModels ? filterXaiModels(listedModels) : listedModels;
      if (!models?.length) throw new Error("No selectable models were returned.");
      if (listing.signal.aborted || this.signInSelectionStale(generation, provider, profile, replaceActive)) return false;
      if (route === "xai") this.installXaiCapabilities(models);
      modelId = this.signedInDefault(route, models);
      const chosen = models.find(model => model.id === modelId);
      if (chosen && (chosen.contextWindow || chosen.maxOutput)) listed = { contextWindow: chosen.contextWindow, maxOutput: chosen.maxOutput };
    } catch {
      if (listing.signal.aborted || this.signInSelectionStale(generation, provider, profile, replaceActive)) return false;
      if (route === "xai") this.clearXaiCapabilities("api-key");
      this.fail("Sign-in saved · /model choose a model · Alt+L sign in");
      return false;
    } finally {
      if (this.signInListAbort === listing) this.signInListAbort = undefined;
      if (listing.signal.aborted && !this.disposed) this.notice("Activation cancelled; sign-in saved · /model choose model");
    }
    if (listing.signal.aborted || this.signInSelectionStale(generation, provider, profile, replaceActive)) return false;
    if (replaceActive && route === "compatible") {
      await this.resetUnsupportedEndpointThinking(target.baseUrl!, modelId);
      if (listing.signal.aborted || this.signInSelectionStale(generation, provider, profile, replaceActive)) return false;
    }
    const applied = await this.changeSettings(
      () => route === "api-key" ? this.configEditor!.prepareOpenAIApiModel(modelId)
        : route === "xai" ? this.configEditor!.prepareXaiModel(modelId)
        : this.configEditor!.prepareModel(target.provider, modelId, target.profile),
      () => suppressSuccessNotice ? undefined : `Signed in · Using ${target.provider}/${this.modelId} · Enter send`,
      "Sign-in saved · /model choose a model",
      true,
      false,
      listed,
    );
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId,
      authRoute: route === "compatible" ? "provider" : "api-key",
      ...(route === "compatible" && this.configEditor.settings.profile ? { profile: this.configEditor.settings.profile } : {}),
    }, !suppressSuccessNotice);
    return applied;
  }

  /** Require a reliable model default so the login flow can offer selection when none exists. */
  private signedInDefault(route: Parameters<typeof reliableListedModel>[0], models: readonly ListedModel[]): string {
    const id = reliableListedModel(route, models);
    if (id) return id;
    throw new Error("Choose a model from the available account models.");
  }

  /** True when a newer choice, disposal, or an active turn makes the pending sign-in activation unsafe. */
  private signInSelectionStale(generation: number, provider: string, profile: string | undefined, replaceActive = false): boolean {
    return this.disposed || this.running || (!replaceActive && this.modelId.trim().length > 0) || this.selectionGeneration !== generation || this.provider !== provider || this.profile !== profile;
  }

  /** Remove exactly one provider's saved credential without altering runtime or environment overrides. */
  async logout(args: string): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    const routed = parseLoginTarget(args);
    if ("error" in routed) {
      this.fail(routed.error);
      return false;
    }
    if (routed.kind === "grok") { if (routed.device) { this.fail(LOGIN_USAGE); return false; } return this.runGrokLogout(); }
    if (routed.kind === "codex") {
      if (routed.device || routed.code !== undefined) {
        this.fail("Usage: /logout codex takes no flags.");
        return false;
      }
      return this.runCodexLogout();
    }
    const target: CredentialTarget = {
      provider: routed.provider,
      baseUrl: this.configEditor?.settings.baseUrl ?? this.baseUrl,
      ...(routed.provider === "openai-compatible" && (this.configEditor?.settings.profile ?? this.profile) !== undefined
        ? { profile: this.configEditor?.settings.profile ?? this.profile }
        : {}),
      ...(routed.provider === "openai-compatible" && this.configEditor?.settings.credentialIdentity !== undefined
        ? { credentialIdentity: this.configEditor?.settings.credentialIdentity }
        : {}),
    };
    if (!this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return false; }
    this.closeModelPicker();
    this.credentialMutation = true;
    const task = (async () => {
      const result = await removeStoredCredential({ ...target, ...this.credentials!, credentialEnv: this.configEditor?.settings.credentialEnv });
      this.notice(result.message);
      if (!result.ok) { this.status = "error"; return false; }
      await this.refreshCredentialModel(credentialIdentity(target));
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  protected parseCredentialTarget(args: string): CredentialTarget | undefined {
    const provider = args.trim().toLowerCase();
    if (!["openai", "xai", "openai-compatible"].includes(provider)) {
      this.fail(LOGIN_USAGE);
      return;
    }
    if (!this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return; }
    const settings = this.configEditor?.settings;
    return {
      provider: provider as CredentialTarget["provider"],
      baseUrl: settings?.baseUrl ?? this.baseUrl,
      ...(provider === "openai-compatible" && (settings?.profile ?? this.profile) !== undefined
        ? { profile: settings?.profile ?? this.profile }
        : {}),
      ...(provider === "openai-compatible" && settings?.credentialIdentity !== undefined
        ? { credentialIdentity: settings.credentialIdentity }
        : {}),
    };
  }

  protected credentialOverrideNotice(target: CredentialTarget): string | undefined {
    if (this.credentials?.runtimeApiKey !== undefined && (this.credentials.runtimeProvider === undefined || this.credentials.runtimeProvider === target.provider)) return "The runtime --api-key override still takes precedence over the saved key.";
    const settings = this.configEditor?.settings;
    if (target.provider === "openai-compatible" && settings?.credentialEnv) {
      if (this.credentials?.env[settings.credentialEnv]?.trim()) return `${settings.credentialEnv} still takes precedence over the saved key.`;
    } else {
      const variable = credentialEnvironmentVariable(target.provider);
      if (this.credentials?.env[variable]?.trim()) return `${variable} still takes precedence over the saved key.`;
    }
    if (target.provider === "openai-compatible" && this.auth === "none") return "Automatic authentication is disabled by auth none; the saved key is not sent.";
  }

  /** Refresh only the selected API-key identity without switching its billing route. */
  protected async refreshCredentialModel(identity: CredentialIdentity): Promise<void> {
    if (this.disposed || !this.credentials) return;
    const settings = this.configEditor?.settings;
    const active = credentialIdentity({
      provider: this.provider as CredentialTarget["provider"],
      baseUrl: settings?.baseUrl ?? this.baseUrl,
      ...(this.provider === "openai-compatible" ? { profile: settings?.profile ?? this.profile } : {}),
      ...(this.provider === "openai-compatible" && settings?.credentialIdentity !== undefined
        ? { credentialIdentity: settings.credentialIdentity }
        : {}),
    });
    if (identity.account === credentialIdentity({ provider: "xai" }).account) this.clearXaiCapabilities("api-key");
    if (identity.account !== active.account || this.grokSelected() || this.model?.provider === "codex-subscription" || (!this.model && this.provider === "openai" && this.openaiAuth === "codex")) return;
    // A removed/replaced saved key must never survive in a previously constructed adapter.
    this.model = undefined;
    try {
      const loaded = await this.credentials.reload(settings ? { ...settings,
        ...(this.provider === "openai" ? { openaiAuth: "api-key" as const } : {}),
        ...(this.provider === "xai" ? { xaiAuth: "api-key" as const } : {}),
      } : undefined);
      if (this.disposed) return;
      if ("error" in loaded) { this.fail(loaded.error); return; }
      this.model = loaded.model;
      if (loaded.notice) {
        this.notice(loaded.notice);
      }
      this.status = "idle";
    } catch {
      this.fail("Connection not refreshed · /login retry");
    }
  }

  /** Install xAI list capabilities without dropping another route's verified entries. */
  protected installXaiCapabilities(models: readonly import("../model/model-list.ts").ListedModel[], authRoute: "api-key" | "grok" = "api-key"): void {
    const capabilities = xaiModelCapabilities(models, authRoute);
    this.configEditor?.replaceRouteCapabilities([], capabilities, authRoute);
  }

  /** Drop xAI route evidence after credential changes, including capabilities loaded at startup. */
  protected clearXaiCapabilities(authRoute: "api-key" | "grok"): void {
    this.configEditor?.replaceRouteCapabilities([], [], authRoute);
  }

  /** Prevent an old Grok model from applying its capability after account credentials change. */
  protected invalidateGrokAdapter(): void {
    this.clearXaiCapabilities("grok");
    this.grokModels = undefined;
    if (this.grokSelected()) { this.model = undefined; this.grokReactivationRequired = true; }
    this.grokPending = true;
  }

  /** Block an old subscription adapter and discard catalog data after a credential replacement. */
  protected invalidateSubscriptionAdapter(): void {
    if (this.model?.provider === "codex-subscription" || (!this.model && this.provider === "openai" && this.openaiAuth === "codex")) {
      this.model = undefined;
      this.subscriptionReactivationRequired = true;
      this.configEditor?.setModelCapabilities([]);
    } else {
      this.configEditor?.replaceRouteCapabilities([], [], "codex");
    }
    this.subscriptionModels = undefined;
    this.subscriptionCapabilities = undefined;
    this.subscriptionPending = true;
  }

  /** Save Grok credentials, activating only a first connection or the selected subscription. */
  protected async runGrokLogin(target: { device: boolean }, accepted: () => void = () => {}): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    const runner = this.credentials?.grokLogin;
    if (!runner) { this.fail("Grok sign-in unavailable · Restart Schway to connect"); return false; }
    const reconnectModel = this.grokSelected() ? this.modelId : undefined;
    const activate = !this.model || this.grokSelected();
    this.closeModelPicker(); this.loginChooserState = undefined;
    const abort = new AbortController(); let saved = false;
    const generation = ++this.loginGeneration;
    this.loginSaving = false;
    this.activeAbort = abort; this.loginAbort = abort; this.credentialMutation = true; this.status = "running";
    this.loginApprovalData = { kind: "browser" };
    this.loginApproval = target.device ? "Starting Grok approval · Esc cancel" : "Approve in your browser · Esc cancel";
    try { accepted(); } catch { /* Presentation cannot cancel an accepted operation. */ }
    const task = (async () => {
      try {
        const result = await runner({ device: target.device, signal: abort.signal,
          onSaving: () => { if (abort.signal.aborted || this.loginAbort !== abort || this.disposed) return; this.loginSaving = true; },
          onSaved: () => { if ((abort.signal.aborted && !this.loginSaving) || this.loginAbort !== abort || this.disposed) return; saved = true; this.invalidateGrokAdapter(); },
          onApproval: approval => { if (this.disposed || abort.signal.aborted) return; this.loginApprovalData = approval; this.loginApproval = approval.kind === "browser" ? "Approve in your browser · Esc cancel" : `Open ${approval.verificationUri.replace(/^https:\/\//, "").replace(/\/$/, "")} and enter ${approval.userCode} · Esc cancel`; },
          onProgress: message => { if (abort.signal.aborted || this.loginAbort !== abort || this.disposed) return; this.notice(redactSecrets(message, this.secrets)); if (message.startsWith("The browser could not")) this.loginChooserState = { level: "grok", selectedId: "grok-device" }; },
        });
        abort.signal.throwIfAborted(); if (this.disposed) return false;
        if (!result.ok) { this.fail(result.message); return false; }
        // Secure storage has settled; discovery is cancellable, including from the picker.
        this.loginSaving = false; this.loginAbort = undefined; this.credentialMutation = false;
        this.loginChooserState = undefined;
        if (!saved) this.invalidateGrokAdapter();
        saved = true; this.grokPending = true;
        if (!activate) { this.notice("Sign-in saved · /model choose model"); return true; }
        if (!this.credentials?.listGrokModels || !this.configEditor || !this.stageSettings) { this.notice("Sign-in saved · /model choose model"); return true; }
        const models = filterXaiModels(await this.credentials.listGrokModels(AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)])));
        abort.signal.throwIfAborted(); if (this.disposed) return false;
        this.grokModels = models; this.installXaiCapabilities(models, "grok");
        if (!models.length || reconnectModel && !models.some(model => model.id === reconnectModel)) throw new Error("Choose an available Grok model.");
        const preferred = reconnectModel || this.signedInDefault("grok", models);
        // Settings staging requires an idle controller; the abort still guards the preceding sign-in and list.
        this.activeAbort = undefined; this.loginAbort = undefined; this.credentialMutation = false; this.status = "idle";
        const applied = await this.changeSettings(() => this.configEditor!.prepareGrokModel(preferred), () => `Grok model active · ${this.modelId} · Enter send`, "Sign-in saved · /model choose model · Alt+L sign in", true);
        if (applied) { this.pickerReturn = undefined; this.grokPending = false; this.grokReactivationRequired = false; await this.emitModelActivated({ provider: "xai", modelId: this.modelId, authRoute: "grok" }); }
        return applied;
      } catch (error) {
        if (this.loginGeneration !== generation) return false;
        if (abort.signal.aborted) this.notice(saved ? "Sign-in saved; activation cancelled · /model choose model" : "Sign-in cancelled · Alt+L retry");
        else this.fail(saved ? "Models unavailable; sign-in saved · /model retry · Alt+L sign in · Ctrl+I details" : "Grok sign-in failed · Alt+L retry · /model choose model", redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
        return false;
      }
    })();
    const tracked = task.then(() => {}); this.activeTurn = tracked;
    let signedIn = false;
    try { signedIn = await task; return signedIn; }
    finally {
      if (this.loginGeneration !== generation) return false;
      this.loginSaving = false;
      this.credentialMutation = false; if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.loginAbort === abort) this.loginAbort = undefined; if (this.activeTurn === tracked) this.activeTurn = undefined;
      if (this.status === "running") this.status = "idle";
      this.loginApproval = undefined; this.loginApprovalData = undefined; this.loginReturn = undefined;
      if (this.pickerReturn && !this.disposed && (signedIn || !this.loginChooserState || abort.signal.aborted)) this.restorePickerAfterConnection(signedIn);
    }
  }

  /** Remove only Grok OAuth credentials and block the removed active account without billing fallback. */
  protected async runGrokLogout(): Promise<boolean> {
    if (!this.credentials) return false;
    this.credentialMutation = true;
    try {
      const { deleteSubscriptionTokens } = await import("../model/providers/grok-subscription.ts");
      const removed = await deleteSubscriptionTokens(this.credentials.store);
      this.notice(removed ? "Grok sign-in removed · Alt+L sign in" : "No Grok sign-in saved · Alt+L sign in");
      this.grokModels = undefined; this.grokPending = false; this.clearXaiCapabilities("grok");
      if (this.grokSelected()) { this.model = undefined; this.grokReactivationRequired = true; this.notice("Grok disconnected · Alt+L reconnect this account"); }
      return true;
    } catch { this.fail(credentialStoreError("delete")); return false; }
    finally { this.credentialMutation = false; }
  }

  /** Run the explicit ChatGPT subscription sign-in, persisting only the subscription identity on success. */
  protected async runCodexLogin(target: { device: boolean; code?: string }, accepted: () => void = () => {}): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Wait for this turn · Esc stop"); return false; }
    if (!this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return false; }
    const runner = this.credentials.codexLogin;
    if (!runner) { this.fail("ChatGPT sign-in unavailable · Restart Schway to connect"); return false; }
    const reconnectModel = this.model?.provider === "codex-subscription" || (!this.model && this.provider === "openai" && this.openaiAuth === "codex") ? this.modelId : undefined;
    const activate = !this.model || reconnectModel !== undefined;
    this.closeModelPicker();
    this.loginApproval = target.device ? "Starting device approval · Esc cancel" : "Approve in your browser · Esc cancel";
    const abort = new AbortController();
    const generation = ++this.loginGeneration;
    this.loginSaving = false;
    let credentialSaved = false;
    this.activeAbort = abort;
    this.loginAbort = abort;
    this.credentialMutation = true;
    this.status = "running";
    this.notice(target.device ? "Starting ChatGPT device sign-in · Esc cancel" : "Starting ChatGPT browser sign-in · Esc cancel");
    try { accepted(); } catch { /* Presentation cannot cancel an accepted sign-in. */ }
    const task = (async (): Promise<boolean> => {
      try {
        const result = await runner({
          device: target.device,
          ...(target.code !== undefined ? { code: target.code } : {}),
          signal: abort.signal,
          onSaving: () => { if (abort.signal.aborted || this.loginAbort !== abort || this.disposed) return; this.loginSaving = true; },
          onSaved: () => {
            if ((abort.signal.aborted && !this.loginSaving) || this.loginAbort !== abort || this.disposed) return;
            credentialSaved = true;
            this.invalidateSubscriptionAdapter();
          },
          onProgress: (message) => {
            if (abort.signal.aborted || this.loginAbort !== abort || this.disposed) return;
            if (message.startsWith("Enter this code at ")) this.loginApproval = message;
            else {
              if (message.startsWith("ChatGPT subscription (Codex OAuth):")) this.notice("Sign-in saved · /model choose model · Ctrl+I details", message);
              else if (message.startsWith("Approval received.")) this.notice("Approval received · Saving sign-in · Esc cancel");
              else this.notice(redactSecrets(message, this.secrets));
              if (message.startsWith("The browser could not be opened automatically")) this.loginChooserState = { level: "chatgpt", selectedId: "chatgpt-device" };
            }
          },
        });
        abort.signal.throwIfAborted();
        if (this.disposed || this.activeAbort !== abort) return false;
        if (!result.ok) {
          this.fail(result.message);
          if (!result.message.startsWith("Cannot save credential")) {
            this.loginChooserState = /callback|localhost|browser/i.test(result.message) ? { level: "chatgpt", selectedId: "chatgpt-device" } : { level: "main", selectedId: "chatgpt" };
          }
          return false;
        }
        this.notice("Sign-in saved · /model choose model · Ctrl+I details", result.status);
        // Test runners may omit onSaved; production also invalidates at the store commit point.
        if (!credentialSaved) this.invalidateSubscriptionAdapter();
        credentialSaved = true;
        if (!activate) { this.status = "idle"; return true; }
        if (this.configEditor && this.stageSettings && this.credentials?.listSubscriptionCatalog) {
          this.subscriptionPending = true;
          this.status = "idle";
          this.notice("Sign-in saved · Finding models · Esc cancel");
          return true;
        }
        if (!reconnectModel) {
          this.status = "idle";
          this.notice("Sign-in saved · /model activate a model");
          return true;
        }
        this.model = undefined;
        const settings = this.configEditor?.settings;
        const loaded = await this.credentials!.reload(settings ? { ...settings, openaiAuth: "codex" } : undefined);
        if (this.disposed || this.activeAbort !== abort) return false;
        if ("error" in loaded) {
          this.fail(loaded.error);
          return false;
        }
        if (loaded.model.provider !== "codex-subscription") {
          this.fail("Sign-in saved · /model choose model · Alt+L sign in");
          return false;
        }
        this.model = loaded.model;
        if (loaded.notice) {
          this.notice(loaded.notice);
        }
        this.status = "idle";
        return true;
      } catch (error) {
        if (this.loginGeneration !== generation) return false;
        if (abort.signal.aborted) {
          this.notice(credentialSaved
            ? "Sign-in cancelled; credential saved · /model choose model"
            : "Sign-in cancelled; nothing saved · Alt+L retry");
          this.status = "idle";
        } else {
          this.fail("ChatGPT sign-in failed · Alt+L retry");
          this.loginChooserState = { level: "main", selectedId: "chatgpt" };
        }
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    let signedIn: boolean;
    try { signedIn = await task; } finally {
      if (this.loginGeneration !== generation) return false;
      this.loginSaving = false;
      this.credentialMutation = false;
      if (this.loginAbort === abort) this.loginAbort = undefined;
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
      this.loginApproval = undefined;
      this.loginReturn = undefined;
    }
    if (signedIn) this.loginChooserState = undefined;
    if (!signedIn && this.pickerReturn && (!this.loginChooserState || abort.signal.aborted)) this.restorePickerAfterConnection(false);
    if (signedIn && activate && this.configEditor && this.stageSettings && this.credentials?.listSubscriptionCatalog && !this.disposed) {
      const discovery = new AbortController();
      this.activeAbort = discovery;
      this.status = "running";
      let preferred: string;
      try {
        const models = await this.loadAccountCatalog(AbortSignal.any([discovery.signal, AbortSignal.timeout(5_000)]));
        if (!models.length || reconnectModel && !models.some(model => model.id === reconnectModel)) throw new Error("Choose an available ChatGPT model.");
        preferred = reconnectModel || this.signedInDefault("codex", models);
        discovery.signal.throwIfAborted();
        this.notice(`Found ${formatCount(models.length, "model")} · Activating ${preferred} · Esc cancel`);
      } catch (error) {
        if (discovery.signal.aborted) this.notice("Activation cancelled; sign-in saved · /model retry · Ctrl+I details", this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked; retry /model." : "Previous provider is still active; retry /model.");
        else this.fail("Models unavailable; sign-in saved · /model retry · Ctrl+I details", `${this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked" : "Previous provider remains active"}; retry /model without signing in again.\n${error instanceof Error ? error.message : String(error)}`);
        if (this.activeAbort === discovery) this.activeAbort = undefined;
        if (this.pickerReturn) this.restorePickerAfterConnection();
        return false;
      } finally {
        if (this.activeAbort === discovery) this.activeAbort = undefined;
        if (this.status === "running") this.status = "idle";
      }
      const applied = await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(preferred),
        () => `ChatGPT model active · Enter send · ${this.modelId}`,
        "Model activation failed · /model retry · Alt+L sign in", true);
      if (applied) { this.pickerReturn = undefined; this.subscriptionPending = false; await this.emitModelActivated({ provider: "openai", modelId: this.modelId, authRoute: "codex" }); }
      else this.notice("Activation failed; sign-in saved · /model retry · Ctrl+I details", `${this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked" : "Previous provider remains active"}; retry /model after checking the error.`);
      if (this.pickerReturn) this.restorePickerAfterConnection();
      return applied;
    }
    if (signedIn && this.pickerReturn) this.restorePickerAfterConnection();
    return signedIn;
  }

  /** Remove only the selected subscription identity, refreshing the adapter when it served OpenAI. */
  protected async runCodexLogout(): Promise<boolean> {
    if (!this.credentials) { this.fail("Sign-in unavailable · Restart Schway to connect"); return false; }
    this.closeModelPicker();
    this.credentialMutation = true;
    const task = (async (): Promise<boolean> => {
      const wasActiveCodex = this.model?.provider === "codex-subscription" || this.openaiAuth === "codex";
      let deleted: boolean;
      try {
        deleted = await this.credentials!.store.delete(codexSubscriptionIdentity());
      } catch {
        this.fail(credentialStoreError("delete"));
        return false;
      }
      this.subscriptionPending = false;
      this.subscriptionReactivationRequired = false;
      if (deleted) {
        this.subscriptionCapabilities = undefined;
        this.subscriptionModels = undefined;
        this.configEditor?.setModelCapabilities([]);
      }
      this.notice(
        deleted
          ? "ChatGPT sign-in removed · Alt+L sign in"
          : "No ChatGPT sign-in saved · Alt+L sign in",
      );
      const overrides: string[] = [];
      if (this.credentials!.runtimeApiKey !== undefined) overrides.push("--api-key");
      if (this.credentials!.env.OPENAI_API_KEY?.trim()) overrides.push("OPENAI_API_KEY");
      if (overrides.length) this.notice(`Explicit API-key overrides remain: ${overrides.join(", ")}. They were not changed by this logout.`);
      if (wasActiveCodex) {
        this.model = undefined;
        this.subscriptionReactivationRequired = true;
        this.notice("ChatGPT disconnected · Alt+L reconnect this account");
        this.status = "idle";
        return true;
      }
      if (this.provider !== "openai") return true;
      // A removed subscription must never survive in a previously constructed adapter.
      this.model = undefined;
      try {
        const loaded = await this.credentials!.reload(this.configEditor?.settings);
        if (this.disposed) return false;
        if ("error" in loaded) {
          this.fail(loaded.error);
          return false;
        }
        this.model = loaded.model;
        if (loaded.notice) {
          this.notice(loaded.notice);
        }
        this.status = "idle";
        return true;
      } catch {
        this.fail("ChatGPT connection not refreshed · /login codex retry");
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }
}
