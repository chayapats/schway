import { configDiagnosticSecrets, type ConfigDiagnosticContext } from "../config/diagnostics.ts";
import type { ConfigDeprecation, ConfigDeprecationWarning } from "../config/deprecations.ts";
import { pruneUndoStore } from "../undo/store.ts";
import { isErrno } from "../tools/fs.ts";
import { formatCount } from "../text/format.ts";
import { bindLoaderReasoning, isOpenRouterEndpoint, validateThinking } from "../model/thinking.ts";
import { flushDraftOnExit, type ExitDraftResult } from "../drafts/exit.ts";
import { version } from "../../package.json";
import { resolveSplash, type SplashPolicy } from "./splash-policy.ts";
import { readSplashSeenVersion, recordSplashSeenVersion } from "./ui-state.ts";
import { resolveMotion } from "./motion-policy.ts";
import { createContextManager, type ContextManager } from "../context/manager.ts";
import { hasBuiltinWebFetch } from "../context/prompt.ts";
import { loadConfigEditor, type ConfigEditor } from "../config/editing.ts";
import type { ResolvedSettings } from "../config/config.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import { resolve } from "node:path";
import { createDiagnosticSink, type DiagnosticSink } from "../diagnostics/sink.ts";
import {
  redactSecrets,
} from "../auth/secrets.ts";
import { resolveProviderCredential, selectOpenAITransport, selectXaiTransport } from "../auth/credentials.ts";
import { loadCredentialSafeTui } from "./credential-input.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import type { Model } from "../model/model.ts";
import {
  createJsonlSession,
  deleteJsonlSession,
  loadJsonlSession,
  SessionLoadError,
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
import { webFetchTool } from "../tools/web-fetch.ts";
import { addWorkspaceRoots, restoreWorkspace, resolveWorkspace, type Workspace } from "../workspace/workspace.ts";
import {
  cliOverridesFromArgs,
  type CliArgs,
  type CliAuthMode,
  type CliOpenAIAuth,
  type CliProvider,
  type CliThinking,
} from "../cli/args.ts";
import { TuiController } from "./controller.ts";
import type { CodexLoginRunner } from "./controller.ts";
import type { BranchTreeSnapshot } from "./controller.ts";
import { SessionResumeError } from "./controller-sessions.ts";
import {
  dispatchEditorInput,
  parseSkillInvocation,
} from "./commands.ts";
import {
  discoverSkills,
  formatSkillsListing,
  prepareSkillInvocation,
} from "../skills/skills.ts";
import { loadProviderModel, bindGrokModel } from "../model/loader.ts";

/** Minimal writer used so the TUI can fall back to stderr when TTY setup fails. */
export interface TuiWriter {
  /** Write a text chunk to the chosen output destination without adding a newline. */
  write(chunk: string): void;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Process I/O passed from the CLI entrypoint into the interactive session. */
export interface InteractiveIo {
  /** Supply a deprecation table for deterministic startup tests. */
  configDeprecations?: readonly ConfigDeprecation[];
  stdout: TuiWriter;
  stderr: TuiWriter;
  env: Record<string, string | undefined>;
  cwd: string;
  args: CliArgs;
  signal?: AbortSignal;
  model?: Model;
  /** Inject secure storage for embeddings and deterministic tests. */
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

/**
 * Open a persisted interactive conversation and handle input until quit or cancellation.
 * Returns 0 on clean quit and 1 on handled startup failure; unhandled setup/I/O failures can reject.
 */
export async function runInteractiveTui(io: InteractiveIo): Promise<number> {
  const home = io.env.HOME;
  if (!home) {
    io.stderr.write("HOME is not set; cannot write session history.\n");
    return 1;
  }

  const secrets: string[] = collectSecrets(io.args.apiKey, io.env, undefined, io.args.headers);
  let diagnosticSessionId: string | undefined;
  const diagnostics = createDiagnosticSink({ home, enabled: io.args.debug ?? false,
    destination: io.args.debugFile ? resolve(io.cwd, io.args.debugFile) : undefined,
    runId: crypto.randomUUID(), sessionId: () => diagnosticSessionId, secrets });
  try {
  diagnostics.record("cli", "startup", { mode: "interactive", resumed: !!io.args.resume });
  let env = io.env;
  if (io.args.envFiles && io.args.envFiles.length > 0) {
    const loadedEnv = await applyEnvFiles(
      io.args.envFiles.map((path) => resolve(io.cwd, path)),
      env,
    );
    if ("error" in loadedEnv) {
      diagnostics.record("config", "env_file_failed", { category: "configuration_input" }, "error");
      io.stderr.write(`${redactSecrets(String(loadedEnv.error), secrets)}\n`);
      return 1;
    }
    env = loadedEnv;
  }
  const diagnosticContext = { env, secrets };
  configDiagnosticSecrets(diagnosticContext);

  const directory = sessionsDirectory(home);
  let workspace: Workspace;
  let startupResumed: JsonlSession | undefined;
  const workspaceDiagnostics: string[] = [];
  try {
    if (io.args.resume) {
      startupResumed = await loadJsonlSession({ directory, id: io.args.resume, branchId: io.args.branch });
      const restored = await restoreWorkspace({ root: startupResumed.header.workspaceRoot, launchCwd: startupResumed.header.launchCwd, extraRoots: [...startupResumed.metadata.extraRoots] });
      workspace = restored.workspace;
      diagnosticSessionId = startupResumed.header.id;
      workspaceDiagnostics.push(...restored.diagnostics);
    } else {
      workspace = await resolveWorkspace(io.cwd);
    }
    workspace = await addWorkspaceRoots(workspace, io.args.addDirs ?? [], io.signal);
    if (startupResumed && io.args.addDirs?.length) startupResumed.setExtraRoots([...new Set([...startupResumed.metadata.extraRoots, ...workspace.extraRoots])]);
  } catch (error) {
    diagnostics.record("workspace", "load_failed", { category: "workspace_setup" }, "error");
    io.stderr.write(`${redactSecrets(messageOf(error), secrets)}\n`);
    return 1;
  }

  let configEditor: ConfigEditor;
  try {
    configEditor = await loadConfigEditor({ home, workspaceRoot: workspace.root, diagnosticContext, cli: cliOverridesFromArgs(io.args), interactiveMemory: true, configDeprecations: io.configDeprecations });
  } catch (error) {
    diagnostics.record("config", "invalid_configuration", { category: "resolution_failed" }, "error");
    io.stderr.write(`${redactSecrets(messageOf(error), secrets)}\n`);
    return 1;
  }
  let settings = configEditor.settings;
  try { await pruneUndoStore({ home, maxAgeDays: settings.undoMaxAgeDays, maxSizeBytes: settings.undoMaxSizeMB * 1024 * 1024 }); }
  catch { diagnostics.record("undo", "prune_failed", { category: "undo_retention" }, "warn"); }

  if (
    hasCliConnectionOptions(io.args) &&
    settings.provider !== "openai-compatible"
  ) {
    diagnostics.record("config", "invalid_configuration", { category: "provider_option_conflict" }, "error");
    io.stderr.write(
      "OpenAI-compatible connection options require --provider openai-compatible\n",
    );
    return 1;
  }
  if (io.args.xaiAuth !== undefined && settings.provider !== "xai") { io.stderr.write("xAI auth preference requires --provider xai\n"); return 1; }
  if (io.args.openaiAuth !== undefined && settings.provider !== "openai") {
    diagnostics.record("config", "invalid_configuration", { category: "provider_option_conflict" }, "error");
    io.stderr.write("OpenAI auth preference requires --provider openai\n");
    return 1;
  }

  configDiagnosticSecrets(diagnosticContext, [settings]);
  diagnostics.record("config", "resolved", { provider: settings.provider, model: settings.model, maxTurns: settings.maxTurns, maxConcurrentTools: settings.maxConcurrentTools });
  const credentialStore = io.credentialStore ?? createNativeCredentialStore();
  const loadWorkspaceExtensions = (nextWorkspace: Workspace, signal: AbortSignal) => loadExtensions({
    modules: io.args.extensions ?? [], workspace: nextWorkspace, secrets, home, signal, configDeprecations: io.configDeprecations,
    tools: createToolRegistry(INTERACTIVE_BUILTIN_TOOLS),
  });
  let tools: ToolRegistry;
  let extensions: ExtensionRuntime;
  try {
    const loaded = await loadExtensions({
      modules: io.args.extensions ?? [], workspace, secrets, home, signal: io.signal, configDeprecations: io.configDeprecations,
      onDiagnostic: (message) => io.stderr.write(`${message}\n`),
      tools: createToolRegistry(INTERACTIVE_BUILTIN_TOOLS),
    });
    tools = loaded.tools;
    extensions = loaded.runtime;
  } catch (error) {
    diagnostics.record("extension", "load_failed", { category: "extension_setup" }, "error");
    io.stderr.write(`${redactSecrets(messageOf(error), secrets)}\n`);
    return 1;
  }

  try {
    const model = io.model;
    const startupError = configEditor.memoryActivationError;
    const runtimeProvider = settings.provider;
    const runtimeKeyFor = (provider: string) => provider === runtimeProvider ? io.args.apiKey : undefined;
    const initialize = async (signal: AbortSignal) => {
      const loaded = await loadInteractiveModel(settings.provider, settings.model, {
        signal,
        verifySubscriptionChoice: configEditor.origins.model === "interactive memory" ? true : settings.openaiAuth === "codex" ? "selected" : false,
        maxTokens: settings.maxOutput,
        baseUrl: settings.baseUrl,
        headers: settings.headers,
        extraBody: settings.extraBody,
        auth: settings.auth,
        openaiAuth: settings.openaiAuth, xaiAuth: settings.xaiAuth,
        thinking: settings.thinking,
        profile: settings.profile,
        credentialEnv: settings.credentialEnv,
        credentialIdentity: settings.credentialIdentity,
        runtimeApiKey: runtimeKeyFor(settings.provider),
        env,
        fetch: io.fetch,
        createModel: io.createModel,
        secrets, credentialStore,
      });
      if ("error" in loaded) {
        diagnostics.record("model", "load_failed", { provider: settings.provider, category: "model_unavailable" }, "error");
        return loaded;
      }
      return { model: loaded.model, activate: () => {
        if (loaded.capability) { configEditor.setModelCapability(loaded.capability); settings = configEditor.settings; }
      } };
    };

    let controller: TuiController;
    const managerOptions = contextManagerOptions(home, settings.explicitContextWindow, io.configDeprecations, diagnosticContext);
    const skillScope: { manager?: ContextManager; workspaceRoot: string; configDeprecations?: readonly ConfigDeprecation[] } = {
      configDeprecations: io.configDeprecations,
      workspaceRoot: startupResumed?.header.workspaceRoot ?? io.cwd,
    };
    const stageSettings = (next: ResolvedSettings, signal: AbortSignal, nextWorkspace?: Workspace, currentModel?: Model, activate?: boolean, budgets?: { contextWindow?: number; maxOutput?: number }) => stageInteractiveSettings(next, settings, {
      forceLoad: activate, model: currentModel, workspace: nextWorkspace ?? controller.workspaceIdentity() ?? workspace,
      signal, home, configDeprecations: io.configDeprecations, runtimeApiKey: runtimeKeyFor(next.provider), env, fetch: io.fetch, createModel: io.createModel, secrets, credentialStore,
      ...(next.explicitContextWindow === undefined && budgets?.contextWindow ? { fetchedContextWindow: budgets.contextWindow } : {}),
      ...(next.explicitMaxOutput === undefined && budgets?.maxOutput ? { fetchedMaxOutput: budgets.maxOutput } : {}),
    });
    const codexLogin = createCodexLoginRunner({ store: credentialStore, fetch: io.fetch, secrets });
    const credentials = {
      store: credentialStore, env, runtimeApiKey: io.args.apiKey, runtimeProvider,
      rememberSecret: (key: string) => { if (!secrets.includes(key)) secrets.push(key); },
      reload: (override?: ResolvedSettings) => {
        const current = override ?? settings;
        return loadInteractiveModel(current.provider, current.model, {
          maxTokens: current.maxOutput, baseUrl: current.baseUrl, headers: current.headers,
          extraBody: current.extraBody, auth: current.auth, openaiAuth: current.openaiAuth, xaiAuth: current.xaiAuth,
          thinking: current.thinking, profile: current.profile,
          credentialEnv: current.credentialEnv, credentialIdentity: current.credentialIdentity,
          runtimeApiKey: runtimeKeyFor(current.provider),
          env, fetch: io.fetch, createModel: io.createModel, secrets, credentialStore,
        });
      },
      codexLogin,
      grokLogin: createGrokLoginRunner({ store: credentialStore, fetch: io.fetch, secrets }),
      listGrokModels: async (signal: AbortSignal) => (await import("../model/providers/grok-subscription.ts")).fetchSubscriptionModels({ store: credentialStore, fetch: io.fetch, signal }),
      listSubscriptionCatalog: async (signal: AbortSignal) => {
        const { fetchSubscriptionCatalog } = await import("../model/providers/codex-subscription.ts");
        return fetchSubscriptionCatalog({ store: credentialStore, fetch: io.fetch, signal });
      },
      listRouteModels: async (route: "api-key" | "compatible" | "xai", signal: AbortSignal, endpoint?: { baseUrl?: string; standalone?: boolean }) => {
        const { resolveProviderCredential } = await import("../auth/credentials.ts");
        const { fetchProviderModelList, OPENAI_MODELS_URL, requireOpenAIApiKeyModels, requireXaiModels } = await import("../model/model-list.ts");
        const current = configEditor.settings;
        if (route === "xai") {
          const { XAI_MODELS_URL } = await import("../model/providers/xai.ts");
          const credential = await resolveProviderCredential({ provider: "xai", runtimeApiKey: runtimeKeyFor("xai"), env, store: credentialStore });
          if ("error" in credential || !credential.apiKey) throw new Error("error" in credential ? credential.error : "Missing xAI API key.");
          return requireXaiModels(await fetchProviderModelList({ url: XAI_MODELS_URL, apiKey: credential.apiKey, fetch: io.fetch, signal, label: "xAI" }));
        }
        if (route === "api-key") {
          const credential = await resolveProviderCredential({ provider: "openai", runtimeApiKey: runtimeKeyFor("openai"), env, store: credentialStore });
          if ("error" in credential || !credential.apiKey) throw new Error("error" in credential ? credential.error : "Missing OpenAI API key.");
          return requireOpenAIApiKeyModels(await fetchProviderModelList({ url: OPENAI_MODELS_URL, apiKey: credential.apiKey, fetch: io.fetch, signal, label: "OpenAI" }));
        }
        const connection = endpoint?.standalone ? configEditor.standaloneEndpoint : current;
        const baseUrl = endpoint?.baseUrl ?? connection.baseUrl;
        if (!baseUrl) throw new Error("Select a compatible base URL before listing models.");
        const credential = await resolveProviderCredential({
          provider: "openai-compatible", baseUrl, auth: connection.auth, profile: endpoint?.standalone ? undefined : current.profile,
          credentialEnv: connection.credentialEnv, credentialIdentity: connection.credentialIdentity,
          runtimeApiKey: runtimeKeyFor("openai-compatible"), env, store: credentialStore,
        });
        if ("error" in credential) throw new Error(credential.error);
        const url = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
        return fetchProviderModelList({ url, apiKey: credential.apiKey, headers: connection.headers, fetch: io.fetch, signal, label: "Compatible endpoint" });
      },
    };
    const onSettingsCommitted = (next: ResolvedSettings, manager: ContextManager) => {
      settings = next;
      skillScope.manager = manager;
    };
    try {
      if (io.args.resume) {
        // Reuse the session handle loaded during startup, including settlements.
        const resumed = startupResumed!;
        const resumedWorkspace = workspace;
        const resumedManager = createContextManager(resumedWorkspace, managerOptions);
        skillScope.manager = resumedManager;
        skillScope.workspaceRoot = resumed.header.workspaceRoot;
        controller = new TuiController({
          session: resumed,
          model,
          contextManager: resumedManager,
          tools,
          extensions,
          loadWorkspaceExtensions,
          home,
          configEditor, stageSettings, onSettingsCommitted, credentials,
          appearanceEnvironment: env.SCHWAY_THEME === "dark" || env.SCHWAY_THEME === "light" ? env.SCHWAY_THEME : undefined,
          onRuntimeEvent: io.args.debug ? (event, sessionId) => { diagnosticSessionId = sessionId; diagnostics.runtime(event); } : undefined,
          workspace: resumedWorkspace,
          provider: settings.provider,
          modelId: settings.model,
          sessionId: resumed.header.id,
          maxTurns: settings.maxTurns,
          maxConcurrentTools: settings.maxConcurrentTools,
          explicitContextWindow: settings.explicitContextWindow,
          explicitMaxOutput: settings.explicitMaxOutput,
          baseUrl: settings.baseUrl,
          auth: settings.auth,
          openaiAuth: settings.openaiAuth, xaiAuth: settings.xaiAuth,
          thinking: settings.thinking,
          profile: settings.profile,
          startupError,
          secrets,
        });
        controller.markRestored();
        if (!startupError) {
          controller.notice(
            `Resumed ${formatCount(resumed.items.length, "saved record")} · /session details`,
          );
        }
      } else {
        const session = await createJsonlSession({ directory, workspace, deferred: true });
        diagnosticSessionId = session.header.id;
        const freshManager = createContextManager(workspace, managerOptions);
        skillScope.manager = freshManager;
        skillScope.workspaceRoot = workspace.root;
        controller = new TuiController({
          session,
          model,
          contextManager: freshManager,
          tools,
          extensions,
          loadWorkspaceExtensions,
          home,
          configEditor, stageSettings, onSettingsCommitted, credentials,
          appearanceEnvironment: env.SCHWAY_THEME === "dark" || env.SCHWAY_THEME === "light" ? env.SCHWAY_THEME : undefined,
          onRuntimeEvent: io.args.debug ? (event, sessionId) => { diagnosticSessionId = sessionId; diagnostics.runtime(event); } : undefined,
          workspace,
          provider: settings.provider,
          modelId: settings.model,
          sessionId: session.header.id,
          maxTurns: settings.maxTurns,
          maxConcurrentTools: settings.maxConcurrentTools,
          explicitContextWindow: settings.explicitContextWindow,
          explicitMaxOutput: settings.explicitMaxOutput,
          baseUrl: settings.baseUrl,
          auth: settings.auth,
          openaiAuth: settings.openaiAuth, xaiAuth: settings.xaiAuth,
          thinking: settings.thinking,
          profile: settings.profile,
          startupError,
          secrets,
        });
      }
    } catch (error) {
      diagnostics.record("session", "start_failed", { category: "session_setup" }, "error");
      io.stderr.write(`Cannot open session storage: ${messageOf(error)} Check that HOME/.schway/sessions is a writable directory.\n`);
      return 1;
    }

    if (!io.args.resume) void controller.offerRecentSession(directory);
    noticeConfigDeprecations(controller, configEditor.deprecationWarnings);
    if (configEditor.memoryProblem && configEditor.memoryNotice) controller.notice(configEditor.memoryNotice);
    if (startupError && !configEditor.memoryProblem && configEditor.memoryNotice) controller.notice(`Remembered choice could not activate: ${redactSecrets(startupError, secrets).slice(0, 500)} Use /model to repair it or /model forget; no alternate billing route was selected.`);
    diagnostics.record("session", "ready", { resumed: !!io.args.resume });
    for (const diagnostic of workspaceDiagnostics) controller.notice(diagnostic);
    try {
      const motion = resolveMotion(env);
      const seen = settings.splash === "first-run" && motion === "full" && !io.args.resume
        ? await readSplashSeenVersion(home, io.signal) : undefined;
      if (io.signal?.aborted) return 0;
      await runTuiRenderer({
        controller,
        initialize: settings.model.length > 0 && !model && !startupError ? () => controller.initializeStartup(initialize) : undefined,
        home,
        workspaceRoot: workspace.root,
        skillScope,
        sessionsDir: directory,
        settings: () => settings,
        env,
        runtimeApiKey: io.args.apiKey,
        fetch: io.fetch,
        createModel: io.createModel,
        secrets,
        signal: io.signal,
        stderr: io.stderr,
        diagnostics,
        splash: resolveSplash(settings.splash, motion, seen, version, !!io.args.resume),
      });
    } catch (error) {
      diagnostics.record("tui", "renderer_failed", { category: "terminal_setup" }, "error");
      io.stderr.write(`${redactSecrets(messageOf(error), secrets)}\n`);
      return 1;
    } finally {
      // Renderer setup may fail before its own cleanup runs; still record the
      // cancellation request before disposal suppresses stale turn events.
      if (controller.running) diagnostics.record("tui", "shutdown", { state: "cancellation_requested", reason: io.signal?.aborted ? "signal" : "renderer_cleanup" }, "warn");
      controller.dispose();
    }
    return 0;
  } finally {
    extensions.dispose();
  }
  } finally {
    await diagnostics.close();
  }
}

/** Stage a changed adapter and context budget, reusing the current adapter for edits that do not affect provider requests. */
export async function stageInteractiveSettings(
  next: ResolvedSettings,
  previous: ResolvedSettings,
  options: Parameters<typeof loadInteractiveModel>[2] & { forceLoad?: boolean; model?: Model; workspace: Workspace; home: string; signal: AbortSignal; fetchedContextWindow?: number; fetchedMaxOutput?: number; configDeprecations?: readonly ConfigDeprecation[] },
): Promise<{ model?: Model; contextManager: ContextManager; modelCapability?: import("../model/catalog.ts").ModelCapability }> {
  const adapterKeys = ["provider", "model", "maxOutput", "baseUrl", "headers", "extraBody", "auth", "openaiAuth", "xaiAuth", "thinking", "effectiveThinking", "supportedThinking", "profile", "credentialEnv", "credentialIdentity"] as const;
  let model = options.model;
  let modelCapability: import("../model/catalog.ts").ModelCapability | undefined;
  if ((options.forceLoad && !model) || (next.provider === "openai" && next.openaiAuth === "codex" && !model) || adapterKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) {
    const loaded = await loadInteractiveModel(next.provider, next.model, { ...options,
      verifySubscriptionChoice: next.openaiAuth === "codex" && next.supportedThinking === undefined,
      maxTokens: next.explicitMaxOutput ?? options.fetchedMaxOutput ?? next.maxOutput, baseUrl: next.baseUrl, headers: next.headers, extraBody: next.extraBody, auth: next.auth, openaiAuth: next.openaiAuth, xaiAuth: next.xaiAuth, thinking: next.thinking,
      ...((next.provider === "xai" && previous.xaiAuth !== next.xaiAuth) ? { modelCapability: undefined } : next.reasoningCapability ? { modelCapability: next.reasoningCapability } : next.provider !== "xai" && next.openaiAuth !== "codex" ? {} : next.supportedThinking !== undefined ? { modelCapability: { id: next.model, supportedThinking: next.supportedThinking, ...(next.supportsDisabling ? { supportsDisabling: true } : {}), ...(next.defaultThinking ? { defaultThinking: next.defaultThinking } : {}) } } : {}),
      profile: next.profile, credentialEnv: next.credentialEnv, credentialIdentity: next.credentialIdentity,
    });
    options.signal.throwIfAborted();
    if ("error" in loaded) throw new Error(loaded.error);
    model = loaded.model;
    modelCapability = loaded.capability;
  }
  options.signal.throwIfAborted();
  return { model, ...(modelCapability ? { modelCapability } : {}), contextManager: createContextManager(options.workspace, contextManagerOptions(options.home, next.explicitContextWindow ?? options.fetchedContextWindow, options.configDeprecations, { env: options.env, secrets: options.secrets })) };
}

/** Mount OpenTUI widgets, pump controller snapshots, and handle input until quit. */
/** Own renderer lifecycle and bounded decorative persistence around interactive input. */
async function runTuiRenderer(options: {
  controller: TuiController;
  initialize?: () => Promise<void>;
  home: string;
  workspaceRoot: string;
  skillScope: { manager?: ContextManager; workspaceRoot: string; configDeprecations?: readonly ConfigDeprecation[] };
  sessionsDir: string;
  settings: () => ResolvedSettings;
  env: Record<string, string | undefined>;
  runtimeApiKey?: string;
  fetch?: FetchLike;
  createModel?: InteractiveIo["createModel"];
  secrets: string[];
  signal?: AbortSignal;
  stderr: TuiWriter;
  diagnostics: DiagnosticSink;
  /** Startup decoration policy resolved from interactive settings, version state and resume intent. */
  splash: SplashPolicy;
}): Promise<void> {
  const { createCliRenderer } = await loadCredentialSafeTui();
  const { createConversationView } = await import("./view.ts");

  const renderer = await createCliRenderer({
    // The app owns Ctrl+C (cancel turn when running, quit when idle) and
    // process signals via io.signal, so the renderer's built-in handlers
    // must not destroy the terminal out from under the cleanup flow.
    exitOnCtrlC: false,
    exitSignals: [],
  });
  let quit = false;
  let quitting = false;
  let splashRecording: Promise<void> | undefined;
  let view: ReturnType<typeof createConversationView> | undefined;
  const onAbort = () => {
    quit = true;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const finishQuit = () => {
    if (quitting) {
      return;
    }
    quitting = true;
    quit = true;
  };

  try {
    renderer.start();
    view = createConversationView(renderer, {
      controller: options.controller, home: options.home, workspaceRoot: options.workspaceRoot, draftPersistence: true,
      env: options.env, secrets: options.secrets, quit: finishQuit,
      openUrl: openBrowserUrl,
      motion: resolveMotion(options.env), splash: options.splash, version,
      onSplashPlayed: () => { splashRecording = recordSplashSeenVersion(options.home, version); },
      submit: (value, accepted) => dispatchEditorInput(value, options.controller, async (command, onAccepted) => {
        return handleSlashCommand(command.name, command.args, {
          controller: options.controller,
          home: options.home,
          workspaceRoot: options.workspaceRoot,
          skillScope: options.skillScope,
          sessionsDir: options.sessionsDir,
          settings: options.settings,
          env: options.env,
          runtimeApiKey: options.runtimeApiKey,
          fetch: options.fetch,
          createModel: options.createModel,
          secrets: options.secrets,
          finishQuit,
          stderr: options.stderr,
        }, command.raw, onAccepted);
      }, accepted),
    });
    void options.initialize?.();
    while (!quit && !quitting) {
      view.refresh();
      if (options.signal?.aborted) break;
      await Bun.sleep(50);
    }
  } finally {
    const interrupted = options.controller.running;
    const resume = options.controller.draftCheckpointTarget();
    let frozen: ReturnType<NonNullable<typeof view>["freezeDraftForExit"]> | undefined;
    let draft: ExitDraftResult | undefined;
    try { frozen = view?.freezeDraftForExit(); }
    catch { draft = { saved: false, failed: true }; }
    try { options.controller.dispose(); }
    catch { options.stderr.write("Cancellation cleanup failed; restoring the terminal.\n"); }
    try { draft ??= frozen?.task ? await flushDraftOnExit(frozen.task) : frozen; }
    catch { draft = { saved: false, failed: true }; }
    try { view?.destroy(); }
    catch { options.stderr.write("Could not release a TUI widget; restoring the terminal.\n"); }
    options.signal?.removeEventListener("abort", onAbort);
    if (interrupted) options.diagnostics.record("tui", "shutdown", {
      state: "cancellation_requested", reason: options.signal?.aborted ? "signal" : quit || quitting ? "quit" : "renderer_cleanup",
    }, "warn");
    try {
      renderer.stop();
    } catch {
      // Stopping twice is harmless; destroy below restores the terminal.
    }
    try {
      renderer.destroy();
    } catch (error) {
      options.stderr.write(`Failed to restore terminal: ${messageOf(error)}\n`);
    }
    // Restore the terminal first; a best-effort decorative write cannot hold exit open.
    if (splashRecording) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([splashRecording, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
      } finally { clearTimeout(timer); }
    }
    if (draft && "timedOut" in draft && draft.timedOut) options.stderr.write("Draft saving timed out; your latest text may not be saved.\n");
    else if (draft?.failed) options.stderr.write("Draft saving failed; your latest text may not be saved.\n");
    else if (draft?.saved) options.stderr.write("Draft saved.\n");
    if (interrupted) options.stderr.write("Cancellation requested. Running tools may have changed files; completion was not confirmed.\n");
    if (resume.persisted() || (draft && "persisted" in draft && draft.persisted)) options.stderr.write(`Resume: schway --resume ${resume.sessionId}\n`);
  }
}

/** Short picker status for a `loadJsonlSession` failure: a missing file, bad ID, failed repair write, file-system read error or invalid contents. */
export function sessionLoadStatus(error: unknown): string {
  if (error instanceof SessionLoadError) return { "not-found": "Session not found", "invalid-id": "Invalid session ID", "repair-failed": "Session repair failed" }[error.reason];
  return typeof (error as { code?: unknown } | undefined)?.code === "string" ? "Session file unreadable" : "Session file damaged or unsupported";
}

/** Execute one interactive slash command and report whether the editor may release it. */
export async function handleSlashCommand(
  name: string,
  args: string,
  ctx: {
    controller: TuiController;
    home: string;
    workspaceRoot: string;
    skillScope: { manager?: ContextManager; workspaceRoot: string; configDeprecations?: readonly ConfigDeprecation[] };
    sessionsDir: string;
    settings: () => ResolvedSettings;
    env: Record<string, string | undefined>;
    runtimeApiKey?: string;
    fetch?: FetchLike;
    createModel?: InteractiveIo["createModel"];
    secrets: string[];
    finishQuit: () => void;
    stderr: TuiWriter;
  },
  raw?: string,
  accepted: () => void = () => {},
  resumeSignal?: AbortSignal,
): Promise<boolean> {
  if ((name === "new" || name === "resume" || name === "sessions") && ctx.controller.running) {
    ctx.controller.notice("Wait for this turn · Esc stop");
    return false;
  }
  const managerOptions = contextManagerOptions(ctx.home, ctx.settings().explicitContextWindow, ctx.skillScope.configDeprecations, { env: ctx.env, secrets: ctx.secrets });
  switch (name) {
    case "new": {
      const workspace = await resolveWorkspace(ctx.workspaceRoot);
      const session = await createJsonlSession({
        directory: ctx.sessionsDir,
        workspace,
        deferred: true,
      });
      const manager = createContextManager(workspace, managerOptions);
      if (!await ctx.controller.switchSession(session, session.header.id, { workspace, contextManager: manager })) return false;
      ctx.skillScope.manager = ctx.controller.activeContextManager();
      ctx.skillScope.workspaceRoot = workspace.root;
      void ctx.controller.offerRecentSession(ctx.sessionsDir);
      ctx.controller.notice("New session · Enter send · / browse commands");
      return true;
    }
    case "delete-session": {
      const id = args.trim();
      if (!id || /\s/.test(id)) { ctx.controller.fail("Usage: /delete-session <exact-session-id>. Switch away with /new first."); return false; }
      if (id === ctx.controller.snapshot().sessionId) { ctx.controller.fail("Switch away with /new before deleting this session."); return false; }
      try { await deleteJsonlSession({ directory: ctx.sessionsDir, home: ctx.home, id }); ctx.controller.notice("Session and draft deleted · /sessions browse"); return true; }
      catch (error) {
        if (isErrno(error, "UNDO_STORE_BUSY")) ctx.controller.fail("Cannot delete session: Undo store busy · /delete-session retry · F2 details", messageOf(error));
        else if (isErrno(error, "HISTORY_STORE_BUSY")) ctx.controller.fail("Session not deleted: history busy · /delete-session retry · F2 details", `Another Schway process is writing turn history. Nothing was deleted. ${messageOf(error)}`);
        else ctx.controller.fail(`Cannot delete session: ${messageOf(error)}`);
        return false;
      }
    }
    case "sessions": {
      return ctx.controller.openSessionPicker(ctx.sessionsDir, (id, signal) => handleSlashCommand("resume", id, ctx, undefined, undefined, signal));
    }
    case "resume": {
      const [sessionId, branchId, ...extra] = args.trim().split(/\s+/);
      if (!sessionId || extra.length || !sessionId.trim()) {
        ctx.controller.fail("Usage: /resume <session-id> [branch-id]. See /sessions for ids.");
        return false;
      }
      // Only the session picker passes a resume signal; its failures stay inside the open picker with a reason-specific status.
      let failure: (error: unknown) => string = sessionLoadStatus;
      try {
        const resumed = await loadJsonlSession({ directory: ctx.sessionsDir, id: sessionId, ...(branchId ? { branchId } : {}) });
        failure = () => "Workspace unavailable";
        const restored = await restoreWorkspace({ root: resumed.header.workspaceRoot, launchCwd: resumed.header.launchCwd, extraRoots: [...resumed.metadata.extraRoots] });
        failure = () => "Workspace setup failed";
        const workspace = restored.workspace;
        const manager = createContextManager(workspace, managerOptions);
        if (resumeSignal?.aborted) return false;
        if (!await ctx.controller.switchSession(resumed, resumed.header.id, { workspace, contextManager: manager, ...(resumeSignal ? { origin: "picker" as const } : {}) })) return false;
        ctx.controller.markRestored();
        ctx.skillScope.manager = ctx.controller.activeContextManager();
        ctx.skillScope.workspaceRoot = workspace.root;
        for (const diagnostic of restored.diagnostics) ctx.controller.notice(diagnostic);
        ctx.controller.notice(
          `Resumed ${formatCount(resumed.items.length, "saved record")} · /session details`,
        );
        return true;
      } catch (error) {
        if (resumeSignal) throw new SessionResumeError(failure(error), messageOf(error));
        ctx.controller.fail(`${messageOf(error)}. Start a new task here or use /sessions for recoverable history.`);
        return false;
      }
    }
    case "model": {
      if (!args) {
        return ctx.controller.openModelPicker();
      }
      return ctx.controller.selectModel(args);
    }
    case "thinking": {
      return ctx.controller.thinkingCommand(args);
    }
    case "branch": {
      return ctx.controller.branchCommand(args);
    }
    case "undo": return ctx.controller.undoCommand(args);
    case "history": return ctx.controller.historyCommand(args);
    case "changes": {
      return ctx.controller.changesCommand(args);
    }
    case "context": {
      ctx.controller.notice(ctx.controller.describeContext());
      return true;
    }
    case "compact": {
      return ctx.controller.compact(accepted);
    }
    case "add-dir": {
      return ctx.controller.addDirectories(args ? [args] : []);
    }
    case "skills": {
      const discovery = await discoverSkills({
        diagnosticContext: { env: ctx.env, secrets: ctx.secrets },
        workspaceRoot: ctx.skillScope.workspaceRoot,
        configDeprecations: ctx.skillScope.configDeprecations,
        extraRoots: ctx.controller.workspaceIdentity()?.extraRoots,
        home: ctx.home,
      });
      ctx.controller.notice(formatSkillsListing(discovery));
      return true;
    }
    case "config": {
      return ctx.controller.configCommand(args);
    }
    case "login": {
      return ctx.controller.login(args, accepted);
    }
    case "logout": {
      return ctx.controller.logout(args);
    }
    case "help": {
      return ctx.controller.openCommandHelp();
    }
    case "quit": {
      ctx.finishQuit();
      return true;
    }
    case "unknown": {
      const invocation = raw ? parseSkillInvocation(raw) : null;
      if (invocation) {
        return invokeSkillTurn(invocation, ctx, accepted);
      }
      ctx.controller.fail("Unknown command · /help browse commands");
      return false;
    }
    default: {
      ctx.controller.fail("Unknown command · /help browse commands");
      return false;
    }
  }
}

/** Run one skill turn, notifying acceptance after its user record is saved. */
export async function invokeSkillTurn(
  invocation: { name: string; args: string; raw: string },
  ctx: {
    controller: TuiController;
    home: string;
    env?: Record<string, string | undefined>;
    secrets?: string[];
    skillScope: { manager?: ContextManager; workspaceRoot: string; configDeprecations?: readonly ConfigDeprecation[] };
  },
  accepted: () => void = () => {},
): Promise<boolean> {
  if (ctx.controller.running) {
    ctx.controller.notice("Wait for this turn · Esc stop");
    return false;
  }
  const manager = ctx.skillScope.manager;
  if (!manager) {
    ctx.controller.fail("Skills loading · Retry shortly");
    return false;
  }
  const branchId = ctx.controller.snapshot().branchId;
  const workspaceIdentity = ctx.controller.workspaceIdentity();
  const prepared = await prepareSkillInvocation({
    diagnosticContext: { env: ctx.env, secrets: ctx.secrets },
    workspaceRoot: ctx.skillScope.workspaceRoot,
    configDeprecations: ctx.skillScope.configDeprecations,
    extraRoots: workspaceIdentity?.extraRoots,
    home: ctx.home,
    name: invocation.name,
  });
  if (!prepared.ok) {
    ctx.controller.fail(prepared.error);
    return false;
  }
  if (ctx.controller.running) {
    ctx.controller.notice("Wait for this turn · Esc stop");
    return false;
  }
  if (ctx.skillScope.manager !== manager || ctx.controller.snapshot().branchId !== branchId || JSON.stringify(workspaceIdentity) !== JSON.stringify(ctx.controller.workspaceIdentity())) {
    ctx.controller.notice("Session changed · Enter retry the skill");
    return false;
  }
  manager.setActiveSkill({
    name: prepared.skill.name,
    body: prepared.body,
    source: prepared.skill.displayPath,
    scope: prepared.skill.scope,
    dir: prepared.skill.dir,
  });
  try {
    return await ctx.controller.submit(invocation.raw, accepted);
  } finally {
    manager.clearActiveSkill();
  }
}

/** Built-in tools every interactive session registers before extensions load; the web-lookup line follows this list only. */
const INTERACTIVE_BUILTIN_TOOLS = [readTool, writeTool, editTool, bashTool, webFetchTool, grepTool, findTool, lsTool];

/** Build context-manager options so catalog budgets follow model switches unless overridden. */
function contextManagerOptions(home: string, explicitContextWindow?: number, configDeprecations?: readonly ConfigDeprecation[], diagnosticContext?: ConfigDiagnosticContext): Parameters<typeof createContextManager>[1] {
  return { home, configDeprecations, diagnosticContext, ...(explicitContextWindow !== undefined ? { contextWindow: explicitContextWindow } : {}),
    ...(hasBuiltinWebFetch(INTERACTIVE_BUILTIN_TOOLS) ? { webLookupGuidance: true } : {}) };
}

/** Report whether branch-tree input must take the slash-command path instead of becoming a fork name. */
export function isBranchTreeCommandInput(value: string): boolean {
  return value.trim().startsWith("/");
}

/** Format the bounded branch tree with stable IDs, active head and selection for terminal display. */
export function formatBranchTree(tree: BranchTreeSnapshot): string {
  const lines = [
    `Branches (IDs are selectors; Up/Down browses, Enter switches or forks, Esc closes):`,
    ...tree.branches.map(branch => `${branch.active ? "*" : "-"} ${branch.id}${branch.name ? ` (${branch.name})` : ""} → ${branch.headId} (${branch.entryCount}) ${branch.preview}`),
    "",
    `Tree rooted at ${tree.rootId} — active ${tree.activeBranchId}${tree.truncated ? ` (showing ${tree.nodes.length} of ${tree.totalNodeCount})` : ""}:`,
    ...tree.nodes.map(node => {
      const marker = node.id === tree.selectedId ? ">" : " ";
      const head = node.isActiveHead ? "*" : node.isHead ? "o" : " ";
      const fork = node.isForkPoint ? "[fork]" : "      ";
      const indent = "  ".repeat(Math.min(node.depth, 12));
      const heads = node.headBranchIds.length ? ` <${node.headBranchIds.join(",")}>` : "";
      return `${marker}${head} ${fork} ${indent}${node.id} [${node.kind}]${heads} ${node.preview}`.trimEnd();
    }),
  ];
  if (tree.truncated) lines.push(`Showing ${formatCount(tree.nodes.length, "node")} of ${formatCount(tree.totalNodeCount, "node")} · /branch list browse`);
  return lines.join("\n");
}

/** True when the user passed compatible connection flags on the CLI. */
function hasCliConnectionOptions(args: CliArgs): boolean {
  return (
    args.baseUrl !== undefined ||
    args.headers !== undefined ||
    args.extraBody !== undefined ||
    args.auth !== undefined ||
    args.profile !== undefined
  );
}

/** Gather runtime and environment API keys so errors can redact them. */
function collectSecrets(
  runtimeApiKey: string | undefined,
  env: Record<string, string | undefined>,
  credentialEnv?: string,
  headers?: Record<string, string>,
): string[] {
  return configDiagnosticSecrets({ env }, [{ apiKey: runtimeApiKey, credentialEnv, headers }]);
}

/** Build the explicit Grok OAuth runner with secure storage and ephemeral approval progress. */
export function createGrokLoginRunner(options: { store: CredentialStore; fetch?: FetchLike; secrets: string[]; openBrowser?: (url: string) => Promise<void> | void }): import("./controller-types.ts").GrokLoginRunner {
  return async ({ device, signal, onProgress, onApproval, onSaving, onSaved }) => {
    const grok = await import("../model/providers/grok-subscription.ts");
    try {
      const deps = { fetch: options.fetch, onProgress, onApproval, onSaved, saveTokens: (tokens: import("../model/providers/grok-subscription.ts").GrokTokens) => {
        onSaving?.(); return grok.saveSubscriptionTokens(options.store, tokens);
      } };
      const tokens = device ? await grok.loginWithDeviceFlow({ signal, deps }) : await grok.loginWithBrowserFlow({ signal, deps: { ...deps, openBrowser: options.openBrowser ?? openBrowserUrl } });
      for (const token of [tokens.accessToken, tokens.refreshToken]) if (token && !options.secrets.includes(token)) options.secrets.push(token);
      signal.throwIfAborted(); return { ok: true, status: "Grok subscription login saved." };
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { ok: false, message: redactSecrets(messageOf(error), options.secrets) };
    }
  };
}

/** Create the explicit ChatGPT OAuth runner with secure storage and safe progress callbacks. */
export function createCodexLoginRunner(options: {
  store: CredentialStore;
  fetch?: FetchLike;
  secrets: string[];
  openBrowser?: (url: string) => Promise<void> | void;
}): CodexLoginRunner {
  return async ({ device, code, signal, onProgress, onSaving, onSaved }) => {
    const codex = await import("../model/providers/codex-subscription.ts");
    try {
      const tokens = device
        ? await codex.loginWithDeviceFlow({
          store: options.store,
          signal,
          deps: { fetch: options.fetch, onProgress, onSaving, onSaved },
        })
        : await codex.loginWithBrowserFlow({
          store: options.store,
          ...(code !== undefined ? { pastedCode: code } : {}),
          signal,
          deps: {
            fetch: options.fetch,
            openBrowser: options.openBrowser ?? openBrowserUrl,
            waitForCallbackCode: (attempt) => codex.waitForLocalhostCallback(attempt),
            onProgress, onSaving, onSaved,
          },
        });
      if (!options.secrets.includes(tokens.accessToken)) {
        options.secrets.push(tokens.accessToken);
      }
      signal.throwIfAborted();
      return { ok: true as const, status: codex.formatSubscriptionStatus(tokens) };
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw error instanceof Error ? error : new DOMException("Aborted", "AbortError");
      }
      const message = messageOf(error);
      const actionable = /^(ChatGPT sign-in was denied|The sign-in code expired|The sign-in response has no access token|No active browser sign-in attempt|The callback state does not match|The pasted callback URL|The pasted code is empty|The callback URL has no authorization code|The localhost|ChatGPT sign-in timed out|The sign-in endpoint|Exchanging the sign-in code failed|Starting device sign-in|The device sign-in|Device sign-in|Cannot save credential)/.test(message);
      return { ok: false as const, message: actionable
        ? redactSecrets(message, options.secrets)
        : "ChatGPT sign-in could not complete. Check the connection and OS secure store, then retry from the sign-in chooser." };
    }
  };
}

/** Resolve the platform launcher for the provider authorization URL without spawning it. */
export function subscriptionAuthorizeLauncher(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** Open a browser URL with the platform launcher and report launch failures. */
async function openBrowserUrl(url: string): Promise<void> {
  const { command, args } = subscriptionAuthorizeLauncher(process.platform, url);
  const child = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  if (child.exitCode !== 0) {
    throw new Error(`platform opener exited ${child.exitCode}`);
  }
}

/** Resolve credentials and construct the selected provider model for interactive use. */
export async function loadInteractiveModel(
  provider: CliProvider,
  modelId: string | undefined,
  options: {
    maxTokens?: number;
    signal?: AbortSignal;
    baseUrl?: string;
    headers?: Record<string, string>;
    extraBody?: Record<string, unknown>;
    auth?: CliAuthMode;
    openaiAuth?: CliOpenAIAuth;
    xaiAuth?: "auto" | "grok" | "api-key";
    thinking?: CliThinking;
    modelCapability?: import("../model/catalog.ts").ModelCapability;
    /** Validate an account selection without fallback; true retains remembered-choice diagnostics. */
    verifySubscriptionChoice?: boolean | "selected";
    profile?: string;
    credentialEnv?: string;
    credentialIdentity?: string;
    runtimeApiKey: string | undefined;
    env: Record<string, string | undefined>;
    fetch?: FetchLike;
    createModel?: InteractiveIo["createModel"];
    secrets: string[];
    credentialStore?: CredentialStore;
  },
): Promise<{ model: Model; notice?: string; capability?: import("../model/catalog.ts").ModelCapability } | { error: string }> {
  const store = options.credentialStore ?? createNativeCredentialStore();
  if (provider === "openai") {
    const selection = await selectOpenAITransport({
      openaiAuth: options.openaiAuth,
      runtimeApiKey: options.runtimeApiKey,
      env: options.env,
      store,
    });
    options.signal?.throwIfAborted();
    if ("error" in selection) return selection;
    if (selection.transport === "codex") {
      let capability = options.modelCapability;
      if (options.verifySubscriptionChoice) {
        try {
          const { fetchSubscriptionCatalog } = await import("../model/providers/codex-subscription.ts");
          capability = (await fetchSubscriptionCatalog({ store, fetch: options.fetch, signal: options.signal })).find(entry => entry.id === modelId);
          if (!capability) return { error: options.verifySubscriptionChoice === "selected"
            ? "Selected model is not available in this ChatGPT account. Use /model to choose an available model; no API-key fallback was used."
            : "Remembered model is no longer available in this ChatGPT account. Use /model to choose an available model or /model forget; no API-key fallback was used." };
          if (options.thinking && !capability.supportedThinking.includes(options.thinking)) return { error: options.verifySubscriptionChoice === "selected"
            ? "Selected reasoning is not supported by this account model. Use /model to repair the choice; no API-key fallback was used."
            : "Remembered reasoning is no longer supported by this account model. Use /model to repair the choice or /model forget; no API-key fallback was used." };
        } catch (error) { return { error: redactSecrets(messageOf(error), options.secrets) }; }
      }
      const input = {
        provider, model: modelId, maxTokens: options.maxTokens,
        ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(capability !== undefined ? { modelCapability: capability } : {}),
        openaiAuth: "codex" as const,
      };
      try {
        const model = options.createModel ? bindLoaderReasoning(await options.createModel(input), input) : await loadProviderModel({ ...input, codexStore: store }, options.fetch);
        return { model, ...(selection.notice ? { notice: selection.notice } : {}), ...(capability ? { capability } : {}) };
      } catch (error) {
        return { error: redactSecrets(messageOf(error), options.secrets) };
      }
    }
  }
  if (provider === "xai") {
    const selection = await selectXaiTransport({ xaiAuth: options.xaiAuth, runtimeApiKey: options.runtimeApiKey, env: options.env, store });
    if ("error" in selection) return selection;
    if (selection.transport === "grok") {
      try {
        let capability = options.modelCapability?.authRoute && options.modelCapability.authRoute !== "grok" ? undefined : options.modelCapability;
        if (options.thinking !== undefined && !capability) {
          const grok = await import("../model/providers/grok-subscription.ts");
          const { xaiModelCapabilities } = await import("../model/model-list.ts");
          capability = xaiModelCapabilities(await grok.fetchSubscriptionModels({ store, fetch: options.fetch, signal: options.signal }), "grok").find(entry => entry.id === modelId);
          if (!capability?.supportedThinking.includes(options.thinking)) return { error: `Thinking level "${options.thinking}" is not listed for xai/${modelId}.` };
        }
        const thinkingError = validateThinking(provider, modelId ?? "", options.thinking, undefined, capability ?? null, undefined, "grok");
        if (thinkingError) return { error: thinkingError };
        const input = { provider, xaiAuth: "grok" as const, model: modelId, maxTokens: options.maxTokens, thinking: options.thinking, modelCapability: capability };
        const model = options.createModel ? bindLoaderReasoning(bindGrokModel(await options.createModel(input)), input) : await loadProviderModel({ ...input, grokStore: store }, options.fetch);
        return { model, ...(capability ? { capability } : {}) };
      } catch (error) { return { error: redactSecrets(messageOf(error), options.secrets) }; }
    }
  }
  const credential = await resolveProviderCredential({
    provider, baseUrl: options.baseUrl, auth: options.auth,
    profile: options.profile, credentialEnv: options.credentialEnv, credentialIdentity: options.credentialIdentity,
    runtimeApiKey: options.runtimeApiKey, env: options.env,
    store,
  });
  options.signal?.throwIfAborted();
  if ("error" in credential) return credential;
  if (credential.apiKey) options.secrets.push(credential.apiKey);
  let routeCapability = provider === "xai" && options.modelCapability?.authRoute && options.modelCapability.authRoute !== "api-key" ? undefined : options.modelCapability;
  if (provider === "xai" && options.thinking !== undefined && routeCapability === undefined) {
    try {
      const { XAI_MODELS_URL } = await import("../model/providers/xai.ts");
      const { fetchProviderModelList, requireXaiModels, xaiModelCapabilities } = await import("../model/model-list.ts");
      const models = requireXaiModels(await fetchProviderModelList({
        url: XAI_MODELS_URL, apiKey: credential.apiKey, fetch: options.fetch, signal: options.signal, label: "xAI",
      }));
      routeCapability = xaiModelCapabilities(models).find(entry => entry.id === modelId)
        ?? { id: modelId ?? "", supportedThinking: [] };
      if (options.thinking && !routeCapability.supportedThinking.includes(options.thinking)) {
        return { error: `Thinking level "${options.thinking}" is not listed for xai/${modelId} in the xAI model list. Leave thinking unset or select a listed level.` };
      }
    } catch (error) { return { error: redactSecrets(messageOf(error), options.secrets) }; }
  }
  if (provider === "xai") {
    const error = validateThinking(provider, modelId ?? "", options.thinking, undefined, routeCapability ?? null, undefined, "api-key");
    if (error) return { error };
  }
  if (provider === "openai-compatible" && isOpenRouterEndpoint(options.baseUrl)) {
    try {
      routeCapability = options.modelCapability?.baseUrl === "https://openrouter.ai/api/v1" && options.modelCapability.id === modelId ? options.modelCapability : undefined;
      if (!routeCapability) {
        const { fetchProviderModelList, openRouterModelCapabilities } = await import("../model/model-list.ts");
        const models = await fetchProviderModelList({ url: "https://openrouter.ai/api/v1/models", apiKey: credential.apiKey,
          headers: options.headers, fetch: options.fetch, signal: options.signal, label: "OpenRouter" });
        routeCapability = openRouterModelCapabilities(models).find(entry => entry.id === modelId);
      }
      const error = validateThinking(provider, modelId ?? "", options.thinking, options.extraBody, routeCapability ?? null, options.baseUrl);
      if (error) return { error };
    } catch (error) {
      if (options.thinking !== undefined) return { error: redactSecrets(messageOf(error), options.secrets) };
      // Provider defaults remain usable when optional discovery is unavailable.
    }
  }
  const input = {
    provider, model: modelId, apiKey: credential.apiKey, maxTokens: options.maxTokens,
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    ...((provider === "xai" || isOpenRouterEndpoint(options.baseUrl)) && routeCapability !== undefined ? { modelCapability: routeCapability } : {}),
    ...(provider === "openai-compatible" ? {
      baseUrl: options.baseUrl, headers: options.headers, extraBody: options.extraBody, auth: options.auth ?? "optional",
    } : {}),
  };
  try {
    return { model: options.createModel ? bindLoaderReasoning(await options.createModel(input), input) : await loadProviderModel(input, options.fetch), ...(routeCapability ? { capability: routeCapability } : {}) };
  } catch (error) {
    return { error: redactSecrets(messageOf(error), options.secrets) };
  }
}

/** Normalize thrown values into a printable error string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const noticedConfigDeprecations = new WeakMap<TuiController, Set<string>>();

/** Publish each source-specific startup warning once for a controller, including after reloads. */
export function noticeConfigDeprecations(controller: TuiController, warnings: readonly ConfigDeprecationWarning[]): void {
  const seen = noticedConfigDeprecations.get(controller) ?? new Set<string>();
  noticedConfigDeprecations.set(controller, seen);
  for (const warning of warnings) {
    if (seen.has(warning.message)) continue;
    seen.add(warning.message);
    controller.notice(warning.message);
  }
}
