import { resolve } from "node:path";
import { runAgentLoop } from "../agent/loop.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { COMPATIBLE_API_KEY_ENV, resolveProviderCredential } from "../auth/credentials.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { loadResolvedSettings, type ResolvedSettings } from "../config/config.ts";
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
import {
  cliOverridesFromArgs,
  parseArgs,
  USAGE,
  type CliArgs,
  type CliAuthMode,
  type CliThinking,
} from "./args.ts";

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
    thinking?: CliThinking;
  }) => Promise<Model>;
}

/**
 * Dispatch CLI arguments to a persisted headless run or a lazily loaded interactive terminal.
 * Without `-p` this opens the interactive terminal; with `-p` it runs headless.
 * Returns 0 on success and 1 on handled usage, auth, or run failure; unhandled setup/I/O failures can reject.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 1;
  }

  if (parsed.args.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (!parsed.args.prompt) {
    return runInteractive(parsed.args, io);
  }

  if (/^\s*\/(?:login|logout)(?:\s|$)/i.test(parsed.args.prompt)) {
    io.stderr.write("Credential management requires interactive mode. Start schway without -p.\n");
    return 1;
  }

  const home = io.env.HOME;
  if (!home) {
    io.stderr.write("HOME is not set; cannot write session history.\n");
    return 1;
  }

  let env = io.env;
  if (parsed.args.envFiles && parsed.args.envFiles.length > 0) {
    const loadedEnv = await applyEnvFiles(
      parsed.args.envFiles.map((path) => resolve(io.cwd, path)),
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
  let session: JsonlSession | undefined;
  if (parsed.args.resume) {
    try {
      session = await loadJsonlSession({
        directory,
        id: parsed.args.resume,
        branchId: parsed.args.branch,
      });
    } catch (error) {
      io.stderr.write(`${errorMessage(error)}\n`);
      return 1;
    }
    const restored = await restoreWorkspace({ root: session.header.workspaceRoot, launchCwd: session.header.launchCwd, extraRoots: [...session.metadata.extraRoots] });
    workspace = restored.workspace;
    for (const diagnostic of restored.diagnostics) io.stderr.write(`${diagnostic}\n`);
  } else {
    workspace = await resolveWorkspace(io.cwd);
  }

  try {
    workspace = await addWorkspaceRoots(workspace, parsed.args.addDirs ?? [], io.signal);
    if (session && parsed.args.addDirs?.length) session.setExtraRoots([...new Set([...session.metadata.extraRoots, ...workspace.extraRoots])]);
  } catch (error) {
    io.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  const settings = await loadResolvedSettings({
    home,
    workspaceRoot: workspace.root,
    cli: cliOverridesFromArgs(parsed.args),
  });
  if ("error" in settings) {
    io.stderr.write(`${settings.error}\n`);
    return 1;
  }
  if (
    hasCliConnectionOptions(parsed.args) &&
    settings.provider !== "openai-compatible"
  ) {
    io.stderr.write(
      `OpenAI-compatible connection options require --provider openai-compatible\n${USAGE}\n`,
    );
    return 1;
  }

  const secrets = collectSecrets(parsed.args.apiKey, env, settings.credentialEnv);
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

    let model = io.model;
    if (!model) {
      const loaded = await loadCliModel(settings, parsed.args.apiKey, { ...io, env }, secrets);
      if ("error" in loaded) {
        io.stderr.write(`${loaded.error}\n`);
        return 1;
      }
      model = loaded.model;
    }

    if (!session) {
      session = await createJsonlSession({ directory, workspace });
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
    try {
      for await (const event of runAgentLoop({
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
            `Retrying provider request (${safeEvent.attempt}/${safeEvent.maxAttempts}) in ${safeEvent.delayMs}ms: ${safeEvent.message}\n`,
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

/** Redact configured secrets from event fields that can reach stdout. */
function redactEvent(event: RuntimeEvent, secrets: readonly string[]): RuntimeEvent {
  if (event.type === "error" || event.type === "model.retry") {
    return { ...event, message: redactSecrets(event.message, secrets) };
  }
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

/** Resolve credentials and construct the selected provider model. */
async function loadCliModel(
  settings: ResolvedSettings,
  runtimeApiKey: string | undefined,
  io: CliIo,
  secrets: string[],
): Promise<{ model: Model } | { error: string }> {
  const credential = await resolveProviderCredential({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    auth: settings.auth,
    profile: settings.profile,
    credentialEnv: settings.credentialEnv,
    credentialIdentity: settings.credentialIdentity,
    runtimeApiKey,
    env: io.env,
    store: io.credentialStore ?? createNativeCredentialStore(),
  });
  if ("error" in credential) return credential;
  if (credential.apiKey) secrets.push(credential.apiKey);
  const input = {
    apiKey: credential.apiKey,
    provider: settings.provider,
    model: settings.model,
    maxTokens: settings.maxOutput,
    ...(settings.thinking !== undefined ? { thinking: settings.thinking } : {}),
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
