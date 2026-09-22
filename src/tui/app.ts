import { createContextManager, type ContextManager } from "../context/manager.ts";
import { loadConfigEditor, type ConfigEditor } from "../config/editing.ts";
import type { ResolvedSettings } from "../config/config.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import { resolve } from "node:path";
import {
  redactSecrets,
  resolveAnthropicApiKey,
  resolveOpenAIApiKey,
} from "../auth/secrets.ts";
import type { Model } from "../model/model.ts";
import {
  createJsonlSession,
  listSessions,
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
  type CliProvider,
} from "../cli/args.ts";
import { TuiController } from "./controller.ts";
import {
  dispatchEditorInput,
  helpText,
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

  let env = io.env;
  if (io.args.envFiles && io.args.envFiles.length > 0) {
    const loadedEnv = await applyEnvFiles(
      io.args.envFiles.map((path) => resolve(io.cwd, path)),
      env,
    );
    if ("error" in loadedEnv) {
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
      workspaceDiagnostics.push(...restored.diagnostics);
    } else {
      workspace = await resolveWorkspace(io.cwd);
    }
    workspace = await addWorkspaceRoots(workspace, io.args.addDirs ?? [], io.signal);
    if (startupResumed && io.args.addDirs?.length) startupResumed.setExtraRoots([...new Set([...startupResumed.metadata.extraRoots, ...workspace.extraRoots])]);
  } catch (error) {
    io.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }

  let configEditor: ConfigEditor;
  try {
    configEditor = await loadConfigEditor({ home, workspaceRoot: workspace.root, cli: cliOverridesFromArgs(io.args) });
  } catch (error) {
    io.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }
  const settings = configEditor.settings;
  if (
    hasCliConnectionOptions(io.args) &&
    settings.provider !== "openai-compatible"
  ) {
    io.stderr.write(
      "OpenAI-compatible connection options require --provider openai-compatible\n",
    );
    return 1;
  }

  const secrets = collectSecrets(io.args.apiKey, env);
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
    io.stderr.write(`${redactSecrets(messageOf(error), secrets)}\n`);
    return 1;
  }

  try {
    let model = io.model;
    let startupError: string | undefined;
    if (!model) {
      const loaded = await loadInteractiveModel(settings.provider, settings.model, {
        maxTokens: settings.maxOutput,
        baseUrl: settings.baseUrl,
        headers: settings.headers,
        extraBody: settings.extraBody,
        auth: settings.auth,
        runtimeApiKey: io.args.apiKey,
        env,
        fetch: io.fetch,
        createModel: io.createModel,
        secrets,
      });
      if ("error" in loaded) {
        startupError = loaded.error;
      } else {
        model = loaded.model;
      }
    }

    let controller: TuiController;
    const managerOptions = contextManagerOptions(home, settings.explicitContextWindow);
    const skillScope: { manager?: ContextManager; workspaceRoot: string } = {
      workspaceRoot: startupResumed?.header.workspaceRoot ?? io.cwd,
    };
    const stageSettings = (next: ResolvedSettings, signal: AbortSignal, nextWorkspace?: Workspace, currentModel?: Model) => stageInteractiveSettings(next, settings, {
      model: currentModel, workspace: nextWorkspace ?? controller.workspaceIdentity() ?? workspace,
      signal, home, runtimeApiKey: io.args.apiKey, env, fetch: io.fetch, createModel: io.createModel, secrets,
    });
    const onSettingsCommitted = (next: ResolvedSettings, manager: ContextManager) => {
      Object.assign(settings, next);
      settings.explicitContextWindow = next.explicitContextWindow;
      settings.explicitMaxOutput = next.explicitMaxOutput;
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
          configEditor, stageSettings, onSettingsCommitted,
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
          startupError,
          secrets,
        });
        if (!startupError) {
          controller.notice(
            `Resumed session ${resumed.header.id} with ${resumed.items.length} saved records. Old tool effects were not replayed.`,
          );
        }
      } else {
        const session = await createJsonlSession({ directory, workspace });
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
          configEditor, stageSettings, onSettingsCommitted,
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
          startupError,
          secrets,
        });
        if (!startupError) {
          controller.notice(`New session ${session.header.id}. Type /help for commands.`);
        }
      }
    } catch (error) {
      io.stderr.write(`${messageOf(error)}\n`);
      return 1;
    }

    for (const diagnostic of workspaceDiagnostics) controller.notice(diagnostic);
    try {
      await runTuiRenderer({
        controller,
        home,
        workspaceRoot: workspace.root,
        skillScope,
        sessionsDir: directory,
        settings,
        env,
        runtimeApiKey: io.args.apiKey,
        fetch: io.fetch,
        createModel: io.createModel,
        secrets,
        signal: io.signal,
        stderr: io.stderr,
      });
    } catch (error) {
      io.stderr.write(`${messageOf(error)}\n`);
      return 1;
    } finally {
      controller.dispose();
    }
    return 0;
  } finally {
    extensions.dispose();
  }
}

/** Stage a changed adapter and context budget, reusing the current adapter for edits that do not affect provider requests. */
export async function stageInteractiveSettings(
  next: ResolvedSettings,
  previous: ResolvedSettings,
  options: Parameters<typeof loadInteractiveModel>[2] & { model?: Model; workspace: Workspace; home: string; signal: AbortSignal },
): Promise<{ model?: Model; contextManager: ContextManager }> {
  const adapterKeys = ["provider", "model", "maxOutput", "baseUrl", "headers", "extraBody", "auth"] as const;
  let model = options.model;
  if (adapterKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))) {
    const loaded = await loadInteractiveModel(next.provider, next.model, { ...options,
      maxTokens: next.maxOutput, baseUrl: next.baseUrl, headers: next.headers, extraBody: next.extraBody, auth: next.auth,
    });
    options.signal.throwIfAborted();
    if ("error" in loaded) throw new Error(loaded.error);
    model = loaded.model;
  }
  options.signal.throwIfAborted();
  return { model, contextManager: createContextManager(options.workspace, contextManagerOptions(options.home, next.explicitContextWindow)) };
}

interface RendererSettings {
  provider: string;
  model: string;
  maxTurns: number;
  maxConcurrentTools: number;
  contextWindow: number;
  maxOutput: number;
  explicitContextWindow?: number;
  explicitMaxOutput?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: CliAuthMode;
}

/** Mount OpenTUI widgets, pump controller snapshots, and handle input until quit. */
async function runTuiRenderer(options: {
  controller: TuiController;
  home: string;
  workspaceRoot: string;
  skillScope: { manager?: ContextManager; workspaceRoot: string };
  sessionsDir: string;
  settings: RendererSettings;
  env: Record<string, string | undefined>;
  runtimeApiKey?: string;
  fetch?: FetchLike;
  createModel?: InteractiveIo["createModel"];
  secrets: string[];
  signal?: AbortSignal;
  stderr: TuiWriter;
}): Promise<void> {
  const { createCliRenderer, BoxRenderable, TextRenderable, InputRenderable, ScrollBoxRenderable } =
    await import("@opentui/core");

  const renderer = await createCliRenderer({
    // The app owns Ctrl+C (cancel turn when running, quit when idle) and
    // process signals via io.signal, so the renderer's built-in handlers
    // must not destroy the terminal out from under the cleanup flow.
    exitOnCtrlC: false,
    exitSignals: [],
  });
  let quit = false;
  let quitting = false;
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
    const root = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
      width: "100%",
      height: "100%",
    });
    renderer.root.add(root);

    const header = new TextRenderable(renderer, { content: "" });
    root.add(header);

    const transcriptBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    root.add(transcriptBox);
    const transcriptContent = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
    });
    transcriptBox.content.add(transcriptContent);

    const statusLine = new TextRenderable(renderer, { content: "" });
    root.add(statusLine);

    const input = new InputRenderable(renderer, {
      placeholder: "Type a prompt or /help (Esc cancels, Ctrl+C quits)",
      flexGrow: 0,
    });
    root.add(input);
    input.focus();

    let lastRendered = "";
    const render = () => {
      const snapshot = options.controller.snapshot();
      const headerText = redactSecrets(`schway - ${snapshot.provider}/${snapshot.modelId} - session ${snapshot.sessionId} - ${snapshot.status}`, options.secrets);
      try {
        header.content = headerText;
      } catch {
        // Header updates are best-effort; transcript below is authoritative.
      }
      let lines = formatTranscript(snapshot.transcript.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        toolName: entry.toolName,
        toolStatus: entry.toolStatus,
      })));
      if (snapshot.modelPicker) {
        const picker = snapshot.modelPicker;
        lines += `\n\nSelect model — search or type provider/model (↑/↓, Enter, Esc)\nCurrent: ${snapshot.provider}/${snapshot.modelId}\n`;
        lines += picker.entries.map((entry, index) => `${index === picker.selectedIndex ? ">" : " "} ${entry.active ? "*" : " "} ${entry.provider}/${entry.modelId} (${entry.contextWindow} ctx, ${entry.maxOutput} output)${entry.custom ? " [typed ID]" : ""}`).join("\n");
        if (!picker.entries.length) lines += "No matching models. Type provider/model-id for a custom ID.";
      }
      lines = redactSecrets(lines, options.secrets);
      const roots = options.controller.workspaceIdentity();
      const rootStatus = roots ? ` | Primary: ${roots.root} | Attached: ${roots.extraRoots.join(", ") || "none"}` : "";
      const statusText = redactSecrets(formatStatus(snapshot.status) + rootStatus, options.secrets);
      const fingerprint = `${headerText}\n${lines}\n${statusText}`;
      if (fingerprint === lastRendered) {
        return;
      }
      lastRendered = fingerprint;
      clearContainer(transcriptContent);
      // Rebuild visible rows from the controller snapshot; sessions stay durable.
      for (const line of lines.split("\n")) {
        const row = new TextRenderable(renderer, { content: line });
        transcriptContent.add(row);
      }
      try {
        statusLine.content = statusText;
      } catch {
        // Ignore sticky render errors; next tick retries.
      }
    };

    const submitPrompt = (value: string) => {
      void dispatchEditorInput(value, options.controller, async (command) => {
        await handleSlashCommand(command.name, command.args, {
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
        }, command.raw);
      }, () => { input.value = ""; }).then(render, (error: unknown) => {
        options.controller.fail(messageOf(error));
        render();
      });
    };

    input.on("enter", () => {
      if (options.controller.snapshot().modelPicker) {
        void options.controller.selectPickerModel().then(selected => { if (selected) input.value = ""; render(); });
        return;
      }
      const value = input.value;
      submitPrompt(value);
      render();
    });
    input.on("input", () => { options.controller.searchModels(input.value); render(); });

    renderer.keyInput.on("keypress", (key) => {
      const name = key.name.toLowerCase();
      if (options.controller.snapshot().modelPicker && (name === "up" || name === "down")) {
        options.controller.moveModelPicker(name === "up" ? -1 : 1);
        render();
        return;
      }
      if (key.ctrl && name === "c") {
        if (options.controller.running) {
          options.controller.cancel();
        } else {
          finishQuit();
        }
        return;
      }
      if (key.ctrl && name === "d") {
        finishQuit();
        return;
      }
      if (name === "escape") {
        if (options.controller.running) {
          options.controller.cancel();
        } else if (options.controller.snapshot().modelPicker) {
          options.controller.closeModelPicker();
          input.value = "";
          render();
        }
      }
    });

    render();
    while (!quit && !quitting) {
      render();
      if (options.signal?.aborted) {
        break;
      }
      await Bun.sleep(50);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    options.controller.dispose();
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
  }
}

/** Handle one slash command without leaving the interactive session. */
async function handleSlashCommand(
  name: string,
  args: string,
  ctx: {
    controller: TuiController;
    home: string;
    workspaceRoot: string;
    skillScope: { manager?: ContextManager; workspaceRoot: string };
    sessionsDir: string;
    settings: RendererSettings;
    env: Record<string, string | undefined>;
    runtimeApiKey?: string;
    fetch?: FetchLike;
    createModel?: InteractiveIo["createModel"];
    secrets: string[];
    finishQuit: () => void;
    stderr: TuiWriter;
  },
  raw?: string,
): Promise<void> {
  if ((name === "new" || name === "resume") && ctx.controller.running) {
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return;
  }
  const managerOptions = contextManagerOptions(ctx.home, ctx.settings.explicitContextWindow);
  switch (name) {
    case "new": {
      const workspace = await resolveWorkspace(ctx.workspaceRoot);
      const session = await createJsonlSession({
        directory: ctx.sessionsDir,
        workspace,
      });
      const manager = createContextManager(workspace, managerOptions);
      if (!await ctx.controller.switchSession(session, session.header.id, { workspace, contextManager: manager })) return;
      ctx.skillScope.manager = ctx.controller.activeContextManager();
      ctx.skillScope.workspaceRoot = workspace.root;
      ctx.controller.notice(`New session ${session.header.id}. Type /help for commands.`);
      return;
    }
    case "sessions": {
      const listed = await listSessions(ctx.sessionsDir);
      if (listed.length === 0) {
        ctx.controller.notice("No saved sessions yet.");
        return;
      }
      const lines = listed
        .slice(0, 20)
        .map((entry) => `- ${entry.id} (${entry.createdAt}, ${entry.workspaceRoot})`);
      ctx.controller.notice(`Saved sessions:\n${lines.join("\n")}`);
      return;
    }
    case "resume": {
      if (!args) {
        ctx.controller.fail("Usage: /resume <session-id>. See /sessions for ids.");
        return;
      }
      try {
        const resumed = await loadJsonlSession({ directory: ctx.sessionsDir, id: args });
        const restored = await restoreWorkspace({ root: resumed.header.workspaceRoot, launchCwd: resumed.header.launchCwd, extraRoots: [...resumed.metadata.extraRoots] });
        const workspace = restored.workspace;
        const manager = createContextManager(workspace, managerOptions);
        if (!await ctx.controller.switchSession(resumed, resumed.header.id, { workspace, contextManager: manager })) return;
        ctx.skillScope.manager = ctx.controller.activeContextManager();
        ctx.skillScope.workspaceRoot = workspace.root;
        for (const diagnostic of restored.diagnostics) ctx.controller.notice(diagnostic);
        ctx.controller.notice(
          `Resumed session ${resumed.header.id} with ${resumed.items.length} saved records. Old tool effects were not replayed.`,
        );
      } catch (error) {
        ctx.controller.fail(messageOf(error));
      }
      return;
    }
    case "model": {
      if (!args) {
        ctx.controller.openModelPicker();
        return;
      }
      await ctx.controller.selectModel(args);
      return;
    }
    case "branch": {
      ctx.controller.branchCommand(args);
      return;
    }
    case "compact": {
      await ctx.controller.compact();
      return;
    }
    case "add-dir": {
      await ctx.controller.addDirectories(args ? [args] : []);
      return;
    }
    case "skills": {
      const discovery = await discoverSkills({
        workspaceRoot: ctx.skillScope.workspaceRoot,
        extraRoots: ctx.controller.workspaceIdentity()?.extraRoots,
        home: ctx.home,
      });
      ctx.controller.notice(formatSkillsListing(discovery));
      return;
    }
    case "config": {
      await ctx.controller.configCommand(args);
      return;
    }
    case "help": {
      ctx.controller.notice(helpText(ctx.controller.extensionCommands()));
      return;
    }
    case "quit": {
      ctx.finishQuit();
      return;
    }
    case "unknown": {
      const invocation = raw ? parseSkillInvocation(raw) : null;
      if (invocation) {
        await invokeSkillTurn(invocation, ctx);
        return;
      }
      ctx.controller.fail("Unknown command. Type /help for commands.");
      return;
    }
    default: {
      ctx.controller.fail("Unknown command. Type /help for commands.");
      return;
    }
  }
}

/** Run one explicit skill invocation as a single active-skill turn, clearing state on settle. */
export async function invokeSkillTurn(
  invocation: { name: string; args: string; raw: string },
  ctx: {
    controller: TuiController;
    home: string;
    skillScope: { manager?: ContextManager; workspaceRoot: string };
  },
): Promise<void> {
  if (ctx.controller.running) {
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return;
  }
  const manager = ctx.skillScope.manager;
  if (!manager) {
    ctx.controller.fail("Skills are not ready yet; try again.");
    return;
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
    return;
  }
  if (ctx.controller.running) {
    ctx.controller.notice("Already running. Press Esc to cancel first.");
    return;
  }
  if (ctx.skillScope.manager !== manager || ctx.controller.snapshot().branchId !== branchId || JSON.stringify(workspaceIdentity) !== JSON.stringify(ctx.controller.workspaceIdentity())) {
    ctx.controller.notice("The active session changed. Retry the skill when ready.");
    return;
  }
  manager.setActiveSkill({
    name: prepared.skill.name,
    body: prepared.body,
    source: prepared.skill.displayPath,
    scope: prepared.skill.scope,
    dir: prepared.skill.dir,
  });
  try {
    await ctx.controller.submit(invocation.raw);
  } finally {
    manager.clearActiveSkill();
  }
}

/** Build context-manager options so catalog budgets follow model switches unless overridden. */
function contextManagerOptions(home: string, explicitContextWindow?: number): { home: string; contextWindow?: number } {
  return explicitContextWindow !== undefined ? { home, contextWindow: explicitContextWindow } : { home };
}

/** Remove all children from a container renderable. */
function clearContainer(container: {
  getChildren(): readonly unknown[];
  remove(child: never): void;
}): void {
  for (const child of [...container.getChildren()]) {
    container.remove(child as never);
  }
}

/** Format transcript rows with tool state and bounded text for terminal display. */
function formatTranscript(
  entries: ReadonlyArray<{
    kind: string;
    text: string;
    toolName?: string;
    toolStatus?: string;
  }>,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      lines.push(`› ${entry.text}`);
    } else if (entry.kind === "assistant") {
      lines.push(entry.text);
    } else if (entry.kind === "tool") {
      const state =
        entry.toolStatus === "running"
          ? "running"
          : entry.toolStatus === "success"
            ? "done"
            : entry.toolStatus === "cancelled"
              ? "cancelled"
              : "error";
      // Completed entry text is already bounded; only live output gets a preview
      // so a finished edit diff never loses its added lines to truncation.
      const visibleText =
        entry.toolStatus === "running"
          ? entry.text.split("\n").slice(0, 12).join("\n")
          : entry.text;
      lines.push(`⚙ ${entry.toolName ?? "tool"} [${state}]\n${visibleText}`);
    } else if (entry.kind === "error") {
      lines.push(`! ${entry.text}`);
    } else {
      lines.push(`* ${entry.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Format the running/idle/error status line. */
function formatStatus(status: string): string {
  if (status === "running") {
    return "running… Esc cancels the turn.";
  }
  if (status === "error") {
    return "error. Fix the issue and keep prompting, or /quit.";
  }
  return "idle. /help for commands.";
}

/** True when the user passed compatible connection flags on the CLI. */
function hasCliConnectionOptions(args: CliArgs): boolean {
  return (
    args.baseUrl !== undefined ||
    args.headers !== undefined ||
    args.extraBody !== undefined ||
    args.auth !== undefined
  );
}

/** Gather runtime and environment API keys so errors can redact them. */
function collectSecrets(
  runtimeApiKey: string | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const secrets: string[] = [];
  if (runtimeApiKey) {
    secrets.push(runtimeApiKey);
  }
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    secrets.push(anthropicKey);
  }
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    secrets.push(openaiKey);
  }
  return secrets;
}

/** Resolve credentials and construct the selected provider model for interactive use. */
async function loadInteractiveModel(
  provider: CliProvider,
  modelId: string | undefined,
  options: {
    maxTokens?: number;
    baseUrl?: string;
    headers?: Record<string, string>;
    extraBody?: Record<string, unknown>;
    auth?: CliAuthMode;
    runtimeApiKey: string | undefined;
    env: Record<string, string | undefined>;
    fetch?: FetchLike;
    createModel?: InteractiveIo["createModel"];
    secrets: string[];
  },
): Promise<{ model: Model } | { error: string }> {
  if (provider === "openai-compatible") {
    const auth = options.auth ?? "optional";
    const apiKey = options.runtimeApiKey?.trim() || undefined;
    if (auth === "required" && apiKey === undefined) {
      return {
        error: "Missing API key for OpenAI-compatible endpoint. Pass --api-key.",
      };
    }
    if (apiKey) {
      options.secrets.push(apiKey);
    }
    try {
      const model = options.createModel
        ? await options.createModel({
            apiKey,
            provider,
            model: modelId,
            maxTokens: options.maxTokens,
            baseUrl: options.baseUrl,
            headers: options.headers,
            extraBody: options.extraBody,
            auth,
          })
        : await loadProviderModel(
            {
              provider,
              apiKey,
              model: modelId,
              maxTokens: options.maxTokens,
              baseUrl: options.baseUrl,
              headers: options.headers,
              extraBody: options.extraBody,
              auth: options.auth,
            },
            options.fetch,
          );
      return { model };
    } catch (error) {
      return { error: redactSecrets(messageOf(error), options.secrets) };
    }
  }

  const credential =
    provider === "openai"
      ? resolveOpenAIApiKey({ runtimeApiKey: options.runtimeApiKey, env: options.env })
      : resolveAnthropicApiKey({ runtimeApiKey: options.runtimeApiKey, env: options.env });
  if ("error" in credential) {
    return credential;
  }
  options.secrets.push(credential.apiKey);
  try {
    const model = options.createModel
      ? await options.createModel({
          apiKey: credential.apiKey,
          provider,
          model: modelId,
          maxTokens: options.maxTokens,
        })
      : await loadProviderModel(
          {
            provider,
            apiKey: credential.apiKey,
            model: modelId,
            maxTokens: options.maxTokens,
          },
          options.fetch,
        );
    return { model };
  } catch (error) {
    return { error: redactSecrets(messageOf(error), options.secrets) };
  }
}

/** Normalize thrown values into a printable error string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
