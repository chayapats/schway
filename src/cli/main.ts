import { runAgentLoop } from "../agent/loop.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import {
  redactSecrets,
  resolveAnthropicApiKey,
} from "../auth/secrets.ts";
import { createContextManager } from "../context/manager.ts";
import type { Model } from "../model/model.ts";
import { createSession } from "../session/session.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { findTool } from "../tools/find.ts";
import { grepTool } from "../tools/grep.ts";
import { lsTool } from "../tools/ls.ts";
import { readTool } from "../tools/read.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { writeTool } from "../tools/write.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";
import { parseArgs, USAGE } from "./args.ts";

/** Minimal writer used so tests can capture CLI output. */
export interface CliWriter {
  write(chunk: string): void;
}

/** Process I/O and optional injected model for headless runs. */
export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
  env: Record<string, string | undefined>;
  cwd: string;
  model?: Model;
  createModel?: (input: { apiKey: string }) => Promise<Model>;
}

/**
 * Run a headless Schway invocation.
 * Returns a process exit code: 0 on success, 1 on usage, auth, or run failure.
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
    io.stderr.write(`Missing prompt. Use schway -p "..." to run headless.\n`);
    return 1;
  }

  const secrets = collectSecrets(parsed.args.apiKey, io.env);
  let model = io.model;
  if (!model) {
    const credential = resolveAnthropicApiKey({
      runtimeApiKey: parsed.args.apiKey,
      env: io.env,
    });
    if ("error" in credential) {
      io.stderr.write(`${credential.error}\n`);
      return 1;
    }
    secrets.push(credential.apiKey);
    model = io.createModel
      ? await io.createModel({ apiKey: credential.apiKey })
      : await loadAnthropicModel(credential.apiKey);
  }

  const workspace = await resolveWorkspace(io.cwd);
  const session = createSession();
  session.append({
    type: "user",
    id: crypto.randomUUID(),
    content: [{ type: "text", text: parsed.args.prompt }],
  });

  let failed = false;
  let printedText = false;
  for await (const event of runAgentLoop({
    session,
    model,
    contextManager: createContextManager(workspace),
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

  if (!parsed.args.json && printedText && !failed) {
    io.stdout.write("\n");
  }

  return failed ? 1 : 0;
}

/** Gather runtime and environment API keys so output can redact them. */
function collectSecrets(
  runtimeApiKey: string | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const secrets: string[] = [];
  if (runtimeApiKey) {
    secrets.push(runtimeApiKey);
  }
  const envKey = env.ANTHROPIC_API_KEY;
  if (envKey) {
    secrets.push(envKey);
  }
  return secrets;
}

/** Redact configured secrets from event fields that can reach stdout. */
function redactEvent(event: RuntimeEvent, secrets: readonly string[]): RuntimeEvent {
  if (event.type === "error") {
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

/** Lazy-load the Anthropic adapter so unused providers stay off the startup path. */
async function loadAnthropicModel(apiKey: string): Promise<Model> {
  const { createAnthropicModel } = await import("../model/providers/anthropic.ts");
  return createAnthropicModel({ apiKey });
}

/** Process entrypoint for the `schway` binary. */
async function main(): Promise<number> {
  return runCli(process.argv.slice(2), {
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
    stderr: { write: (chunk) => void process.stderr.write(chunk) },
    env: process.env,
    cwd: process.cwd(),
  });
}

if (import.meta.main) {
  process.exit(await main());
}
