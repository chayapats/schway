import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import type { Model } from "../src/model/model.ts";
import type { ToolResult } from "../src/conversation/types.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

/** Capture writes so CLI tests can assert stdout and stderr. */
function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

/** Run `runCli` against an in-memory IO harness. */
async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    model?: Model;
    signal?: AbortSignal;
    createModel?: (input: {
      apiKey?: string;
      provider: string;
      model?: string;
      maxTokens?: number;
      baseUrl?: string;
      headers?: Record<string, string>;
      extraBody?: Record<string, unknown>;
      auth?: "required" | "optional" | "none";
    }) => Promise<Model>;
  } = {},
) {
  const isolatedHome =
    options.env?.HOME ?? (await mkdtemp(join(tmpdir(), "schway-home-")));
  const stdout = capture();
  const stderr = capture();
  try {
    const exitCode = await runCli(argv, {
      stdout,
      stderr,
      env: {
        HOME: isolatedHome,
        ...(options.env ?? { ANTHROPIC_API_KEY: "sk-test" }),
      },
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      signal: options.signal,
      createModel: options.createModel,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  } finally {
    if (options.env?.HOME === undefined) {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
}

/** True when any parsed JSONL value contains `secret` as a string, not as escaped JSON text. */
function parsedJsonlContains(text: string, secret: string): boolean {
  for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
    if (valueContains(JSON.parse(line), secret)) {
      return true;
    }
  }
  return false;
}

function valueContains(value: unknown, secret: string): boolean {
  if (typeof value === "string") {
    return value.includes(secret);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueContains(entry, secret));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) => valueContains(entry, secret));
  }
  return false;
}

test("schway -p streams text from the agent loop", async () => {
  const result = await run(["-p", "hello"], {
    model: createScriptedModel({ chunks: ["Hel", "lo"] }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.startsWith("Hello")).toBe(true);
  expect(result.stderr).toBe("");
});

test("--json streams normalized runtime events as JSONL on stdout", async () => {
  const result = await run(["-p", "hello", "--json"], {
    model: createScriptedModel({ chunks: ["Hi"] }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  expect(events.map((event) => event.type)).toEqual([
    "agent.started",
    "model.started",
    "model.delta",
    "model.finished",
    "agent.finished",
  ]);
  expect(result.stdout.includes("content_block_delta")).toBe(false);
  expect(result.stdout.includes("message_start")).toBe(false);
});

test("missing credentials exit non-zero without interactive login", async () => {
  const result = await run(["-p", "hello"], { env: {} });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing Anthropic API key");
  expect(result.stderr.toLowerCase().includes("login")).toBe(false);
});

test("runtime --api-key takes precedence over the environment key", async () => {
  let usedKey: string | undefined;
  const result = await run(["-p", "hello", "--api-key", "sk-runtime"], {
    env: { ANTHROPIC_API_KEY: "sk-env" },
    createModel: async ({ apiKey }) => {
      usedKey = apiKey;
      return createScriptedModel({ text: "ok" });
    },
  });
  expect(result.exitCode).toBe(0);
  expect(usedKey).toBe("sk-runtime");
  expect(result.stdout).toContain("ok");
});

test("selecting OpenAI without OPENAI_API_KEY fails even when Anthropic is configured", async () => {
  const result = await run(["-p", "hello", "--provider", "openai"], {
    env: { ANTHROPIC_API_KEY: "sk-anthropic" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing OpenAI API key");
  expect(result.stderr.toLowerCase().includes("login")).toBe(false);
  expect(result.stderr.toLowerCase().includes("codex")).toBe(false);
});

test("selecting OpenAI uses OPENAI_API_KEY and records the provider", async () => {
  let used: { apiKey?: string; provider?: string; model?: string } = {};
  const result = await run(["-p", "hello", "--provider", "openai"], {
    env: { OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" },
    createModel: async ({ apiKey, provider, model }) => {
      used = { apiKey, provider, model };
      return createScriptedModel({
        provider: "openai",
        id: model ?? "scripted",
        text: "ok",
      });
    },
  });
  expect(result.exitCode).toBe(0);
  expect(used.apiKey).toBe("sk-openai");
  expect(used.provider).toBe("openai");
  expect(result.stdout).toContain("ok");
});

test("OpenAI --api-key takes precedence over OPENAI_API_KEY", async () => {
  let usedKey: string | undefined;
  const result = await run(
    ["-p", "hello", "--provider", "openai", "--api-key", "sk-runtime"],
    {
      env: { OPENAI_API_KEY: "sk-env" },
      createModel: async ({ apiKey }) => {
        usedKey = apiKey;
        return createScriptedModel({ text: "ok" });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(usedKey).toBe("sk-runtime");
});

test("a user-supplied model ID is passed through without catalog membership", async () => {
  let usedModel: string | undefined;
  const result = await run(
    ["-p", "hello", "--provider", "openai", "--model", "my-custom-gpt"],
    {
      env: { OPENAI_API_KEY: "sk-openai" },
      createModel: async ({ model }) => {
        usedModel = model;
        return createScriptedModel({ id: model, text: "ok" });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(usedModel).toBe("my-custom-gpt");
});

test("OpenAI-compatible connection options are selectable from the headless CLI", async () => {
  let used: {
    apiKey?: string;
    provider?: string;
    model?: string;
    maxTokens?: number;
    baseUrl?: string;
    headers?: Record<string, string>;
    extraBody?: Record<string, unknown>;
    auth?: string;
  } = {};
  const result = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:11434/v1",
      "--model",
      "llama3.2",
      "--header",
      "X-Test: ok",
      "--body",
      '{"temperature":0.2}',
      "--auth",
      "optional",
      "--api-key",
      "sk-compat",
    ],
    {
      env: { OPENAI_API_KEY: "sk-openai" },
      createModel: async (input) => {
        used = input;
        return createScriptedModel({
          provider: "openai-compatible",
          id: input.model,
          text: "ok",
        });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(used).toEqual({
    apiKey: "sk-compat",
    provider: "openai-compatible",
    model: "llama3.2",
    maxTokens: 16_384,
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: { "X-Test": "ok" },
    extraBody: { temperature: 0.2 },
    auth: "optional",
  });
  expect(result.stdout).toContain("ok");
});

test("OpenAI-compatible optional auth works without a key and ignores OPENAI_API_KEY", async () => {
  let used: { apiKey?: string; auth?: string } = {};
  const result = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:8080/v1",
    ],
    {
      env: { OPENAI_API_KEY: "sk-openai" },
      createModel: async ({ apiKey, auth }) => {
        used = { apiKey, auth };
        return createScriptedModel({
          provider: "openai-compatible",
          text: "ok",
        });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(used.apiKey).toBeUndefined();
  expect(used.auth).toBe("optional");
});

test("OpenAI-compatible required auth fails headlessly without --api-key", async () => {
  const result = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:8080/v1",
      "--auth",
      "required",
    ],
    { env: { OPENAI_API_KEY: "sk-openai" } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing API key for OpenAI-compatible endpoint");
  expect(result.stderr.includes("sk-openai")).toBe(false);
  expect(result.stderr.toLowerCase().includes("login")).toBe(false);
});

test("OpenAI-compatible absent auth is selectable even when --api-key is set", async () => {
  let used: { apiKey?: string; auth?: string } = {};
  const result = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:8080/v1",
      "--auth",
      "none",
      "--api-key",
      "sk-compat",
    ],
    {
      env: {},
      createModel: async ({ apiKey, auth }) => {
        used = { apiKey, auth };
        return createScriptedModel({
          provider: "openai-compatible",
          text: "ok",
        });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(used.auth).toBe("none");
  expect(used.apiKey).toBe("sk-compat");
});

test("OpenAI-compatible provider requires --base-url", async () => {
  const result = await run(["-p", "hello", "--provider", "openai-compatible"], {
    env: {},
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing --base-url");
});

test("OpenAI-compatible connection flags are rejected for other providers", async () => {
  const result = await run(
    ["-p", "hello", "--base-url", "http://127.0.0.1:8080/v1"],
    { env: { ANTHROPIC_API_KEY: "sk-test" } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "OpenAI-compatible connection options require --provider openai-compatible",
  );
});

test("invalid --body and --auth values fail with actionable errors", async () => {
  const body = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:8080/v1",
      "--body",
      "[1]",
    ],
    { env: {} },
  );
  expect(body.exitCode).toBe(1);
  expect(body.stderr).toContain("Invalid --body");

  const auth = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://127.0.0.1:8080/v1",
      "--auth",
      "bearer",
    ],
    { env: {} },
  );
  expect(auth.exitCode).toBe(1);
  expect(auth.stderr).toContain("Unknown auth mode: bearer");
});

test("unknown --provider exits with an actionable error", async () => {
  const result = await run(["-p", "hello", "--provider", "codex"], {
    env: { OPENAI_API_KEY: "sk-openai" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unknown provider: codex");
});

test("--provider does not treat the next flag as a provider", async () => {
  const result = await run(["-p", "hello", "--provider", "--json"], {
    env: {},
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing value for --provider");
});

test("--model does not treat the next flag as a model", async () => {
  const result = await run(["-p", "hello", "--model", "--json"], {
    env: {},
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing value for --model");
});

test("secrets are not printed when a run fails", async () => {
  const secret = "sk-secret-do-not-print";
  const result = await run(["-p", "hello", "--api-key", secret], {
    env: {},
    model: createScriptedModel({
      error: `unauthorized ${secret}`,
      status: 401,
    }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.includes(secret)).toBe(false);
  expect(result.stderr.includes(secret)).toBe(false);
  expect(result.stderr).toContain("unauthorized");
});

test("secrets are redacted from json tool results and model text", async () => {
  const secret = "sk-secret-do-not-print";
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), `token ${secret}\n`);
    const result = await run(["-p", "read note", "--json", "--api-key", secret], {
      env: {},
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "t1",
                name: "read",
                arguments: { path: "note.txt" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult => item.type === "tool_result",
            );
            return { text: `got ${tool?.content ?? ""}` };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
    expect(result.stdout).toContain("***");
  });
});

test("secrets with JSON metacharacters are redacted from parsed edit details", async () => {
  const secret = 'sk-"secret\\do-not-print';
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), `token ${secret}\n`);
    const result = await run(["-p", "edit note", "--json", "--api-key", secret], {
      env: {},
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "e1",
                name: "edit",
                arguments: {
                  path: "note.txt",
                  edits: [
                    {
                      oldText: `token ${secret}`,
                      newText: "token gone",
                    },
                  ],
                },
              },
            ],
          },
          { text: "done" },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(parsedJsonlContains(result.stdout, secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
  });
});

test("secrets are redacted from json edit details", async () => {
  const secret = "sk-secret-do-not-print";
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), `token ${secret}\n`);
    const result = await run(["-p", "edit note", "--json", "--api-key", secret], {
      env: {},
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "e1",
                name: "edit",
                arguments: {
                  path: "note.txt",
                  edits: [
                    {
                      oldText: `token ${secret}`,
                      newText: "token gone",
                    },
                  ],
                },
              },
            ],
          },
          { text: "done" },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
    expect(result.stdout).toContain("***");
  });
});

test("CLI AbortSignal cancels model streaming and exits non-zero", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const pending = run(["-p", "hello", "--json"], {
    signal: controller.signal,
    model: {
      provider: "scripted",
      id: "scripted",
      async *stream(request) {
        seenSignal = request.signal;
        requestStarted();
        yield { type: "text_delta" as const, text: "Hel" };
        await new Promise<void>((_resolve, reject) => {
          const signal = request.signal;
          if (signal?.aborted) {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    },
  });
  await started;
  expect(seenSignal).toBe(controller.signal);
  controller.abort();
  const result = await pending;
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('"reason":"cancelled"');
  expect(result.stdout.includes("should not run")).toBe(false);
});

test("provider stream failure exits non-zero with an actionable error", async () => {
  const result = await run(["-p", "hello"], {
    model: createScriptedModel({ error: "invalid request", status: 400 }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("invalid request");
});

test("headless CLI uses the resolved workspace", async () => {
  await withTempDir(async (dir) => {
    const result = await run(["-p", "hello", "--json"], {
      cwd: dir,
      model: createScriptedModel({ text: "ok" }),
    });
    expect(result.exitCode).toBe(0);
  });
});

test("-p does not treat the next flag as a prompt", async () => {
  const result = await run(["-p", "--json"], {
    model: createScriptedModel({ text: "nope" }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing prompt for -p");
  expect(result.stdout).toBe("");
});

test("--api-key does not treat the next flag as a key", async () => {
  const result = await run(["-p", "hello", "--api-key", "--json"], {
    env: {},
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing value for --api-key");
});

test("headless -p can read a workspace file through the agent loop", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "README.md"), "hello from workspace\n");
    const result = await run(["-p", "read README", "--json"], {
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "t1",
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult => item.type === "tool_result",
            );
            return { text: tool?.content ?? "missing" };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tool.started");
    expect(result.stdout).toContain("tool.finished");
    expect(result.stdout).toContain("hello from workspace");
  });
});

test("headless -p can grep a workspace file through the agent loop", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "app.ts"), "export const LocateMe = 1;\n");
    const result = await run(["-p", "find LocateMe", "--json"], {
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "g1",
                name: "grep",
                arguments: { pattern: "LocateMe" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult => item.type === "tool_result",
            );
            return { text: tool?.content ?? "missing" };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app.ts:1:");
    expect(result.stdout).toContain("LocateMe");
  });
});

test("headless -p can create a file through the agent loop", async () => {
  await withTempDir(async (dir) => {
    const result = await run(["-p", "write note", "--json"], {
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "w1",
                name: "write",
                arguments: { path: "note.txt", content: "cli-created\n" },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: "r1",
                name: "read",
                arguments: { path: "note.txt" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult =>
                item.type === "tool_result" && item.toolCallId === "r1",
            );
            return { text: tool?.content ?? "missing" };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cli-created");
  });
});

test("headless -p can run a shell command through the agent loop", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "marker.txt"), "cli-bash\n");
    const result = await run(["-p", "cat marker", "--json"], {
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "b1",
                name: "bash",
                arguments: { command: "cat marker.txt" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult => item.type === "tool_result",
            );
            return { text: tool?.content ?? "missing" };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tool.delta");
    expect(result.stdout).toContain("cli-bash");
  });
});

test("secrets are redacted from bash tool.delta events", async () => {
  const secret = "sk-secret-do-not-print";
  await withTempDir(async (dir) => {
    const result = await run(["-p", "echo secret", "--json", "--api-key", secret], {
      env: {},
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "b1",
                name: "bash",
                arguments: { command: `echo ${secret}` },
              },
            ],
          },
          { text: "done" },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(secret)).toBe(false);
    expect(result.stderr.includes(secret)).toBe(false);
    expect(result.stdout).toContain("***");
  });
});

test("partial streamed text is terminated before an error diagnostic", async () => {
  const result = await run(["-p", "hello"], {
    model: {
      provider: "scripted",
      id: "scripted",
      async *stream() {
        yield { type: "text_delta" as const, text: "Hel" };
        throw Object.assign(new Error("invalid request"), { status: 400 });
      },
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("Hel\n");
  expect(result.stderr).toContain("invalid request");
});

test("--resume requires a session id", async () => {
  const result = await run(["-p", "hello", "--resume"], {
    model: createScriptedModel({ text: "nope" }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Missing value for --resume");
  expect(result.stdout).toBe("");
});

test("--resume of an unknown session exits with an actionable error", async () => {
  await withTempDir(async (dir) => {
    const result = await run(["-p", "hello", "--resume", "missing-id"], {
      env: { HOME: dir, ANTHROPIC_API_KEY: "sk-test" },
      model: createScriptedModel({ text: "nope" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing-id");
    expect(result.stdout).toBe("");
  });
});

test("headless -p saves a session that --resume continues with workspace identity", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    const other = join(dir, "other");
    await mkdir(home);
    await mkdir(project);
    await mkdir(other);
    await writeFile(join(project, "note.txt"), "from-saved-workspace\n");

    const first = await run(["-p", "read note", "--json"], {
      env: { HOME: home, ANTHROPIC_API_KEY: "sk-test" },
      cwd: project,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "t1",
                name: "read",
                arguments: { path: "note.txt" },
              },
            ],
          },
          (request) => {
            const tool = request.items.find(
              (item): item is ToolResult => item.type === "tool_result",
            );
            return { text: tool?.content ?? "missing" };
          },
        ],
      }),
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("from-saved-workspace");

    const files = (await readdir(join(home, ".schway", "sessions"))).filter(
      (name) => name.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const sessionId = files[0]!.slice(0, -".jsonl".length);
    const records = (await Bun.file(join(home, ".schway", "sessions", files[0]!)).text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.map((record) => record.type)).toEqual([
      "session",
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    expect(JSON.stringify(records).includes("agent.started")).toBe(false);

    const second = await run(
      ["-p", "remind me", "--resume", sessionId, "--json"],
      {
        env: { HOME: home, ANTHROPIC_API_KEY: "sk-test" },
        cwd: other,
        model: createScriptedModel({
          responses: [
            (request) => {
              const tool = request.items.find(
                (item): item is ToolResult => item.type === "tool_result",
              );
              const environment = request.context.find(
                (section) => section.name === "environment",
              );
              return {
                text: `${tool?.content ?? "missing"}\n${environment?.content ?? ""}`,
              };
            },
          ],
        }),
      },
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("from-saved-workspace");
    const savedRoot = await realpath(project);
    expect(second.stdout).toContain(`Workspace root: ${savedRoot}`);
    expect(second.stdout.includes(await realpath(other))).toBe(false);
  });
});
