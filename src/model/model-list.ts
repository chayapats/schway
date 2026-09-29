import { listCatalog, ROUTE_FALLBACK_MODELS, type ModelCapability } from "./catalog.ts";
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
  /** Provider-reported default reasoning level, when the list names one. */
  defaultThinking?: ThinkingLevel;
}

/** Platform model list for an OpenAI API key. Subscription discovery uses a different endpoint. */
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Prefixes that mark an OpenAI API-key ID as a chat model. */
export const OPENAI_CHAT_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt-"] as const;

/** Segments that exclude an otherwise chat-prefixed OpenAI API-key ID. */
export const OPENAI_NON_CHAT_SEGMENTS = ["embedding", "whisper", "tts", "transcribe", "audio", "realtime", "image", "dall-e", "moderation", "search", "instruct", "babbage", "davinci"] as const;

/** Prefix required for an xAI ID to be offered as a chat model. */
export const XAI_CHAT_MODEL_PREFIX = "grok-";

/** Segments that exclude an otherwise chat-prefixed xAI ID. */
export const XAI_EXCLUDED_MODEL_SEGMENTS = ["image", "imagine", "video", "vision-only", "embed"] as const;

/** Maximum models kept from one parsed list; later entries are ignored rather than rejected. */
const MAX_PARSED_MODELS = 5_000;

/** Thrown when a model-list response exceeds the 1 MiB read cap. */
export class ModelListTooLargeError extends Error {
  constructor(label: string) {
    super(`${label} model list exceeds the 1 MiB limit.`);
    this.name = "ModelListTooLargeError";
  }
}

/** Keep OpenAI API-key IDs that match the chat rule or appear in the static OpenAI catalog. */
export function filterOpenAIApiKeyModels(models: readonly ListedModel[]): ListedModel[] {
  const catalog = new Set(listCatalog().filter(entry => entry.provider === "openai").map(entry => entry.id));
  return models.filter(model => catalog.has(model.id) || isOpenAIChatModelId(model.id));
}

/** Return the filtered API-key list, or fail the list when no chat model remains. */
export function requireOpenAIApiKeyModels(models: readonly ListedModel[]): ListedModel[] {
  const filtered = filterOpenAIApiKeyModels(models);
  if (!filtered.length) throw new Error("OpenAI model list returned no selectable models.");
  return filtered;
}

/** Keep xAI IDs that start with the chat prefix and contain no excluded segment. */
export function filterXaiModels(models: readonly ListedModel[]): ListedModel[] {
  return models.filter(model => model.id.startsWith(XAI_CHAT_MODEL_PREFIX)
    && !XAI_EXCLUDED_MODEL_SEGMENTS.some(segment => containsSegment(model.id, segment)));
}

/** Return the filtered xAI list, or fail the list when no chat model remains. */
export function requireXaiModels(models: readonly ListedModel[]): ListedModel[] {
  const filtered = filterXaiModels(models);
  if (!filtered.length) throw new Error("xAI model list returned no selectable models.");
  return filtered;
}

/** Turn a parsed xAI list into capabilities, offering only off when the list names no reasoning efforts. */
export function xaiModelCapabilities(models: readonly ListedModel[]): ModelCapability[] {
  return models.map(model => ({
    id: model.id,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    ...(model.defaultThinking !== undefined ? { defaultThinking: model.defaultThinking } : {}),
    supportedThinking: model.supportedThinking ?? ["off"],
    ...(model.supportedThinking?.includes("off") ? { supportsDisabling: true } : {}),
  }));
}

/** Choose a marked default, the route fallback, a catalog ID, then the first listed ID. */
export function recommendedListedModel(route: "api-key" | "codex" | "compatible" | "xai", models: readonly ListedModel[]): string {
  const marked = models.find(model => model.recommended);
  if (marked) return marked.id;
  const provider = route === "compatible" ? "openai-compatible" : route === "xai" ? "xai" : "openai";
  const fallback = ROUTE_FALLBACK_MODELS[provider];
  if (models.some(model => model.id === fallback)) return fallback;
  const catalog = new Set(listCatalog().filter(entry => entry.provider === provider).map(entry => entry.id));
  const known = models.find(model => catalog.has(model.id));
  if (known) return known.id;
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
        ...input.headers,
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
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
      if (size > 1_048_576) throw new ModelListTooLargeError(input.label);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ModelListTooLargeError) throw error;
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
  if (!raw) throw new Error(`${label} model list returned an invalid model list.`);
  const marked = typeof record.default === "string" ? record.default
    : typeof record.default_model === "string" ? record.default_model
      : typeof record.recommended === "string" ? record.recommended
        : undefined;
  const models = new Map<string, ListedModel>();
  for (const item of raw) {
    if (models.size >= MAX_PARSED_MODELS) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.slug === "string" ? row.slug : undefined;
    if (!id || !MODEL_ID.test(id) || models.has(id)) continue;
    if (row.visibility !== undefined && row.visibility !== "list") continue;
    const contextWindow = positiveInt(row.context_window ?? row.contextWindow ?? row.context_length, 10_000_000);
    const maxOutput = positiveInt(row.max_output_tokens ?? row.max_completion_tokens ?? row.maxOutput, 1_000_000);
    const supportedThinking = thinkingLevels(row.supported_reasoning_levels ?? row.supportedThinking ?? reasoningEfforts(row));
    const defaultThinking = oneThinkingLevel(row.default_reasoning_effort);
    models.set(id, {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(row.default === true || row.recommended === true || row.is_default === true || id === marked ? { recommended: true } : {}),
      ...(supportedThinking ? { supportedThinking } : {}),
      ...(defaultThinking ? { defaultThinking } : {}),
    });
  }
  if (!models.size) throw new Error(`${label} model list returned no selectable models.`);
  return [...models.values()];
}

function isOpenAIChatModelId(id: string): boolean {
  if (!OPENAI_CHAT_MODEL_PREFIXES.some(prefix => id.startsWith(prefix))) return false;
  return !OPENAI_NON_CHAT_SEGMENTS.some(segment => containsSegment(id, segment));
}

function containsSegment(id: string, segment: string): boolean {
  let from = 0;
  while (from <= id.length - segment.length) {
    const at = id.indexOf(segment, from);
    if (at < 0) return false;
    const before = at === 0 || /[^A-Za-z0-9]/.test(id[at - 1] ?? "");
    const afterIndex = at + segment.length;
    const after = afterIndex === id.length || /[^A-Za-z0-9]/.test(id[afterIndex] ?? "");
    if (before && after) return true;
    from = at + 1;
  }
  return false;
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

function reasoningEfforts(row: Record<string, unknown>): unknown {
  const capabilities = row.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  return (capabilities as Record<string, unknown>).reasoning_effort;
}

function oneThinkingLevel(value: unknown): ThinkingLevel | undefined {
  const level = value === "none" ? "off" : value;
  return THINKING_LEVELS.includes(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}
