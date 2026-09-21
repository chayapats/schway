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

/**
 * Resolve catalog metadata for a provider/id pair, filling unknown IDs with
 * conservative defaults and applying explicit limit overrides last.
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
