import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MODEL_IDS,
  lookupModel,
  type ModelInfo,
} from "../model/catalog.ts";
import {
  DEFAULT_MAX_CONCURRENT_TOOLS,
  DEFAULT_MAX_TURNS,
  DEFAULT_PROVIDER,
} from "./defaults.ts";

/** First-party config keys. Unknown names are rejected rather than ignored. */
export const CONFIG_SETTING_NAMES = [
  "provider",
  "model",
  "maxTurns",
  "maxConcurrentTools",
  "contextWindow",
  "maxOutput",
  "baseUrl",
  "headers",
  "extraBody",
  "auth",
] as const;

const ProviderSchema = Type.Union([
  Type.Literal("anthropic"),
  Type.Literal("openai"),
  Type.Literal("openai-compatible"),
]);

const AuthSchema = Type.Union([
  Type.Literal("required"),
  Type.Literal("optional"),
  Type.Literal("none"),
]);

const PositiveInt = Type.Integer({ minimum: 1 });

/** TypeBox schema for one config.json object. Additional properties are errors. */
export const ConfigSchema = Type.Object(
  {
    provider: Type.Optional(ProviderSchema),
    model: Type.Optional(Type.String({ minLength: 1 })),
    maxTurns: Type.Optional(PositiveInt),
    maxConcurrentTools: Type.Optional(PositiveInt),
    contextWindow: Type.Optional(PositiveInt),
    maxOutput: Type.Optional(PositiveInt),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    auth: Type.Optional(AuthSchema),
  },
  { additionalProperties: false },
);

/** One overlay of first-party settings from defaults, a file, or the CLI. */
export type ConfigLayer = Static<typeof ConfigSchema>;

/** Built-in provider families selectable from config and the CLI. */
export type ProviderFamily = NonNullable<ConfigLayer["provider"]>;

/** Authentication mode for OpenAI-compatible endpoints. */
export type AuthMode = NonNullable<ConfigLayer["auth"]>;

/** Fully resolved runtime settings after precedence and catalog lookup. */
export interface ResolvedSettings {
  provider: ProviderFamily;
  model: string;
  maxTurns: number;
  maxConcurrentTools: number;
  contextWindow: number;
  maxOutput: number;
  catalog: ModelInfo;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: AuthMode;
}

/** Lowest-precedence settings. Files and CLI override these; nothing writes them. */
export const BUILTIN_DEFAULTS: ConfigLayer = {
  provider: DEFAULT_PROVIDER,
  maxTurns: DEFAULT_MAX_TURNS,
  maxConcurrentTools: DEFAULT_MAX_CONCURRENT_TOOLS,
};

const SECRET_KEY_ALIASES = new Set([
  "apikey",
  "anthropicapikey",
  "openaiapikey",
  "token",
  "secret",
  "credentials",
]);

/** User-global config path: `~/.schway/config.json`. */
export function userConfigPath(home: string): string {
  return join(home, ".schway", "config.json");
}

/** Project config path: `<workspaceRoot>/.schway/config.json`. */
export function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".schway", "config.json");
}

/** Validate a parsed JSON value as a config layer and name the source in errors. */
export function parseConfigObject(
  value: unknown,
  source: string,
): ConfigLayer | { error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: `Invalid config at ${source}: expected a JSON object` };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const secretKey = keys.find((key) =>
    SECRET_KEY_ALIASES.has(normalizeKey(key)),
  );
  if (secretKey !== undefined) {
    return {
      error: `API keys must not be stored in ${source}. Use --api-key or environment variables.`,
    };
  }

  const known = new Set<string>(CONFIG_SETTING_NAMES);
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return {
      error: `Invalid config at ${source}: unknown setting "${unknown[0]}". Valid settings: ${CONFIG_SETTING_NAMES.join(", ")}`,
    };
  }

  if (!Value.Check(ConfigSchema, value)) {
    const errors = [...Value.Errors(ConfigSchema, value)]
      .map((entry) => formatSchemaError(entry.path, entry.message))
      .join("; ");
    return {
      error: `Invalid config at ${source}: ${errors || "failed validation"}`,
    };
  }

  return normalizeLayer(value);
}

/** Later layers replace earlier values for the same key. Undefined layers are skipped. */
export function mergeConfigLayers(
  ...layers: Array<ConfigLayer | undefined>
): ConfigLayer {
  const merged: ConfigLayer = {};
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    for (const key of CONFIG_SETTING_NAMES) {
      const value = layer[key];
      if (value !== undefined) {
        (merged[key] as typeof value) = value;
      }
    }
  }
  return merged;
}

/**
 * Merge built-in defaults, optional file layers, and CLI overrides, then fill
 * catalog metadata. Does not create configuration files.
 */
export function resolveSettings(input: {
  user?: ConfigLayer;
  project?: ConfigLayer;
  cli?: ConfigLayer;
}): ResolvedSettings | { error: string } {
  const merged = mergeConfigLayers(
    BUILTIN_DEFAULTS,
    input.user,
    input.project,
    input.cli,
  );
  const provider = merged.provider ?? DEFAULT_PROVIDER;
  const model = merged.model?.trim() || DEFAULT_MODEL_IDS[provider];
  const catalog = lookupModel(provider, model, {
    contextWindow: merged.contextWindow,
    maxOutput: merged.maxOutput,
  });

  const resolved: ResolvedSettings = {
    provider,
    model,
    maxTurns: merged.maxTurns ?? DEFAULT_MAX_TURNS,
    maxConcurrentTools:
      merged.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
    contextWindow: catalog.contextWindow,
    maxOutput: catalog.maxOutput,
    catalog,
  };

  if (provider !== "openai-compatible") {
    return resolved;
  }

  const baseUrl = merged.baseUrl?.trim() ?? "";
  if (baseUrl.length === 0) {
    return {
      error:
        "Missing --base-url for OpenAI-compatible provider. Set baseUrl in config or pass --base-url.",
    };
  }
  return {
    ...resolved,
    baseUrl,
    headers: merged.headers,
    extraBody: merged.extraBody,
    auth: merged.auth ?? "optional",
  };
}

/** Read user-global and project config files, then resolve settings. */
export async function loadResolvedSettings(input: {
  home: string;
  workspaceRoot: string;
  cli?: ConfigLayer;
}): Promise<ResolvedSettings | { error: string }> {
  const user = await readConfigFile(userConfigPath(input.home));
  if (user && "error" in user) {
    return user;
  }
  const project = await readConfigFile(projectConfigPath(input.workspaceRoot));
  if (project && "error" in project) {
    return project;
  }
  return resolveSettings({
    user,
    project,
    cli: input.cli,
  });
}

/** Read one config.json. Missing files are skipped; invalid files are errors. */
export async function readConfigFile(
  path: string,
): Promise<ConfigLayer | { error: string } | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    return {
      error: `Unable to read config ${path}: ${errorMessage(error)}`,
    };
  }
  if (text.trim().length === 0) {
    return { error: `Invalid config at ${path}: expected a JSON object` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `Invalid config at ${path}: malformed JSON` };
  }
  return parseConfigObject(parsed, path);
}

/** Trim string fields after schema validation. */
function normalizeLayer(layer: ConfigLayer): ConfigLayer {
  return {
    ...layer,
    ...(layer.model !== undefined ? { model: layer.model.trim() } : {}),
    ...(layer.baseUrl !== undefined ? { baseUrl: layer.baseUrl.trim() } : {}),
  };
}

/** Fold TypeBox path + message into a short, setting-oriented phrase. */
function formatSchemaError(path: string, message: string): string {
  const setting = path.replace(/^\//, "").replaceAll("/", ".") || "value";
  return `${setting} ${message}`;
}

/** Compare config keys without punctuation so api_key and apiKey match. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[-_]/g, "");
}

/** True when a filesystem error means the config file does not exist. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/** Normalize thrown values into a printable error string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
