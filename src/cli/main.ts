import { openUndoStore, pruneUndoStore } from "../undo/store.ts";
import { isOpenRouterEndpoint } from "../model/thinking.ts";
import { formatDuration } from "../text/format.ts";
import { resolve } from "node:path";
import { createDiagnosticSink } from "../diagnostics/sink.ts";
import { diagnose, doctorExitCode, formatDoctor } from "../doctor/doctor.ts";
import { runAgentLoop } from "../agent/loop.ts";
import type { HeadlessSessionReadyEvent, RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { COMPATIBLE_API_KEY_ENV, resolveProviderCredential, selectOpenAITransport, selectXaiTransport } from "../auth/credentials.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { loadResolvedSettings, ignoredProjectApprovalNotice, projectConfigPath, type ResolvedSettings } from "../config/config.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import { createContextManager } from "../context/manager.ts";
import {
  RESERVED_SKILL_NAMES,
  discoverSkills,
  formatSkillsListing,
  isSkillNameToken,
  prepareSkillInvocation,
  splitSlashCommand,
  type SkillMetadata,
} from "../skills/skills.ts";
import type { Model } from "../model/model.ts";
import {
  createJsonlSession,
  loadJsonlSession,
  sessionsDirectory,
  type JsonlSession,
} from "../session/jsonl.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { findTool } from "../tools/find.ts";
import { grepTool } from "../tools/grep.ts";
import { lsTool } from "../tools/ls.ts";
import { readTool } from "../tools/read.ts";
import { loadExtensions } from "../extensions/loader.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";
import { loadProviderModel } from "../model/loader.ts";
import { addWorkspaceRoots, restoreWorkspace, resolveWorkspace, type Workspace } from "../workspace/workspace.ts";
import { ANTHROPIC_REMOVED_MESSAGE } from "../config/removed-provider.ts";
import {
  cliOverridesFromArgs,
  hasCliConnectionOptions,
  parseArgs,
  type CliArgs,
  type CliAuthMode,
  type CliOpenAIAuth,
  type CliThinking,
} from "./args.ts";
import { formatDoctorHelp, formatHelp } from "./help.ts";

/** Minimal writer used so tests can capture CLI output. */
export interface CliWriter {
  /** Write a text chunk to the chosen output destination without adding a newline. */
  write(chunk: string): void;
}

/** Optional fetch override used by protocol fixture tests. */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Process inputs, output sinks, and optional model/transport overrides for a CLI invocation. */
export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
  env: Record<string, string | undefined>;
  cwd: string;
  signal?: AbortSignal;
  model?: Model;
  /** Override OS credential storage for embedding or deterministic tests. */
  credentialStore?: CredentialStore;
  /** Override provider HTTP transport when the built-in model loader is used. */
  fetch?: FetchLike;
  /** Construct a model from resolved provider settings instead of using the built-in loader. */
  createModel?: (input: {
    apiKey?: string;
    provider: string;
    model?: string;
    maxTokens?: number;
    baseUrl?: string;
    headers?: Record<string, string>;
    extraBody?: Record<string, unknown>;
    auth?: CliAuthMode;
    openaiAuth?: CliOpenAIAuth;
    xaiAuth?: "auto" | "grok" | "api-key";
    thinking?: CliThinking;
  }) => Promise<Model>;
}

/** Dispatch help, diagnostics or a session; return 0 on success, 1 on failure, or 2 when doctor cannot complete. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "doctor") {
    const parsedDoctor = parseArgs(argv.slice(1));
    if ("error" in parsedDoctor && parsedDoctor.error === ANTHROPIC_REMOVED_MESSAGE) {
      io.stderr.write(`${parsedDoctor.error}\n`);
      return 1;
    }
    if ("error" in parsedDoctor || parsedDoctor.args.prompt || parsedDoctor.args.resume || parsedDoctor.args.branch) {
      const error = "error" in parsedDoctor ? parsedDoctor.error : "Invalid doctor options. Doctor does not accept prompts or session resume.";
      io.stderr.write(`${error}\nRun 'schway doctor --help' for usage.\n`);
      return 2;
    }
    if (parsedDoctor.args.help) {
      io.stdout.write(formatDoctorHelp());
      return 0;
    }
    try {
      const report = await diagnose({ cwd: io.cwd, env: io.env, args: parsedDoctor.args, store: io.credentialStore, signal: io.signal });
      io.stdout.write(parsedDoctor.args.json ? `${JSON.stringify(report)}\n` : formatDoctor(report));
      return doctorExitCode(report);
    } catch {
      io.stderr.write("Doctor could not finish · Check filesystem access and run schway doctor again\n");
      return 2;
    }
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.stderr.write(parsed.error === ANTHROPIC_REMOVED_MESSAGE ? `${parsed.error}\n` : `${parsed.error}\nRun 'schway --help' for usage.\n`);
    if (parsed.error.includes("approval")) io.stderr.write(formatHelp());
    return 1;
  }

  if (parsed.args.help) {
    io.stdout.write(formatHelp());
    return 0;
  }

  if (!parsed.args.prompt) {
    return runInteractive(parsed.args, io);
  }

  if (/^\s*\/(?:login|logout)(?:\s|$)/i.test(parsed.args.prompt)) {
    io.stderr.write("Sign-in needs interactive mode · Run schway without -p\n");
    return 1;
  }

  const home = io.env.HOME;
  if (!home) {
    io.stderr.write("Session storage unavailable · Set HOME to a writable directory\n");
    return 1;
  }

  const secrets: string[] = collectSecrets(parsed.args.apiKey, io.env);
  let diagnosticSessionId: string | undefined;
  const diagnostics = createDiagnosticSink({
    enabled: parsed.args.debug ?? false, home,
    destination: parsed.args.debugFile ? resolve(io.cwd, parsed.args.debugFile) : undefined,
    runId: crypto.randomUUID(), sessionId: () => diagnosticSessionId, secrets,
  });
  try {
  diagnostics.record("cli", "startup", { mode: "headless", resumed: !!parsed.args.resume });
  let env = io.env;
  if (parsed.args.envFiles && parsed.args.envFiles.length > 0) {
    const loadedEnv = await applyEnvFiles(
      parsed.args.envFiles.map((path) => resolve(io.cwd, path)),
      env,
    );
    if ("error" in loadedEnv) {
      diagnostics.record("config", "env_file_failed", { category: "configuration_input" }, "error");
      io.stderr.write(`${loadedEnv.error}\n`);
      return 1;
    }
    env = loadedEnv;
  }

  const directory = sessionsDirectory(home);
  let workspace: Workspace;
  let session: JsonlSession | undefined;
  if (parsed.args.resume) {
    try {
      session = await loadJsonlSession({
        directory,
        id: parsed.args.resume,
        branchId: parsed.args.branch,
      });
    } catch (error) {
      diagnostics.record("session", "resume_failed", { category: "session_load" }, "error");
      io.stderr.write(`${errorMessage(error)}\n`);
      return 1;
    }
    const restored = await restoreWorkspace({ root: session.header.workspaceRoot, launchCwd: session.header.launchCwd, extraRoots: [...session.metadata.extraRoots] });
    workspace = restored.workspace;
    diagnosticSessionId = session.header.id;
    for (const diagnostic of restored.diagnostics) io.stderr.write(`${diagnostic}\n`);
  } else {
    workspace = await resolveWorkspace(io.cwd);
  }

  try {
    workspace = await addWorkspaceRoots(workspace, parsed.args.addDirs ?? [], io.signal);
    if (session && parsed.args.addDirs?.length) session.setExtraRoots([...new Set([...session.metadata.extraRoots, ...workspace.extraRoots])]);
  } catch (error) {
    diagnostics.record("workspace", "attach_failed", { category: "workspace_setup" }, "error");
    io.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  const cliLayer = cliOverridesFromArgs(parsed.args);
  let settings = await loadResolvedSettings({
    home,
    workspaceRoot: workspace.root,
    cli: cliLayer,
    deferOpenAIThinking: !io.model && !io.createModel,
    requireExplicitModel: !io.model && !io.createModel && splitSlashCommand(parsed.args.prompt ?? "")?.name !== "skills",
  });
  if ("error" in settings) {
    diagnostics.record("config", "invalid_configuration", { category: "resolution_failed" }, "error");
    io.stderr.write(`${settings.error}\n`);
    return 1;
  }
  if (
    hasCliConnectionOptions(parsed.args) &&
    settings.provider !== "openai-compatible"
  ) {
    diagnostics.record("config", "invalid_configuration", { category: "provider_option_conflict" }, "error");
    io.stderr.write(
      `OpenAI-compatible connection options require --provider openai-compatible\nRun 'schway --help' for usage.\n`,
    );
    return 1;
  }
  if (parsed.args.xaiAuth !== undefined && settings.provider !== "xai") { io.stderr.write("xAI auth preference requires --provider xai\nRun 'schway --help' for usage.\n"); return 1; }
  if (parsed.args.openaiAuth !== undefined && settings.provider !== "openai") {
    diagnostics.record("config", "invalid_configuration", { category: "provider_option_conflict" }, "error");
    io.stderr.write(
      `OpenAI auth preference requires --provider openai\nRun 'schway --help' for usage.\n`,
    );
    return 1;
  }

  const approvalNotice = ignoredProjectApprovalNotice(settings, projectConfigPath(workspace.root));
  if (approvalNotice) io.stderr.write(`${approvalNotice}\n`);

  try { await pruneUndoStore({ home, maxAgeDays: settings.undoMaxAgeDays, maxSizeBytes: settings.undoMaxSizeMB * 1024 * 1024 }); }
  catch { diagnostics.record("undo", "prune_failed", { category: "undo_retention" }, "warn"); }
  secrets.push(...collectSecrets(undefined, env, settings.credentialEnv));
  let tools: ToolRegistry;
  let extensions: ExtensionRuntime;
  try {
    const loaded = await loadExtensions({
      modules: parsed.args.extensions ?? [], workspace, secrets, home, signal: io.signal,
      onDiagnostic: (message) => io.stderr.write(`${message}\n`),
      tools: createToolRegistry([readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool]),
    });
    tools = loaded.tools;
    extensions = loaded.runtime;
  } catch (error) {
    diagnostics.record("extension", "load_failed", { category: "extension_setup" }, "error");
    io.stderr.write(`${redactSecrets(errorMessage(error), secrets)}\n`);
    return 1;
  }

  try {
    const slash = splitSlashCommand(parsed.args.prompt);
    let skillTurn: { skill: SkillMetadata; body: string } | undefined;
    if (slash && slash.name === "skills") {
      const discovery = await discoverSkills({ workspaceRoot: workspace.root, extraRoots: workspace.extraRoots, home });
      io.stdout.write(`${formatSkillsListing(discovery)}\n`);
      return 0;
    }
    if (slash && !RESERVED_SKILL_NAMES.includes(slash.name) && isSkillNameToken(slash.name)) {
      const prepared = await prepareSkillInvocation({
        workspaceRoot: workspace.root,
        extraRoots: workspace.extraRoots,
        home,
        name: slash.name,
      });
      if (!prepared.ok) {
        io.stderr.write(`${prepared.error}\n`);
        return 1;
      }
      skillTurn = { skill: prepared.skill, body: prepared.body };
    }

    if (settings.provider === "openai" && !io.model && !io.createModel) {
      const store = io.credentialStore ?? createNativeCredentialStore();
      const transport = await selectOpenAITransport({ openaiAuth: settings.openaiAuth, runtimeApiKey: parsed.args.apiKey, env, store });
      if ("error" in transport) { io.stderr.write(`${transport.error}\n`); return 1; }
      if (transport.transport === "codex") {
        try {
          const { fetchSubscriptionCatalog } = await import("../model/providers/codex-subscription.ts");
          const capabilities = await fetchSubscriptionCatalog({ store, fetch: io.fetch, signal: io.signal });
          const configuredModel = settings.model;
          const selected = capabilities.find(entry => entry.id === configuredModel)?.id ?? capabilities[0]?.id;
          if (!selected) throw new Error("No selectable models were returned for this ChatGPT subscription.");
          if (parsed.args.model && parsed.args.model !== selected) {
            throw new Error(`Model "${parsed.args.model}" is not available for this ChatGPT subscription. Select one with /model in interactive mode.`);
          }
          const chosen = await loadResolvedSettings({ home, workspaceRoot: workspace.root,
            cli: { ...cliLayer, openaiAuth: "codex", model: selected }, modelCapabilities: capabilities });
          if ("error" in chosen) throw new Error(chosen.error);
          if (settings.model !== selected) io.stderr.write(`Selected account-available ChatGPT subscription model ${selected} for this run; saved configuration is unchanged.\n`);
          settings = chosen;
        } catch (error) {
          io.stderr.write(`${redactSecrets(errorMessage(error), secrets)}\n`);
          return 1;
        }
      } else {
        const validated = await loadResolvedSettings({ home, workspaceRoot: workspace.root, cli: cliLayer });
        if ("error" in validated) { io.stderr.write(`${validated.error}\n`); return 1; }
        settings = validated;
      }
    }
    if (settings.provider === "xai" && settings.thinking !== undefined && !io.model) {
      const store = io.credentialStore ?? createNativeCredentialStore();
      const selected = await selectXaiTransport({ xaiAuth: settings.xaiAuth, runtimeApiKey: parsed.args.apiKey, env, store });
      if ("error" in selected) { io.stderr.write(`${selected.error}\n`); return 1; }
      try {
        const { XAI_MODELS_URL } = await import("../model/providers/xai.ts");
        const { fetchProviderModelList, requireXaiModels, xaiModelCapabilities } = await import("../model/model-list.ts");
        const credential = selected.transport === "grok" ? undefined : await resolveProviderCredential({ provider: "xai", runtimeApiKey: parsed.args.apiKey, env, store });
        if (credential && "error" in credential) throw new Error(credential.error);
        const models = selected.transport === "grok"
          ? await (await import("../model/providers/grok-subscription.ts")).fetchSubscriptionModels({ store, fetch: io.fetch, signal: io.signal })
          : requireXaiModels(await fetchProviderModelList({ url: XAI_MODELS_URL, apiKey: credential?.apiKey, fetch: io.fetch, signal: io.signal, label: "xAI" }));
        const chosen = await loadResolvedSettings({
          home, workspaceRoot: workspace.root, cli: cliLayer, modelCapabilities: xaiModelCapabilities(models, selected.transport === "grok" ? "grok" : "api-key"),
        });
        if ("error" in chosen) throw new Error(chosen.error);
        settings = chosen;
      } catch (error) {
        io.stderr.write(`${redactSecrets(errorMessage(error), secrets)}\n`);
        return 1;
      }
    }
    if (settings.provider === "openai-compatible" && isOpenRouterEndpoint(settings.baseUrl) && !io.model && settings.thinking !== undefined) {
      try {
        const store = io.credentialStore ?? createNativeCredentialStore();
        const credential = await resolveProviderCredential({ provider: settings.provider, baseUrl: settings.baseUrl, auth: settings.auth,
          profile: settings.profile, credentialEnv: settings.credentialEnv, credentialIdentity: settings.credentialIdentity,
          runtimeApiKey: parsed.args.apiKey, env, store });
        if ("error" in credential) throw new Error(credential.error);
        const { fetchProviderModelList, openRouterModelCapabilities } = await import("../model/model-list.ts");
        const models = await fetchProviderModelList({ url: "https://openrouter.ai/api/v1/models", apiKey: credential.apiKey,
          headers: settings.headers, fetch: io.fetch, signal: io.signal, label: "OpenRouter" });
        const chosen = await loadResolvedSettings({ home, workspaceRoot: workspace.root, cli: cliLayer, modelCapabilities: openRouterModelCapabilities(models) });
        if ("error" in chosen) throw new Error(chosen.error);
        settings = chosen;
      } catch (error) { io.stderr.write(`${redactSecrets(errorMessage(error), secrets)}\n`); return 1; }
    }
    diagnostics.record("config", "resolved", { provider: settings.provider, model: settings.model, maxTurns: settings.maxTurns, maxConcurrentTools: settings.maxConcurrentTools, resumed: !!session });

    let model = io.model;
    if (!model) {
      const loaded = await loadCliModel(settings, parsed.args.apiKey, { ...io, env }, secrets);
      if ("error" in loaded) {
        diagnostics.record("model", "load_failed", { provider: settings.provider, category: "model_unavailable" }, "error");
        io.stderr.write(`${loaded.error}\n`);
        return 1;
      }
      if (loaded.notice) {
        io.stderr.write(`${loaded.notice}\n`);
      }
      model = loaded.model;
    }

    if (!session) {
      session = await createJsonlSession({ directory, workspace });
      diagnosticSessionId = session.header.id;
    }
    diagnostics.record("session", "ready", { resumed: !!parsed.args.resume });
    if (parsed.args.json && session.persisted) {
      const event: HeadlessSessionReadyEvent = { type: "session.ready", sessionId: session.header.id };
      const ready = headlessSessionReadyPreamble(event, secrets);
      if (ready) {
        io.stdout.write(`${JSON.stringify(ready)}\n`);
      }
    }
    session.append({
      type: "user",
      id: crypto.randomUUID(),
      content: [{ type: "text", text: parsed.args.prompt }],
    });

    let failed = false;
    let printedText = false;
    const contextManager = createContextManager(workspace, {
      home,
      contextWindow: settings.contextWindow,
    });
    if (skillTurn) {
      contextManager.setActiveSkill({
        name: skillTurn.skill.name,
        body: skillTurn.body,
        source: skillTurn.skill.displayPath,
        scope: skillTurn.skill.scope,
        dir: skillTurn.skill.dir,
      });
    }
    const approvalSettings = settings;
    try {
      for await (const event of runAgentLoop({
        approval: { interactive: false, mode: () => approvalSettings.approvalMode },
        undo: openUndoStore({ home }),
        session,
        model,
        contextManager,
        tools,
        extensions,
        workspace,
        signal: io.signal,
        maxTurns: settings.maxTurns,
        maxConcurrentTools: settings.maxConcurrentTools,
      })) {
        diagnostics.runtime(event);
        const safeEvent = redactEvent(event, secrets);
        if (parsed.args.json) {
          io.stdout.write(`${JSON.stringify(safeEvent)}\n`);
        } else if (
          safeEvent.type === "model.delta" &&
          safeEvent.content.type === "text"
        ) {
          io.stdout.write(safeEvent.content.text);
          printedText = true;
        } else if (safeEvent.type === "model.retry") {
          if (printedText) {
            io.stdout.write("\n");
            printedText = false;
          }
          io.stderr.write(
            `Retry ${safeEvent.attempt}/${safeEvent.maxAttempts} · Waiting ${formatDuration(safeEvent.delayMs)} · Ctrl+C stop\n${safeEvent.message}\n`,
          );
        }

        if (safeEvent.type === "error") {
          if (!parsed.args.json && printedText) {
            io.stdout.write("\n");
            printedText = false;
          }
          failed = true;
          io.stderr.write(`${safeEvent.message}\n`);
        } else if (
          safeEvent.type === "agent.finished" &&
          (safeEvent.reason === "error" || safeEvent.reason === "cancelled")
        ) {
          failed = true;
        }
      }
    } finally {
      contextManager.clearActiveSkill();
    }

    if (!parsed.args.json && printedText && !failed) {
      io.stdout.write("\n");
    }

    return failed ? 1 : 0;
  } finally {
    extensions.dispose();
  }
  } catch (error) {
    diagnostics.record("cli", "setup_failed", { category: "unexpected_setup_failure" }, "error");
    throw error;
  } finally {
    await diagnostics.close();
  }
}

/** Normalize thrown values into a printable error string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Gather runtime and environment API keys so output can redact them. */
function collectSecrets(
  runtimeApiKey: string | undefined,
  env: Record<string, string | undefined>,
  credentialEnv?: string,
): string[] {
  const secrets: string[] = [];
  if (runtimeApiKey) {
    secrets.push(runtimeApiKey);
  }
  // The route is gone, but a leftover key can still reach tool output through the inherited environment.
  const legacyAnthropicKey = env.ANTHROPIC_API_KEY;
  if (legacyAnthropicKey) secrets.push(legacyAnthropicKey);
  const compatibleKey = env[COMPATIBLE_API_KEY_ENV];
  if (compatibleKey) secrets.push(compatibleKey);
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    secrets.push(openaiKey);
  }
  const xaiKey = env.XAI_API_KEY;
  if (xaiKey) secrets.push(xaiKey);
  if (credentialEnv && credentialEnv !== COMPATIBLE_API_KEY_ENV) {
    const profileKey = env[credentialEnv];
    if (profileKey) secrets.push(profileKey);
  }
  return secrets;
}

/**
 * Emit the exact persisted session ID for --resume.
 * If that ID would expose a collected secret substring, suppress the preamble
 * instead of mangling the ID (e.g. OPENAI_API_KEY="-" vs UUID hyphens).
 */
function headlessSessionReadyPreamble(
  event: HeadlessSessionReadyEvent,
  secrets: readonly string[],
): HeadlessSessionReadyEvent | null {
  for (const secret of secrets) {
    if (secret.length > 0 && event.sessionId.includes(secret)) {
      return null;
    }
  }
  return event;
}

/** Redact configured secrets from event fields that can reach stdout. */
function redactEvent(event: RuntimeEvent, secrets: readonly string[]): RuntimeEvent {
  if (event.type === "error" || event.type === "model.retry") {
    return { ...event, message: redactSecrets(event.message, secrets) };
  }
  if (event.type === "tool.denied") return { ...event, reason: redactSecrets(event.reason, secrets) };
  if (event.type === "tool.finished") {
    return {
      ...event,
      content: redactSecrets(event.content, secrets),
      ...(event.details !== undefined
        ? { details: redactJsonValue(event.details, secrets) }
        : {}),
    };
  }
  if (event.type === "tool.delta") {
    return {
      ...event,
      text: redactSecrets(event.text, secrets),
    };
  }
  if (event.type === "model.delta") {
    return {
      ...event,
      content: {
        ...event.content,
        text: redactSecrets(event.content.text, secrets),
      },
    };
  }
  return event;
}

/** Redact secrets inside structured tool details that JSON events may print. */
function redactJsonValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactJsonValue(nested, secrets),
      ]),
    );
  }
  return value;
}

/** Resolve credentials and construct the selected provider model. */
async function loadCliModel(
  settings: ResolvedSettings,
  runtimeApiKey: string | undefined,
  io: CliIo,
  secrets: string[],
): Promise<{ model: Model; notice?: string } | { error: string }> {
  const credentialStore = io.credentialStore ?? createNativeCredentialStore();
  if (settings.provider === "openai") {
    const selection = await selectOpenAITransport({
      openaiAuth: settings.openaiAuth,
      runtimeApiKey,
      env: io.env,
      store: credentialStore,
    });
    if ("error" in selection) return selection;
    if (selection.transport === "codex") {
      const input = {
        provider: settings.provider,
        model: settings.model,
        maxTokens: settings.maxOutput,
        ...(settings.thinking !== undefined ? { thinking: settings.thinking } : {}),
        ...(settings.supportedThinking !== undefined ? { modelCapability: settings.reasoningCapability ?? { id: settings.model, supportedThinking: settings.supportedThinking, ...(settings.supportsDisabling ? { supportsDisabling: true } : {}) } } : {}),
        openaiAuth: "codex" as const,
      };
      try {
        const model = io.createModel
          ? await io.createModel(input)
          : await loadProviderModel({ ...input, codexStore: credentialStore }, io.fetch);
        return selection.notice !== undefined ? { model, notice: selection.notice } : { model };
      } catch (error) {
        return { error: redactSecrets(errorMessage(error), secrets) };
      }
    }
  }
  if (settings.provider === "xai") {
    const selection = await selectXaiTransport({ xaiAuth: settings.xaiAuth, runtimeApiKey, env: io.env, store: credentialStore });
    if ("error" in selection) return selection;
    if (selection.transport === "grok") {
      const input = { provider: "xai" as const, xaiAuth: "grok" as const, model: settings.model, maxTokens: settings.maxOutput, thinking: settings.thinking,
        ...(settings.supportedThinking !== undefined ? { modelCapability: settings.reasoningCapability ?? { id: settings.model, supportedThinking: settings.supportedThinking, supportsDisabling: settings.supportsDisabling } } : {}) };
      try { return { model: io.createModel ? await io.createModel(input) : await loadProviderModel({ ...input, grokStore: credentialStore }, io.fetch) }; }
      catch (error) { return { error: redactSecrets(errorMessage(error), secrets) }; }
    }
  }
  const credential = await resolveProviderCredential({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    auth: settings.auth,
    profile: settings.profile,
    credentialEnv: settings.credentialEnv,
    credentialIdentity: settings.credentialIdentity,
    runtimeApiKey,
    env: io.env,
    store: credentialStore,
  });
  if ("error" in credential) return credential;
  if (credential.apiKey) secrets.push(credential.apiKey);
  const input = {
    apiKey: credential.apiKey,
    provider: settings.provider,
    model: settings.model,
    maxTokens: settings.maxOutput,
    ...(settings.thinking !== undefined ? { thinking: settings.thinking } : {}),
    ...(settings.provider === "xai" && settings.supportedThinking !== undefined ? { modelCapability: {
      id: settings.model, supportedThinking: settings.supportedThinking, ...(settings.supportsDisabling ? { supportsDisabling: true } : {}),
      ...(settings.defaultThinking ? { defaultThinking: settings.defaultThinking } : {}),
    } } : {}),
    ...(settings.reasoningCapability ? { modelCapability: settings.reasoningCapability } : {}),
    ...(settings.provider === "openai-compatible" ? {
      baseUrl: settings.baseUrl,
      headers: settings.headers,
      extraBody: settings.extraBody,
      auth: settings.auth ?? "optional",
    } : {}),
  };
  try {
    return { model: io.createModel ? await io.createModel(input) : await loadProviderModel(input, io.fetch) };
  } catch (error) {
    return { error: redactSecrets(errorMessage(error), secrets) };
  }
}

/** Open the interactive terminal without bundling it into headless startup. */
async function runInteractive(args: CliArgs, io: CliIo): Promise<number> {
  const tui = await loadInteractiveTui();
  return tui.runInteractiveTui({
    stdout: io.stdout,
    stderr: io.stderr,
    env: io.env,
    cwd: io.cwd,
    args,
    signal: io.signal,
    model: io.model,
    credentialStore: io.credentialStore,
    fetch: io.fetch,
    createModel: io.createModel,
  });
}

/**
 * Lazy-load the TUI module through a runtime specifier.
 * The joined segments keep the headless bundle free of the renderer
 * while Bun still resolves the module relative to this file at runtime.
 */
async function loadInteractiveTui(): Promise<typeof import("../tui/app.ts")> {
  const specifier = ["..", "tui", "app.ts"].join("/");
  return (await import(specifier)) as typeof import("../tui/app.ts");
}

/** Process entrypoint for the `schway` binary. */
async function main(): Promise<number> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await runCli(process.argv.slice(2), {
      stdout: { write: (chunk) => void process.stdout.write(chunk) },
      stderr: { write: (chunk) => void process.stderr.write(chunk) },
      env: process.env,
      cwd: process.cwd(),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
