import { listCatalog, lookupModel } from "../model/catalog.ts";
import { parseModelArgs } from "./commands.ts";

/** One selectable known or typed model with effective budgets and active state. */
export interface ModelPickerEntry {
  provider: string;
  modelId: string;
  contextWindow: number;
  maxOutput: number;
  active: boolean;
  custom: boolean;
}

/** Renderable keyboard picker state; selectedIndex selects from the filtered entries. */
export interface ModelPickerSnapshot {
  query: string;
  selectedIndex: number;
  entries: ModelPickerEntry[];
}

/** Build matching catalog choices and an explicit typed choice using normal model parsing and fallback budgets. */
export function modelPickerEntries(query: string, provider: string, modelId: string, limits: { contextWindow?: number; maxOutput?: number }): ModelPickerEntry[] {
  const entries = listCatalog().filter(entry => `${entry.provider}/${entry.id}`.toLowerCase().includes(query.toLowerCase())).map(entry => ({
    provider: entry.provider, modelId: entry.id, ...budgets(entry.provider, entry.id, limits), active: entry.provider === provider && entry.id === modelId, custom: false,
  }));
  const selection = parseModelArgs(query || `${provider}/${modelId}`, provider);
  if (!("error" in selection) && !entries.some(entry => entry.provider === selection.provider && entry.modelId === selection.modelId)) {
    entries.push({ ...selection, ...budgets(selection.provider, selection.modelId, limits), active: selection.provider === provider && selection.modelId === modelId, custom: true });
  }
  if (!query) entries.sort((a, b) => Number(b.active) - Number(a.active));
  return entries;
}

function budgets(provider: string, id: string, limits: { contextWindow?: number; maxOutput?: number }) {
  const info = lookupModel(provider, id, limits);
  return { contextWindow: info.contextWindow, maxOutput: info.maxOutput };
}
