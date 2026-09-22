import { BUILTIN_DEFAULTS, CONFIG_SETTING_NAMES, mergeConfigLayers, parseConfigObject, projectConfigPath, readConfigFile, resolveSettings, userConfigPath, type ConfigLayer, type ResolvedSettings } from "./config.ts";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Settings that can be applied immediately without reloading executable extensions or accepting arbitrary secrets. */
export const EDITABLE_CONFIG_KEYS = ["provider", "model", "maxTurns", "maxConcurrentTools", "contextWindow", "maxOutput", "baseUrl", "auth"] as const;

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
  const origins: ConfigOrigins = {};
  let merged: ConfigLayer = {};
  for (const [origin, layer] of [["built-in default", BUILTIN_DEFAULTS], ["user-global", layers.user], ["project", layers.project], ["CLI", layers.cli], ["current-session override", layers.session]] as const) {
    if (!layer) continue;
    if (layer.provider !== undefined && layer.provider !== merged.provider && layer.model === undefined) delete origins.model;
    for (const key of CONFIG_SETTING_NAMES) if (layer[key] !== undefined) origins[key] = origin;
    merged = mergeConfigLayers(merged, layer);
  }
  origins.model ??= "built-in default";
  origins.contextWindow ??= "catalog";
  origins.maxOutput ??= "catalog";
  origins.auth ??= "built-in default";
  return origins;
}

/** Own validated config layers and prepare edits without publishing partially staged settings. */
export class ConfigEditor {
  private layers: Layers;
  private revision = 0;
  private committing = false;
  private current: ResolvedSettings;

  /** Initialize from validated layers without reading or writing configuration files. */
  constructor(layers: Layers, private readonly paths: { user: string; project: string }) {
    this.layers = structuredClone(layers);
    this.current = resolved(this.layers);
  }

  /** Return a copy of effective settings so callers cannot alter committed layers. */
  get settings(): ResolvedSettings { return structuredClone(this.current); }

  /** Return the source of each currently effective setting. */
  get origins(): ConfigOrigins { return configOrigins(this.layers); }

  /** Stage a different primary workspace's project layer while retaining user, CLI and session settings. */
  async forWorkspace(workspaceRoot: string): Promise<ConfigEditor> {
    const path = projectConfigPath(workspaceRoot);
    const project = await readConfigFile(path);
    if (project && "error" in project) throw new Error(project.error);
    return new ConfigEditor({ ...this.layers, project }, { ...this.paths, project: path });
  }

  /** Stage one validated setting edit, retaining the previous settings until commit. */
  async prepare(edit: ConfigEdit): Promise<ConfigTransaction> {
    return this.prepareChanges(edit.scope, [edit]);
  }

  /** Stage provider and model together as one session override. */
  async prepareModel(provider: string, model: string): Promise<ConfigTransaction> {
    return this.prepareChanges("session", [{ key: "provider", value: provider }, { key: "model", value: model }]);
  }

  private async prepareChanges(scope: ConfigScope, changes: Array<{ key: string; value?: unknown }>): Promise<ConfigTransaction> {
    for (const edit of changes) if (!(EDITABLE_CONFIG_KEYS as readonly string[]).includes(edit.key)) throw new Error(`Unsupported or secret setting. Editable keys: ${EDITABLE_CONFIG_KEYS.join(", ")}. API-key/token fields are not ordinary configuration.`);
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
    for (const edit of changes) {
      if (edit.value === undefined) delete layer[edit.key];
      else layer[edit.key] = edit.value;
    }
    const parsed = parseConfigObject(layer, scope);
    if ("error" in parsed) throw new Error(parsed.error);
    for (const edit of changes) if ((edit.key === "model" || edit.key === "baseUrl") && edit.value !== undefined && !parsed[edit.key]?.trim()) throw new Error(`${edit.key} must be a nonempty string.`);
    const layers = { ...this.layers, [scope]: parsed };
    const settings = resolved(layers);
    return { settings, origins: configOrigins(layers), commit: async (signal) => {
      signal?.throwIfAborted();
      if (revision !== this.revision || this.committing) throw new Error("Configuration changed while this edit was staged. Retry the edit.");
      this.committing = true;
      try {
        const saved = { ...source } as Record<string, unknown>;
        for (const edit of changes) {
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

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

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

function resolved(layers: Layers): ResolvedSettings {
  const settings = resolveSettings(layers);
  if ("error" in settings) throw new Error(settings.error);
  return settings;
}
