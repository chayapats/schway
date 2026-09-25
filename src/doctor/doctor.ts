import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { CREDENTIAL_HEADER_NAMES, redactSecrets } from "../auth/secrets.ts";
import { platform } from "node:os";
import { version } from "../../package.json";
import { COMPATIBLE_API_KEY_ENV, credentialEnvironmentVariable } from "../auth/credentials.ts";
import { codexSubscriptionIdentity, createNativeCredentialStore, credentialIdentity, type CredentialStore } from "../auth/store.ts";
import { readConfigFile, userConfigPath, projectConfigPath, resolveSettings, type ConfigLayer } from "../config/config.ts";
import { inspectPackages } from "../packages/packages.ts";
import { discoverSkills } from "../skills/skills.ts";
import { sessionsDirectory } from "../session/jsonl.ts";
import { resolveWorkspace, addWorkspaceRoots } from "../workspace/workspace.ts";
import { findGitRoot } from "../workspace/git.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import type { CliArgs } from "../cli/args.ts";
import { cliOverridesFromArgs, hasCliConnectionOptions } from "../cli/args.ts";

/** One locally evaluated readiness check, with a stable identifier and recovery action. */
export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  summary: string;
  remedy: string;
}

/** Stable local diagnostic payload; no credential values or live-provider results are included. */
export interface DoctorReport {
  schemaVersion: 1;
  version: string;
  runtime: string;
  platform: string;
  workspace?: string;
  provider?: string;
  profile?: string;
  authSource?: "runtime" | "environment" | "secure-store" | "subscription" | "none" | "unknown";
  checks: DoctorCheck[];
}

/** Diagnose the installed runtime without starting a model, logging in, or loading extension code. */
export async function diagnose(input: {
  cwd: string;
  env: Record<string, string | undefined>;
  args: CliArgs;
  store?: CredentialStore;
  signal?: AbortSignal;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: DoctorCheck["status"], summary: string, remedy = "None.") =>
    checks.push({ id, status, summary, remedy });
  const report: DoctorReport = { schemaVersion: 1, version, runtime: `Bun ${Bun.version}`, platform: `${platform()} ${process.arch}`, checks };
  input.signal?.throwIfAborted();
  add("runtime", "ok", `Schway ${version}; ${report.runtime}; ${report.platform}`);

  let workspace: string | undefined;
  let extraRoots: string[] = [];
  try {
    const resolved = await resolveWorkspace(input.cwd);
    workspace = resolved.root;
    if (input.args.addDirs?.length) {
      try {
        extraRoots = (await addWorkspaceRoots(resolved, input.args.addDirs, input.signal)).extraRoots;
        add("attachments", "ok", `${extraRoots.length} additional workspace root(s) accessible.`);
      } catch {
        input.signal?.throwIfAborted();
        add("attachments", "error", "An attached workspace directory is inaccessible.", "Correct --add-dir paths and permissions.");
      }
    }
    report.workspace = workspace;
    add("workspace", "ok", `Primary workspace: ${workspace}`);
    const gitRoot = await findGitRoot(input.cwd);
    add("git", !Bun.which("git") ? "warning" : gitRoot ? "ok" : "warning", !Bun.which("git") ? "Git executable unavailable; workspace paths still resolve." : gitRoot ? "Git workspace available." : "No Git repository; using launch directory.", "Install git and initialize a repository if Git inspection is needed.");
  } catch {
    add("workspace", "error", "Primary workspace cannot be accessed.", "Run doctor from a readable directory.");
    add("git", "warning", "Git workspace could not be determined.", "Restore workspace access and retry.");
  }
  for (const [id, executable, remedy] of [
    ["shell", "bash", "Install bash and ensure it is on PATH."],
    ["search", "rg", "Install ripgrep (rg) and ensure it is on PATH."],
  ] as const) {
    add(id, Bun.which(executable) ? "ok" : "error", Bun.which(executable) ? `${executable} available.` : `${executable} not found on PATH.`, remedy);
  }

  let env = input.env;
  if (input.args.envFiles?.length) {
    try {
      const loaded = await applyEnvFiles(input.args.envFiles.map(path => resolve(input.cwd, path)), env);
      if ("error" in loaded) add("env-files", "error", "An explicitly enabled environment file could not be loaded.", "Check --env-file paths and syntax.");
      else { env = loaded; add("env-files", "ok", "Explicit environment files loaded for presence checks."); }
    } catch { add("env-files", "error", "Environment file inspection failed.", "Check --env-file paths and permissions."); }
  }
  // Normal CLI requires process HOME before reading --env-file; overlays may provide keys but cannot move storage.
  const home = input.env.HOME;
  if (!home) add("sessions", "error", "HOME is unset; session storage unavailable.", "Set HOME to a writable home directory.");
  else {
    const directory = sessionsDirectory(home);
    try {
      let current = directory;
      let exists = true;
      while (true) {
        try { const info = await stat(current); if (!info.isDirectory()) throw new Error("not a directory"); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          exists = false;
          const parent = dirname(current);
          if (parent === current) throw error;
          current = parent;
        }
      }
      await access(current, constants.R_OK | constants.W_OK | constants.X_OK);
      add("sessions", exists ? "ok" : "warning", exists ? "Session directory accessible." : "Session directory not created yet; writable parent available.", "Make ~/.schway/sessions readable and writable.");
    } catch {
      add("sessions", "error", "Session directory or its parent is inaccessible.", "Make ~/.schway/sessions a readable and writable directory, or fix HOME permissions.");
    }
  }

  let user: ConfigLayer | undefined;
  let project: ConfigLayer | undefined;
  for (const [scope, path] of [
    ...(home ? [["user", userConfigPath(home)] as const] : []),
    ...(workspace ? [["project", projectConfigPath(workspace)] as const] : []),
  ]) {
    try {
      const config = await readConfigFile(path);
      if (config && "error" in config) add(`config.${scope}`, "error", `Invalid ${scope} configuration.`, `Correct or remove ${path}; validate JSON and setting names.`);
      else {
        if (scope === "user") user = config;
        else project = config;
        add(`config.${scope}`, "ok", config ? `${scope} configuration valid.` : `${scope} configuration not present; defaults apply.`);
      }
    } catch {
      add(`config.${scope}`, "error", `Cannot inspect ${scope} configuration.`, `Check access to ${path}.`);
    }
  }
  const invalidConfig = checks.some(c => c.id.startsWith("config.") && c.status === "error");
  const settings = resolveSettings({ user, project, cli: cliOverridesFromArgs(input.args) });
  if (invalidConfig) add("provider", "warning", "Provider selection may change after invalid configuration is fixed.", "Fix configuration, then rerun doctor.");
  else if ("error" in settings) {
    add("provider", "error", "Provider or profile settings cannot be resolved (unknown profile, incompatible mode, or missing endpoint).", "Check --profile, --provider and --base-url against configured profiles.");
  } else if (hasCliConnectionOptions(input.args) && settings.provider !== "openai-compatible") {
    add("provider", "error", "OpenAI-compatible connection flags conflict with the selected provider.", "Select --provider openai-compatible or remove --base-url, --header, --body, --auth and --profile.");
  } else if (input.args.openaiAuth !== undefined && settings.provider !== "openai") {
    add("provider", "error", "OpenAI auth preference conflicts with the selected provider.", "Select --provider openai or remove --openai-auth.");
  } else {
    report.provider = settings.provider;
    if (settings.profile) report.profile = settings.profile;
    add("provider", "ok", `${settings.provider}${settings.profile ? ` profile ${settings.profile}` : ""} selected.`);
    const store = input.store ?? createNativeCredentialStore();
    const runtime = input.args.apiKey;
    const envName = settings.credentialEnv ?? credentialEnvironmentVariable(settings.provider);
    const environment = env[envName];
    const preferred = settings.provider === "openai" ? settings.openaiAuth ?? "auto" : "api-key";
    const optional = settings.provider === "openai-compatible" && (settings.auth ?? "optional") !== "required";
    const none = settings.provider === "openai-compatible" && settings.auth === "none";
    const subscription = async (): Promise<"present" | "missing" | "unavailable" | "refresh" | "expired" | "invalid"> => {
      try {
        const raw = await store.get(codexSubscriptionIdentity());
        if (!raw?.trim()) return "missing";
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return "invalid"; }
        if (typeof parsed !== "object" || !parsed || !("accessToken" in parsed) || typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) return "invalid";
        const token = parsed as { expiresAt?: unknown; refreshToken?: unknown };
        // Match the provider's finite expiry/skew rule without importing its executable adapter.
        if (typeof token.expiresAt === "number" && Number.isFinite(token.expiresAt) && token.expiresAt <= Date.now() + 60_000)
          return typeof token.refreshToken === "string" && token.refreshToken.trim() ? "refresh" : "expired";
        return "present";
      } catch { return "unavailable"; }
    };
    let sub: Awaited<ReturnType<typeof subscription>> | undefined;
    let storedOpenAI: string | null | undefined;
    let storeUnavailable = false;
    const emptyOverride = runtime !== undefined && !runtime.trim();
    if (!emptyOverride && settings.provider === "openai" && preferred === "codex") sub = await subscription();
    if (!emptyOverride && settings.provider === "openai" && preferred === "auto" && !runtime?.trim() && !environment?.trim()) {
      // Auto selection checks BOTH identities, even if the subscription is present.
      // A failure of either read prevents healthy fallback to the other billing mode.
      sub = await subscription();
      if (sub === "unavailable") storeUnavailable = true;
      else try { storedOpenAI = await store.get(credentialIdentity({ provider: "openai" })); }
      catch { storeUnavailable = true; }
    }
    const useSubscription = preferred === "codex" || (preferred === "auto" && !runtime?.trim() && !environment?.trim() && (sub === "present" || sub === "refresh" || sub === "expired" || sub === "invalid"));
    if (emptyOverride) {
      report.authSource = "runtime";
      add("auth", "error", "Explicit API key is empty.", "Supply a nonempty --api-key or remove it.");
    } else if (storeUnavailable) {
      report.authSource = "unknown";
      add("auth", "error", "OS secure store unavailable or locked; OpenAI auto selection cannot inspect both identities.", "Unlock/allow access to the OS secure store or explicitly select --openai-auth api-key with a supplied --api-key / OPENAI_API_KEY.");
    } else if (useSubscription) {
      report.authSource = "subscription";
      if (sub === "present") add("auth", "ok", "ChatGPT subscription login present; access-token status checked locally.");
      else if (sub === "refresh") add("auth", "warning", "ChatGPT access token needs refresh; refresh token present (not tested).", "Refresh occurs during a future model request; sign in again if it fails.");
      else add("auth", "error", sub === "expired" ? "ChatGPT access token expired without a refresh token." : sub === "unavailable" ? "OS secure store unavailable or locked." : sub === "invalid" ? "Stored subscription login is invalid." : "No ChatGPT subscription login found.", "Unlock the OS secure store or sign in interactively with /login codex; choose --openai-auth api-key to use an API key.");
    } else if (runtime?.trim()) {
      report.authSource = "runtime";
      add("auth", "ok", "Runtime API key present.");
    } else if (none) {
      report.authSource = "none";
      add("auth", "ok", "Authentication disabled for compatible endpoint.");
    } else if (environment?.trim()) {
      report.authSource = "environment";
      add("auth", "ok", `API key present in ${envName}.`);
    } else {
      try {
        const identity = credentialIdentity(settings);
        const stored = storedOpenAI !== undefined ? storedOpenAI : await store.get(identity);
        if (stored?.trim()) {
          report.authSource = "secure-store";
          add("auth", "ok", "Selected API key present in OS secure store.");
        } else {
          report.authSource = "none";
          add("auth", optional ? "warning" : "error", optional ? "Optional auth: no credential configured; unauthenticated endpoint can be used." : "Required API key is missing.", `Set ${envName}, pass --api-key, or save a key interactively.`);
        }
      } catch {
        report.authSource = "unknown";
        add("auth", optional ? "warning" : "error", "OS secure store unavailable or locked; credential presence unknown.", `Unlock/allow the OS secure store, or set ${envName}; optional endpoints may run unauthenticated.`);
      }
      if (settings.provider === "openai" && sub === "unavailable") add("subscription", "warning", "Subscription status unavailable (OS secure store locked).", "Unlock the store to inspect subscription login.");
    }
  }

  if (workspace) {
    try {
      const inspected = await inspectPackages({ workspaceRoot: workspace, home, signal: input.signal });
      add("packages", "ok", `${inspected.packages.length} enabled package manifest(s) valid.`);
      // Bound identifiers and redact only known credential sources: ordinary env/header values are not keys.
      const credentialEnvNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", COMPATIBLE_API_KEY_ENV,
        ...(!("error" in settings) && settings.credentialEnv ? [settings.credentialEnv] : [])];
      const credentialHeaders = Object.entries(input.args.headers ?? {})
        .filter(([name]) => CREDENTIAL_HEADER_NAMES.has(name.trim().toLowerCase()))
        .flatMap(([, value]) => {
          // Authorization schemes prefix the actual credential; redact both forms.
          const token = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(value.trim())?.[1];
          return token ? [value, token] : [value];
        });
      const secrets = [input.args.apiKey, ...credentialEnvNames.map(name => env[name]), ...credentialHeaders]
        .filter((value): value is string => !!value).sort((a, b) => b.length - a.length);
      const safeName = (value: string) => redactSecrets(value, secrets).replace(/[^a-zA-Z0-9._*/-]/g, "?").slice(0, 64);
      const safeEntry = (value: string) => {
        const redacted = redactSecrets(value, secrets).replace(/[^a-zA-Z0-9._*/-]/g, "?");
        return redacted.length > 64 ? `...${redacted.slice(-61)}` : redacted;
      };
      for (let i = 0; i < inspected.issues.length; i++) {
        const issue = inspected.issues[i]!;
        const subject = issue.name ? `${issue.scope} package ${safeName(issue.name)}` : `${issue.scope} package configuration`;
        const category = issue.kind === "configuration" ? "is invalid or unreadable" : issue.kind === "missing" ? "has a missing installation" : issue.kind === "entry" ? `has missing declared entry ${safeEntry(issue.entry ?? "unknown")}` : issue.kind === "peer" ? "has an invalid or incompatible peer declaration" : "has an invalid manifest";
        add(`package.${i}`, "error", `${subject} ${category}.`, issue.kind === "entry" ? `Restore declared path ${safeEntry(issue.entry ?? "unknown")} inside ${safeName(issue.name ?? "package")}, or remove it from that package's schway manifest.` : issue.name ? `Inspect the schway manifest and declared paths for ${safeName(issue.name)}; install it in its configured scope or remove its enablement.` : "Correct the invalid package configuration or restore access to it.");
      }
      // Discovery accepts already validated packages and never imports extension registration code.
      try {
        const skills = await discoverSkills({ workspaceRoot: workspace, extraRoots, home, packages: inspected.packages, signal: input.signal });
        add("skills", "ok", `${skills.skills.length} skill(s) available.`);
        for (let i = 0; i < skills.diagnostics.length; i++) {
          const source = skills.diagnostics[i]!.source;
          const identifier = safeName(basename(source.endsWith("SKILL.md") ? dirname(source) : source));
          add(`skill.invalid.${i}`, "error", `Skill metadata invalid or unreadable in ${identifier}.`, `Repair SKILL.md for ${identifier} (frontmatter, body or permissions) under .agents/skills, ~/.schway/skills or its configured package.`);
        }
        for (const [i, duplicate] of skills.ambiguous.entries()) add(`skill.duplicate.${i}`, "error", `Duplicate skill name: ${safeName(duplicate.name)}.`, "Rename or remove a duplicate skill in the same precedence tier.");
        for (const [i, collision] of skills.collisions.entries()) add(`skill.collision.${i}`, "error", `Skill ${safeName(collision.name)} collides with a built-in command.`, "Rename the skill.");
      } catch {
        input.signal?.throwIfAborted();
        add("skills", "error", "Unable to inspect skill metadata.", "Check skill directories and permissions.");
      }
      const identities = new Set<string>();
      const entries = [...inspected.packages.flatMap(pkg => pkg.extensions), ...(input.args.extensions ?? []).map(path => resolve(workspace, path))];
      if (!entries.length) add("extensions", "ok", "No executable extensions enabled (optional capability disabled).");
      for (let i = 0; i < entries.length; i++) {
        try {
          const canonical = await realpath(entries[i]!);
          if (!(await stat(canonical)).isFile()) throw new Error("not a file");
          if (identities.has(canonical)) add(`extension.${i}`, "error", `Duplicate enabled extension module ${safeName(basename(entries[i]!))}.`, "Remove one duplicate --extension or package entry.");
          else { identities.add(canonical); add(`extension.${i}`, "ok", `Enabled extension ${safeName(basename(entries[i]!))} exists; registration not executed.`); }
        } catch { add(`extension.${i}`, "error", `Enabled extension ${safeName(basename(entries[i]!))} missing or inaccessible.`, `Restore module ${safeName(basename(entries[i]!))} in its configured package or --extension path, or remove its enablement.`); }
      }
    } catch {
      input.signal?.throwIfAborted();
      add("packages", "error", "Unable to inspect enabled package manifests.", "Check configuration and filesystem permissions.");
    }
  }
  input.signal?.throwIfAborted();
  return report;
}

/** Return documented doctor status: 0 healthy/warnings, 1 required errors. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some(check => check.status === "error") ? 1 : 0;
}

/** Render checks with concrete recovery guidance and no credential values. */
export function formatDoctor(report: DoctorReport): string {
  return report.checks.map(check => `[${check.status.toUpperCase()}] ${check.id}: ${check.summary}${check.status === "ok" ? "" : ` Fix: ${check.remedy}`}`).join("\n") + "\n";
}
