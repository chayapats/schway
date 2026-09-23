import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CREDENTIAL_HEADER_NAMES } from "../auth/secrets.ts";
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
  "packages",
  "profiles",
  "profile",
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

/** Profile names are filesystem- and CLI-safe identifiers without secrets. */
export const PROFILE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/** Environment-variable names referenced by profiles, never secret values. */
export const CREDENTIAL_ENV_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

/** Optional secure-store identity suffix referenced by profiles, never a secret value. */
export const CREDENTIAL_IDENTITY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/** TypeBox schema for one named compatible profile; secrets are references only. */
export const CompatibleProfileSchema = Type.Object(
  {
    baseUrl: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 1 })),
    contextWindow: Type.Optional(PositiveInt),
    maxOutput: Type.Optional(PositiveInt),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    auth: Type.Optional(AuthSchema),
    credentialEnv: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: CREDENTIAL_ENV_PATTERN }),
    ),
    credentialIdentity: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64, pattern: CREDENTIAL_IDENTITY_PATTERN }),
    ),
  },
  { additionalProperties: false },
);

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
    packages: Type.Optional(Type.Array(Type.String({ pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$" }), { uniqueItems: true })),
    profiles: Type.Optional(Type.Record(Type.String(), CompatibleProfileSchema)),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

/** One overlay of first-party settings from defaults, a file, or the CLI. */
export type ConfigLayer = Static<typeof ConfigSchema>;

/** Built-in provider families selectable from config and the CLI. */
export type ProviderFamily = NonNullable<ConfigLayer["provider"]>;

/** Authentication mode for OpenAI-compatible endpoints. */
export type AuthMode = NonNullable<ConfigLayer["auth"]>;

/** Validated named OpenAI-compatible endpoint with reference-only credentials. */
export type CompatibleProfile = Static<typeof CompatibleProfileSchema>;

/** Map of profile names to their whole definitions for global/project merging. */
export type CompatibleProfileMap = Record<string, CompatibleProfile>;

/** Fully resolved runtime settings after precedence and catalog lookup. */
export interface ResolvedSettings {
  provider: ProviderFamily;
  model: string;
  maxTurns: number;
  maxConcurrentTools: number;
  contextWindow: number;
  maxOutput: number;
  catalog: ModelInfo;
  /** Explicit limit overrides that outrank catalog budgets across model switches. */
  explicitContextWindow?: number;
  /** Explicit output limit that outranks catalog budgets across model switches. */
  explicitMaxOutput?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: AuthMode;
  /** Active named compatible profile, when a selection resolved successfully. */
  profile?: string;
  /** Environment-variable name referenced by the active profile, never a secret value. */
  credentialEnv?: string;
  /** Secure-store identity suffix referenced by the active profile, never a secret value. */
  credentialIdentity?: string;
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

/** Join the supplied home directory with `.schway/config.json` without reading or creating it. */
export function userConfigPath(home: string): string {
  return join(home, ".schway", "config.json");
}

/** Join the primary workspace root with `.schway/config.json` without reading or creating it. */
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

  const nestedSecret = findNestedProfileSecret(record, source);
  if (nestedSecret !== undefined) {
    return { error: nestedSecret };
  }

  if (!Value.Check(ConfigSchema, value)) {
    const errors = [...Value.Errors(ConfigSchema, value)]
      .map((entry) => formatSchemaError(entry.path, entry.message))
      .join("; ");
    return {
      error: `Invalid config at ${source}: ${errors || "failed validation"}`,
    };
  }

  const layer = normalizeLayer(value);
  const credentialHeader = Object.keys(layer.headers ?? {}).find((name) =>
    CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()),
  );
  if (credentialHeader !== undefined) {
    return {
      error: `API keys must not be stored in ${source}. Use --api-key, --header at runtime, or environment variables.`,
    };
  }
  const profilesError = validateProfiles(layer.profiles, source);
  if (profilesError !== undefined) {
    return { error: profilesError };
  }
  if (layer.profile !== undefined && !isValidProfileName(layer.profile.trim())) {
    return {
      error: `Invalid config at ${source}: profile must match ${PROFILE_NAME_PATTERN}.`,
    };
  }
  if (layer.profile !== undefined && layer.profile.trim().length === 0) {
    return {
      error: `Invalid config at ${source}: profile must be a nonempty string.`,
    };
  }
  return layer;
}

/** Find secret-like keys inside profile definitions before schema validation. */
function findNestedProfileSecret(record: Record<string, unknown>, source: string): string | undefined {
  const profiles = record.profiles;
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) {
    return undefined;
  }
  for (const profile of Object.values(profiles as Record<string, unknown>)) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
      continue;
    }
    const secretKey = Object.keys(profile as Record<string, unknown>).find((key) =>
      SECRET_KEY_ALIASES.has(normalizeKey(key)),
    );
    if (secretKey !== undefined) {
      return `API keys must not be stored in ${source}. Use --api-key or environment variables.`;
    }
  }
  return undefined;
}

/** Validate profile names, reference-only credentials, and non-secret headers. */
function validateProfiles(
  profiles: CompatibleProfileMap | undefined,
  source: string,
): string | undefined {
  if (profiles === undefined) {
    return undefined;
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isValidProfileName(name)) {
      return `Invalid config at ${source}: profile name "${name}" must match ${PROFILE_NAME_PATTERN}.`;
    }
    const keys = Object.keys(profile as unknown as Record<string, unknown>);
    const secretKey = keys.find((key) => SECRET_KEY_ALIASES.has(normalizeKey(key)));
    if (secretKey !== undefined) {
      return `API keys must not be stored in ${source}. Use --api-key or environment variables.`;
    }
    if (profile.baseUrl.trim().length === 0) {
      return `Invalid config at ${source}: profiles.${name}.baseUrl must be a nonempty string.`;
    }
    if (profile.model !== undefined && profile.model.trim().length === 0) {
      return `Invalid config at ${source}: profiles.${name}.model must be a nonempty string.`;
    }
    if (
      profile.credentialEnv !== undefined &&
      !new RegExp(CREDENTIAL_ENV_PATTERN).test(profile.credentialEnv)
    ) {
      return `Invalid config at ${source}: profiles.${name}.credentialEnv must match ${CREDENTIAL_ENV_PATTERN}.`;
    }
    if (
      profile.credentialIdentity !== undefined &&
      !new RegExp(CREDENTIAL_IDENTITY_PATTERN).test(profile.credentialIdentity)
    ) {
      return `Invalid config at ${source}: profiles.${name}.credentialIdentity must match ${CREDENTIAL_IDENTITY_PATTERN}.`;
    }
    const credentialHeader = Object.keys(profile.headers ?? {}).find((header) =>
      CREDENTIAL_HEADER_NAMES.has(header.toLowerCase()),
    );
    if (credentialHeader !== undefined) {
      return `API keys must not be stored in ${source}. Use --api-key, --header at runtime, or environment variables.`;
    }
  }
  return undefined;
}

/** True when a profile name uses only safe identifier characters. */
export function isValidProfileName(name: string): boolean {
  return new RegExp(PROFILE_NAME_PATTERN).test(name);
}

/** Merge profile maps by name with later definitions replacing the whole same-name profile. */
export function mergeProfileMaps(
  ...maps: Array<CompatibleProfileMap | undefined>
): CompatibleProfileMap {
  const merged: CompatibleProfileMap = {};
  for (const map of maps) {
    if (map === undefined) {
      continue;
    }
    for (const [name, profile] of Object.entries(map)) {
      merged[name] = profile;
    }
  }
  return merged;
}

/**
 * Return merged settings with later defined values winning and inherited models cleared on provider changes.
 * Undefined layers are skipped; nested values such as headers are replaced rather than merged.
 * Profile maps merge by name with later definitions replacing the whole same-name profile.
 */
export function mergeConfigLayers(
  ...layers: Array<ConfigLayer | undefined>
): ConfigLayer {
  const merged: ConfigLayer = {};
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    const dropInheritedModel =
      layer.provider !== undefined &&
      merged.provider !== undefined &&
      layer.provider !== merged.provider &&
      layer.model === undefined;
    for (const key of CONFIG_SETTING_NAMES) {
      if (key === "profiles") {
        if (layer.profiles !== undefined) {
          merged.profiles = mergeProfileMaps(merged.profiles, layer.profiles);
        }
        continue;
      }
      const value = layer[key];
      if (value !== undefined) {
        (merged[key] as typeof value) = value;
      }
    }
    if (dropInheritedModel) {
      delete merged.model;
    }
  }
  return merged;
}

/**
 * Resolve defaults, user, project, CLI and session overrides in increasing precedence with catalog budgets.
 * Named compatible profiles merge by name across global/project config; the selected name resolves by
 * normal precedence while explicit CLI/session connection flags apply last over the profile.
 * Returns an error for unknown/malformed profiles or a missing base URL before any provider request.
 */
export function resolveSettings(input: {
  user?: ConfigLayer;
  project?: ConfigLayer;
  cli?: ConfigLayer;
  session?: ConfigLayer;
}): ResolvedSettings | { error: string } {
  const mergedProfiles = mergeProfileMaps(input.user?.profiles, input.project?.profiles, input.cli?.profiles, input.session?.profiles);
  const selection = mergeConfigLayers(
    BUILTIN_DEFAULTS,
    input.user,
    input.project,
    input.cli,
    input.session,
  );
  const selectedName = selection.profile?.trim() || undefined;
  if (selectedName !== undefined && !isValidProfileName(selectedName)) {
    return { error: `Invalid profile "${selectedName}". Profile names must match ${PROFILE_NAME_PATTERN}.` };
  }
  let merged: ConfigLayer;
  let activeProfile: CompatibleProfile | undefined;
  if (selectedName === undefined) {
    merged = selection;
  } else {
    activeProfile = mergedProfiles[selectedName];
    if (activeProfile === undefined) {
      const available = Object.keys(mergedProfiles);
      return {
        error:
          available.length === 0
            ? `Unknown profile "${selectedName}". No compatible profiles are defined.`
            : `Unknown profile "${selectedName}". Available: ${available.sort().join(", ")}.`,
      };
    }
    const profileError = validateProfiles({ [selectedName]: activeProfile }, "selected profile");
    if (profileError !== undefined) {
      return { error: profileError };
    }
    const profileLayer = profileToLayer(activeProfile);
    merged = mergeConfigLayers(
      BUILTIN_DEFAULTS,
      omitProfileKeys(input.user),
      omitProfileKeys(input.project),
      profileLayer,
      omitProfileKeys(input.cli),
      omitProfileKeys(input.session),
    );
    merged.profile = selectedName;
    merged.profiles = mergedProfiles;
  }
  const provider = merged.provider ?? DEFAULT_PROVIDER;
  const model = merged.model?.trim() || DEFAULT_MODEL_IDS[provider];
  if (selectedName !== undefined && provider !== "openai-compatible") {
    return {
      error: `Profile "${selectedName}" requires provider openai-compatible. Remove the conflicting provider override.`,
    };
  }
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
    ...(merged.contextWindow !== undefined
      ? { explicitContextWindow: merged.contextWindow }
      : {}),
    ...(merged.maxOutput !== undefined
      ? { explicitMaxOutput: merged.maxOutput }
      : {}),
    ...(selectedName !== undefined ? { profile: selectedName } : {}),
    ...(selectedName !== undefined && activeProfile?.credentialEnv !== undefined
      ? { credentialEnv: activeProfile.credentialEnv }
      : {}),
    ...(selectedName !== undefined && activeProfile?.credentialIdentity !== undefined
      ? { credentialIdentity: activeProfile.credentialIdentity }
      : {}),
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

/** Expand one validated profile into a config layer that implies the compatible provider. */
export function profileToLayer(profile: CompatibleProfile): ConfigLayer {
  return {
    provider: "openai-compatible",
    baseUrl: profile.baseUrl.trim(),
    ...(profile.model !== undefined ? { model: profile.model.trim() } : {}),
    ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
    ...(profile.maxOutput !== undefined ? { maxOutput: profile.maxOutput } : {}),
    ...(profile.headers !== undefined ? { headers: profile.headers } : {}),
    ...(profile.extraBody !== undefined ? { extraBody: profile.extraBody } : {}),
    ...(profile.auth !== undefined ? { auth: profile.auth } : {}),
  };
}

/** Remove profile maps and selection so explicit connection layers can surround the profile. */
function omitProfileKeys(layer: ConfigLayer | undefined): ConfigLayer | undefined {
  if (layer === undefined) {
    return undefined;
  }
  const { profiles: _profiles, profile: _profile, ...direct } = layer;
  return direct;
}

/** Read config under the supplied home and workspace root, returning resolved settings or the first file/settings error. */
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

/** Trim string fields after schema validation, including profile selections and definitions. */
function normalizeLayer(layer: ConfigLayer): ConfigLayer {
  const profiles = layer.profiles === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(layer.profiles).map(([name, profile]) => [
        name,
        {
          ...profile,
          baseUrl: profile.baseUrl.trim(),
          ...(profile.model !== undefined ? { model: profile.model.trim() } : {}),
        },
      ]),
    );
  return {
    ...layer,
    ...(layer.model !== undefined ? { model: layer.model.trim() } : {}),
    ...(layer.baseUrl !== undefined ? { baseUrl: layer.baseUrl.trim() } : {}),
    ...(layer.profile !== undefined ? { profile: layer.profile.trim() } : {}),
    ...(profiles !== undefined ? { profiles } : {}),
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
