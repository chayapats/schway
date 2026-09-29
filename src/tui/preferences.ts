import type { ConfigEditor, ConfigScope } from "../config/editing.ts";
import { resolveThinkingPolicy, describeEffectiveThinking, isOpenRouterEndpoint, validateThinking } from "../model/thinking.ts";
import { redactSecrets } from "../auth/secrets.ts";

/** A bounded ordinary preference or an explicitly separate complete model-choice action. */
export interface PreferenceRow {
  key: string;
  value: string;
  origin: string;
  saved: string;
  reset: string;
  choices: readonly unknown[];
}

/** Keyboard selection and preview, with no raw configuration or credential fields. */
export interface PreferencesSnapshot {
  scope: ConfigScope | "memory";
  selectedIndex: number;
  choiceIndex: number;
  rows: PreferenceRow[];
  preview?: string;
  error?: string;
}

/** Describe the effect of each scope before a preference is applied. */
export const PREFERENCE_SCOPES = {
  session: "Session only; disappears on restart. No files change.",
  memory: "Workspace memory in user-local storage; explicit config/CLI wins. Headless ignores it.",
  user: "User config; survives restart for all workspaces, below project/CLI/session.",
  project: "Project config; writes repository-owned .schway/config.json ONLY on confirmation.",
} as const;

/** Build a secret-free view from the same editor used by the effective resolver. */
export function preferenceRows(editor: ConfigEditor, scope: PreferencesSnapshot["scope"], secrets: readonly string[], appearanceEnvironment?: "dark" | "light"): PreferenceRow[] {
  const settings = editor.settings;
  const safe = (value: unknown) => redactSecrets(value === undefined ? "unset" : String(value), secrets).replace(/https?:\/\/[^\s]+/g, "[URL hidden]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  const layers = editor.preferenceLayers;
  const labels: Record<string, string> = { memory: "workspace memory", user: "user config", project: "project config", cli: "CLI", session: "session" };
  const listed = settings.provider === "xai" || settings.openaiAuth === "codex" || (settings.provider === "openai-compatible" && isOpenRouterEndpoint(settings.baseUrl));
  const context = { baseUrl: settings.baseUrl, extraBody: settings.extraBody, ...(listed ? { capability: settings.reasoningCapability ?? null } : {}) };
  const policy = resolveThinkingPolicy({ provider: settings.provider, model: settings.model, ...context });
  const choices: Record<string, readonly unknown[]> = {
    thinking: [undefined, ...policy.supported.filter(level => !validateThinking(settings.provider, settings.model, level, settings.extraBody, context.capability, settings.baseUrl))],
    maxTurns: [undefined, 8, 16, 32, 64, 128], maxConcurrentTools: [undefined, 1, 2, 5, 10, 20],
    contextWindow: [undefined, 8192, 32768, 65536, 131072, 200000],
    maxOutput: [undefined, 1024, 4096, 8192, 16384, 32768],
    git: [undefined, "off", "on-demand", "snapshot"],
    appearance: [undefined, "auto", "dark", "light"],
  };
  if (scope === "memory") return [{ key: "workspace choice", value: safe(`${settings.provider}/${settings.model} (${settings.provider === "xai" ? settings.xaiAuth : settings.openaiAuth ?? settings.auth})`), origin: editor.origins.model ?? "built-in default",
    saved: layers.memory?.model ? safe(`${layers.memory.provider}/${layers.memory.model} (${(layers.memory.provider === "xai" ? layers.memory.xaiAuth : layers.memory.openaiAuth) ?? "provider auth"}); thinking ${layers.memory.thinking ?? "default"}; profile ${layers.memory.profile ?? "none"}`) : "unset",
    reset: "Reset removes only workspace memory; explicit config and session overrides remain.", choices: ["remember active choice", "reset workspace memory"] }];
  return ["thinking", "maxTurns", "maxConcurrentTools", "contextWindow", "maxOutput", "git", "provider", "model", "profile", "auth", "openaiAuth", "xaiAuth", "appearance"].map(key => {
    const origin = safe(editor.origins[key as keyof typeof editor.origins] ?? "built-in default");
    const originScope = origin === "CLI" ? undefined : origin === "interactive memory" ? "memory" : origin === "user-global" ? "user" : origin === "project" ? "project" : origin === "current-session override" ? "session" : undefined;
    const memoryConflict = ["session", "cli", "project", "user"].flatMap(name => {
      const layer = layers[name], memory = layers.memory;
      if (!layer || !memory || !["model", "thinking", "profile", "provider", "openaiAuth", "xaiAuth"].includes(key)) return [];
      const conflict = ["provider", "profile", "openaiAuth", "xaiAuth"].find(field => layer[field] !== undefined && (layer[field] ?? undefined) !== memory[field]);
      return conflict ? [`${labels[name]} ${conflict} selection shadows workspace memory; reset that ${labels[name]} override to restore it.`] : [];
    })[0];
    return { key, value: key === "thinking" ? `${safe(settings.thinking)} (effective: ${safe(describeEffectiveThinking(settings.provider, settings.thinking, settings.model, context))})` : safe(key === "appearance" && appearanceEnvironment ? appearanceEnvironment : key === "git" ? settings.gitChangeTracking : settings[key as keyof typeof settings]), origin: key === "appearance" && appearanceEnvironment ? "environment" : origin,
      saved: Object.entries(layers).filter(([, layer]) => layer[key] !== undefined).map(([name, layer]) => `${labels[name]}=${safe(layer[key])}`).join("; ") || "No saved override",
      reset: key === "appearance" && appearanceEnvironment ? "SCHWAY_THEME overrides saved appearance. Remove it to use the saved preference; reset a scope to inherit auto." : memoryConflict ?? (origin.startsWith("profile ") ? "The selected profile supplies this value; reset its selection on the profile row or edit the named profile configuration." : origin === "CLI" ? "CLI shadows lower values: remove the launch flag to inherit." : originScope ? `Reset in ${labels[originScope]} to inherit lower values.` : "Inherited default; reset the selected scope to inherit."),
      choices: choices[key] ?? [undefined, "open model + route picker (activates and remembers)"] };
  });
}
