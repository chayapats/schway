import { applyConfigDeprecations, ConfigDeprecationError, CONFIG_DEPRECATIONS, type ConfigDeprecation, type ConfigDeprecationWarning } from "./deprecations.ts";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, stricterApprovalMode, type ApprovalMode } from "../agent/approval.ts";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { configDiagnostic, configDiagnosticSecrets, configReadError, safeConfigSource, schemaDiagnostics, type ConfigDiagnosticContext, type ConfigReadError, type ConfigDiagnostic } from "./diagnostics.ts";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CREDENTIAL_HEADER_NAMES } from "../auth/secrets.ts";
import {
  type ModelCapability,
  lookupModel,
  UNKNOWN_MODEL_DEFAULTS,
  type ModelInfo,
} from "../model/catalog.ts";
import { validateThinking, resolveThinkingPolicy, isOpenRouterEndpoint } from "../model/thinking.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../model/model.ts";
import { removedProviderMessage } from "./removed-provider.ts";
import {
  DEFAULT_UNDO_MAX_AGE_DAYS,
  DEFAULT_UNDO_MAX_SIZE_MB,
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
  "xaiAuth",
  "packages",
  "profiles",
  "profile",
  "git",
  "undo",
  "approval",
  "appearance",
  "ui",
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
export const ThinkingSchema = Type.Union(THINKING_LEVELS.map(level => Type.Literal(level)));

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

/** Startup decoration preference; motion restrictions take precedence in the interactive UI. */
export const SplashSettingSchema = Type.Union([Type.Literal("always"), Type.Literal("first-run"), Type.Literal("never")]);

/** Validated interactive display settings; unknown keys are rejected. */
export const UiConfigSchema = Type.Object({
  inlineDiffLines: Type.Optional(Type.Integer({ minimum: 0 })),
  splash: Type.Optional(SplashSettingSchema),
}, { additionalProperties: false });

/** User-selected startup decoration policy, before terminal motion and resume gates. */
export type SplashSetting = Static<typeof SplashSettingSchema>;

const PositiveInt = Type.Integer({ minimum: 1 });

/** Retention limits for private undo data; unknown settings are rejected. */
export const UndoConfigSchema = Type.Object({
  maxAgeDays: Type.Optional(PositiveInt),
  maxSizeMB: Type.Optional(PositiveInt),
}, { additionalProperties: false });

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
    headers: Type.Optional(Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.String())),
    extraBody: Type.Optional(Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.Unknown())),
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
    headers: Type.Optional(Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.String())),
    extraBody: Type.Optional(Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.Unknown())),
    auth: Type.Optional(AuthSchema),
    openaiAuth: Type.Optional(OpenAIAuthSchema),
    xaiAuth: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("grok"), Type.Literal("api-key")])),
    packages: Type.Optional(Type.Array(Type.String({ pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$" }), { uniqueItems: true })),
    profiles: Type.Optional(Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), CompatibleProfileSchema)),
    profile: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()])),
    git: Type.Optional(GitConfigSchema),
    undo: Type.Optional(UndoConfigSchema),
    approval: Type.Optional(Type.Object({ mode: Type.Optional(Type.Union(APPROVAL_MODES.map(mode => Type.Literal(mode)))) }, { additionalProperties: false })),
    appearance: Type.Optional(AppearanceSchema),
    ui: Type.Optional(UiConfigSchema),
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
  "No model configured · Pass --provider and --model, or set them in config";

/** Default maximum changed rows shown inline for successful edits and created files. */
export const DEFAULT_INLINE_DIFF_LINES = 12;

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
  /** Exact verified route metadata retained for adapter validation. */
  reasoningCapability?: ModelCapability;
  /** Provider-advertised default when thinking is unset; no explicit control is sent. */
  defaultThinking?: ThinkingLevel;
  /** Verified reasoning choices for the selected provider, model and route. */
  supportedThinking?: readonly ThinkingLevel[];
  /** True when explicit off sends a disable control; absent means off leaves defaults untouched. */
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
  xaiAuth?: "auto" | "grok" | "api-key";
  /** Active named compatible profile, when a selection resolved successfully. */
  profile?: string;
  /** Environment-variable name referenced by the active profile, never a secret value. */
  credentialEnv?: string;
  /** Secure-store identity suffix referenced by the active profile, never a secret value. */
  credentialIdentity?: string;
  /** Observational Git change-tracking mode; on-demand reads only on explicit inspection. */
  gitChangeTracking: GitChangeTrackingMode;
  /** Effective tool approval mode after stricter-only project settings and user overrides. */
  approvalMode: ApprovalMode;
  /** User-file approval mode, or the default, before project and runtime overrides. */
  userApprovalMode: ApprovalMode;
  /** Project approval mode ignored because it is looser than the user-file setting. */
  ignoredProjectApprovalMode?: ApprovalMode;
  /** Maximum age of stored undo turns in days. */
  undoMaxAgeDays: number;
  /** Maximum private undo store size in MiB. */
  undoMaxSizeMB: number;
  /** TUI appearance preference before an explicit environment override. */
  appearance: "auto" | "dark" | "light";
  /** Maximum changed rows shown inline; zero disables inline diffs. */
  inlineDiffLines: number;
  /** Effective startup decoration preference; defaults to the first launch of each installed version. */
  splash: SplashSetting;
}

/** Lowest-precedence settings. Files and CLI override these; nothing writes them. */
export const BUILTIN_DEFAULTS: ConfigLayer = {
  provider: DEFAULT_PROVIDER,
  maxTurns: DEFAULT_MAX_TURNS,
  maxConcurrentTools: DEFAULT_MAX_CONCURRENT_TOOLS,
  git: { changeTracking: DEFAULT_GIT_CHANGE_TRACKING },
  approval: { mode: DEFAULT_APPROVAL_MODE },
  undo: { maxAgeDays: DEFAULT_UNDO_MAX_AGE_DAYS, maxSizeMB: DEFAULT_UNDO_MAX_SIZE_MB },
  ui: { inlineDiffLines: DEFAULT_INLINE_DIFF_LINES, splash: "first-run" },
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

/** Preserve parsed settings compatibility while exposing non-persisted deprecation diagnostics. */
export type ParsedConfigLayer = ConfigLayer & { readonly deprecationWarnings?: readonly ConfigDeprecationWarning[] };

/** Validate migrated settings and return source-specific warnings without changing the input object. */
export function parseConfigObject(
  value: unknown,
  source: string,
  deprecations: readonly ConfigDeprecation[] = CONFIG_DEPRECATIONS,
  diagnosticContext?: ConfigDiagnosticContext,
): ParsedConfigLayer | ConfigReadError {
  const secretsForDiagnostics = configDiagnosticSecrets(diagnosticContext, [value]);
  const diagnosticSource = safeConfigSource(source, secretsForDiagnostics);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return configReadError([configDiagnostic(diagnosticSource, "", "root", "Use a JSON object")]);
  }

  let migrated: ReturnType<typeof applyConfigDeprecations>;
  try { migrated = applyConfigDeprecations(value as Record<string, unknown>, source, deprecations, secretsForDiagnostics); }
  catch (error) { return configReadError([configDiagnostic(diagnosticSource, error instanceof ConfigDeprecationError ? error.field : "", "type", "Use a JSON object")]); }
  value = migrated.value;
  const record = migrated.value;
  for (const entry of deprecations) {
    if (entry.replacement) continue;
    const parts = entry.key.split(".");
    let schema: TSchema | undefined = ConfigSchema;
    let parent: Record<string, unknown> | undefined = record;
    const ancestors: Array<{ parent: Record<string, unknown>; key: string; schema?: TSchema }> = [];
    for (const part of parts.slice(0, -1)) {
      schema = schema?.properties?.[part];
      if (parent && Object.hasOwn(parent, part)) ancestors.push({ parent, key: part, schema });
      const next: unknown = parent && Object.hasOwn(parent, part) ? parent[part] : undefined;
      parent = next && typeof next === "object" && !Array.isArray(next) ? next as Record<string, unknown> : undefined;
    }
    const key = parts.at(-1)!;
    if (!schema?.properties?.[key] && parent && Object.hasOwn(parent, key)) {
      delete parent[key];
      for (const ancestor of ancestors.reverse()) {
        if (ancestor.schema || Object.keys(ancestor.parent[ancestor.key] as object).length) break;
        delete ancestor.parent[ancestor.key];
      }
    }
  }
  const secrets = configSecrets(record, diagnosticSource);
  const removedProvider = removedProviderMessage(record.provider);
  if (removedProvider !== undefined && !secrets.size) {
    return { error: removedProvider, diagnostics: [configDiagnostic(diagnosticSource, "provider", "removed-provider", removedProvider)] };
  }

  if (!Value.Check(ConfigSchema, value)) {
    return configReadError([...secrets.values(), ...schemaDiagnostics(ConfigSchema, [...Value.Errors(ConfigSchema, value)].filter(error => !secrets.has(error.path)), diagnosticSource)]);
  }

  if (secrets.size) return configReadError([...secrets.values()]);
  const layer = normalizeLayer(value);
  const diagnostics = validateProfiles(layer.profiles, diagnosticSource);
  if (layer.thinking === null && source !== "session") diagnostics.push(configDiagnostic(diagnosticSource, "thinking", "enum", `Use ${THINKING_LEVELS.join(", ")}; null is only supported in a session`, THINKING_LEVELS));
  if (layer.profile === null && source !== "session") diagnostics.push(configDiagnostic(diagnosticSource, "profile", "type", "Use a nonempty string; null is only supported in a session"));
  if (layer.profile !== undefined && layer.profile !== null && !isValidProfileName(layer.profile.trim())) {
    diagnostics.push(configDiagnostic(diagnosticSource, "profile", "constraint", `Use a nonempty profile name matching ${PROFILE_NAME_PATTERN}`));
  }
  if (diagnostics.length) return configReadError(diagnostics);
  return Object.defineProperty(layer, "deprecationWarnings", { value: migrated.warnings, enumerable: false }) as ParsedConfigLayer;
}

/** Find forbidden credential fields without exposing their values or dynamic names. */
function configSecrets(record: Record<string, unknown>, source: string): Map<string, ConfigDiagnostic> {
  const diagnostics = new Map<string, ConfigDiagnostic>();
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const inspect = (value: Record<string, unknown>, prefix: string, segments: string[]) => {
    const add = (keys: string[], path: string, headers = false) => {
      const pointer = "/" + [...segments, ...keys].map(key => key.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
      diagnostics.set(pointer, configDiagnostic(source, prefix + path, "secret", `API keys must not be stored in config; use --api-key${headers ? ", --header at runtime," : ""} or environment variables`));
    };
    for (const key of Object.keys(value)) if (SECRET_KEY_ALIASES.has(normalizeKey(key))) add([key], "<unknown setting>");
    if (object(value.headers)) for (const key of Object.keys(value.headers)) if (CREDENTIAL_HEADER_NAMES.has(key.toLowerCase())) add(["headers", key], "headers.<unknown setting>", true);
    if (object(value.extraBody)) for (const key of Object.keys(value.extraBody)) if (SECRET_KEY_ALIASES.has(normalizeKey(key))) add(["extraBody", key], "extraBody.<unknown setting>");
  };
  inspect(record, "", []);
  if (object(record.profiles)) for (const [name, profile] of Object.entries(record.profiles)) if (object(profile)) inspect(profile, "profiles.<unknown setting>.", ["profiles", name]);
  return diagnostics;
}

/** Validate profile constraints without echoing arbitrary names or endpoint credentials. */
function validateProfiles(profiles: CompatibleProfileMap | undefined, source: string): ConfigDiagnostic[] {
  const diagnostics = [...configSecrets({ profiles }, source).values()];
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    const path = "profiles.<unknown setting>";
    if (!isValidProfileName(name)) diagnostics.push(configDiagnostic(source, path, "constraint", `Use a profile name matching ${PROFILE_NAME_PATTERN}`));
    if (!profile.baseUrl.trim()) diagnostics.push(configDiagnostic(source, `${path}.baseUrl`, "constraint", "Use a nonempty string"));
    else if (!isValidProfileBaseUrl(profile.baseUrl.trim())) diagnostics.push(configDiagnostic(source, `${path}.baseUrl`, "constraint", "Use an absolute URL without userinfo or query parameters"));
    if (profile.credentialEnv !== undefined && !new RegExp(CREDENTIAL_ENV_PATTERN).test(profile.credentialEnv)) diagnostics.push(configDiagnostic(source, `${path}.credentialEnv`, "constraint", `Use a string matching ${CREDENTIAL_ENV_PATTERN}`));
    if (profile.credentialIdentity !== undefined && !new RegExp(CREDENTIAL_IDENTITY_PATTERN).test(profile.credentialIdentity)) diagnostics.push(configDiagnostic(source, `${path}.credentialIdentity`, "constraint", `Use a string matching ${CREDENTIAL_IDENTITY_PATTERN}`));
    if (profile.model !== undefined && !profile.model.trim()) diagnostics.push(configDiagnostic(source, `${path}.model`, "constraint", "Use a nonempty string"));
  }
  return diagnostics;
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
    if (layer.xaiAuth !== undefined && layer.xaiAuth !== input.memory.xaiAuth) { delete memory.model; delete memory.thinking; delete memory.xaiAuth; }
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
  /** Original file paths for actionable resolution failures after schema validation. */
  configSources?: { user?: string; project?: string };
  diagnosticContext?: ConfigDiagnosticContext;
  /** Verified account or endpoint capabilities for the selected billing route. */
  modelCapabilities?: readonly ModelCapability[];
  /** Preliminary headless resolution only; never use it for an outgoing request. */
  deferOpenAIThinking?: boolean;
  /** Stage an uncached OpenRouter or xAI choice for verified discovery before interactive activation. */
  deferUncachedThinking?: boolean;
}): ResolvedSettings | { error: string; diagnostics?: readonly ConfigDiagnostic[] } {
  const approval = resolveApprovalSettings(input);
  const memory = effectiveInteractiveMemory(input);
  const diagnosticSecrets = configDiagnosticSecrets(input.diagnosticContext, [input.user, input.project, input.cli, input.session]);
  const sourceFor = (field: keyof ConfigLayer, profileName?: string): string => {
    for (const [layer, source] of [[input.session, "session settings"], [input.cli, "CLI settings"], [input.project, input.configSources?.project ?? "project settings"], [input.user, input.configSources?.user ?? "user settings"], [memory, "interactive memory"]] as const) {
      if (profileName ? layer?.profiles && Object.hasOwn(layer.profiles, profileName) : layer?.[field] !== undefined) return safeConfigSource(source, diagnosticSecrets);
    }
    return "default settings";
  };
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
    return configReadError([configDiagnostic(sourceFor("profile"), "profile", "constraint", `Use a name matching ${PROFILE_NAME_PATTERN}`)]);
  }
  let merged: ConfigLayer;
  let activeProfile: CompatibleProfile | undefined;
  if (selectedName === undefined) {
    merged = selection;
  } else {
    activeProfile = Object.hasOwn(mergedProfiles, selectedName) ? mergedProfiles[selectedName] : undefined;
    if (activeProfile === undefined) {
      return configReadError([configDiagnostic(sourceFor("profile"), "profile", "constraint", "Select a configured compatible profile")]);
    }
    const profileError = validateProfiles({ [selectedName]: activeProfile }, sourceFor("profiles", selectedName));
    if (profileError.length) return configReadError(profileError);
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
    return configReadError([configDiagnostic(sourceFor("provider"), "provider", "constraint", "Use openai-compatible with a profile; remove the conflicting provider override")]);
  }
  if (!model) {
    if (provider === "openai-compatible" && !(merged.baseUrl?.trim())) {
      return {
        error: "Missing --base-url for OpenAI-compatible provider. Set baseUrl in config or pass --base-url.",
      };
    }
    const unsetThinking = merged.thinking === null ? undefined : merged.thinking as ThinkingLevel | undefined;
    const unsetThinkingError = unsetThinking === undefined ? undefined
      : validateThinking(provider, model, unsetThinking, merged.extraBody, undefined, merged.baseUrl);
    if (unsetThinkingError !== undefined) return { error: unsetThinkingError };
    return finishResolvedSettings({
      approval,
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
  const routerSelected = provider === "openai-compatible" && isOpenRouterEndpoint(merged.baseUrl);
  const listedSelected = subscriptionSelected || provider === "xai" || routerSelected;
  const authRoute = provider === "xai" ? merged.xaiAuth === "grok" ? "grok" : merged.xaiAuth === "api-key" ? "api-key" : undefined : subscriptionSelected ? "codex" : undefined;
  const listedCatalog = listedSelected ? input.modelCapabilities : undefined;
  const capability = listedCatalog?.find(entry => entry.id === model && (!entry.authRoute || !authRoute || entry.authRoute === authRoute) && (!routerSelected || entry.baseUrl === "https://openrouter.ai/api/v1"));
  const metadata = lookupModel(provider, model, {
    contextWindow: merged.contextWindow ?? capability?.contextWindow,
    maxOutput: merged.maxOutput ?? capability?.maxOutput,
  });
  const catalog = capability ? { ...metadata, supportsThinking: capability.supportedThinking.length > 0 } : metadata;
  const thinking = merged.thinking === null ? undefined : merged.thinking as ThinkingLevel | undefined;
  const uncachedInteractiveChoice = input.deferUncachedThinking && !capability;
  const pendingCatalog = (provider === "xai" && (input.modelCapabilities === undefined || uncachedInteractiveChoice))
    || (routerSelected && (!input.modelCapabilities?.some(entry => entry.baseUrl === "https://openrouter.ai/api/v1") || uncachedInteractiveChoice));
  const deferThinking = (input.deferOpenAIThinking && provider === "openai") || pendingCatalog;
  const thinkingError = deferThinking ? undefined
    : validateThinking(provider, model, thinking, merged.extraBody, listedSelected ? capability ?? null : undefined, merged.baseUrl, authRoute);
  if (thinkingError !== undefined) {
    return { error: thinkingError };
  }

  if (provider === "openai-compatible" && !(merged.baseUrl?.trim())) {
    return {
      error:
        "Missing --base-url for OpenAI-compatible provider. Set baseUrl in config or pass --base-url.",
    };
  }
  const policy = resolveThinkingPolicy({ provider, model, authRoute, baseUrl: merged.baseUrl, capability: listedSelected ? capability ?? null : undefined });
  return finishResolvedSettings({
    approval,
    provider,
    model,
    modelConfigured: true,
    merged,
    selectedName,
    activeProfile,
    thinking,
    reasoningCapability: capability,
    defaultThinking: policy.defaultThinking,
    supportedThinking: listedSelected && !capability ? undefined : policy.supported,
    supportsDisabling: policy.supportsDisabling,
    contextWindow: catalog.contextWindow,
    maxOutput: catalog.maxOutput,
    catalog,
  });
}

function finishResolvedSettings(input: {
  approval: ReturnType<typeof resolveApprovalSettings>;
  provider: ProviderFamily;
  model: string;
  modelConfigured: boolean;
  merged: ConfigLayer;
  selectedName?: string;
  activeProfile?: CompatibleProfile;
  thinking?: ThinkingLevel;
  reasoningCapability?: ModelCapability;
  defaultThinking?: ThinkingLevel;
  supportedThinking?: readonly ThinkingLevel[];
  supportsDisabling?: boolean;
  contextWindow: number;
  maxOutput: number;
  catalog: ModelInfo;
}): ResolvedSettings {
  return {
    approvalMode: input.approval.approvalMode,
    userApprovalMode: input.approval.userApprovalMode,
    ...(input.approval.ignoredProjectApprovalMode !== undefined ? { ignoredProjectApprovalMode: input.approval.ignoredProjectApprovalMode } : {}),
    provider: input.provider,
    model: input.model,
    modelConfigured: input.modelConfigured,
    ...(input.thinking !== undefined ? { thinking: input.thinking, effectiveThinking: input.thinking } : {}),
    ...(input.reasoningCapability ? { reasoningCapability: input.reasoningCapability } : {}),
    ...(input.defaultThinking !== undefined ? { defaultThinking: input.defaultThinking } : {}),
    ...(input.supportedThinking !== undefined ? { supportedThinking: input.supportedThinking } : {}),
    ...(input.supportsDisabling ? { supportsDisabling: true } : {}),
    maxTurns: input.merged.maxTurns ?? DEFAULT_MAX_TURNS,
    maxConcurrentTools: input.merged.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
    contextWindow: input.contextWindow,
    maxOutput: input.maxOutput,
    catalog: input.catalog,
    gitChangeTracking: input.merged.git?.changeTracking ?? DEFAULT_GIT_CHANGE_TRACKING,
    undoMaxAgeDays: input.merged.undo?.maxAgeDays ?? DEFAULT_UNDO_MAX_AGE_DAYS,
    undoMaxSizeMB: input.merged.undo?.maxSizeMB ?? DEFAULT_UNDO_MAX_SIZE_MB,
    appearance: input.merged.appearance ?? "auto",
    inlineDiffLines: input.merged.ui?.inlineDiffLines ?? DEFAULT_INLINE_DIFF_LINES,
    splash: input.merged.ui?.splash ?? "first-run",
    openaiAuth: input.merged.openaiAuth ?? "auto",
    xaiAuth: input.merged.xaiAuth ?? "auto",
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

/** Shared reasoning policy remains available to existing configuration callers. */
export { validateThinking, describeEffectiveThinking } from "../model/thinking.ts";

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

/** Read each actual config once, collecting both scopes' credential references before formatting diagnostics. */
export async function readConfigSources(paths: readonly string[], deprecations?: readonly ConfigDeprecation[], diagnosticContext?: ConfigDiagnosticContext): Promise<Map<string, Awaited<ReturnType<typeof readConfigFile>>>> {
  const identities = await Promise.all(paths.map(async path => { try { return await realpath(path); } catch { return resolve(path); } }));
  const reads = new Map<string, ReturnType<typeof readConfigInput>>();
  const inputs = await Promise.all(paths.map((path, index) => {
    const identity = identities[index]!;
    let read = reads.get(identity);
    if (!read) { read = readConfigInput(path); reads.set(identity, read); }
    return read;
  }));
  const context = { ...diagnosticContext, secrets: configDiagnosticSecrets(diagnosticContext, inputs.map(input => input && "value" in input ? input.value : undefined)) };
  const parsed = new Map<string, Awaited<ReturnType<typeof readConfigFile>>>();
  return new Map(paths.map((path, index) => {
    const identity = identities[index]!;
    if (!parsed.has(identity)) parsed.set(identity, parseConfigInput(inputs[index], path, deprecations, context));
    return [path, parsed.get(identity)];
  }));
}

/** Read both config sources before reporting failure, so one invalid file cannot hide another. */
export async function readConfigLayers(input: {
  home: string;
  workspaceRoot: string;
  configDeprecations?: readonly ConfigDeprecation[];
  diagnosticContext?: ConfigDiagnosticContext;
}): Promise<{ user?: ParsedConfigLayer; project?: ParsedConfigLayer } | ConfigReadError> {
  const paths = [userConfigPath(input.home), projectConfigPath(input.workspaceRoot)];
  const observations = await readConfigSources(paths, input.configDeprecations, input.diagnosticContext);
  const layers = paths.map(path => observations.get(path));
  const failures = [...new Set(layers)].filter((layer): layer is ConfigReadError => !!layer && "error" in layer);
  if (failures.length) return { error: failures.map(failure => failure.error).join("\n"), diagnostics: failures.flatMap(failure => failure.diagnostics) };
  const [user, project] = layers as [ParsedConfigLayer | undefined, ParsedConfigLayer | undefined];
  return { user, project };
}

/** Read config under the supplied home and workspace root, returning every invalid file reason before resolving settings. */
export async function loadResolvedSettings(input: {
  home: string;
  workspaceRoot: string;
  cli?: ConfigLayer;
  modelCapabilities?: readonly ModelCapability[];
  deferOpenAIThinking?: boolean;
  /** Headless runs must name a provider and model in config or CLI flags. */
  requireExplicitModel?: boolean;
  configDeprecations?: readonly ConfigDeprecation[];
  diagnosticContext?: ConfigDiagnosticContext;
  onDeprecation?: (warning: ConfigDeprecationWarning) => void;
}): Promise<ResolvedSettings | { error: string; diagnostics?: readonly ConfigDiagnostic[] }> {
  const layers = await readConfigLayers(input);
  if ("error" in layers) return layers;
  const { user, project } = layers;
  for (const layer of new Set([user, project])) for (const warning of layer?.deprecationWarnings ?? []) input.onDeprecation?.(warning);
  const resolved = resolveSettings({
    user,
    project,
    cli: input.cli,
    modelCapabilities: input.modelCapabilities,
    deferOpenAIThinking: input.deferOpenAIThinking,
    configSources: { user: userConfigPath(input.home), project: projectConfigPath(input.workspaceRoot) },
    diagnosticContext: input.diagnosticContext,
  });
  if ("error" in resolved) return resolved;
  if (input.requireExplicitModel && !resolved.modelConfigured) {
    return { error: NO_MODEL_CONFIGURED_MESSAGE };
  }
  return resolved;
}

type ConfigInput = { value: unknown } | { category: "unreadable" | "root" | "json"; constraint: string } | undefined;

/** Read and decode one source without formatting a path before other scopes' credential references are known. */
async function readConfigInput(path: string): Promise<ConfigInput> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (isNotFound(error)) return undefined;
    return { category: "unreadable", constraint: "Restore access to a readable config file" };
  }
  if (!text.trim()) return { category: "root", constraint: "Use a JSON object" };
  try { return { value: JSON.parse(text) }; }
  catch { return { category: "json", constraint: "Fix malformed JSON; use a JSON object with quoted setting names" }; }
}

function parseConfigInput(input: ConfigInput, path: string, deprecations: readonly ConfigDeprecation[] = CONFIG_DEPRECATIONS, diagnosticContext?: ConfigDiagnosticContext): ParsedConfigLayer | ConfigReadError | undefined {
  if (!input) return undefined;
  if ("value" in input) return parseConfigObject(input.value, path, deprecations, diagnosticContext);
  return configReadError([configDiagnostic(safeConfigSource(path, configDiagnosticSecrets(diagnosticContext)), "", input.category, input.constraint)]);
}

/** Read one config.json. Missing files are skipped; invalid files carry sanitized source-specific errors. */
export async function readConfigFile(path: string, deprecations: readonly ConfigDeprecation[] = CONFIG_DEPRECATIONS, diagnosticContext?: ConfigDiagnosticContext): Promise<ParsedConfigLayer | ConfigReadError | undefined> {
  return parseConfigInput(await readConfigInput(path), path, deprecations, diagnosticContext);
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

/** Resolve approval independently of memory, allowing project settings only to tighten the user baseline. */
export function resolveApprovalSettings(input: { user?: ConfigLayer; project?: ConfigLayer; cli?: ConfigLayer; session?: ConfigLayer }): {
  approvalMode: ApprovalMode; userApprovalMode: ApprovalMode; ignoredProjectApprovalMode?: ApprovalMode; origin: string;
} {
  const userApprovalMode = input.user?.approval?.mode ?? DEFAULT_APPROVAL_MODE;
  let approvalMode = userApprovalMode;
  let origin = input.user?.approval?.mode !== undefined ? "user-global" : "built-in default";
  const project = input.project?.approval?.mode;
  const ignoredProjectApprovalMode = project !== undefined && stricterApprovalMode(userApprovalMode, project) !== project ? project : undefined;
  if (project !== undefined && ignoredProjectApprovalMode === undefined) { approvalMode = project; origin = "project"; }
  if (input.cli?.approval?.mode !== undefined) { approvalMode = input.cli.approval.mode; origin = "CLI"; }
  if (input.session?.approval?.mode !== undefined) { approvalMode = input.session.approval.mode; origin = "current-session override"; }
  return { approvalMode, userApprovalMode, ignoredProjectApprovalMode, origin };
}

/** Explain an ignored project approval value using its user-file baseline and source path. */
export function ignoredProjectApprovalNotice(settings: ResolvedSettings, path: string): string | undefined {
  return settings.ignoredProjectApprovalMode === undefined ? undefined
    : `Ignored approval.mode "${settings.ignoredProjectApprovalMode}" in ${path}: project config can only make approval stricter than your "${settings.userApprovalMode}" setting.`;
}
