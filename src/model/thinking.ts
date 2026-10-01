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
  context: { authRoute?: ThinkingContext["authRoute"]; baseUrl?: string; capability?: ModelCapability | null; extraBody?: Record<string, unknown> } = {}): string {
  const policy = resolveThinkingPolicy({ provider, model: modelId ?? "", ...context });
  if (thinking === undefined) {
    if (findCompatibleReasoningBodyKey(context.extraBody)) return "Custom reasoning controls";
    return policy.defaultThinking ? `Provider default (${policy.defaultThinking})` : "Provider default";
  }
  if (!policy.supported.includes(thinking)) return context.capability === null && provider === "openai" ? "Choose thinking · /model open choices" : `${thinking} unavailable · /model choose thinking`;
  if (thinking === "off") {
    if (policy.supportsDisabling) return "Off";
    return "Provider default";
  }
  return `${thinking}`;
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
