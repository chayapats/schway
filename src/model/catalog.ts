import type { ThinkingLevel } from "./model.ts";

/** Default model ID used when a provider is selected without an explicit model. */
export const DEFAULT_MODEL_IDS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  "openai-compatible": "gpt-4o",
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

/** Optional user-supplied limits that outrank catalog and unknown defaults. */
export interface ModelLimitOverrides {
  contextWindow?: number;
  maxOutput?: number;
}

const CATALOG: readonly ModelInfo[] = [
  {
    id: DEFAULT_MODEL_IDS.anthropic,
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: true,
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: true,
  },
  {
    id: DEFAULT_MODEL_IDS.openai,
    provider: "openai",
    contextWindow: 256_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: true,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: false,
  },
  {
    id: DEFAULT_MODEL_IDS["openai-compatible"],
    provider: "openai-compatible",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: false,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai-compatible",
    contextWindow: 128_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: false,
  },
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

/** Anthropic thinking-capable IDs per extended-thinking docs (numeric budgets, disabled off). */
const ANTHROPIC_THINKING_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
]);

/** OpenAI reasoning-capable IDs per reasoning guide (named effort levels, none disables). */
const OPENAI_THINKING_MODELS = new Set(["gpt-5.4"]);

/** Return supported thinking levels; unknown IDs stay usable with off as a no-op that sends no controls. */
export function getThinkingSupport(provider: string, modelId: string): ThinkingSupport {
  const known = CATALOG.some((entry) => entry.provider === provider && entry.id === modelId);
  if (provider === "anthropic" && ANTHROPIC_THINKING_MODELS.has(modelId)) {
    return { known: true, supported: ["off", "low", "medium", "high"], supportsDisabling: true };
  }
  if (provider === "openai" && OPENAI_THINKING_MODELS.has(modelId)) {
    return { known: true, supported: ["off", "low", "medium", "high"], supportsDisabling: true };
  }
  if (known) {
    return { known: true, supported: ["off"], supportsDisabling: false };
  }
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
  return `${provider}/${modelId} supports thinking off/low/medium/high. Explicit off sends the provider's documented disable control.`;
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
