import { listCatalog, lookupModel } from "../model/catalog.ts";
import type { CompatibleProfile } from "../config/config.ts";
import { parseModelArgs } from "./commands.ts";

/** One selectable known or typed model with effective budgets and active state. */
export interface ModelPickerEntry {
  provider: string;
  modelId: string;
  contextWindow: number;
  maxOutput: number;
  active: boolean;
  custom: boolean;
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
export function modelPickerEntries(query: string, provider: string, modelId: string, limits: { contextWindow?: number; maxOutput?: number }, options?: { profiles?: Record<string, CompatibleProfile>; activeProfile?: string; subscriptionModels?: readonly string[]; subscriptionMode?: boolean }): ModelPickerEntry[] {
  const normalized = query.toLowerCase();
  const entries: ModelPickerEntry[] = listCatalog().filter(entry => (!options?.subscriptionMode || entry.provider !== "openai") && `${entry.provider}/${entry.id}`.toLowerCase().includes(normalized)).map(entry => ({
    provider: entry.provider, modelId: entry.id, ...budgets(entry.provider, entry.id, limits), active: entry.provider === provider && entry.id === modelId && (options?.activeProfile === undefined), custom: false,
  }));
  for (const id of options?.subscriptionModels ?? []) {
    if (!`openai/${id}`.toLowerCase().includes(normalized)) continue;
    entries.push({ provider: "openai", modelId: id, ...budgets("openai", id, limits), active: provider === "openai" && modelId === id, custom: false });
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
    });
  }
  const selection = parseModelArgs(query || `${provider}/${modelId}`, provider);
  if (!("error" in selection) && selection.profile === undefined && !(options?.subscriptionMode && selection.provider === "openai") && !entries.some(entry => entry.provider === selection.provider && entry.modelId === selection.modelId && entry.profile === undefined)) {
    entries.push({ ...selection, ...budgets(selection.provider, selection.modelId, limits), active: selection.provider === provider && selection.modelId === modelId && options?.activeProfile === undefined, custom: true });
  }
  if (!query) entries.sort((a, b) => Number(b.active) - Number(a.active));
  return entries;
}

function budgets(provider: string, id: string, limits: { contextWindow?: number; maxOutput?: number }) {
  const info = lookupModel(provider, id, limits);
  return { contextWindow: info.contextWindow, maxOutput: info.maxOutput };
}
