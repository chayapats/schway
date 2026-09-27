import { listCatalog, lookupModel, type ModelCapability } from "../model/catalog.ts";
import type { CompatibleProfile } from "../config/config.ts";
import { parseModelArgs } from "./commands.ts";
import type { ModelAccess, ModelPickerAccess } from "./model-access.ts";

/** One selectable known or typed model with effective budgets and active state. */
export interface ModelPickerEntry {
  provider: string;
  modelId: string;
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
}

/** Renderable keyboard picker state; selectedIndex selects from the filtered entries. */
export interface ModelPickerSnapshot {
  query: string;
  selectedIndex: number;
  entries: ModelPickerEntry[];
  loading?: boolean;
  error?: string;
}

/** Build matching catalog and profile choices plus an explicit typed choice with fallback budgets. */
export function modelPickerEntries(query: string, provider: string, modelId: string, limits: { contextWindow?: number; maxOutput?: number }, options?: { profiles?: Record<string, CompatibleProfile>; activeProfile?: string; subscriptionModels?: readonly string[]; subscriptionCapabilities?: readonly ModelCapability[]; subscriptionMode?: boolean; access?: ModelPickerAccess }): ModelPickerEntry[] {
  const normalized = query.toLowerCase();
  const entries: ModelPickerEntry[] = listCatalog().filter(entry => (!options?.subscriptionMode || entry.provider !== "openai") && `${entry.provider}/${entry.id}`.toLowerCase().includes(normalized)).map(entry => ({
    provider: entry.provider, modelId: entry.id, ...budgets(entry.provider, entry.id, limits), active: entry.provider === provider && entry.id === modelId && (options?.activeProfile === undefined), custom: false,
    ...(options?.subscriptionMode ? { otherProvider: true } : {}),
  }));
  for (const id of options?.subscriptionModels ?? []) {
    if (!`openai/${id}`.toLowerCase().includes(normalized)) continue;
    const capability = options?.subscriptionCapabilities?.find(entry => entry.id === id);
    entries.push({ provider: "openai", modelId: id, ...budgets("openai", id, { contextWindow: limits.contextWindow ?? capability?.contextWindow, maxOutput: limits.maxOutput ?? capability?.maxOutput }), active: provider === "openai" && modelId === id, custom: false,
      ...(capability?.defaultThinking !== undefined ? { defaultThinking: capability.defaultThinking } : {}),
      ...(capability !== undefined ? { supportedThinking: capability.supportedThinking } : {}),
    });
  }
  const profiles = options?.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    const model = profile.model?.trim() || "gpt-4o";
    const haystacks = [`profile:${name}`, `profile ${name}`, name, `openai-compatible/${model}`];
    if (normalized.length > 0 && !haystacks.some(hay => hay.toLowerCase().includes(normalized))) {
      continue;
    }
    entries.push({
      provider: "openai-compatible",
      modelId: model,
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
  if (!("error" in selection) && selection.profile === undefined && !(options?.subscriptionMode && (!query || selection.provider === "openai")) && !entries.some(entry => entry.provider === selection.provider && entry.modelId === selection.modelId && entry.profile === undefined)) {
    entries.push({ ...selection, ...budgets(selection.provider, selection.modelId, limits), active: selection.provider === provider && selection.modelId === modelId && options?.activeProfile === undefined, custom: true,
      ...(options?.subscriptionMode ? { otherProvider: true } : {}),
    });
  }
  for (const entry of entries) {
    entry.access = entry.profile !== undefined ? options?.access?.profiles[entry.profile]
      : options?.subscriptionMode && entry.provider === "openai" ? "ChatGPT" : options?.access?.providers[entry.provider];
  }
  const rank = (entry: ModelPickerEntry): number => {
    if (entry.custom && !entry.active) return 5;
    if (entry.access === "Login required") return 4;
    if (entry.active) return 0;
    if (options?.subscriptionMode && !entry.otherProvider) return 1;
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
