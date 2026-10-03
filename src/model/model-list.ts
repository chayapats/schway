import { listCatalog, ROUTE_FALLBACK_MODELS, type ModelCapability } from "./catalog.ts";
import { isOpenRouterEndpoint } from "./thinking.ts";
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
  /** Reasoning metadata bound to its trusted endpoint. */
  reasoningCapability?: ModelCapability;
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
export function xaiModelCapabilities(models: readonly ListedModel[], authRoute: "api-key" | "grok" = "api-key"): ModelCapability[] {
  return models.map(model => ({
    id: model.id, authRoute,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    ...(model.defaultThinking !== undefined ? { defaultThinking: model.defaultThinking } : {}),
    supportedThinking: model.supportedThinking ?? ["off"],
    ...(model.supportedThinking?.includes("off") ? { supportsDisabling: true } : {}),
  }));
}

type ModelListRoute = "api-key" | "codex" | "compatible" | "xai" | "grok";

/** Choose a marked default, the route fallback, a catalog ID, then the first listed ID. */
export function recommendedListedModel(route: ModelListRoute, models: readonly ListedModel[]): string {
  return listedModelRecommendation(route, models).id;
}

/** Return a listed marked, known supported, or sole model; leave ambiguous and empty lists unselected. */
export function reliableListedModel(route: ModelListRoute, models: readonly ListedModel[]): string | undefined {
  const choice = listedModelRecommendation(route, models);
  return choice.reliable ? choice.id : undefined;
}

/** Apply route recommendation precedence and identify choices supported by the returned list. */
function listedModelRecommendation(route: ModelListRoute, models: readonly ListedModel[]): { id: string; reliable: boolean } {
  const marked = models.find(model => model.recommended);
  if (marked) return { id: marked.id, reliable: true };
  const provider = route === "compatible" ? "openai-compatible" : (route === "xai" || route === "grok") ? "xai" : "openai";
  const fallback = ROUTE_FALLBACK_MODELS[provider];
  if (models.some(model => model.id === fallback)) return { id: fallback, reliable: true };
  const catalog = new Set(listCatalog().filter(entry => entry.provider === provider).map(entry => entry.id));
  const known = models.find(model => catalog.has(model.id));
  if (known) return { id: known.id, reliable: true };
  return { id: models[0]?.id ?? fallback, reliable: models.length === 1 };
}

/** Route-specific selection rules applied before the usable-model capacity limit. */
export interface ModelListParseOptions { maxModels?: number; codex?: boolean; chatOnly?: "openai" | "xai" }

/** Bounded catalog data plus an honest account of discarded entries. */
export interface ModelListResult { models: ListedModel[]; warnings: string[]; partial: boolean }

/** Reject promptly on cancellation while handling late settlement of the underlying operation. */
export async function abortableCatalogOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Read at most one MiB under the caller's operation signal, cancelling a stalled reader on abort. */
export async function readModelCatalogBody(response: Response, signal: AbortSignal, label: string): Promise<Uint8Array> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} model list returned no data.`);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortableCatalogOperation(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new ModelListTooLargeError(label);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    cancel();
    signal.throwIfAborted();
    if (error instanceof ModelListTooLargeError) throw error;
    throw new Error(`Could not read the ${label} model list.`);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Fetch with one caller-owned signal and discard any response arriving after cancellation. */
export async function fetchModelCatalogResponse(input: { url: string | URL | Request; init?: RequestInit; fetch?: ModelListFetch; signal: AbortSignal; label: string }): Promise<Response> {
  input.signal.throwIfAborted();
  const request = Promise.resolve().then(() => {
    input.signal.throwIfAborted();
    return (input.fetch ?? fetch)(input.url, { ...input.init, signal: input.signal, redirect: "error" });
  }).then(response => {
    if (input.signal.aborted) { void response.body?.cancel().catch(() => {}); input.signal.throwIfAborted(); }
    return response;
  });
  try { return await abortableCatalogOperation(request, input.signal); }
  catch { input.signal.throwIfAborted(); throw new Error(`Could not reach the ${input.label} model list.`); }
}

/** Fetch a catalog under an existing total-operation deadline; no phase restarts the budget. */
export async function fetchProviderModelListResult(input: {
  url: string; apiKey?: string; headers?: Record<string, string>; fetch?: ModelListFetch; signal: AbortSignal; label: string; parseOptions?: ModelListParseOptions;
}): Promise<ModelListResult> {
  const headers = new Headers({ Accept: "application/json", ...input.headers });
  if (input.apiKey) headers.set("Authorization", `Bearer ${input.apiKey}`);
  const response = await fetchModelCatalogResponse({ ...input, init: { method: "GET", headers } });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${input.label} model list returned HTTP ${response.status}.`);
  }
  const bytes = await readModelCatalogBody(response, input.signal, input.label);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`${input.label} model list returned invalid JSON.`); }
  return parseModelListResult(payload, input.label, input.url.replace(/\/models\/?$/, ""), input.parseOptions);
}

/** Fetch and parse one route's model list with the existing five-second request ceiling. */
export async function fetchProviderModelList(input: {
  url: string; apiKey?: string; headers?: Record<string, string>; fetch?: ModelListFetch; signal?: AbortSignal; label: string;
}): Promise<ListedModel[]> {
  const deadline = AbortSignal.timeout(5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try { return (await fetchProviderModelListResult({ ...input, signal })).models; }
  catch (error) {
    if (input.signal?.aborted) throw new Error(`${input.label} model list cancelled.`);
    if (signal.aborted) throw new Error(`${input.label} model list timed out.`);
    throw error;
  }
}

/** Parse an OpenAI-style `{ data: [...] }` list or a `{ models: [...] }` list without trusting extra fields. */
export function parseModelList(payload: unknown, label: string, baseUrl?: string): ListedModel[] {
  return parseModelListResult(payload, label, baseUrl).models;
}

/** Parse validated IDs and observed metadata, reporting invalid entries and capacity loss separately from filtering. */
export function parseModelListResult(payload: unknown, label: string, baseUrl?: string, options: ModelListParseOptions = {}): ModelListResult {
  if (!payload || typeof payload !== "object") throw new Error(`${label} model list returned an invalid model list.`);
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!raw) throw new Error(`${label} model list returned an invalid model list.`);
  const marked = typeof record.default === "string" ? record.default
    : typeof record.default_model === "string" ? record.default_model
      : typeof record.recommended === "string" ? record.recommended
        : undefined;
  const models = new Map<string, ListedModel>();
  const seen = new Set<string>();
  let invalid = 0, capped = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { invalid++; continue; }
    const row = item as Record<string, unknown>;
    const id = options.codex ? typeof row.slug === "string" ? row.slug : undefined : typeof row.id === "string" ? row.id : typeof row.slug === "string" ? row.slug : undefined;
    if (row.visibility !== undefined && row.visibility !== "list") continue;
    if (options.codex && row.visibility === undefined) { invalid++; continue; }
    if (!id || !(options.codex ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ : MODEL_ID).test(id)) { invalid++; continue; }
    if (options.chatOnly === "openai" && !filterOpenAIApiKeyModels([{ id }]).length) continue;
    if (options.chatOnly === "xai" && !filterXaiModels([{ id }]).length) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (models.size >= (options.maxModels ?? MAX_PARSED_MODELS)) { capped++; continue; }
    const contextWindow = positiveInt(row.context_window ?? row.contextWindow ?? row.context_length, 10_000_000);
    const maxOutput = positiveInt(row.max_output_tokens ?? row.max_completion_tokens ?? row.maxOutput, 1_000_000);
    const supportedThinking = thinkingLevels(row.supported_reasoning_levels ?? row.supportedThinking ?? reasoningEfforts(row));
    const defaultThinking = oneThinkingLevel(row.default_reasoning_effort);
    const reasoningCapability = isOpenRouterEndpoint(baseUrl) ? openRouterCapability(id, row.reasoning) : undefined;
    models.set(id, {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(row.default === true || row.recommended === true || row.is_default === true || id === marked ? { recommended: true } : {}),
      ...(supportedThinking ? { supportedThinking } : {}),
      ...(reasoningCapability ? { reasoningCapability, supportedThinking: reasoningCapability.supportedThinking, defaultThinking: reasoningCapability.defaultThinking } : {}),
      ...(defaultThinking ? { defaultThinking } : {}),
    });
  }
  if (!models.size) throw new Error(`${label} model list returned no selectable models.`);
  const warnings: string[] = [];
  if (invalid) warnings.push(`Discarded ${invalid} invalid model ${invalid === 1 ? "entry" : "entries"}. Retry schway models list for a fresh catalog.`);
  if (capped) warnings.push(`Model list truncated at ${options.maxModels ?? MAX_PARSED_MODELS} models. Ask the provider for a smaller catalog.`);
  return { models: [...models.values()], warnings, partial: invalid > 0 || capped > 0 };
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

/** Convert verified OpenRouter model metadata into endpoint-scoped policy evidence. */
export function openRouterModelCapabilities(models: readonly ListedModel[]): ModelCapability[] {
  return models.map(model => model.reasoningCapability ?? { id: model.id, baseUrl: "https://openrouter.ai/api/v1", reasoningKnown: false, supportedThinking: [] });
}

function openRouterCapability(id: string, value: unknown): ModelCapability {
  const base = { id, baseUrl: "https://openrouter.ai/api/v1" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...base, reasoningKnown: false, supportedThinking: [] };
  const reasoning = value as Record<string, unknown>;
  const all: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const advertised = reasoning.supported_efforts === null ? all : thinkingLevels(reasoning.supported_efforts) ?? [];
  const supportedThinking = advertised.filter(level => all.includes(level) && !(reasoning.mandatory === true && level === "off"));
  const defaultThinking = reasoning.default_enabled === false && reasoning.mandatory !== true ? "off" : oneThinkingLevel(reasoning.default_effort);
  return { ...base, reasoningKnown: reasoning.supported_efforts === null || Array.isArray(reasoning.supported_efforts), mandatoryThinking: reasoning.mandatory === true, supportedThinking, supportsDisabling: supportedThinking.includes("off"),
    ...(defaultThinking && !(reasoning.mandatory === true && defaultThinking === "off") ? { defaultThinking } : {}) };
}

/** Wrap catalog-only token requests so their complete bodies obey the same deadline and response bound. */
export function boundedCatalogFetch(input: { fetch?: ModelListFetch; signal: AbortSignal; label: string }): ModelListFetch {
  return async (url, init) => {
    const response = await fetchModelCatalogResponse({ ...input, url, init });
    if (!response.ok) {
      // Refresh diagnostics use the status; ignore untrusted bodies, including HTML gateway failures.
      void response.body?.cancel().catch(() => {});
      return Response.json({}, { status: response.status });
    }
    const bytes = await readModelCatalogBody(response, input.signal, input.label);
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
}
