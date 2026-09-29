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
  /** Endpoint-scoped evidence must never be reused for another compatible service. */
  baseUrl?: string;
  /** False when a discovered model does not advertise a reasoning selector. */
  reasoningKnown?: boolean;
  /** True when the provider requires reasoning and cannot accept off. */
  mandatoryThinking?: boolean;
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
  { id: "gpt-6-sol", provider: "openai", contextWindow: 1_050_000, maxOutput: 128_000, supportsTools: true, supportsThinking: true },
  { id: "gpt-6-luna", provider: "openai", contextWindow: 1_050_000, maxOutput: 128_000, supportsTools: true, supportsThinking: true },
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

/** Compatibility exports for callers migrating to the shared reasoning policy. */
export { getThinkingSupport, isThinkingSupported, describeThinkingSupport, COMPATIBLE_REASONING_BODY_KEYS, findCompatibleReasoningBodyKey, type ThinkingSupport } from "./thinking.ts";
