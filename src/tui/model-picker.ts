import { ROUTE_FALLBACK_MODELS, getThinkingSupport, listCatalog, lookupModel, type ModelCapability } from "../model/catalog.ts";
import type { CompatibleProfile } from "../config/config.ts";
import { parseModelArgs } from "./commands.ts";
import type { ModelAccess, ModelPickerAccess } from "./model-access.ts";
import { createHash } from "node:crypto";
import { fuzzyRank } from "./fuzzy.ts";
import { displayText } from "./presentation.ts";

/** Order real auth-route groups independently of connection state and the active model. */
export const MODEL_PICKER_ROUTE_GROUPS = [
  { provider: "openai", authRoute: "codex", label: "ChatGPT subscription" },
  { provider: "xai", authRoute: "grok", label: "Grok subscription" },
  { provider: "openai", authRoute: "api-key", label: "OpenAI API key" },
  { provider: "xai", authRoute: "api-key", label: "xAI API key" },
  { provider: "openai-compatible", authRoute: "provider", label: "OpenAI-compatible" },
] as const;

/** Format floored token counts with k or M suffixes and at most two decimal places for millions. */
export function formatContextWindow(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}k`;
  return `${Math.floor(tokens / 10_000) / 100}M`;
}

/** One grouped header, sign-in action or selectable model with stable identity and effective budgets. */
export interface ModelPickerEntry {
  /** Headers are informational; models and sign-in actions are selectable. */
  kind: "header" | "model" | "sign-in" | "browse" | "connect";
  /** Mark user-wide pinned models without changing their route identity. */
  favorite?: boolean;
  /** Stable auth-route and endpoint/profile identity shared by all rows in a group. */
  groupIdentity: string;
  /** Route or profile label, with only host and port for configured compatible endpoints. */
  groupLabel: string;
  /** Advertised or catalog-supported reasoning, independent of the selected effort. */
  reasoning?: boolean;
  /** Stable route, endpoint/profile and model identity across sorting and refreshes. */
  identity: string;
  provider: string;
  modelId: string;
  authRoute: "codex" | "grok" | "api-key" | "provider";
  contextWindow: number;
  maxOutput: number;
  active: boolean;
  custom: boolean;
  /** Mark non-subscription choices explicitly when a subscription is selected. */
  otherProvider?: boolean;
  /** Describe configured access without exposing credentials or promising server acceptance. */
  access?: ModelAccess;
  /** Verified subscription default, not a locally guessed effort. */
  defaultThinking?: string;
  /** Advertised account-specific thinking levels. */
  supportedThinking?: readonly string[];
  /** Named compatible profile backing this row, when the entry selects a profile. */
  profile?: string;
  /** Account catalog confirms access to this subscription model, unlike configured API keys. */
  verifiedCatalog?: boolean;
  /** Connection action shown when subscription catalog rows cannot yet be known. */
  connect?: boolean;
  /** Static catalog row shown because this route's model list could not be fetched. */
  listUnavailable?: boolean;
}

type ModelChoice = Omit<ModelPickerEntry, "kind" | "groupIdentity" | "groupLabel"> & { groupIdentity?: string };

/** Renderable keyboard picker state; selectedIndex selects from the filtered entries. */
export interface ModelPickerSnapshot {
  browsing?: boolean;
  connecting?: boolean;
  details?: boolean;
  query: string;
  selectedIndex: number;
  entries: ModelPickerEntry[];
  loading?: boolean;
  accessLoading?: boolean;
  error?: string;
  /** Redacted, bounded discovery diagnostic behind F2 while `error` shows; never part of the primary row. */
  errorDetails?: string;
  catalogState?: "loading" | "ready" | "empty" | "offline" | "failed";
}

/** True while F2 shows a discovery error's diagnostic in place of the model rows, so list keys must not act. */
export function modelPickerDiagnosticOpen(picker: Pick<ModelPickerSnapshot, "error" | "errorDetails" | "details">): boolean {
  return !!picker.error && !!picker.details && !!picker.errorDetails;
}

/**
 * Word-wrapped rows of the open error diagnostic, at most `maxRows` with `…` marking a cut, or undefined when F2 has
 * not opened one; terminal control sequences are removed so provider text cannot style the terminal.
 */
export function modelPickerErrorRows(picker: Pick<ModelPickerSnapshot, "error" | "errorDetails" | "details">, columns: number, maxRows: number): string[] | undefined {
  if (!modelPickerDiagnosticOpen(picker)) return undefined;
  const width = Math.max(1, columns), rows: string[] = [];
  const clip = (text: string, cells = width) => { let out = ""; for (const char of text) { if (Bun.stringWidth(out + char) > cells) break; out += char; } return out; };
  for (const paragraph of displayText(picker.errorDetails!).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (Bun.stringWidth(next) <= width) { line = next; continue; }
      if (line) rows.push(line);
      line = word;
      while (Bun.stringWidth(line) > width) { const head = clip(line) || [...line][0]!; rows.push(head); line = line.slice(head.length); }
    }
    rows.push(line);
  }
  if (rows.length <= maxRows) return rows;
  const kept = rows.slice(0, Math.max(1, maxRows));
  kept[kept.length - 1] = `${clip(kept.at(-1)!, width - 1)}…`;
  return kept;
}

/** Name Enter's action for the selected model, navigation row or connection target. */
export function modelPickerAction(entry?: ModelPickerEntry): "use" | "open" | "connect" {
  return entry?.kind === "model" ? "use" : entry?.kind === "sign-in" ? "connect" : "open";
}

/** Present connected choices as a small shortlist or a full searchable catalog. */
export function presentModelPicker(entries: ModelPickerEntry[], options: { query: string; browsing?: boolean; connecting?: boolean; favorites: readonly string[]; recents: readonly string[] }): ModelPickerEntry[] {
  if (options.connecting) return entries.filter(entry => entry.kind === "header" || entry.kind === "sign-in").map(entry => ({ ...entry, kind: "sign-in", identity: `sign-in:${entry.groupIdentity}` }));
  const models = [...new Map(entries.filter(entry => entry.kind === "model" && entry.access !== "Login required").map(entry => [entry.identity, { ...entry, favorite: options.favorites.includes(entry.identity) }])).values()];
  let rows = models;
  if (!options.query.trim() && !options.browsing) {
    const byId = new Map(models.map(entry => [entry.identity, entry]));
    const ordered = [...models.filter(entry => entry.active), ...options.favorites.flatMap(id => byId.get(id) ?? []), ...options.recents.flatMap(id => byId.get(id) ?? [])];
    if (!options.favorites.length && !options.recents.length) {
      const groups = new Set<string>();
      for (const entry of models) {
        if (groups.has(entry.groupIdentity)) continue;
        groups.add(entry.groupIdentity);
        const preferred = models.find(row => row.groupIdentity === entry.groupIdentity && row.modelId === ROUTE_FALLBACK_MODELS[row.provider as keyof typeof ROUTE_FALLBACK_MODELS]);
        ordered.push(preferred ?? entry);
        if (groups.size >= 3) break;
      }
    }
    rows = [...new Map(ordered.map(entry => [entry.identity, entry])).values()].slice(0, 8);
  }
  const action = (kind: "browse" | "connect", label: string): ModelPickerEntry => ({ kind, identity: kind, groupIdentity: kind, groupLabel: label, provider: "", authRoute: "provider", modelId: "", contextWindow: 0, maxOutput: 0, active: false, custom: false });
  return [...rows, ...(models.length || options.browsing || options.query ? [action("browse", options.browsing ? "Back to your models" : "Browse all models")] : []), action("connect", "Connect a provider")];
}

/** Recover remembered manual API IDs only on their exact, currently connected route. */
export function rememberedPickerModels(entries: ModelPickerEntry[], models: Record<string, { modelId: string; groupIdentity: string }> = {}, query = "", routes = entries, limits: { contextWindow?: number; maxOutput?: number } = {}): ModelPickerEntry[] {
  const result = [...entries];
  for (const [identity, saved] of Object.entries(models)) {
    if (result.some(entry => entry.identity === identity)) continue;
    if (createHash("sha256").update(JSON.stringify([saved.groupIdentity, saved.modelId])).digest("hex") !== identity) continue;
    const route = routes.find(entry => entry.groupIdentity === saved.groupIdentity && entry.kind === "header");
    // Account subscription catalogs are authoritative; do not revive removed account models.
    if (!route || route.authRoute === "codex" || route.authRoute === "grok" || [saved.modelId, modelPickerName(saved.modelId), `${route.provider}/${saved.modelId}`, route.groupLabel].every(candidate => fuzzyRank(query, candidate) === undefined)) continue;
    result.push({ ...route, ...budgets(route.provider, saved.modelId, limits), kind: "model", modelId: saved.modelId, identity, custom: true, listUnavailable: false });
  }
  return result;
}

/** Format familiar model families for reading while preserving unknown custom IDs exactly. */
export function modelPickerName(id: string): string {
  if (/^gpt-\d/.test(id)) return id.replace(/^gpt-/, "GPT-").replace(/-(astra|sol|luna|mini|nano|codex)\b/g, (_, word: string) => ` ${word[0]!.toUpperCase()}${word.slice(1)}`);
  if (/^grok-\d/.test(id)) return id.replace(/^grok-/, "Grok ").replace(/-fast\b/g, " Fast");
  return id;
}

/** Identify the complete selectable route without relying on a model ID or row index. */
export function modelPickerIdentity(entry: Pick<ModelPickerEntry, "provider" | "authRoute" | "profile" | "modelId">, endpoint?: string, credential?: string): string {
  const route = createHash("sha256").update(JSON.stringify([entry.provider, entry.authRoute, entry.profile ?? "", endpoint ?? "", credential ?? ""])).digest("hex");
  return entry.modelId ? createHash("sha256").update(JSON.stringify([route, entry.modelId])).digest("hex") : route;
}

/** Build fuzzy-matched auth-route groups in fixed order, hiding model rows until their route has configured access. */
export function modelPickerEntries(query: string, provider: string, modelId: string, limits: { contextWindow?: number; maxOutput?: number }, options?: { profiles?: Record<string, CompatibleProfile>; activeProfile?: string; activeConnection?: CompatibleProfile; activeConnectionAccess?: ModelAccess; subscriptionModels?: readonly string[]; subscriptionCapabilities?: readonly ModelCapability[]; subscriptionMode?: boolean; activeRoute?: "codex" | "grok" | "api-key"; baseUrl?: string; credentialIdentity?: string; access?: ModelPickerAccess; apiModels?: readonly { id: string; contextWindow?: number; maxOutput?: number; supportedThinking?: readonly string[]; defaultThinking?: string }[]; apiModelsUnavailable?: boolean; compatibleModels?: readonly { id: string; contextWindow?: number; maxOutput?: number; supportedThinking?: readonly string[] }[]; compatibleModelsUnavailable?: boolean; xaiModels?: readonly { id: string; contextWindow?: number; maxOutput?: number; supportedThinking?: readonly string[]; defaultThinking?: string }[]; xaiModelsUnavailable?: boolean; subscriptionUnavailable?: boolean; grokModels?: readonly import("../model/model-list.ts").ListedModel[]; grokModelsUnavailable?: boolean }): ModelPickerEntry[] {
  const activeRoute = options?.activeRoute ?? (options?.subscriptionMode ? "codex" : "api-key");
  const staticUnavailable = (entryProvider: string) => entryProvider === "openai" ? options?.apiModelsUnavailable : entryProvider === "xai" ? options?.xaiModelsUnavailable : options?.compatibleModelsUnavailable;
  const entries: ModelChoice[] = listCatalog().filter(entry => {
    if (entry.provider === "openai" && options?.apiModels) return false;
    if (entry.provider === "xai" && (options?.xaiModels || !options?.xaiModelsUnavailable)) return false;
    if (entry.provider === "openai-compatible" && options?.compatibleModels) return false;
    return true;
  }).map(entry => {
      const authRoute = entry.provider === "openai" || entry.provider === "xai" ? "api-key" as const : "provider" as const;
      const unavailable = staticUnavailable(entry.provider);
      const row: ModelChoice = {
        identity: modelPickerIdentity({ provider: entry.provider, authRoute, modelId: entry.id }, entry.provider === "openai-compatible" ? options?.baseUrl : undefined, entry.provider === "openai-compatible" ? options?.credentialIdentity : undefined),
        provider: entry.provider, modelId: entry.id, authRoute, ...budgets(entry.provider, entry.id, limits),
        active: entry.provider === provider && entry.id === modelId && options?.activeProfile === undefined && ((entry.provider !== "openai" && entry.provider !== "xai") || activeRoute === "api-key"), custom: false,
        ...(unavailable ? { listUnavailable: true } : {}),
        ...(options?.subscriptionMode ? { otherProvider: true } : {}),
      };
      return row;
    });
  for (const listed of options?.apiModels ?? []) {
    entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "api-key", modelId: listed.id }), provider: "openai", modelId: listed.id, authRoute: "api-key",
      ...budgets("openai", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "openai" && modelId === listed.id && activeRoute === "api-key" && options?.activeProfile === undefined, custom: false,
      ...(listed.supportedThinking !== undefined ? { supportedThinking: listed.supportedThinking } : {}),
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const listed of options?.xaiModels ?? []) {
    entries.push({ identity: modelPickerIdentity({ provider: "xai", authRoute: "api-key", modelId: listed.id }), provider: "xai", modelId: listed.id, authRoute: "api-key",
      ...budgets("xai", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "xai" && activeRoute === "api-key" && modelId === listed.id && options?.activeProfile === undefined, custom: false,
      ...(listed.defaultThinking !== undefined ? { defaultThinking: listed.defaultThinking } : {}),
      ...(listed.supportedThinking !== undefined ? { supportedThinking: listed.supportedThinking } : {}),
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const listed of options?.compatibleModels ?? []) {
    entries.push({ identity: modelPickerIdentity({ provider: "openai-compatible", authRoute: "provider", modelId: listed.id }, options?.baseUrl, options?.credentialIdentity),
      provider: "openai-compatible", modelId: listed.id, authRoute: "provider",
      ...budgets("openai-compatible", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "openai-compatible" && modelId === listed.id && options?.activeProfile === undefined, custom: false,
      ...(listed.supportedThinking !== undefined ? { supportedThinking: listed.supportedThinking } : {}),
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const id of options?.subscriptionModels ?? []) {
    const capability = options?.subscriptionCapabilities?.find(entry => entry.id === id);
    entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: id }), provider: "openai", modelId: id, authRoute: "codex", verifiedCatalog: true,
      ...budgets("openai", id, { contextWindow: limits.contextWindow ?? capability?.contextWindow, maxOutput: limits.maxOutput ?? capability?.maxOutput }), active: provider === "openai" && modelId === id && activeRoute === "codex", custom: false,
      ...(capability?.defaultThinking !== undefined ? { defaultThinking: capability.defaultThinking } : {}),
      ...(capability !== undefined ? { supportedThinking: capability.supportedThinking } : {}),
    });
  }
  if (options?.subscriptionUnavailable && !options.subscriptionModels?.length) {
    // The current subscription model stays listed and marked even when the account list cannot load.
    const currentSubscription = provider === "openai" && activeRoute === "codex" && modelId ? modelId : undefined;
    const fallbackIds = listCatalog().filter(item => item.provider === "openai").map(item => item.id);
    for (const id of currentSubscription && !fallbackIds.includes(currentSubscription) ? [...fallbackIds, currentSubscription] : fallbackIds) {
      entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: id }), provider: "openai", modelId: id, authRoute: "codex",
        ...budgets("openai", id, limits), active: id === currentSubscription, custom: false, listUnavailable: true });
    }
  }
  const profiles = options?.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    const activeProfile = provider === "openai-compatible" && options?.activeProfile === name;
    const connection = activeProfile ? options?.activeConnection ?? profile : profile;
    const currentIdentity = modelPickerIdentity({ provider: "openai-compatible", authRoute: "provider", profile: name, modelId }, connection.baseUrl, connection.credentialIdentity);
    const choices = [{ connection: profile, model: profile.model?.trim() || "gpt-4o" },
      ...(activeProfile && modelId ? [{ connection, model: modelId }] : [])];
    for (const { connection: target, model } of choices) {
      const choice = { provider: "openai-compatible", authRoute: "provider" as const, profile: name, modelId: model };
      const identity = modelPickerIdentity(choice, target.baseUrl, target.credentialIdentity);
      const row = { ...choice, identity,
        groupIdentity: modelPickerIdentity({ ...choice, modelId: "" }, target.baseUrl, target.credentialIdentity),
        ...budgets("openai-compatible", model, { contextWindow: target.contextWindow ?? limits.contextWindow, maxOutput: target.maxOutput ?? limits.maxOutput }),
        active: activeProfile && identity === currentIdentity,
        custom: model !== profile.model,
        ...(options?.subscriptionMode ? { otherProvider: true } : {}),
      };
      const existing = entries.findIndex(entry => entry.identity === identity);
      if (existing >= 0) entries[existing] = row;
      else entries.push(row);
    }
  }
  const grok: readonly import("../model/model-list.ts").ListedModel[] = options?.grokModels ?? (options?.grokModelsUnavailable ? [] : [{ id: ROUTE_FALLBACK_MODELS.xai }]);
  for (const listed of grok) {
    entries.push({ identity: modelPickerIdentity({ provider: "xai", authRoute: "grok", modelId: listed.id }), provider: "xai", modelId: listed.id, authRoute: "grok",
      ...budgets("xai", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }), active: provider === "xai" && modelId === listed.id && activeRoute === "grok", custom: false,
      ...(listed.supportedThinking ? { supportedThinking: listed.supportedThinking } : {}),
      ...(options?.subscriptionMode ? { otherProvider: true } : {}),
    });
  }
  const selection = parseModelArgs(query || `${provider}/${modelId}`, provider);
  if ((!query || query.includes("/")) && !("error" in selection) && selection.profile === undefined && !entries.some(entry => entry.provider === selection.provider && entry.modelId === selection.modelId && entry.profile === undefined && entry.authRoute !== "codex" && entry.authRoute !== "grok")) {
    const authRoute = selection.provider === "openai" || selection.provider === "xai" ? "api-key" as const : "provider" as const;
    entries.push({ ...selection, identity: modelPickerIdentity({ ...selection, authRoute }, selection.provider === "openai-compatible" ? options?.baseUrl : undefined, selection.provider === "openai-compatible" ? options?.credentialIdentity : undefined), authRoute,
      ...budgets(selection.provider, selection.modelId, limits), active: selection.provider === provider && selection.modelId === modelId && options?.activeProfile === undefined && ((selection.provider !== "openai" && selection.provider !== "xai") || activeRoute === "api-key"), custom: true,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}),
    });
  }
  for (const entry of entries) {
    entry.access = entry.profile !== undefined ? options?.access?.profiles[entry.profile]
      : entry.authRoute === "grok" ? options?.access?.grok ?? "Login required"
      : entry.authRoute === "codex" ? options?.access?.subscription ?? "ChatGPT"
        : entry.authRoute === "api-key" && entry.provider === "xai" ? options?.access?.xaiApiKey ?? options?.access?.providers.xai
        : entry.authRoute === "api-key" ? options?.access?.openaiApiKey ?? options?.access?.providers.openai
          : options?.access?.providers[entry.provider];
  }
  const groups: ModelPickerEntry[] = [];
  const addGroup = (provider: string, authRoute: ModelPickerEntry["authRoute"], label: string, access: ModelAccess | undefined, endpoint?: string, profile?: string, credential?: string) => {
    const groupIdentity = modelPickerIdentity({ provider, authRoute, profile, modelId: "" }, endpoint, credential);
    const common = { provider, authRoute, profile, groupIdentity, groupLabel: label,
      contextWindow: 0, maxOutput: 0, active: false, custom: false, access };
    if (access === "Login required") {
      if (fuzzyRank(query, label) !== undefined) groups.push({ ...common, kind: "sign-in", identity: `sign-in:${groupIdentity}`, modelId: "" });
      return;
    }
    const choices = entries.filter(entry => entry.provider === provider && entry.authRoute === authRoute && entry.profile === profile && (!entry.groupIdentity || entry.groupIdentity === groupIdentity));
    const matching = choices.map((entry, order) => {
      const scores = [entry.modelId, modelPickerName(entry.modelId), `${provider}/${entry.modelId}`, label].map(candidate => fuzzyRank(query, candidate))
        .filter((score): score is number => score !== undefined).map(score => score === 3 ? 2 : score === 4 ? 3 : score);
      return { entry, order, rank: scores.length ? Math.min(...scores) : undefined };
    }).filter((choice): choice is typeof choice & { rank: number } => choice.rank !== undefined);
    matching.sort((a, b) => Number(a.entry.custom) - Number(b.entry.custom) || a.rank - b.rank || a.order - b.order);
    if (!matching.length) return;
    groups.push({ ...common, kind: "header", identity: `header:${groupIdentity}`, modelId: "", listUnavailable: choices.some(entry => entry.listUnavailable) });
    for (const { entry } of matching) groups.push({ ...entry, access, kind: "model", groupIdentity, groupLabel: label,
      reasoning: !!entry.supportedThinking?.some(level => level !== "off") || getThinkingSupport(provider, entry.modelId).supported.some(level => level !== "off") });
  };
  for (const route of MODEL_PICKER_ROUTE_GROUPS) {
    const access = route.authRoute === "codex" ? options?.access?.subscription ?? (options?.subscriptionModels?.length || options?.subscriptionUnavailable ? "ChatGPT" : "Login required")
      : route.authRoute === "grok" ? options?.access?.grok ?? "Login required"
      : route.provider === "openai" ? options?.access?.openaiApiKey ?? options?.access?.providers.openai
      : route.provider === "xai" ? options?.access?.xaiApiKey ?? options?.access?.providers.xai
      : options?.access?.providers["openai-compatible"];
    if (route.provider === "openai-compatible") {
      if (options?.baseUrl) addGroup(route.provider, route.authRoute, `${route.label} · ${endpointHost(options.baseUrl)}`, access, options.baseUrl, undefined, options.credentialIdentity);
      else if (!Object.keys(profiles).length) addGroup(route.provider, route.authRoute, route.label, "Login required");
    } else addGroup(route.provider, route.authRoute, route.label, access);
  }
  for (const [name, profile] of Object.entries(profiles)) addGroup("openai-compatible", "provider", `${name} · ${endpointHost(profile.baseUrl)}`,
    options?.access?.profiles[name], profile.baseUrl, name, profile.credentialIdentity);
  if (options?.activeProfile && options.activeConnection && provider === "openai-compatible") {
    const connection = options.activeConnection;
    const identity = modelPickerIdentity({ provider, authRoute: "provider", profile: options.activeProfile, modelId: "" }, connection.baseUrl, connection.credentialIdentity);
    // Resolve the active endpoint separately even when its profile name also names a configured route.
    for (let index = groups.length - 1; index >= 0; index--) if (groups[index]!.groupIdentity === identity) groups.splice(index, 1);
    addGroup(provider, "provider", `${options.activeProfile} · ${endpointHost(connection.baseUrl)}`, options.activeConnectionAccess,
      connection.baseUrl, options.activeProfile, connection.credentialIdentity);
  }
  return groups;
}

function endpointHost(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return ""; }
}

function budgets(provider: string, id: string, limits: { contextWindow?: number; maxOutput?: number }) {
  const info = lookupModel(provider, id, limits);
  return { contextWindow: info.contextWindow, maxOutput: info.maxOutput };
}
