import { listCatalog, lookupModel, type ModelCapability } from "../model/catalog.ts";
import type { CompatibleProfile } from "../config/config.ts";
import { parseModelArgs } from "./commands.ts";
import type { ModelAccess, ModelPickerAccess } from "./model-access.ts";
import { createHash } from "node:crypto";

/** One selectable known or typed model with effective budgets and active state. */
export interface ModelPickerEntry {
  /** Stable route, endpoint/profile and model identity across sorting and refreshes. */
  identity: string;
  provider: string;
  modelId: string;
  authRoute: "codex" | "api-key" | "provider";
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

/** Renderable keyboard picker state; selectedIndex selects from the filtered entries. */
export interface ModelPickerSnapshot {
  query: string;
  selectedIndex: number;
  entries: ModelPickerEntry[];
  loading?: boolean;
  accessLoading?: boolean;
  error?: string;
  catalogState?: "loading" | "ready" | "empty" | "offline" | "failed";
}

/** Identify the complete selectable route without relying on a model ID or row index. */
export function modelPickerIdentity(entry: Pick<ModelPickerEntry, "provider" | "authRoute" | "profile" | "modelId">, endpoint?: string, credential?: string): string {
  return createHash("sha256").update(JSON.stringify([entry.provider, entry.authRoute, entry.profile ?? "", endpoint ?? "", credential ?? "", entry.modelId])).digest("hex");
}

/** Build matching catalog and profile choices plus an explicit typed choice with fallback budgets. */
export function modelPickerEntries(query: string, provider: string, modelId: string, limits: { contextWindow?: number; maxOutput?: number }, options?: { profiles?: Record<string, CompatibleProfile>; activeProfile?: string; subscriptionModels?: readonly string[]; subscriptionCapabilities?: readonly ModelCapability[]; subscriptionMode?: boolean; activeRoute?: "codex" | "api-key"; baseUrl?: string; credentialIdentity?: string; access?: ModelPickerAccess; apiModels?: readonly { id: string; contextWindow?: number; maxOutput?: number; supportedThinking?: readonly string[]; defaultThinking?: string }[]; apiModelsUnavailable?: boolean; compatibleModels?: readonly { id: string; contextWindow?: number; maxOutput?: number }[]; compatibleModelsUnavailable?: boolean; xaiModels?: readonly { id: string; contextWindow?: number; maxOutput?: number; supportedThinking?: readonly string[]; defaultThinking?: string }[]; xaiModelsUnavailable?: boolean; subscriptionUnavailable?: boolean }): ModelPickerEntry[] {
  const normalized = query.toLowerCase();
  const activeRoute = options?.activeRoute ?? (options?.subscriptionMode ? "codex" : "api-key");
  const matches = (family: string, id: string, route: string) => `${family}/${id} ${route}`.toLowerCase().includes(normalized);
  const staticUnavailable = (entryProvider: string) => entryProvider === "openai" ? options?.apiModelsUnavailable : entryProvider === "xai" ? options?.xaiModelsUnavailable : options?.compatibleModelsUnavailable;
  const entries: ModelPickerEntry[] = listCatalog().filter(entry => {
    if (entry.provider === "openai" && options?.apiModels) return false;
    if (entry.provider === "xai" && (options?.xaiModels || !options?.xaiModelsUnavailable)) return false;
    if (entry.provider === "openai-compatible" && options?.compatibleModels) return false;
    return matches(entry.provider, entry.id, entry.provider === "openai" || entry.provider === "xai" ? "API key" : "");
  }).map(entry => {
      const authRoute = entry.provider === "openai" || entry.provider === "xai" ? "api-key" as const : "provider" as const;
      const unavailable = staticUnavailable(entry.provider);
      const row: ModelPickerEntry = {
        identity: modelPickerIdentity({ provider: entry.provider, authRoute, modelId: entry.id }, entry.provider === "openai-compatible" ? options?.baseUrl : undefined, entry.provider === "openai-compatible" ? options?.credentialIdentity : undefined),
        provider: entry.provider, modelId: entry.id, authRoute, ...budgets(entry.provider, entry.id, limits),
        active: entry.provider === provider && entry.id === modelId && options?.activeProfile === undefined && (entry.provider !== "openai" || activeRoute === "api-key"), custom: false,
        ...(unavailable ? { listUnavailable: true } : {}),
        ...(options?.subscriptionMode ? { otherProvider: true } : {}),
      };
      return row;
    });
  for (const listed of options?.apiModels ?? []) {
    if (!matches("openai", listed.id, "API key")) continue;
    entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "api-key", modelId: listed.id }), provider: "openai", modelId: listed.id, authRoute: "api-key",
      ...budgets("openai", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "openai" && modelId === listed.id && activeRoute === "api-key" && options?.activeProfile === undefined, custom: false,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const listed of options?.xaiModels ?? []) {
    if (!matches("xai", listed.id, "API key")) continue;
    entries.push({ identity: modelPickerIdentity({ provider: "xai", authRoute: "api-key", modelId: listed.id }), provider: "xai", modelId: listed.id, authRoute: "api-key",
      ...budgets("xai", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "xai" && modelId === listed.id && options?.activeProfile === undefined, custom: false,
      ...(listed.defaultThinking !== undefined ? { defaultThinking: listed.defaultThinking } : {}),
      ...(listed.supportedThinking !== undefined ? { supportedThinking: listed.supportedThinking } : {}),
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const listed of options?.compatibleModels ?? []) {
    if (!matches("openai-compatible", listed.id, "")) continue;
    entries.push({ identity: modelPickerIdentity({ provider: "openai-compatible", authRoute: "provider", modelId: listed.id }, options?.baseUrl, options?.credentialIdentity),
      provider: "openai-compatible", modelId: listed.id, authRoute: "provider",
      ...budgets("openai-compatible", listed.id, { contextWindow: listed.contextWindow ?? limits.contextWindow, maxOutput: listed.maxOutput ?? limits.maxOutput }),
      active: provider === "openai-compatible" && modelId === listed.id && options?.activeProfile === undefined, custom: false,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}) });
  }
  for (const id of options?.subscriptionModels ?? []) {
    if (!matches("openai", id, "ChatGPT subscription connect")) continue;
    const capability = options?.subscriptionCapabilities?.find(entry => entry.id === id);
    entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: id }), provider: "openai", modelId: id, authRoute: "codex", verifiedCatalog: true,
      ...budgets("openai", id, { contextWindow: limits.contextWindow ?? capability?.contextWindow, maxOutput: limits.maxOutput ?? capability?.maxOutput }), active: provider === "openai" && modelId === id && activeRoute === "codex", custom: false,
      ...(capability?.defaultThinking !== undefined ? { defaultThinking: capability.defaultThinking } : {}),
      ...(capability !== undefined ? { supportedThinking: capability.supportedThinking } : {}),
    });
  }
  if (options?.subscriptionUnavailable && !options.subscriptionModels?.length) {
    for (const entry of listCatalog().filter(item => item.provider === "openai")) {
      if (!matches("openai", entry.id, "ChatGPT subscription list unavailable")) continue;
      entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: entry.id }), provider: "openai", modelId: entry.id, authRoute: "codex",
        ...budgets("openai", entry.id, limits), active: false, custom: false, listUnavailable: true });
    }
  }
  const profiles = options?.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    const model = profile.model?.trim() || "gpt-4o";
    const haystacks = [`profile:${name}`, `profile ${name}`, name, `openai-compatible/${model}`];
    if (normalized.length > 0 && !haystacks.some(hay => hay.toLowerCase().includes(normalized))) {
      continue;
    }
    entries.push({
      identity: modelPickerIdentity({ provider: "openai-compatible", authRoute: "provider", profile: name, modelId: model }, profile.baseUrl, profile.credentialIdentity),
      provider: "openai-compatible",
      modelId: model,
      authRoute: "provider",
      ...budgets("openai-compatible", model, {
        contextWindow: profile.contextWindow ?? limits.contextWindow,
        maxOutput: profile.maxOutput ?? limits.maxOutput,
      }),
      active: options?.activeProfile === name,
      custom: false,
      profile: name,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}),
    });
  }
  const selection = parseModelArgs(query || `${provider}/${modelId}`, provider);
  if ((!query || query.includes("/")) && !("error" in selection) && selection.profile === undefined && !entries.some(entry => entry.provider === selection.provider && entry.modelId === selection.modelId && entry.profile === undefined && entry.authRoute !== "codex")) {
    const authRoute = selection.provider === "openai" || selection.provider === "xai" ? "api-key" as const : "provider" as const;
    entries.push({ ...selection, identity: modelPickerIdentity({ ...selection, authRoute }, selection.provider === "openai-compatible" ? options?.baseUrl : undefined, selection.provider === "openai-compatible" ? options?.credentialIdentity : undefined), authRoute,
      ...budgets(selection.provider, selection.modelId, limits), active: selection.provider === provider && selection.modelId === modelId && options?.activeProfile === undefined && (selection.provider !== "openai" || activeRoute === "api-key"), custom: true,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}),
    });
  }
  for (const entry of entries) {
    entry.access = entry.profile !== undefined ? options?.access?.profiles[entry.profile]
      : entry.authRoute === "codex" ? options?.access?.subscription ?? "ChatGPT"
        : entry.authRoute === "api-key" && entry.provider === "xai" ? options?.access?.xaiApiKey ?? options?.access?.providers.xai
        : entry.authRoute === "api-key" ? options?.access?.openaiApiKey ?? options?.access?.providers.openai
          : options?.access?.providers[entry.provider];
  }
  const rank = (entry: ModelPickerEntry): number => {
    if (entry.access === "Login required") return 5;
    if (entry.active) return 0;
    if (entry.authRoute === "codex") return 1;
    if (entry.custom) return 4;
    if (!options?.subscriptionMode && entry.provider === provider && entry.profile === options?.activeProfile) return 1;
    return entry.access !== undefined ? 2 : 3;
  };
  entries.sort((a, b) => rank(a) - rank(b));
  return entries;
}

function budgets(provider: string, id: string, limits: { contextWindow?: number; maxOutput?: number }) {
  const info = lookupModel(provider, id, limits);
  return { contextWindow: info.contextWindow, maxOutput: info.maxOutput };
}
