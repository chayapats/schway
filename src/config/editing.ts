import { BUILTIN_DEFAULTS, CONFIG_SETTING_NAMES, isValidProfileName, mergeConfigLayers, mergeProfileMaps, parseConfigObject, profileToLayer, projectConfigPath, readConfigFile, resolveSettings, userConfigPath, type CompatibleProfile, type ConfigLayer, type ResolvedSettings } from "./config.ts";
import { isValidProfileBaseUrl } from "./profile-name.ts";
import type { ModelCapability } from "../model/catalog.ts";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Settings that can be applied immediately without reloading executable extensions or accepting arbitrary secrets. */
export const EDITABLE_CONFIG_KEYS = ["provider", "model", "thinking", "profile", "maxTurns", "maxConcurrentTools", "contextWindow", "maxOutput", "baseUrl", "auth", "openaiAuth", "git"] as const;

/** Writable scopes ordered below CLI and current-session overrides. */
export type ConfigScope = "user" | "project" | "session";

/** A single setting mutation; omitting value removes the selected override. */
export interface ConfigEdit {
  scope: ConfigScope;
  key: string;
  value?: unknown;
}

/** Effective setting origins, with catalog budgets distinguished from explicit limits. */
export type ConfigOrigins = Partial<Record<keyof ConfigLayer, string>>;

/** A validated candidate that leaves the live configuration untouched until committed. */
export interface ConfigTransaction {
  settings: ResolvedSettings;
  origins: ConfigOrigins;
  /** Save the selected layer atomically and publish it unless cancellation precedes the rename commit point. */
  commit(signal?: AbortSignal): Promise<void>;
}

type Layers = { user?: ConfigLayer; project?: ConfigLayer; cli?: ConfigLayer; session?: ConfigLayer };

/** Resolve effective origins with the same provider-change model inheritance rules as settings. */
export function configOrigins(layers: Layers): ConfigOrigins {
  return traceOrigins(layers).origins;
}

/** Trace per-setting layer origins with provider-change model inheritance applied. */
function traceOrigins(layers: Layers): { origins: ConfigOrigins; modelFallbackSource?: string } {
  const origins: ConfigOrigins = {};
  let modelFallbackSource: string | undefined;
  let merged: ConfigLayer = {};
  for (const [origin, layer] of [["built-in default", BUILTIN_DEFAULTS], ["user-global", layers.user], ["project", layers.project], ["CLI", layers.cli], ["current-session override", layers.session]] as const) {
    if (!layer) continue;
    if (layer.provider !== undefined && merged.provider !== undefined && layer.provider !== merged.provider && layer.model === undefined) {
      delete origins.model;
      modelFallbackSource = origin;
    }
    if (layer.model !== undefined) modelFallbackSource = undefined;
    for (const key of CONFIG_SETTING_NAMES) if (layer[key] !== undefined) origins[key] = origin;
    merged = mergeConfigLayers(merged, layer);
  }
  const selectedName = merged.profile?.trim() || undefined;
  if (selectedName !== undefined && isValidProfileName(selectedName)) {
    const definitionOrigin = layers.project?.profiles?.[selectedName] !== undefined
      ? "project"
      : layers.user?.profiles?.[selectedName] !== undefined
        ? "user-global"
        : layers.cli?.profiles?.[selectedName] !== undefined
          ? "CLI"
          : layers.session?.profiles?.[selectedName] !== undefined
            ? "current-session override"
            : origins.profiles;
    const profileLabel = `profile "${selectedName}"${definitionOrigin ? ` [${definitionOrigin}]` : ""}`;
    const cliSessionOverrides = mergeConfigLayers(layers.cli, layers.session);
    const activeProfile = mergeProfileMaps(layers.user?.profiles, layers.project?.profiles, layers.cli?.profiles, layers.session?.profiles)[selectedName];
    const profileLayer = activeProfile === undefined ? undefined : profileToLayer(activeProfile);
    // File direct connection keys sit below the selected profile while file budgets stay intact.
    const strippedConnectionKeys = ["baseUrl", "model", "headers", "extraBody", "auth"] as const;
    const profileKeys = ["baseUrl", "model", "contextWindow", "maxOutput", "headers", "extraBody", "auth"] as const;
    for (const key of profileKeys) {
      if (cliSessionOverrides[key] !== undefined) {
        continue;
      }
      if (profileLayer !== undefined) {
        if (profileLayer[key] !== undefined) {
          origins[key] = profileLabel;
          continue;
        }
        if ((strippedConnectionKeys as readonly string[]).includes(key)) {
          delete origins[key];
          continue;
        }
        continue;
      }
      if (merged[key] !== undefined) {
        origins[key] = profileLabel;
      }
    }
    if (cliSessionOverrides.model === undefined && layers.user?.model === undefined && layers.project?.model === undefined) {
      modelFallbackSource = undefined;
    }
  }
  origins.model ??= "built-in default";
  origins.contextWindow ??= "catalog";
  origins.maxOutput ??= "catalog";
  origins.auth ??= "built-in default";
  origins.openaiAuth ??= "built-in default";
  origins.profile ??= selectedName !== undefined ? origins.profile ?? "built-in default" : origins.profile;
  return { origins, modelFallbackSource };
}

/** Own validated config layers and prepare edits without publishing partially staged settings. */
export class ConfigEditor {
  private layers: Layers;
  private revision = 0;
  private committing = false;
  private current: ResolvedSettings;
  private modelCapabilities?: readonly ModelCapability[];

  /** Initialize from validated layers without reading or writing configuration files. */
  constructor(layers: Layers, private readonly paths: { user: string; project: string }, capabilities?: readonly ModelCapability[]) {
    this.layers = structuredClone(layers);
    this.modelCapabilities = capabilities === undefined ? undefined : structuredClone(capabilities);
    // A saved Codex effort can be resolved after login, without blocking interactive recovery.
    const pendingCodexCatalog = this.modelCapabilities === undefined &&
      mergeConfigLayers(BUILTIN_DEFAULTS, this.layers.user, this.layers.project, this.layers.cli, this.layers.session).openaiAuth === "codex";
    this.current = resolved(this.layers, this.modelCapabilities, pendingCodexCatalog);
  }

  /** Install verified account capabilities for future session edits without persisting them. */
  setModelCapabilities(capabilities: readonly ModelCapability[]): void {
    const next = structuredClone(capabilities);
    // An incompatible saved effort must not prevent recovery or leave stale model limits.
    let settings: ResolvedSettings | undefined;
    try { settings = resolved(this.layers, next); } catch {
      try {
        const recovered = resolved({ ...this.layers, session: { ...this.layers.session, thinking: null } }, next);
        if (recovered.provider === this.current.provider && recovered.model === this.current.model && recovered.openaiAuth === this.current.openaiAuth) {
          settings = { ...recovered, thinking: this.current.thinking };
        }
      } catch { /* The next staged model edit validates against the new catalog. */ }
    }
    this.modelCapabilities = next;
    this.current = settings ?? { ...this.current, defaultThinking: undefined, supportedThinking: undefined };
    this.revision++;
  }

  /** Return a copy of effective settings so callers cannot alter committed layers. */
  get settings(): ResolvedSettings { return structuredClone(this.current); }

  /** Return the source of each currently effective setting. */
  get origins(): ConfigOrigins { return configOrigins(this.layers); }

  /** Return merged compatible profiles with project definitions replacing whole same-name profiles. */
  get profiles(): Record<string, CompatibleProfile> {
    return structuredClone(mergeProfileMaps(this.layers.user?.profiles, this.layers.project?.profiles, this.layers.cli?.profiles, this.layers.session?.profiles));
  }

  /** Identify the provider override that discarded an inherited model and selected a built-in model default. */
  get modelFallbackSource(): string | undefined { return traceOrigins(this.layers).modelFallbackSource; }

  /** Stage a different primary workspace's project layer while retaining user, CLI and session settings. */
  async forWorkspace(workspaceRoot: string): Promise<ConfigEditor> {
    const path = projectConfigPath(workspaceRoot);
    const project = await readConfigFile(path);
    if (project && "error" in project) throw new Error(project.error);
    return new ConfigEditor({ ...this.layers, project }, { ...this.paths, project: path }, this.modelCapabilities);
  }

  /** Stage one validated setting edit, retaining the previous settings until commit. */
  async prepare(edit: ConfigEdit): Promise<ConfigTransaction> {
    return this.prepareChanges(edit.scope, [edit]);
  }

  /** Stage provider and model together as one session override, clearing any profile selection. */
  async prepareModel(provider: string, model: string): Promise<ConfigTransaction> {
    const capability = provider === "openai" && this.current.openaiAuth === "codex" ? this.modelCapabilities?.find(entry => entry.id === model) : undefined;
    return this.prepareChanges("session", [
      { key: "provider", value: provider },
      { key: "model", value: model },
      // Session-only null clears profile selections from user, project, and CLI layers.
      { key: "profile", value: null },
      ...(capability && this.current.thinking && !capability.supportedThinking.includes(this.current.thinking) ? [{ key: "thinking", value: null }] : []),
    ]);
  }

  /** Stage the verified subscription choice and its transport as one session-only edit. */
  async prepareSubscriptionModel(model: string): Promise<ConfigTransaction> {
    const capability = this.modelCapabilities?.find(entry => entry.id === model);
    return this.prepareChanges("session", [
      { key: "provider", value: "openai" }, { key: "openaiAuth", value: "codex" },
      { key: "model", value: model }, { key: "profile", value: null },
      ...(capability && this.current.thinking && !capability.supportedThinking.includes(this.current.thinking) ? [{ key: "thinking", value: null }] : []),
    ]);
  }

  /** Stage a named compatible profile switch as one session override, clearing shadowed direct keys. */
  async prepareProfile(profile: string, scope: ConfigScope = "session"): Promise<ConfigTransaction> {
    const connectionKeys = ["provider", "model", "baseUrl", "auth", "contextWindow", "maxOutput"];
    return this.prepareChanges(scope, [
      { key: "profile", value: profile },
      ...(scope === "session"
        ? connectionKeys.map((key) => ({ key, value: undefined as unknown as string | undefined }))
        : []),
    ]);
  }

  private async prepareChanges(scope: ConfigScope, changes: Array<{ key: string; value?: unknown }>): Promise<ConfigTransaction> {
    for (const edit of changes) if (!(EDITABLE_CONFIG_KEYS as readonly string[]).includes(edit.key)) throw new Error(`Unsupported or secret setting. Editable keys: ${EDITABLE_CONFIG_KEYS.join(", ")}. API-key/token fields are not ordinary configuration.`);
    // A session reset of profile records the cleared marker so file and CLI selections stay cleared.
    const normalized = scope === "session"
      ? changes.map((edit) => edit.key === "profile" && edit.value === undefined ? { ...edit, value: null } : edit)
      : changes;
    const expanded = expandProfileSwitch(scope, normalized);
    const revision = this.revision;
    const path = scope === "session" ? undefined : this.paths[scope];
    const before = path ? await readText(path) : undefined;
    let source = this.layers[scope];
    if (path) {
      let json: unknown;
      try { json = before === undefined ? {} : JSON.parse(before); }
      catch { throw new Error(`Invalid config at ${path}: malformed JSON. Repair this file before editing; it was not changed.`); }
      const checked = parseConfigObject(json, path);
      if ("error" in checked) throw new Error(`${checked.error}. Repair this file before editing; it was not changed.`);
      source = json as ConfigLayer;
    }
    const layer = { ...source } as Record<string, unknown>;
    for (const edit of expanded) {
      if (edit.value === undefined) delete layer[edit.key];
      else layer[edit.key] = edit.value;
    }
    const parsed = parseConfigObject(layer, scope);
    if ("error" in parsed) throw new Error(parsed.error);
    for (const edit of expanded) if ((edit.key === "model" || edit.key === "baseUrl" || edit.key === "profile") && typeof edit.value === "string" && !parsed[edit.key]?.trim()) throw new Error(`${edit.key} must be a nonempty string.`);
    if (scope !== "session" && expanded.some(edit => edit.key === "baseUrl" && edit.value !== undefined)) validatePersistedBaseUrl(parsed.baseUrl!);
    const layers = { ...this.layers, [scope]: parsed };
    const settings = resolved(layers, this.modelCapabilities);
    return { settings, origins: configOrigins(layers), commit: async (signal) => {
      signal?.throwIfAborted();
      if (revision !== this.revision || this.committing) throw new Error("Configuration changed while this edit was staged. Retry the edit.");
      this.committing = true;
      try {
        const saved = { ...source } as Record<string, unknown>;
        for (const edit of expanded) {
          if (edit.value === undefined) delete saved[edit.key];
          else saved[edit.key] = parsed[edit.key as keyof ConfigLayer];
        }
        if (path && !(before === undefined && Object.keys(parsed).length === 0)) await atomicWrite(path, saved, before, signal);
        else signal?.throwIfAborted();
        this.layers = layers;
        this.current = settings;
        this.revision++;
      } finally { this.committing = false; }
    } };
  }
}

/** Clear stale connection keys when a session profile switch would otherwise inherit them. */
function expandProfileSwitch(scope: ConfigScope, changes: Array<{ key: string; value?: unknown }>): Array<{ key: string; value?: unknown }> {
  const setsProfile = changes.some((edit) => edit.key === "profile" && typeof edit.value === "string");
  if (scope !== "session" || !setsProfile) {
    return changes;
  }
  const explicit = new Set(changes.map((edit) => edit.key));
  const connectionKeys = ["provider", "model", "baseUrl", "auth", "contextWindow", "maxOutput"];
  const cleared = connectionKeys
    .filter((key) => !explicit.has(key))
    .map((key) => ({ key, value: undefined as unknown as string | undefined }));
  return [...changes, ...cleared];
}

/** Reject persisted base URLs that are not absolute or that carry userinfo or query parts. */
function validatePersistedBaseUrl(value: string): void {
  if (!isValidProfileBaseUrl(value)) {
    let hasUrl = true;
    try {
      new URL(value);
    } catch {
      hasUrl = false;
    }
    if (!hasUrl) {
      throw new Error("Persisted baseUrl must be an absolute URL without userinfo or query parameters. Use session scope for runtime-only URLs.");
    }
    throw new Error("Persisted baseUrl must not contain userinfo or query parameters. Use session scope for runtime-only URLs.");
  }
}

/** Read a config file as text, returning undefined when the path does not exist. */
async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Persist one config layer atomically, failing when the file changed while staged. */
async function atomicWrite(path: string, layer: ConfigLayer, before: string | undefined, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let committed = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(layer, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    signal?.throwIfAborted();
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== before) throw new Error("Configuration file changed while this edit was staged. Retry the edit.");
    // Rename is the commit point: cancellation after it cannot undo the saved edit.
    renameSync(temporary, path);
    committed = true;
  } finally { if (!committed) await rm(temporary, { force: true }).catch(() => {}); }
}

/** Load editable settings from the explicit home and primary workspace without creating files. */
export async function loadConfigEditor(input: { home: string; workspaceRoot: string; cli?: ConfigLayer }): Promise<ConfigEditor> {
  const paths = { user: userConfigPath(input.home), project: projectConfigPath(input.workspaceRoot) };
  const user = await readConfigFile(paths.user);
  if (user && "error" in user) throw new Error(user.error);
  const project = await readConfigFile(paths.project);
  if (project && "error" in project) throw new Error(project.error);
  return new ConfigEditor({ user, project, cli: input.cli }, paths);
}

/** Resolve layers to settings, throwing a readable error when validation fails. */
function resolved(layers: Layers, modelCapabilities?: readonly ModelCapability[], deferOpenAIThinking = false): ResolvedSettings {
  const settings = resolveSettings({ ...layers, modelCapabilities, deferOpenAIThinking });
  if ("error" in settings) throw new Error(settings.error);
  return settings;
}
