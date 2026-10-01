/** Built-in provider when no config or CLI override selects one. */
export const DEFAULT_PROVIDER = "openai" as const;

/** Safety bound on model rounds per agent invocation. */
export const DEFAULT_MAX_TURNS = 32;

/** Default cap on consecutive parallel-safe tool calls. */
export const DEFAULT_MAX_CONCURRENT_TOOLS = 10;

/** Default lifetime of captured turn pre-images in days. */
export const DEFAULT_UNDO_MAX_AGE_DAYS = 30;

/** Default size limit for the undo store in MiB. */
export const DEFAULT_UNDO_MAX_SIZE_MB = 500;
