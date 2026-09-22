import { createContextManager, type ContextManager } from "../context/manager.ts";
import { loadResolvedSettings } from "../config/config.ts";
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
import { createToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";
import { resolveWorkspace, type Workspace } from "../workspace/workspace.ts";
import {
  cliOverridesFromArgs,
  type CliArgs,
  type CliAuthMode,
  type CliProvider,
} from "../cli/args.ts";
import { TuiController } from "./controller.ts";
import {
  formatModelPicker,
  helpText,
  parseModelArgs,
  parseSkillInvocation,
  parseSlashCommand,
} from "./commands.ts";
import {
  discoverSkills,
  formatSkillsListing,
  prepareSkillInvocation,
} from "../skills/skills.ts";
import { loadProviderModel } from "../model/loader.ts";
import { listCatalog, lookupModel } from "../model/catalog.ts";

/** Minimal writer used so the TUI can fall back to stderr when TTY setup fails. */
export interface TuiWriter {
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
  fetch?: FetchLike;
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
 * Run the interactive terminal conversation.
 * Returns a process exit code: 0 on clean quit, 1 on startup failure.
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
  try {
    if (io.args.resume) {
      startupResumed = await loadJsonlSession({ directory, id: io.args.resume });
      workspace = {
        root: startupResumed.header.workspaceRoot,
        launchCwd: startupResumed.header.launchCwd,
        extraRoots: [...startupResumed.header.extraRoots],
      };
    } else {
      workspace = await resolveWorkspace(io.cwd);
    }
  } catch (error) {
    io.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }

  const settings = await loadResolvedSettings({
    home,
    workspaceRoot: workspace.root,
    cli: cliOverridesFromArgs(io.args),
  });
  if ("error" in settings) {
    io.stderr.write(`${settings.error}\n`);
    return 1;
  }
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
  try {
    if (io.args.resume) {
      // Reuse the session handle loaded during startup, including settlements.
      const resumed = startupResumed!;
      const resumedWorkspace: Workspace = {
        root: resumed.header.workspaceRoot,
        launchCwd: resumed.header.launchCwd,
        extraRoots: resumed.header.extraRoots,
      };
      const resumedManager = createContextManager(resumedWorkspace, managerOptions);
      skillScope.manager = resumedManager;
      skillScope.workspaceRoot = resumed.header.workspaceRoot;
      controller = new TuiController({
        session: resumed,
        model,
        contextManager: resumedManager,
        tools: createToolRegistry([
          readTool,
          writeTool,
          editTool,
          bashTool,
          grepTool,
          findTool,
          lsTool,
        ]),
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
        tools: createToolRegistry([
          readTool,
          writeTool,
          editTool,
          bashTool,
          grepTool,
          findTool,
          lsTool,
        ]),
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

  try {
    await runTuiRenderer({
      controller,
      home,
      workspaceRoot: workspace.root,
      skillScope,
      sessionsDir: directory,
      settings: {
        provider: settings.provider,
        model: settings.model,
        maxTurns: settings.maxTurns,
        maxConcurrentTools: settings.maxConcurrentTools,
        contextWindow: settings.contextWindow,
        maxOutput: settings.maxOutput,
        explicitContextWindow: settings.explicitContextWindow,
        explicitMaxOutput: settings.explicitMaxOutput,
        baseUrl: settings.baseUrl,
        headers: settings.headers,
        extraBody: settings.extraBody,
        auth: settings.auth,
      },
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
      const headerText = `schway - ${snapshot.provider}/${snapshot.modelId} - session ${snapshot.sessionId} - ${snapshot.status}`;
      try {
        header.content = headerText;
      } catch {
        // Header updates are best-effort; transcript below is authoritative.
      }
      const lines = formatTranscript(snapshot.transcript.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        toolName: entry.toolName,
        toolStatus: entry.toolStatus,
      })));
      const statusText = formatStatus(snapshot.status);
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
      const text = value.trim();
      if (text.length === 0) {
        return;
      }
      const command = parseSlashCommand(text);
      if (command) {
        void handleSlashCommand(command.name, command.args, {
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
        }, command.raw).catch((error: unknown) => {
          options.controller.fail(messageOf(error));
        });
        return;
      }
      if (options.controller.running) {
        options.controller.notice("Already running. Press Esc to cancel first.");
        render();
        return;
      }
      void options.controller.submit(text).then(render, render);
    };

    input.on("enter", () => {
      const value = input.value;
      input.value = "";
      submitPrompt(value);
      render();
    });

    renderer.keyInput.on("keypress", (key) => {
      const name = key.name.toLowerCase();
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
  const managerOptions = contextManagerOptions(ctx.home, ctx.settings.explicitContextWindow);
  switch (name) {
    case "new": {
      const workspace = await resolveWorkspace(ctx.workspaceRoot);
      const session = await createJsonlSession({
        directory: ctx.sessionsDir,
        workspace,
      });
      const manager = createContextManager(workspace, managerOptions);
      ctx.skillScope.manager = manager;
      ctx.skillScope.workspaceRoot = workspace.root;
      ctx.controller.replaceSession(session, session.header.id, {
        workspace,
        contextManager: manager,
      });
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
        const workspace: Workspace = {
          root: resumed.header.workspaceRoot,
          launchCwd: resumed.header.launchCwd,
          extraRoots: [...resumed.header.extraRoots],
        };
        const manager = createContextManager(workspace, managerOptions);
        ctx.skillScope.manager = manager;
        ctx.skillScope.workspaceRoot = workspace.root;
        ctx.controller.replaceSession(resumed, resumed.header.id, {
          workspace,
          contextManager: manager,
        });
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
        const snapshot = ctx.controller.snapshot();
        ctx.controller.notice(
          formatModelPicker(snapshot.provider, snapshot.modelId, listCatalog()),
        );
        return;
      }
      const snapshot = ctx.controller.snapshot();
      const selection = parseModelArgs(args, snapshot.provider);
      if ("error" in selection) {
        ctx.controller.fail(selection.error);
        return;
      }
      if (ctx.controller.running) {
        ctx.controller.notice("Already running. Press Esc to cancel first.");
        return;
      }
      await switchInteractiveModel(selection.provider, selection.modelId, ctx);
      return;
    }
    case "compact": {
      await ctx.controller.compact();
      return;
    }
    case "skills": {
      const discovery = await discoverSkills({
        workspaceRoot: ctx.skillScope.workspaceRoot,
        home: ctx.home,
      });
      ctx.controller.notice(formatSkillsListing(discovery));
      return;
    }
    case "config": {
      ctx.controller.notice(ctx.controller.describeConfig());
      return;
    }
    case "help": {
      ctx.controller.notice(helpText());
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
async function invokeSkillTurn(
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
  const prepared = await prepareSkillInvocation({
    workspaceRoot: ctx.skillScope.workspaceRoot,
    home: ctx.home,
    name: invocation.name,
  });
  if (!prepared.ok) {
    ctx.controller.fail(prepared.error);
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

/** Switch the session model without persisting credentials or config files. */
async function switchInteractiveModel(
  provider: string,
  modelId: string,
  ctx: {
    controller: TuiController;
    settings: RendererSettings;
    env: Record<string, string | undefined>;
    runtimeApiKey?: string;
    fetch?: FetchLike;
    createModel?: InteractiveIo["createModel"];
    secrets: string[];
  },
): Promise<void> {
  const normalizedProvider = provider.toLowerCase();
  if (
    normalizedProvider !== "anthropic" &&
    normalizedProvider !== "openai" &&
    normalizedProvider !== "openai-compatible"
  ) {
    ctx.controller.fail(
      `Unknown provider: ${provider}. Valid providers: anthropic, openai, openai-compatible`,
    );
    return;
  }
  const target = normalizedProvider as CliProvider;
  const budgets = lookupModel(target, modelId, {
    ...(ctx.settings.explicitContextWindow !== undefined
      ? { contextWindow: ctx.settings.explicitContextWindow }
      : {}),
    ...(ctx.settings.explicitMaxOutput !== undefined
      ? { maxOutput: ctx.settings.explicitMaxOutput }
      : {}),
  });
  const loaded = await loadInteractiveModel(target, modelId, {
    maxTokens: ctx.settings.explicitMaxOutput ?? budgets.maxOutput,
    baseUrl: ctx.settings.baseUrl,
    headers: ctx.settings.headers,
    extraBody: ctx.settings.extraBody,
    auth: ctx.settings.auth,
    runtimeApiKey: ctx.runtimeApiKey,
    env: ctx.env,
    fetch: ctx.fetch,
    createModel: ctx.createModel,
    secrets: ctx.secrets,
  });
  if ("error" in loaded) {
    ctx.controller.fail(loaded.error);
    return;
  }
  ctx.controller.setModel(loaded.model, target, modelId);
  ctx.settings.provider = target;
  ctx.settings.model = modelId;
  ctx.settings.contextWindow = budgets.contextWindow;
  ctx.settings.maxOutput = budgets.maxOutput;
  ctx.controller.notice(
    `Switched to ${target}/${modelId} (${budgets.contextWindow} ctx). Applies to this session only.`,
  );
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
