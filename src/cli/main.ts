import { runAgentLoop } from "../agent/loop.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import {
  redactSecrets,
  resolveAnthropicApiKey,
} from "../auth/secrets.ts";
import { createContextManager } from "../context/manager.ts";
import type { Model } from "../model/model.ts";
import { createSession } from "../session/session.ts";
import { readTool } from "../tools/read.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";
import { parseArgs, USAGE } from "./args.ts";

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
  env: Record<string, string | undefined>;
  cwd: string;
  model?: Model;
  createModel?: (input: { apiKey: string }) => Promise<Model>;
}

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
    tools: createToolRegistry([readTool]),
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

function redactEvent(event: RuntimeEvent, secrets: readonly string[]): RuntimeEvent {
  if (event.type !== "error") {
    return event;
  }
  return { ...event, message: redactSecrets(event.message, secrets) };
}

async function loadAnthropicModel(apiKey: string): Promise<Model> {
  const { createAnthropicModel } = await import("../model/providers/anthropic.ts");
  return createAnthropicModel({ apiKey });
}

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
