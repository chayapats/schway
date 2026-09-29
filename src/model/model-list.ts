import { ROUTE_FALLBACK_MODELS } from "./catalog.ts";
import type { ThinkingLevel } from "./model.ts";
import { THINKING_LEVELS } from "./model.ts";

/** Optional fetch override used by protocol fixtures. */
export type ModelListFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One model returned by a route's model-list endpoint, with optional provider metadata. */
export interface ListedModel {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  /** True when the provider marked this id as its default or recommendation. */
  recommended?: boolean;
  supportedThinking?: readonly ThinkingLevel[];
}

/** Platform model list for an OpenAI API key. Subscription discovery uses a different endpoint. */
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Choose the provider's marked default, otherwise the documented per-route fallback when it was listed. */
export function recommendedListedModel(route: "api-key" | "codex" | "compatible", models: readonly ListedModel[]): string {
  const marked = models.find(model => model.recommended);
  if (marked) return marked.id;
  const fallback = route === "compatible" ? ROUTE_FALLBACK_MODELS["openai-compatible"] : ROUTE_FALLBACK_MODELS.openai;
  if (models.some(model => model.id === fallback)) return fallback;
  return models[0]?.id ?? fallback;
}

/** Fetch and parse one route's model list. Throws when the endpoint cannot be read; callers show static fallback. */
export async function fetchProviderModelList(input: {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: ModelListFetch;
  signal?: AbortSignal;
  label: string;
}): Promise<ListedModel[]> {
  const deadline = AbortSignal.timeout(5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(input.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...input.headers,
      },
      redirect: "error",
      signal,
    });
  } catch {
    if (input.signal?.aborted) throw new Error(`${input.label} model list cancelled.`);
    if (signal.aborted) throw new Error(`${input.label} model list timed out.`);
    throw new Error(`Could not reach the ${input.label} model list.`);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${input.label} model list returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${input.label} model list returned no data.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new Error(`${input.label} model list exceeds the 1 MiB limit.`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.includes("1 MiB")) throw error;
    throw new Error(`Could not read the ${input.label} model list.`);
  }
  let payload: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${input.label} model list returned invalid JSON.`);
  }
  return parseModelList(payload, input.label);
}

/** Parse an OpenAI-style `{ data: [...] }` list or a `{ models: [...] }` list without trusting extra fields. */
export function parseModelList(payload: unknown, label: string): ListedModel[] {
  if (!payload || typeof payload !== "object") throw new Error(`${label} model list returned an invalid model list.`);
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!raw || raw.length > 256) throw new Error(`${label} model list returned an invalid model list.`);
  const marked = typeof record.default === "string" ? record.default
    : typeof record.default_model === "string" ? record.default_model
      : typeof record.recommended === "string" ? record.recommended
        : undefined;
  const models = new Map<string, ListedModel>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.slug === "string" ? row.slug : undefined;
    if (!id || !MODEL_ID.test(id) || models.has(id)) continue;
    if (row.visibility !== undefined && row.visibility !== "list") continue;
    const contextWindow = positiveInt(row.context_window ?? row.contextWindow, 10_000_000);
    const maxOutput = positiveInt(row.max_output_tokens ?? row.max_completion_tokens ?? row.maxOutput, 1_000_000);
    const supportedThinking = thinkingLevels(row.supported_reasoning_levels ?? row.supportedThinking);
    models.set(id, {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(row.default === true || row.recommended === true || row.is_default === true || id === marked ? { recommended: true } : {}),
      ...(supportedThinking ? { supportedThinking } : {}),
    });
  }
  if (!models.size) throw new Error(`${label} model list returned no selectable models.`);
  return [...models.values()];
}

function positiveInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;
}

function thinkingLevels(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = [...new Set(value.map(entry => {
    const effort = entry && typeof entry === "object" && "effort" in entry ? entry.effort : entry;
    const level = effort === "none" ? "off" : effort;
    return THINKING_LEVELS.includes(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
  }).filter((level): level is ThinkingLevel => level !== undefined))];
  return levels.length ? levels : undefined;
}
