import { listCatalog, type ModelCapability } from "./catalog.ts";
import type { ThinkingLevel } from "./model.ts";

/** Capability outcome for a provider-independent thinking level without touching provider wire types. */
export interface ThinkingSupport {
  /** True when verified metadata establishes the model’s reasoning capability. */
  known: boolean;
  /** Levels that can be requested truthfully using this capability evidence. */
  supported: readonly ThinkingLevel[];
  /** True when explicit off sends a documented disable control; false means off leaves provider defaults untouched. */
  supportsDisabling: boolean;
}

/** Static reasoning metadata refreshed from provider docs; account catalogs still override subscription models. */
const OPENAI_THINKING: Record<string, { supported: readonly ThinkingLevel[]; supportsDisabling: boolean }> = {
  "gpt-6-sol": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-6-luna": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-6-astra": { supported: ["low", "medium", "high", "xhigh", "max"], supportsDisabling: false },
  "gpt-5.6-terra": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-5.6-luna": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-5.4": { supported: ["off", "low", "medium", "high"], supportsDisabling: true },
};

/** Return supported thinking levels; unknown IDs stay usable with off as a no-op that sends no controls. */
export function getThinkingSupport(provider: string, modelId: string): ThinkingSupport {
  const known = listCatalog().some((entry) => entry.provider === provider && entry.id === modelId);
  const thinking = provider === "openai" ? OPENAI_THINKING[modelId] : undefined;
  if (thinking) return { known: true, supported: thinking.supported, supportsDisabling: thinking.supportsDisabling };
  if (known) return { known: true, supported: ["off"], supportsDisabling: false };
  return { known: false, supported: ["off"], supportsDisabling: false };
}

/** True when the requested level can be applied truthfully for the provider/model pair. */
export function isThinkingSupported(provider: string, modelId: string, level: ThinkingLevel): boolean {
  return getThinkingSupport(provider, modelId).supported.includes(level);
}

/** Human-readable capability summary naming supported levels and disabling support for errors and disabled UI entries. */
export function describeThinkingSupport(provider: string, modelId: string): string {
  const support = getThinkingSupport(provider, modelId);
  if (!support.known) {
    return `Unknown model "${provider}/${modelId}". Reasoning support cannot be established; leave thinking unset or use off. Explicit low/medium/high would pretend a mapping applied. Explicit off sends no reasoning controls.`;
  }
  if (support.supported.length === 1) {
    return `${provider}/${modelId} does not support reasoning; only thinking "off" (provider default, no reasoning controls) is supported.`;
  }
  const levels = support.supported.join("/");
  return support.supportsDisabling
    ? `${provider}/${modelId} supports thinking ${levels}. Explicit off sends the provider's documented disable control.`
    : `${provider}/${modelId} supports thinking ${levels}. Off is not a supported level.`;
}

/** Extra-body keys treated as reasoning controls for compatible single-source-of-truth checks. */
export const COMPATIBLE_REASONING_BODY_KEYS = [
  "reasoning",
  "reasoning_effort",
  "include_reasoning",
  "reasoningEffort",
  "reasoning_budget",
  "thinking",
  "thinking_budget",
  "budget_tokens",
] as const;

/** Name the first extra-body reasoning key present, if any, for conflict errors. */
export function findCompatibleReasoningBodyKey(extraBody: Record<string, unknown> | undefined): string | undefined {
  if (!extraBody) {
    return undefined;
  }
  for (const key of COMPATIBLE_REASONING_BODY_KEYS) {
    if (extraBody[key] !== undefined) {
      return key;
    }
  }
  return undefined;
}

/** Inputs binding reasoning evidence to a selected provider, endpoint, model and auth route. */
export interface ThinkingContext {
  provider: string;
  model: string;
  baseUrl?: string;
  authRoute?: "api-key" | "grok" | "codex";
  /** Undefined uses documented public metadata; null means a required account catalog is unavailable. */
  capability?: ModelCapability | null;
}

/** Resolved policy retains evidence and distinguishes a disable control from leaving defaults untouched. */
export interface ThinkingPolicy extends ThinkingSupport {
  provenance: "documentation" | "account-catalog" | "provider-catalog" | "unknown";
  defaultThinking?: ThinkingLevel;
  mandatory?: boolean;
  error?: string;
}

/** Recognize only the documented OpenRouter API endpoint, never another compatible service. */
export function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Resolve one capability policy reused by configuration, interactive controls and provider adapters. */
export function resolveThinkingPolicy(context: ThinkingContext): ThinkingPolicy {
  if (context.capability !== undefined) {
    const capability = context.capability;
    if (!capability) return { known: false, supported: [], supportsDisabling: false, provenance: "unknown" };
    if (capability.baseUrl && (!isOpenRouterEndpoint(context.baseUrl) || context.provider !== "openai-compatible")) return { known: false, supported: [], supportsDisabling: false, provenance: "unknown", error: "Capability does not match the selected endpoint." };
    if (context.provider === "openai-compatible" && isOpenRouterEndpoint(context.baseUrl) && capability.baseUrl !== "https://openrouter.ai/api/v1") return { known: false, supported: [], supportsDisabling: false, provenance: "unknown", error: "OpenRouter reasoning requires endpoint-scoped model metadata." };
    if (capability.authRoute && context.authRoute && capability.authRoute !== context.authRoute) return { known: false, supported: [], supportsDisabling: false, provenance: "unknown", error: "Capability does not match the selected auth route." };
    if (capability.id !== context.model) return { known: false, supported: [], supportsDisabling: false, provenance: "unknown", error: "Capability does not match the selected model." };
    return { known: capability.reasoningKnown !== false, supported: capability.mandatoryThinking ? capability.supportedThinking.filter(level => level !== "off") : capability.supportedThinking, mandatory: capability.mandatoryThinking, supportsDisabling: context.provider === "openai" ? capability.supportedThinking.includes("off") : capability.supportsDisabling === true,
      provenance: capability.reasoningKnown === false ? "unknown" : capability.baseUrl ? "provider-catalog" : "account-catalog", ...(capability.defaultThinking !== undefined ? { defaultThinking: capability.defaultThinking } : {}) };
  }
  if (context.provider === "openai-compatible" && isOpenRouterEndpoint(context.baseUrl)) return { known: false, supported: [], supportsDisabling: false, provenance: "unknown" };
  const support = getThinkingSupport(context.provider, context.model);
  return { ...support, provenance: support.known ? "documentation" : "unknown",
    ...(context.provider === "openai" && ["gpt-6-luna", "gpt-6-sol"].includes(context.model) ? { defaultThinking: "medium" as const } : {}) };
}

/** Reject conflicting controls, mismatched evidence and unadvertised levels before a request is sent. */
export function validateThinking(
  provider: string,
  model: string,
  thinking: ThinkingLevel | undefined,
  extraBody?: Record<string, unknown>,
  accountCapability?: ModelCapability | null,
  baseUrl?: string,
  authRoute?: ThinkingContext["authRoute"],
): string | undefined {
  const policy = resolveThinkingPolicy({ provider, model, baseUrl, authRoute, capability: accountCapability });
  if (policy.error) return policy.error;
  if (thinking === undefined) return undefined;
  const bodyKey = provider === "openai-compatible" ? findCompatibleReasoningBodyKey(extraBody) : undefined;
  if (bodyKey !== undefined) return `thinking "${thinking}" conflicts with extraBody.${bodyKey}; remove one to define a single source of truth for reasoning.`;
  if (!policy.supported.includes(thinking)) {
    if (provider === "openai-compatible" && isOpenRouterEndpoint(baseUrl)) return `Thinking level "${thinking}" is not advertised for ${provider}/${model} in the OpenRouter model catalog. Leave thinking unset or select an advertised level.`;
    if (accountCapability !== undefined) {
      return provider === "xai"
        ? `Thinking level "${thinking}" is not listed for xai/${model} in the xAI model list. Leave thinking unset or select a listed level.`
        : `Thinking level "${thinking}" is not listed for ${provider}/${model} in this account's subscription catalog. Leave thinking unset or select an advertised level.`;
    }
    return `Thinking level "${thinking}" is not supported for ${provider}/${model}. ${describeThinkingSupport(provider, model)}${provider === "openai-compatible" ? " Configure reasoning via extraBody instead or leave thinking unset." : ""}`;
  }
}

/** Validate adapter requests with the same policy as interactive and headless configuration. */
export function assertThinking(context: ThinkingContext, thinking: ThinkingLevel | undefined, extraBody?: Record<string, unknown>): ThinkingPolicy {
  const error = validateThinking(context.provider, context.model, thinking, extraBody, context.capability, context.baseUrl, context.authRoute);
  if (error) throw new Error(error);
  return resolveThinkingPolicy(context);
}

/** Describe requested controls and advertised defaults from the same policy used to send requests. */
export function describeEffectiveThinking(provider: string, thinking: ThinkingLevel | undefined, modelId?: string,
  context: EffectiveThinkingContext = {}): string {
  return resolveEffectiveThinking(provider, thinking, modelId, context).label;
}

/** Route, endpoint and evidence inputs shared by effective-reasoning descriptions and per-turn records. */
export type EffectiveThinkingContext = { authRoute?: ThinkingContext["authRoute"]; baseUrl?: string; capability?: ModelCapability | null; extraBody?: Record<string, unknown> };

/**
 * Who chose the reasoning effort in effect: an explicit level, a Schway per-model default, the provider's own default
 * (Schway sends no control), or `extraBody` reasoning keys on a compatible endpoint.
 */
export type ThinkingSource = "explicit" | "model-default" | "provider-default" | "custom";

/** One Schway-sent default for a provider, auth route and model, applied only when every settings layer leaves thinking unset. */
export interface ModelThinkingDefault {
  provider: string;
  /** Auth route the default covers; capabilities are never transferred across routes. */
  authRoute?: ThinkingContext["authRoute"];
  /** Exact model ID, or a pattern such as `/^grok-4(\.|$)/` for a model family. */
  model: string | RegExp;
  level: ThinkingLevel;
}

/**
 * Schway-sent per-model defaults. Empty: #321 ships no default without a recorded live evaluation showing that the
 * route accepts the level and that it cuts median reasoning tokens and model time (see docs/live-providers.md).
 * A new entry also needs the adoption wiring listed under "Reasoning levels" in docs/configuration.md.
 */
export const MODEL_THINKING_DEFAULTS: readonly ModelThinkingDefault[] = [];

/** The Schway default level for this exact route and model, only when verified capability evidence lists it; otherwise undefined. */
export function resolveModelThinkingDefault(context: ThinkingContext, defaults: readonly ModelThinkingDefault[] = MODEL_THINKING_DEFAULTS): ThinkingLevel | undefined {
  const entry = defaults.find(candidate => candidate.provider === context.provider && candidate.authRoute === context.authRoute
    && (typeof candidate.model === "string" ? candidate.model === context.model : candidate.model.test(context.model)));
  // A default is sent only with a verified capability for this exact model and route that lists the level.
  if (!entry || !context.capability) return undefined;
  const policy = resolveThinkingPolicy(context);
  return !policy.error && policy.known && policy.supported.includes(entry.level) ? entry.level : undefined;
}

/** Structured effective reasoning: what Schway sends, who chose it, and the full and footer-chip wording. */
export interface EffectiveThinking {
  /** `unavailable` means the requested level is not offered, so a request would be refused before it is sent. */
  state: ThinkingSource | "unavailable";
  /** Level Schway sends; undefined when it sends no reasoning control. */
  sent?: ThinkingLevel;
  /** Provider-advertised default when Schway sends nothing; never sent by Schway. */
  advertised?: ThinkingLevel;
  /** Full description for `/thinking`, `/config` and preferences. */
  label: string;
  /** Terse footer chip text. */
  chip: string;
}

/** Resolve requested controls, a Schway model default and advertised provider defaults from the same policy used to send requests. */
export function resolveEffectiveThinking(provider: string, thinking: ThinkingLevel | undefined, modelId?: string,
  context: EffectiveThinkingContext = {}, defaults: readonly ModelThinkingDefault[] = MODEL_THINKING_DEFAULTS): EffectiveThinking {
  const full: ThinkingContext = { provider, model: modelId ?? "", ...context };
  const policy = resolveThinkingPolicy(full);
  if (thinking === undefined) {
    if (findCompatibleReasoningBodyKey(context.extraBody)) return { state: "custom", label: "Custom reasoning controls", chip: "Custom reasoning" };
    const modelDefault = resolveModelThinkingDefault(full, defaults);
    if (modelDefault) return { state: "model-default", sent: modelDefault, label: `Schway default (${modelDefault})`, chip: `Schway default (${modelDefault})` };
    const label = policy.defaultThinking ? `Provider default (${policy.defaultThinking})` : "Provider default";
    return { state: "provider-default", ...(policy.defaultThinking ? { advertised: policy.defaultThinking } : {}), label, chip: label };
  }
  if (!policy.supported.includes(thinking)) {
    return { state: "unavailable", chip: `${thinking} unavailable`,
      label: context.capability === null && provider === "openai" ? "Choose thinking · /model open choices" : `${thinking} unavailable · /model choose thinking` };
  }
  // Off without a documented disable control sends nothing, so the provider's default applies.
  if (thinking === "off" && !policy.supportsDisabling) return { state: "provider-default", label: "Provider default", chip: "Provider default" };
  return { state: "explicit", sent: thinking, label: thinking === "off" ? "Off" : thinking, chip: thinking };
}

/** Plain-data reasoning evidence for one attempt: the route-bound model and the level Schway sent, with no wire payload. */
export interface ReasoningRecord {
  /** Settings provider family, such as `openai`, `xai` or `openai-compatible`. */
  provider: string;
  model: string;
  /** Auth route of the adapter; absent for compatible endpoints. */
  route?: "api-key" | "grok" | "codex";
  /** Level sent; null when Schway sent no reasoning control. */
  level: ThinkingLevel | null;
  source: ThinkingSource;
}

/** Resolve the record for an adapter built from these inputs; undefined when the adapter would refuse the request before sending it. */
export function resolveReasoningRecord(input: Parameters<typeof resolveThinkingSelection>[0] & { thinking?: ThinkingLevel },
  defaults: readonly ModelThinkingDefault[] = MODEL_THINKING_DEFAULTS): ReasoningRecord | undefined {
  const { context } = resolveThinkingSelection(input);
  // The adapter refuses such a request before sending anything, so there is no effort to record.
  if (validateThinking(context.provider, context.model, input.thinking, context.extraBody, context.capability, context.baseUrl, context.authRoute)) return undefined;
  const effective = resolveEffectiveThinking(input.provider, input.thinking, input.model, context, defaults);
  if (effective.state === "unavailable") return undefined;
  return { provider: input.provider, model: input.model, ...(context.authRoute ? { route: context.authRoute } : {}), level: effective.sent ?? null, source: effective.state };
}

const boundReasoning = new WeakMap<object, ReasoningRecord>();

/** Attach the reasoning record an adapter was built with, returning the same adapter; undefined leaves it unbound. */
export function bindModelReasoning<T extends object>(model: T, record: ReasoningRecord | undefined): T {
  if (record) boundReasoning.set(model, { ...record });
  return model;
}

/** Bind the reasoning record implied by an adapter's construction inputs to that adapter, for per-turn history; inputs without a model ID bind nothing. */
export function bindLoaderReasoning<T extends object>(model: T, input: { provider: string; model?: string; thinking?: ThinkingLevel; openaiAuth?: string; xaiAuth?: string;
  baseUrl?: string; extraBody?: Record<string, unknown>; modelCapability?: ModelCapability }): T {
  if (!input.model?.trim()) return model;
  return bindModelReasoning(model, resolveReasoningRecord({ provider: input.provider, model: input.model.trim(), thinking: input.thinking, openaiAuth: input.openaiAuth,
    xaiAuth: input.xaiAuth, baseUrl: input.baseUrl, extraBody: input.extraBody, capability: input.modelCapability }));
}

/** Copy of the reasoning record bound to an adapter, or undefined for an adapter built without one (such as a scripted model). */
export function modelReasoning(model: object | undefined): ReasoningRecord | undefined {
  const record = model ? boundReasoning.get(model) : undefined;
  return record ? { ...record } : undefined;
}


/** Resolve route-bound evidence and valid choices once for every interactive reasoning selector. */
export function resolveThinkingSelection(input: {
  provider: string;
  model: string;
  openaiAuth?: string;
  xaiAuth?: string;
  baseUrl?: string;
  capability?: ModelCapability;
  extraBody?: Record<string, unknown>;
}): { context: ThinkingContext & { extraBody?: Record<string, unknown> }; policy: ThinkingPolicy; choices: readonly ThinkingLevel[] } {
  const listed = input.provider === "xai" || (input.provider === "openai" && input.openaiAuth === "codex")
    || (input.provider === "openai-compatible" && isOpenRouterEndpoint(input.baseUrl));
  const authRoute = input.provider === "xai" ? input.xaiAuth === "grok" || (input.xaiAuth !== "api-key" && input.capability?.authRoute === "grok") ? "grok" : "api-key" : input.provider === "openai" ? input.openaiAuth === "codex" ? "codex" : "api-key" : undefined;
  const context: ThinkingContext & { extraBody?: Record<string, unknown> } = { authRoute, provider: input.provider, model: input.model, baseUrl: input.baseUrl, extraBody: input.extraBody,
    ...(listed ? { capability: input.capability ?? null } : {}) };
  const policy = resolveThinkingPolicy(context);
  const choices = policy.supported.filter(level => !validateThinking(context.provider, context.model, level, context.extraBody, context.capability, context.baseUrl, context.authRoute));
  return { context, policy, choices };
}
