import { flushDraftOnExit, type ExitDraftResult } from "../drafts/exit.ts";
import { createContextManager, type ContextManager } from "../context/manager.ts";
import { loadConfigEditor, type ConfigEditor } from "../config/editing.ts";
import type { ResolvedSettings } from "../config/config.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import { resolve } from "node:path";
import { createDiagnosticSink, type DiagnosticSink } from "../diagnostics/sink.ts";
import {
  redactSecrets,
} from "../auth/secrets.ts";
import { COMPATIBLE_API_KEY_ENV, resolveProviderCredential, selectOpenAITransport } from "../auth/credentials.ts";
import { loadCredentialSafeTui } from "./credential-input.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import type { Model } from "../model/model.ts";
import {
  createJsonlSession,
  deleteJsonlSession,
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
import {
  dispatchEditorInput,
  parseSkillInvocation,
} from "./commands.ts";
import {
  discoverSkills,
  formatSkillsListing,
  prepareSkillInvocation,
} from "../skills/skills.ts";
import { loadProviderModel } from "../model/loader.ts";

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

  const secrets: string[] = collectSecrets(io.args.apiKey, io.env);
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
      io.stderr.write(`${loadedEnv.error}\n`);
      return 1;
    }
    env = loadedEnv;
  }

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
    io.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }

  let configEditor: ConfigEditor;
  try {
    configEditor = await loadConfigEditor({ home, workspaceRoot: workspace.root, cli: cliOverridesFromArgs(io.args), interactiveMemory: true });
  } catch (error) {
    diagnostics.record("config", "invalid_configuration", { category: "resolution_failed" }, "error");
    io.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }
  let settings = configEditor.settings;
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
  if (io.args.openaiAuth !== undefined && settings.provider !== "openai") {
    diagnostics.record("config", "invalid_configuration", { category: "provider_option_conflict" }, "error");
    io.stderr.write("OpenAI auth preference requires --provider openai\n");
    return 1;
  }

  secrets.push(...collectSecrets(undefined, env, settings.credentialEnv));
  diagnostics.record("config", "resolved", { provider: settings.provider, model: settings.model, maxTurns: settings.maxTurns, maxConcurrentTools: settings.maxConcurrentTools });
  const credentialStore = io.credentialStore ?? createNativeCredentialStore();
  const loadWorkspaceExtensions = (nextWorkspace: Workspace, signal: AbortSignal) => loadExtensions({
    modules: io.args.extensions ?? [], workspace: nextWorkspace, secrets, home, signal,
    tools: createToolRegistry([readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool]),
  });
  let tools: ToolRegistry;
  let extensions: ExtensionRuntime;
  try {
    const loaded = await loadExtensions({
      modules: io.args.extensions ?? [], workspace, secrets, home, signal: io.signal,
      onDiagnostic: (message) => io.stderr.write(`${message}\n`),
      tools: createToolRegistry([readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool]),
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
    const initialize = async (signal: AbortSignal) => {
      const loaded = await loadInteractiveModel(settings.provider, settings.model, {
        signal,
        verifySubscriptionChoice: configEditor.origins.model === "interactive memory" ? true : settings.openaiAuth === "codex" ? "selected" : false,
        maxTokens: settings.maxOutput,
        baseUrl: settings.baseUrl,
        headers: settings.headers,
        extraBody: settings.extraBody,
        auth: settings.auth,
        openaiAuth: settings.openaiAuth,
        thinking: settings.thinking,
        profile: settings.profile,
        credentialEnv: settings.credentialEnv,
        credentialIdentity: settings.credentialIdentity,
        runtimeApiKey: io.args.apiKey,
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
        if (loaded.capability) { configEditor.setModelCapabilities([loaded.capability]); settings = configEditor.settings; }
      } };
    };

    let controller: TuiController;
    const managerOptions = contextManagerOptions(home, settings.explicitContextWindow);
    const skillScope: { manager?: ContextManager; workspaceRoot: string } = {
      workspaceRoot: startupResumed?.header.workspaceRoot ?? io.cwd,
    };
    const stageSettings = (next: ResolvedSettings, signal: AbortSignal, nextWorkspace?: Workspace, currentModel?: Model, activate?: boolean) => stageInteractiveSettings(next, settings, {
      forceLoad: activate, model: currentModel, workspace: nextWorkspace ?? controller.workspaceIdentity() ?? workspace,
      signal, home, runtimeApiKey: io.args.apiKey, env, fetch: io.fetch, createModel: io.createModel, secrets, credentialStore,
    });
    const codexLogin = createCodexLoginRunner({ store: credentialStore, fetch: io.fetch, secrets });
    const credentials = {
      store: credentialStore, env, runtimeApiKey: io.args.apiKey,
      rememberSecret: (key: string) => { if (!secrets.includes(key)) secrets.push(key); },
      reload: (override?: ResolvedSettings) => {
        const current = override ?? settings;
        return loadInteractiveModel(current.provider, current.model, {
          maxTokens: current.maxOutput, baseUrl: current.baseUrl, headers: current.headers,
          extraBody: current.extraBody, auth: current.auth, openaiAuth: current.openaiAuth,
          thinking: current.thinking, profile: current.profile,
          credentialEnv: current.credentialEnv, credentialIdentity: current.credentialIdentity,
          runtimeApiKey: io.args.apiKey,
          env, fetch: io.fetch, createModel: io.createModel, secrets, credentialStore,
        });
      },
      codexLogin,
      listSubscriptionCatalog: async (signal: AbortSignal) => {
        const { fetchSubscriptionCatalog } = await import("../model/providers/codex-subscription.ts");
        return fetchSubscriptionCatalog({ store: credentialStore, fetch: io.fetch, signal });
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
          openaiAuth: settings.openaiAuth,
          thinking: settings.thinking,
          profile: settings.profile,
          startupError,
          secrets,
        });
        controller.markRestored();
        if (!startupError) {
          controller.notice(
            `Resumed ${resumed.items.length} saved records. /session for details.`,
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
          openaiAuth: settings.openaiAuth,
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
    if (configEditor.memoryProblem && configEditor.memoryNotice) controller.notice(configEditor.memoryNotice);
    if (startupError && !configEditor.memoryProblem && configEditor.memoryNotice) controller.notice(`Remembered choice could not activate: ${redactSecrets(startupError, secrets).slice(0, 500)} Use /model to repair it or /model forget; no alternate billing route was selected.`);
    diagnostics.record("session", "ready", { resumed: !!io.args.resume });
    for (const diagnostic of workspaceDiagnostics) controller.notice(diagnostic);
    try {
      await runTuiRenderer({
        controller,
        initialize: !model && !startupError ? () => controller.initializeStartup(initialize) : undefined,
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
      });
    } catch (error) {
      diagnostics.record("tui", "renderer_failed", { category: "terminal_setup" }, "error");
      io.stderr.write(`${messageOf(error)}\n`);
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
  options: Parameters<typeof loadInteractiveModel>[2] & { forceLoad?: boolean; model?: Model; workspace: Workspace; home: string; signal: AbortSignal },
): Promise<{ model?: Model; contextManager: ContextManager; modelCapability?: import("../model/catalog.ts").ModelCapability }> {
  const adapterKeys = ["provider", "model", "maxOutput", "baseUrl", "headers", "extraBody", "auth", "openaiAuth", "thinking", "effectiveThinking", "supportedThinking", "profile", "credentialEnv", "credentialIdentity"] as const;
  let model = options.model;
  let modelCapability: import("../model/catalog.ts").ModelCapability | undefined;
  if ((options.forceLoad && !model) || (next.provider === "openai" && next.openaiAuth === "codex" && !model) || adapterKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) {
    const loaded = await loadInteractiveModel(next.provider, next.model, { ...options,
      verifySubscriptionChoice: next.openaiAuth === "codex" && next.supportedThinking === undefined,
      maxTokens: next.maxOutput, baseUrl: next.baseUrl, headers: next.headers, extraBody: next.extraBody, auth: next.auth, openaiAuth: next.openaiAuth, thinking: next.thinking,
      ...(next.supportedThinking !== undefined ? { modelCapability: { id: next.model, supportedThinking: next.supportedThinking } } : {}),
      profile: next.profile, credentialEnv: next.credentialEnv, credentialIdentity: next.credentialIdentity,
    });
    options.signal.throwIfAborted();
    if ("error" in loaded) throw new Error(loaded.error);
    model = loaded.model;
    modelCapability = loaded.capability;
  }
  options.signal.throwIfAborted();
  return { model, ...(modelCapability ? { modelCapability } : {}), contextManager: createContextManager(options.workspace, contextManagerOptions(options.home, next.explicitContextWindow)) };
}

/** Mount OpenTUI widgets, pump controller snapshots, and handle input until quit. */
async function runTuiRenderer(options: {
  controller: TuiController;
  initialize?: () => Promise<void>;
  home: string;
  workspaceRoot: string;
  skillScope: { manager?: ContextManager; workspaceRoot: string };
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
    if (draft && "timedOut" in draft && draft.timedOut) options.stderr.write("Draft checkpoint timed out; unsaved input was not confirmed saved.\n");
    else if (draft?.failed) options.stderr.write("Draft checkpoint failed; unsaved input was not confirmed saved.\n");
    else if (draft?.saved) options.stderr.write("Latest completed draft checkpoint saved.\n");
    if (interrupted) options.stderr.write("Cancellation requested. Running tools may have changed files; completion was not confirmed.\n");
    if (resume.persisted() || (draft && "persisted" in draft && draft.persisted)) options.stderr.write(`Resume: schway --resume ${resume.sessionId}\n`);
  }
}

/** Execute one interactive slash command and report whether the editor may release it. */
export async function handleSlashCommand(
  name: string,
  args: string,
  ctx: {
    controller: TuiController;
    home: string;
    workspaceRoot: string;
    skillScope: { manager?: ContextManager; workspaceRoot: string };
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
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return false;
  }
  const managerOptions = contextManagerOptions(ctx.home, ctx.settings().explicitContextWindow);
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
      ctx.controller.notice("New session. Type / for commands or /session for details.");
      return true;
    }
    case "delete-session": {
      const id = args.trim();
      if (!id || /\s/.test(id)) { ctx.controller.fail("Usage: /delete-session <exact-session-id>. Switch away with /new first."); return false; }
      if (id === ctx.controller.snapshot().sessionId) { ctx.controller.fail("Switch away with /new before deleting this session."); return false; }
      try { await deleteJsonlSession({ directory: ctx.sessionsDir, home: ctx.home, id }); ctx.controller.notice("Session and associated draft content deleted."); return true; }
      catch (error) { ctx.controller.fail(`Cannot delete session: ${messageOf(error)}`); return false; }
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
      try {
        const resumed = await loadJsonlSession({ directory: ctx.sessionsDir, id: sessionId, ...(branchId ? { branchId } : {}) });
        const restored = await restoreWorkspace({ root: resumed.header.workspaceRoot, launchCwd: resumed.header.launchCwd, extraRoots: [...resumed.metadata.extraRoots] });
        const workspace = restored.workspace;
        const manager = createContextManager(workspace, managerOptions);
        if (resumeSignal?.aborted) return false;
        if (!await ctx.controller.switchSession(resumed, resumed.header.id, { workspace, contextManager: manager })) return false;
        ctx.controller.markRestored();
        ctx.skillScope.manager = ctx.controller.activeContextManager();
        ctx.skillScope.workspaceRoot = workspace.root;
        for (const diagnostic of restored.diagnostics) ctx.controller.notice(diagnostic);
        ctx.controller.notice(
          `Resumed ${resumed.items.length} saved records. /session for details.`,
        );
        return true;
      } catch (error) {
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
        workspaceRoot: ctx.skillScope.workspaceRoot,
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
      ctx.controller.fail("Unknown command. Type /help for commands.");
      return false;
    }
    default: {
      ctx.controller.fail("Unknown command. Type /help for commands.");
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
    skillScope: { manager?: ContextManager; workspaceRoot: string };
  },
  accepted: () => void = () => {},
): Promise<boolean> {
  if (ctx.controller.running) {
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return false;
  }
  const manager = ctx.skillScope.manager;
  if (!manager) {
    ctx.controller.fail("Skills are not ready yet; try again.");
    return false;
  }
  const branchId = ctx.controller.snapshot().branchId;
  const workspaceIdentity = ctx.controller.workspaceIdentity();
  const prepared = await prepareSkillInvocation({
    workspaceRoot: ctx.skillScope.workspaceRoot,
    extraRoots: workspaceIdentity?.extraRoots,
    home: ctx.home,
    name: invocation.name,
  });
  if (!prepared.ok) {
    ctx.controller.fail(prepared.error);
    return false;
  }
  if (ctx.controller.running) {
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return false;
  }
  if (ctx.skillScope.manager !== manager || ctx.controller.snapshot().branchId !== branchId || JSON.stringify(workspaceIdentity) !== JSON.stringify(ctx.controller.workspaceIdentity())) {
    ctx.controller.notice("The active session changed. Retry the skill when ready.");
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

/** Build context-manager options so catalog budgets follow model switches unless overridden. */
function contextManagerOptions(home: string, explicitContextWindow?: number): { home: string; contextWindow?: number } {
  return explicitContextWindow !== undefined ? { home, contextWindow: explicitContextWindow } : { home };
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
  if (tree.truncated) lines.push(`… truncated to ${tree.nodes.length} of ${tree.totalNodeCount} nodes. Use /branch list for IDs.`);
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
): string[] {
  const secrets: string[] = [];
  if (runtimeApiKey) {
    secrets.push(runtimeApiKey);
  }
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    secrets.push(anthropicKey);
  }
  const compatibleKey = env[COMPATIBLE_API_KEY_ENV];
  if (compatibleKey) secrets.push(compatibleKey);
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    secrets.push(openaiKey);
  }
  if (credentialEnv && credentialEnv !== COMPATIBLE_API_KEY_ENV) {
    const profileKey = env[credentialEnv];
    if (profileKey) secrets.push(profileKey);
  }
  return secrets;
}

/** Build the explicit subscription login runner, lazily loading the isolated Codex adapter only on use. */
export function createCodexLoginRunner(options: {
  store: CredentialStore;
  fetch?: FetchLike;
  secrets: string[];
  openBrowser?: (url: string) => Promise<void> | void;
}): CodexLoginRunner {
  return async ({ device, code, signal, onProgress, onSaved }) => {
    const codex = await import("../model/providers/codex-subscription.ts");
    try {
      const tokens = device
        ? await codex.loginWithDeviceFlow({
          store: options.store,
          signal,
          deps: { fetch: options.fetch, onProgress, onSaved },
        })
        : await codex.loginWithBrowserFlow({
          store: options.store,
          ...(code !== undefined ? { pastedCode: code } : {}),
          signal,
          deps: {
            fetch: options.fetch,
            openBrowser: options.openBrowser ?? openBrowserUrl,
            waitForCallbackCode: (attempt) => codex.waitForLocalhostCallback(attempt),
            onProgress, onSaved,
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
      const actionable = /^(ChatGPT sign-in was denied|The sign-in code expired|The sign-in response has no access token|No active browser sign-in attempt|The callback state does not match|The pasted callback URL|The pasted code is empty|The callback URL has no authorization code|The localhost|ChatGPT sign-in timed out|The sign-in endpoint|Exchanging the sign-in code failed|Device sign-in|Cannot save credential)/.test(message);
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
        const model = options.createModel ? await options.createModel(input) : await loadProviderModel({ ...input, codexStore: store }, options.fetch);
        return { model, ...(selection.notice ? { notice: selection.notice } : {}), ...(capability ? { capability } : {}) };
      } catch (error) {
        return { error: redactSecrets(messageOf(error), options.secrets) };
      }
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
  const input = {
    provider, model: modelId, apiKey: credential.apiKey, maxTokens: options.maxTokens,
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    ...(provider === "openai-compatible" ? {
      baseUrl: options.baseUrl, headers: options.headers, extraBody: options.extraBody, auth: options.auth ?? "optional",
    } : {}),
  };
  try {
    return { model: options.createModel ? await options.createModel(input) : await loadProviderModel(input, options.fetch) };
  } catch (error) {
    return { error: redactSecrets(messageOf(error), options.secrets) };
  }
}

/** Normalize thrown values into a printable error string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
