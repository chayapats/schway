import type { ThinkingLevel } from "./model.ts";

/**
 * Documented per-route fallback used after sign-in when the provider list names no default.
 * These are not selected before sign-in and are not a headless default.
 * OpenAI's published starting model is `gpt-6-astra` (the models list has no default field).
 * Compatible endpoints vary; `gpt-4o` is the documented fallback.
 * xAI's docs recommend `grok-4.7` for code.
 */
export const ROUTE_FALLBACK_MODELS = {
  openai: "gpt-6-astra",
  "openai-compatible": "gpt-4o",
  xai: "grok-4.7",
} as const;

/** Conservative metadata applied to model IDs absent from the built-in catalog. */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxOutput: 16_384,
  supportsTools: true,
  supportsThinking: false,
} as const;

/** Catalog metadata used for context budgeting and capability checks. */
export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsThinking: boolean;
}

/** Verified account-scoped model capabilities, independent of provider response fields. */
export interface ModelCapability {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  defaultThinking?: ThinkingLevel;
  supportedThinking: readonly ThinkingLevel[];
  /** True when the account catalog marked this model as its default. */
  recommended?: boolean;
  /** True when listed off sends the provider disable effort; absent means off sends no reasoning field. */
  supportsDisabling?: boolean;
}

/** Optional user-supplied limits that outrank catalog and unknown defaults. */
export interface ModelLimitOverrides {
  contextWindow?: number;
  maxOutput?: number;
}

const CATALOG: readonly ModelInfo[] = [
  { id: "gpt-6-astra", provider: "openai", contextWindow: 1_050_000, maxOutput: 128_000, supportsTools: true, supportsThinking: true },
  { id: "gpt-5.6-terra", provider: "openai", contextWindow: 1_050_000, maxOutput: 128_000, supportsTools: true, supportsThinking: true },
  { id: "gpt-5.6-luna", provider: "openai", contextWindow: 1_050_000, maxOutput: 128_000, supportsTools: true, supportsThinking: true },
  { id: "gpt-5.4", provider: "openai", contextWindow: 256_000, maxOutput: 16_384, supportsTools: true, supportsThinking: true },
  { id: "gpt-4.1", provider: "openai", contextWindow: 1_047_576, maxOutput: 32_768, supportsTools: true, supportsThinking: false },
  { id: "gpt-4o", provider: "openai", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true, supportsThinking: false },
  { id: "gpt-4o", provider: "openai-compatible", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true, supportsThinking: false },
  { id: "gpt-4o-mini", provider: "openai-compatible", contextWindow: 128_000, maxOutput: 16_384, supportsTools: true, supportsThinking: false },
];

/** Return the static known-model list. Unknown IDs are still usable via lookup. */
export function listCatalog(): readonly ModelInfo[] {
  return CATALOG;
}

/** Return metadata for a provider/id pair with explicit limit overrides applied last.
 * Unknown IDs receive conservative defaults; the catalog itself is unchanged.
 */
export function lookupModel(
  provider: string,
  id: string,
  overrides: ModelLimitOverrides = {},
): ModelInfo {
  const known = CATALOG.find(
    (entry) => entry.provider === provider && entry.id === id,
  );
  const base: ModelInfo = known
    ? { ...known }
    : { id, provider, ...UNKNOWN_MODEL_DEFAULTS };
  return {
    ...base,
    contextWindow: overrides.contextWindow ?? base.contextWindow,
    maxOutput: overrides.maxOutput ?? base.maxOutput,
  };
}

/** Capability outcome for a provider-independent thinking level without touching provider wire types. */
export interface ThinkingSupport {
  /** True when the provider/model pair appears in the built-in catalog. */
  known: boolean;
  /** Levels that can be requested truthfully; unknown and non-reasoning models expose only off. */
  supported: readonly ThinkingLevel[];
  /** True when explicit off sends a documented disable control; false means off leaves provider defaults untouched. */
  supportsDisabling: boolean;
}

/** Static reasoning metadata refreshed from provider docs; account catalogs still override subscription models. */
const OPENAI_THINKING: Record<string, { supported: readonly ThinkingLevel[]; supportsDisabling: boolean }> = {
  "gpt-6-astra": { supported: ["low", "medium", "high", "xhigh", "max"], supportsDisabling: false },
  "gpt-5.6-terra": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-5.6-luna": { supported: ["off", "low", "medium", "high", "xhigh", "max"], supportsDisabling: true },
  "gpt-5.4": { supported: ["off", "low", "medium", "high"], supportsDisabling: true },
};

/** Return supported thinking levels; unknown IDs stay usable with off as a no-op that sends no controls. */
export function getThinkingSupport(provider: string, modelId: string): ThinkingSupport {
  const known = CATALOG.some((entry) => entry.provider === provider && entry.id === modelId);
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
