import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CREDENTIAL_HEADER_NAMES } from "../auth/secrets.ts";
import {
  type ModelCapability,
  describeThinkingSupport,
  findCompatibleReasoningBodyKey,
  getThinkingSupport,
  lookupModel,
  UNKNOWN_MODEL_DEFAULTS,
  type ModelInfo,
} from "../model/catalog.ts";
import type { ThinkingLevel } from "../model/model.ts";
import { removedProviderMessage } from "./removed-provider.ts";
import {
  DEFAULT_MAX_CONCURRENT_TOOLS,
  DEFAULT_MAX_TURNS,
  DEFAULT_PROVIDER,
} from "./defaults.ts";
import {
  PROFILE_NAME_PATTERN,
  isValidProfileBaseUrl,
  isValidProfileName,
} from "./profile-name.ts";
import {
  DEFAULT_GIT_CHANGE_TRACKING,
  type GitChangeTrackingMode,
} from "../workspace/git.ts";

/** Shared profile-name pattern and validator; re-exported for existing config importers. */
export { PROFILE_NAME_PATTERN, isValidProfileName, isValidProfileBaseUrl };

/** First-party config keys. Unknown names are rejected rather than ignored. */
export const CONFIG_SETTING_NAMES = [
  "provider",
  "model",
  "thinking",
  "maxTurns",
  "maxConcurrentTools",
  "contextWindow",
  "maxOutput",
  "baseUrl",
  "headers",
  "extraBody",
  "auth",
  "openaiAuth",
  "packages",
  "profiles",
  "profile",
  "git",
  "appearance",
] as const;

const ProviderSchema = Type.Union([
  Type.Literal("openai"),
  Type.Literal("xai"),
  Type.Literal("openai-compatible"),
]);

const AuthSchema = Type.Union([
  Type.Literal("required"),
  Type.Literal("optional"),
  Type.Literal("none"),
]);

/** Validated OpenAI credential preference, independent of compatible required/optional/none auth. */
export const OpenAIAuthSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("codex"),
  Type.Literal("api-key"),
]);

/** Validated provider-independent reasoning levels without assuming identical wire semantics. */
export const ThinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
  Type.Literal("ultra"),
]);

/** Validated Git change-tracking modes for observational inspection. */
export const GitChangeTrackingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("on-demand"),
  Type.Literal("snapshot"),
]);

/** Observational Git settings; Schway never manages commits, branches, or worktrees. */
export const GitConfigSchema = Type.Object(
  {
    changeTracking: Type.Optional(GitChangeTrackingSchema),
  },
  { additionalProperties: false },
);

/** Saved TUI appearance; auto follows terminal background detection. */
export const AppearanceSchema = Type.Union([Type.Literal("auto"), Type.Literal("dark"), Type.Literal("light")]);

const PositiveInt = Type.Integer({ minimum: 1 });

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

/** TypeBox schema for one config layer; a null profile is a session-only marker that clears lower selections. */
export const ConfigSchema = Type.Object(
  {
    provider: Type.Optional(ProviderSchema),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(Type.Union([ThinkingSchema, Type.Null()])),
    maxTurns: Type.Optional(PositiveInt),
    maxConcurrentTools: Type.Optional(PositiveInt),
    contextWindow: Type.Optional(PositiveInt),
    maxOutput: Type.Optional(PositiveInt),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    auth: Type.Optional(AuthSchema),
    openaiAuth: Type.Optional(OpenAIAuthSchema),
    packages: Type.Optional(Type.Array(Type.String({ pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$" }), { uniqueItems: true })),
    profiles: Type.Optional(Type.Record(Type.String(), CompatibleProfileSchema)),
    profile: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    git: Type.Optional(GitConfigSchema),
    appearance: Type.Optional(AppearanceSchema),
  },
  { additionalProperties: false },
);

/** One overlay of first-party settings from defaults, a file, or the CLI. */
export type ConfigLayer = Static<typeof ConfigSchema>;

/** Built-in provider families selectable from config and the CLI. */
export type ProviderFamily = NonNullable<ConfigLayer["provider"]>;

/** Authentication mode for OpenAI-compatible endpoints. */
export type AuthMode = NonNullable<ConfigLayer["auth"]>;

/** OpenAI credential preference selecting subscription login, API key, or automatic headless-safe choice. */
export type OpenAIAuthMode = NonNullable<ConfigLayer["openaiAuth"]>;

/** Validated named OpenAI-compatible endpoint with reference-only credentials. */
export type CompatibleProfile = Static<typeof CompatibleProfileSchema>;

/** Map of profile names to their whole definitions for global/project merging. */
export type CompatibleProfileMap = Record<string, CompatibleProfile>;

/** Observational Git change-tracking mode without commit or branch management. */
export type { GitChangeTrackingMode };

/** Validated Git settings with on-demand as the default inspection mode. */
export type GitConfig = Static<typeof GitConfigSchema>;

/** Default change-tracking mode that reads Git only on explicit inspection. */
export { DEFAULT_GIT_CHANGE_TRACKING };

/** Headless exit text when neither config nor the CLI names a provider and model. */
export const NO_MODEL_CONFIGURED_MESSAGE =
  "No model configured. Pass --provider and --model, or set them in config.";

/** Fully resolved runtime settings after precedence and catalog lookup. */
export interface ResolvedSettings {
  provider: ProviderFamily;
  model: string;
  /** False when no layer named a model. Interactive must not display or send with a built-in model. */
  modelConfigured: boolean;
  /** Requested provider-independent reasoning level; undefined leaves provider defaults untouched. */
  thinking?: ThinkingLevel;
  /** Effective reasoning level after capability checks; undefined means provider defaults. */
  effectiveThinking?: ThinkingLevel;
  /** Account-advertised default when thinking is unset. */
  defaultThinking?: ThinkingLevel;
  /** Account-advertised reasoning levels for a selected subscription or xAI model. */
  supportedThinking?: readonly ThinkingLevel[];
  /** True when xAI off sends reasoning effort none; absent means off sends no reasoning field. */
  supportsDisabling?: boolean;
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
  /** OpenAI credential preference; auto prefers explicit/runtime/environment API keys over a stored subscription. */
  openaiAuth?: OpenAIAuthMode;
  /** Active named compatible profile, when a selection resolved successfully. */
  profile?: string;
  /** Environment-variable name referenced by the active profile, never a secret value. */
  credentialEnv?: string;
  /** Secure-store identity suffix referenced by the active profile, never a secret value. */
  credentialIdentity?: string;
  /** Observational Git change-tracking mode; on-demand reads only on explicit inspection. */
  gitChangeTracking: GitChangeTrackingMode;
  /** TUI appearance preference before an explicit environment override. */
  appearance: "auto" | "dark" | "light";
}

/** Lowest-precedence settings. Files and CLI override these; nothing writes them. */
export const BUILTIN_DEFAULTS: ConfigLayer = {
  provider: DEFAULT_PROVIDER,
  maxTurns: DEFAULT_MAX_TURNS,
  maxConcurrentTools: DEFAULT_MAX_CONCURRENT_TOOLS,
  git: { changeTracking: DEFAULT_GIT_CHANGE_TRACKING },
};

const SECRET_KEY_ALIASES = new Set([
  "apikey",
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

  const removedProvider = removedProviderMessage(record.provider);
  if (removedProvider !== undefined) {
    return { error: removedProvider };
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
  if (layer.thinking === null && source !== "session") {
    return { error: `Invalid config at ${source}: thinking must be a supported level. Null is a session-only provider-default marker.` };
  }
  if (layer.profile === null && source !== "session") {
    return {
      error: `Invalid config at ${source}: profile must be a nonempty string. Null is a session-only cleared marker.`,
    };
  }
  if (layer.profile !== undefined && layer.profile !== null && !isValidProfileName(layer.profile.trim())) {
    return {
      error: `Invalid config at ${source}: profile must match ${PROFILE_NAME_PATTERN}.`,
    };
  }
  if (layer.profile !== undefined && layer.profile !== null && layer.profile.trim().length === 0) {
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
    const extraBody = (profile as Record<string, unknown>).extraBody;
    if (extraBody !== null && typeof extraBody === "object" && !Array.isArray(extraBody)) {
      const extraBodySecret = Object.keys(extraBody as Record<string, unknown>).find((key) =>
        SECRET_KEY_ALIASES.has(normalizeKey(key)),
      );
      if (extraBodySecret !== undefined) {
        return `API keys must not be stored in ${source}. Use --api-key or environment variables.`;
      }
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
    const extraBodySecret = Object.keys(profile.extraBody ?? {}).find((key) =>
      SECRET_KEY_ALIASES.has(normalizeKey(key)),
    );
    if (extraBodySecret !== undefined) {
      return `API keys must not be stored in ${source}. Use --api-key or environment variables.`;
    }
    if (profile.baseUrl.trim().length === 0) {
      return `Invalid config at ${source}: profiles.${name}.baseUrl must be a nonempty string.`;
    }
    if (!isValidProfileBaseUrl(profile.baseUrl.trim())) {
      return `Invalid config at ${source}: profiles.${name}.baseUrl must be an absolute URL without userinfo or query parameters.`;
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

/** Drop remembered connection fields when a higher layer explicitly selects a different route or profile. */
export function effectiveInteractiveMemory(input: { memory?: ConfigLayer; user?: ConfigLayer; project?: ConfigLayer; cli?: ConfigLayer; session?: ConfigLayer }): ConfigLayer | undefined {
  if (!input.memory) return undefined;
  const memory = { ...input.memory };
  for (const layer of [input.user, input.project, input.cli, input.session]) {
    if (!layer) continue;
    if (layer.provider !== undefined && layer.provider !== input.memory.provider ||
        layer.profile !== undefined && (layer.profile ?? undefined) !== input.memory.profile) return undefined;
    if (layer.openaiAuth !== undefined && layer.openaiAuth !== input.memory.openaiAuth) { delete memory.model; delete memory.thinking; delete memory.openaiAuth; }
    if (layer.model !== undefined && layer.model !== memory.model) delete memory.thinking;
  }
  return memory;
}

/**
 * Resolve defaults, optional interactive memory, user, project, CLI and session overrides in increasing precedence with catalog budgets.
 * Named compatible profiles merge by name across global/project config; the selected name resolves by
 * normal precedence while explicit CLI/session connection flags apply last over the profile.
 * Returns an error for unknown/malformed profiles or a missing base URL before any provider request.
 */
export function resolveSettings(input: {
  /** Opt-in, secret-free interactive choice below explicit configuration. */
  memory?: ConfigLayer;
  user?: ConfigLayer;
  project?: ConfigLayer;
  cli?: ConfigLayer;
  session?: ConfigLayer;
  /** Verified account capabilities are applied only to the explicit Codex subscription. */
  modelCapabilities?: readonly ModelCapability[];
  /** Preliminary headless resolution only; never use it for an outgoing request. */
  deferOpenAIThinking?: boolean;
}): ResolvedSettings | { error: string } {
  const memory = effectiveInteractiveMemory(input);
  const mergedProfiles = mergeProfileMaps(input.user?.profiles, input.project?.profiles, input.cli?.profiles, input.session?.profiles);
  const selection = mergeConfigLayers(
    BUILTIN_DEFAULTS,
    memory,
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
    const PROFILE_CONNECTION_KEYS = ["baseUrl", "model", "headers", "extraBody", "auth"] as const;
    const fileLayer = (layer: ConfigLayer | undefined): ConfigLayer | undefined => {
      const direct = omitProfileKeys(layer);
      if (direct === undefined) return undefined;
      const copy: ConfigLayer = { ...direct };
      for (const key of PROFILE_CONNECTION_KEYS) delete copy[key];
      return copy;
    };
    merged = mergeConfigLayers(
      BUILTIN_DEFAULTS,
      ...(memory?.profile === selectedName
        ? [profileLayer, omitProfileKeys(memory), omitProfileKeys(input.user), omitProfileKeys(input.project)]
        : [memory, fileLayer(input.user), fileLayer(input.project), profileLayer]),
      omitProfileKeys(input.cli),
      omitProfileKeys(input.session),
    );
    merged.profile = selectedName;
    merged.profiles = mergedProfiles;
  }
  const provider = merged.provider ?? DEFAULT_PROVIDER;
  const model = merged.model?.trim() ?? "";
  if (selectedName !== undefined && provider !== "openai-compatible") {
    return {
      error: `Profile "${selectedName}" requires provider openai-compatible. Remove the conflicting provider override.`,
    };
  }
  if (!model) {
    if (provider === "openai-compatible" && !(merged.baseUrl?.trim())) {
      return {
        error: "Missing --base-url for OpenAI-compatible provider. Set baseUrl in config or pass --base-url.",
      };
    }
    const unsetThinking = merged.thinking === null ? undefined : merged.thinking as ThinkingLevel | undefined;
    const unsetThinkingError = unsetThinking === undefined ? undefined
      : validateThinking(provider, model, unsetThinking, merged.extraBody);
    if (unsetThinkingError !== undefined) return { error: unsetThinkingError };
    return finishResolvedSettings({
      provider,
      model: "",
      modelConfigured: false,
      merged,
      selectedName,
      activeProfile,
      thinking: unsetThinking,
      contextWindow: merged.contextWindow ?? UNKNOWN_MODEL_DEFAULTS.contextWindow,
      maxOutput: merged.maxOutput ?? UNKNOWN_MODEL_DEFAULTS.maxOutput,
      catalog: {
        id: "",
        provider,
        ...UNKNOWN_MODEL_DEFAULTS,
        contextWindow: merged.contextWindow ?? UNKNOWN_MODEL_DEFAULTS.contextWindow,
        maxOutput: merged.maxOutput ?? UNKNOWN_MODEL_DEFAULTS.maxOutput,
      },
    });
  }
  const subscriptionSelected = provider === "openai" && merged.openaiAuth === "codex";
  const listedSelected = subscriptionSelected || provider === "xai";
  const listedCatalog = listedSelected ? input.modelCapabilities : undefined;
  const capability = listedCatalog?.find(entry => entry.id === model);
  const metadata = lookupModel(provider, model, {
    contextWindow: merged.contextWindow ?? capability?.contextWindow,
    maxOutput: merged.maxOutput ?? capability?.maxOutput,
  });
  const catalog = capability ? { ...metadata, supportsThinking: capability.supportedThinking.length > 0 } : metadata;
  const thinking = merged.thinking === null ? undefined : merged.thinking as ThinkingLevel | undefined;
  const thinkingError = (input.deferOpenAIThinking && provider === "openai") || (provider === "xai" && input.modelCapabilities === undefined) ? undefined
    : validateThinking(provider, model, thinking, merged.extraBody, listedSelected ? capability ?? null : undefined);
  if (thinkingError !== undefined) {
    return { error: thinkingError };
  }

  if (provider === "openai-compatible" && !(merged.baseUrl?.trim())) {
    return {
      error:
        "Missing --base-url for OpenAI-compatible provider. Set baseUrl in config or pass --base-url.",
    };
  }
  return finishResolvedSettings({
    provider,
    model,
    modelConfigured: true,
    merged,
    selectedName,
    activeProfile,
    thinking,
    defaultThinking: capability?.defaultThinking,
    supportedThinking: capability?.supportedThinking,
    supportsDisabling: capability?.supportsDisabling,
    contextWindow: catalog.contextWindow,
    maxOutput: catalog.maxOutput,
    catalog,
  });
}

function finishResolvedSettings(input: {
  provider: ProviderFamily;
  model: string;
  modelConfigured: boolean;
  merged: ConfigLayer;
  selectedName?: string;
  activeProfile?: CompatibleProfile;
  thinking?: ThinkingLevel;
  defaultThinking?: ThinkingLevel;
  supportedThinking?: readonly ThinkingLevel[];
  supportsDisabling?: boolean;
  contextWindow: number;
  maxOutput: number;
  catalog: ModelInfo;
}): ResolvedSettings {
  return {
    provider: input.provider,
    model: input.model,
    modelConfigured: input.modelConfigured,
    ...(input.thinking !== undefined ? { thinking: input.thinking, effectiveThinking: input.thinking } : {}),
    ...(input.defaultThinking !== undefined ? { defaultThinking: input.defaultThinking } : {}),
    ...(input.supportedThinking !== undefined ? { supportedThinking: input.supportedThinking } : {}),
    ...(input.supportsDisabling ? { supportsDisabling: true } : {}),
    maxTurns: input.merged.maxTurns ?? DEFAULT_MAX_TURNS,
    maxConcurrentTools: input.merged.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
    contextWindow: input.contextWindow,
    maxOutput: input.maxOutput,
    catalog: input.catalog,
    gitChangeTracking: input.merged.git?.changeTracking ?? DEFAULT_GIT_CHANGE_TRACKING,
    appearance: input.merged.appearance ?? "auto",
    openaiAuth: input.merged.openaiAuth ?? "auto",
    ...(input.merged.contextWindow !== undefined ? { explicitContextWindow: input.merged.contextWindow } : {}),
    ...(input.merged.maxOutput !== undefined ? { explicitMaxOutput: input.merged.maxOutput } : {}),
    ...(input.selectedName !== undefined ? { profile: input.selectedName } : {}),
    ...(input.selectedName !== undefined && input.activeProfile?.credentialEnv !== undefined ? { credentialEnv: input.activeProfile.credentialEnv } : {}),
    ...(input.selectedName !== undefined && input.activeProfile?.credentialIdentity !== undefined ? { credentialIdentity: input.activeProfile.credentialIdentity } : {}),
    ...(input.provider === "openai-compatible" ? {
      baseUrl: input.merged.baseUrl?.trim(),
      headers: input.merged.headers,
      extraBody: input.merged.extraBody,
      auth: input.merged.auth ?? "optional",
    } : {}),
  };
}

/** Return an error when the requested thinking level is unsupported for the model or conflicts with extra-body reasoning controls, otherwise undefined. */
export function validateThinking(
  provider: string,
  model: string,
  thinking: ThinkingLevel | undefined,
  extraBody: Record<string, unknown> | undefined,
  accountCapability?: ModelCapability | null,
): string | undefined {
  if (thinking === undefined) {
    return undefined;
  }
  if (provider === "openai-compatible") {
    const bodyKey = findCompatibleReasoningBodyKey(extraBody);
    if (bodyKey !== undefined) {
      return `thinking "${thinking}" conflicts with extraBody.${bodyKey}; remove one to define a single source of truth for reasoning.`;
    }
  }
  const support = accountCapability === undefined ? getThinkingSupport(provider, model) : undefined;
  if (accountCapability !== undefined && !accountCapability?.supportedThinking.includes(thinking)) {
    if (provider === "xai") {
      return `Thinking level "${thinking}" is not listed for xai/${model} in the xAI model list. Leave thinking unset or select a listed level.`;
    }
    return `Thinking level "${thinking}" is not listed for ${provider}/${model} in this account's subscription catalog. Leave thinking unset or select an advertised level.`;
  }
  if (support && !support.supported.includes(thinking)) {
    return `Thinking level "${thinking}" is not supported for ${provider}/${model}. ${describeThinkingSupport(provider, model)}`;
  }
  return undefined;
}

/** Describe the effective wire control for a resolved thinking level without exposing provider field names in core. */
export function describeEffectiveThinking(provider: string, thinking: ThinkingLevel | undefined, modelId?: string): string {
  if (thinking === undefined) {
    return "provider default (no reasoning controls sent)";
  }
  if (thinking === "off") {
    if (modelId !== undefined && !getThinkingSupport(provider, modelId).supportsDisabling) {
      return "off (provider default, no reasoning controls sent)";
    }
    if (modelId === undefined && provider !== "openai") {
      return "off (provider default, no reasoning controls sent)";
    }
    if (provider === "openai" && modelId !== undefined) {
      return "off (reasoning effort none)";
    }
    if (provider === "openai") {
      return "off (disable control on reasoning-capable models; otherwise no reasoning controls sent)";
    }
    return "off (provider default, no reasoning controls sent)";
  }
  if (provider === "openai" || provider === "xai") {
    return `${thinking} (reasoning effort ${thinking})`;
  }
  return `${thinking} (via extraBody when configured; no automatic mapping)`;
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
  modelCapabilities?: readonly ModelCapability[];
  deferOpenAIThinking?: boolean;
  /** Headless runs must name a provider and model in config or CLI flags. */
  requireExplicitModel?: boolean;
}): Promise<ResolvedSettings | { error: string }> {
  const user = await readConfigFile(userConfigPath(input.home));
  if (user && "error" in user) {
    return user;
  }
  const project = await readConfigFile(projectConfigPath(input.workspaceRoot));
  if (project && "error" in project) {
    return project;
  }
  const resolved = resolveSettings({
    user,
    project,
    cli: input.cli,
    modelCapabilities: input.modelCapabilities,
    deferOpenAIThinking: input.deferOpenAIThinking,
  });
  if ("error" in resolved) return resolved;
  if (input.requireExplicitModel && !resolved.modelConfigured) {
    return { error: NO_MODEL_CONFIGURED_MESSAGE };
  }
  return resolved;
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
    ...(layer.profile !== undefined ? { profile: layer.profile === null ? null : layer.profile.trim() } : {}),
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
