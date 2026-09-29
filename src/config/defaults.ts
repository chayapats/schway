/** Built-in provider when no config or CLI override selects one. */
export const DEFAULT_PROVIDER = "openai" as const;

/** Safety bound on model rounds per agent invocation. */
export const DEFAULT_MAX_TURNS = 32;

/** Default cap on consecutive parallel-safe tool calls. */
export const DEFAULT_MAX_CONCURRENT_TOOLS = 10;
