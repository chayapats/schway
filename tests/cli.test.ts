import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSse as encodeOpenAISse, TEXT_STREAM_EVENTS as OPENAI_TEXT } from "./fixtures/openai.ts";
import { runCli, type CliIo } from "../src/cli/main.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { credentialIdentity, type CredentialStore } from "../src/auth/store.ts";
import type { Model } from "../src/model/model.ts";
import type { ToolResult } from "../src/conversation/types.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { decodeStoredLine, withTempDir } from "./helpers.ts";

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
    credentialStore?: CredentialStore;
    fetch?: CliIo["fetch"];
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
        ...(options.env ?? { OPENAI_API_KEY: "sk-test" }),
      },
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      credentialStore: options.credentialStore ?? fakeCredentialStore(),
      signal: options.signal,
      fetch: options.fetch,
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
    "model.usage",
    "model.finished",
    "agent.finished",
  ]);
  expect(result.stdout.includes("content_block_delta")).toBe(false);
  expect(result.stdout.includes("message_start")).toBe(false);
});

test("missing credentials exit non-zero without interactive login", async () => {
  const result = await run(["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"], { env: {} });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing OpenAI API key");
});

test("runtime --api-key takes precedence over the environment key", async () => {
  let usedKey: string | undefined;
  const result = await run(["-p", "hello", "--api-key", "sk-runtime"], {
    env: { OPENAI_API_KEY: "sk-env" },
    createModel: async ({ apiKey }) => {
      usedKey = apiKey;
      return createScriptedModel({ text: "ok" });
    },
  });
  expect(result.exitCode).toBe(0);
  expect(usedKey).toBe("sk-runtime");
  expect(result.stdout).toContain("ok");
});

test("selecting OpenAI without OPENAI_API_KEY fails even when a compatible key is configured", async () => {
  const result = await run(["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"], {
    env: { OPENAI_COMPATIBLE_API_KEY: "sk-compatible" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing OpenAI API key");
  expect(result.stderr).toContain("/login codex");
});

test("selecting OpenAI uses OPENAI_API_KEY and records the provider", async () => {
  let used: { apiKey?: string; provider?: string; model?: string } = {};
  const result = await run(["-p", "hello", "--provider", "openai"], {
    env: { OPENAI_API_KEY: "sk-openai", OPENAI_COMPATIBLE_API_KEY: "sk-compatible" },
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

test("headless compatible default auth reaches the endpoint without a key when storage is locked", async () => {
  let requestHeaders: Headers | undefined;
  const result = await run(["-p", "hello", "--provider", "openai-compatible", "--model", "gpt-4o", "--base-url", "https://compatible.example.test/v1"], {
    env: {},
    credentialStore: unavailableCredentialStore(),
    fetch: async (input, init) => {
      requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      return new Response('data: {"choices":[{"delta":{"content":"from-local"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("from-local");
  expect(requestHeaders?.get("authorization")).toBeNull();
  expect(JSON.stringify(result)).not.toContain("locked-secret-sentinel");
});

function unavailableCredentialStore(): CredentialStore {
  return {
    async get() { throw new Error("locked-secret-sentinel"); },
    async set() { throw new Error("locked-secret-sentinel"); },
    async delete() { throw new Error("locked-secret-sentinel"); },
  };
}

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
      "--model",
      "gpt-4o",
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
    ["-p", "hello", "--provider", "openai", "--model", "gpt-5.4", "--base-url", "http://127.0.0.1:8080/v1"],
    { env: { OPENAI_API_KEY: "sk-test" } },
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
      env: { HOME: dir, OPENAI_API_KEY: "sk-test" },
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
      env: { HOME: home, OPENAI_API_KEY: "sk-test" },
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
      .flatMap(decodeStoredLine);
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
        env: { HOME: home, OPENAI_API_KEY: "sk-test" },
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

test("headless provider construction consumes only the selected saved credential", async () => {
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai-compatible", baseUrl: "https://compatible.example.test/v1" }), "saved-compatible-sentinel");
  await store.set(credentialIdentity({ provider: "openai" }), "saved-openai-sentinel");
  let selected: { apiKey?: string; provider?: string } = {};
  const result = await run(["-p", "hello", "--provider", "openai"], {
    env: {}, credentialStore: store,
    createModel: async (input) => { selected = input; return createScriptedModel({ text: "ok" }); },
  });
  expect(result.exitCode).toBe(0);
  expect(selected).toMatchObject({ apiKey: "saved-openai-sentinel", provider: "openai" });
  expect(JSON.stringify(result)).not.toContain("sentinel");
});

for (const provider of ["openai", "openai-compatible"] as const) {
  test(`saved ${provider} key reaches the real adapter without entering session JSONL or output`, async () => {
    await withTempDir(async (home) => {
      const store = fakeCredentialStore();
      const baseUrl = "https://compatible.example.test/v1";
      const key = `saved-${provider}-secret-sentinel`;
      await store.set(credentialIdentity({ provider, baseUrl }), key);
      let requestHeaders: Headers | undefined;
      const result = await run(["-p", "hello", "--json", "--provider", provider, "--model", provider === "openai" ? "gpt-5.4" : "gpt-4o",
        ...(provider === "openai-compatible" ? ["--base-url", baseUrl, "--auth", "required"] : [])], {
        env: { HOME: home }, credentialStore: store,
        fetch: async (input, init) => {
          requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const body = provider === "openai" ? encodeOpenAISse(OPENAI_TEXT)
            : 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
          return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        },
      });
      expect(result.exitCode).toBe(0);
      expect(requestHeaders?.get("authorization")).toBe(`Bearer ${key}`);
      expect(JSON.stringify(result)).not.toContain(key);
      const records = join(home, ".schway", "sessions");
      for (const file of await readdir(records)) {
        expect(await Bun.file(join(records, file)).text()).not.toContain(key);
      }
      expect(await Bun.file(join(home, ".schway", "config.json")).exists()).toBe(false);
    });
  });
}

test("saved keys are redacted from model-construction diagnostics and unavailable reads never construct a provider", async () => {
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai" }), "stored-diagnostic-sentinel");
  const result = await run(["-p", "hello", "--provider", "openai"], {
    env: {}, credentialStore: store,
    createModel: async ({ apiKey }) => { throw new Error(`failed with ${apiKey}`); },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("failed with ***");
  expect(result.stderr).not.toContain("sentinel");
  const locked = await run(["-p", "hello"], {
    env: {}, credentialStore: { ...store, async get() { throw new Error("locked-secret-sentinel"); } },
    createModel: async () => { throw new Error("SHOULD_NOT_CONSTRUCT"); },
  });
  expect(locked.exitCode).toBe(1);
  expect(locked.stderr).toContain("Unlock or allow access");
  expect(locked.stderr).not.toContain("sentinel");
  expect(locked.stderr).not.toContain("SHOULD_NOT_CONSTRUCT");
});

test("xAI headless runs with a key, refuses a missing model or key, and lists models only when thinking is set", async () => {
  const success = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7"], {
    env: { XAI_API_KEY: "xai-env-key" },
    createModel: async () => createScriptedModel({ provider: "xai", id: "grok-4.7", responses: [{ text: "ok" }] }),
  });
  expect(success.exitCode).toBe(0);
  const stored = fakeCredentialStore();
  await stored.set(credentialIdentity({ provider: "xai" }), "stored-xai-key");
  const fromStore = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7"], {
    env: {}, credentialStore: stored,
    createModel: async ({ apiKey }) => {
      expect(apiKey).toBe("stored-xai-key");
      return createScriptedModel({ provider: "xai", id: "grok-4.7", responses: [{ text: "ok" }] });
    },
  });
  expect(fromStore.exitCode).toBe(0);
  const flagged = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7", "--api-key", "flag-xai"], {
    env: {},
    createModel: async ({ apiKey }) => {
      expect(apiKey).toBe("flag-xai");
      return createScriptedModel({ provider: "xai", id: "grok-4.7", responses: [{ text: "ok" }] });
    },
  });
  expect(flagged.exitCode).toBe(0);
  let requests = 0;
  const missingModel = await run(["-p", "hello", "--provider", "xai"], {
    env: { XAI_API_KEY: "xai-env-key" },
    fetch: async () => { requests += 1; return new Response("no"); },
  });
  expect(missingModel.exitCode).toBe(1);
  expect(missingModel.stderr.trim()).toBe("No model configured. Pass --provider and --model, or set them in config.");
  expect(missingModel.stderr).not.toContain("grok-4.7");
  expect(requests).toBe(0);
  const missingKey = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7"], {
    env: { OPENAI_API_KEY: "openai-only" },
    fetch: async () => { requests += 1; return new Response("no"); },
    createModel: async () => { throw new Error("SHOULD_NOT_CONSTRUCT"); },
  });
  expect(missingKey.exitCode).toBe(1);
  expect(missingKey.stderr).toContain("Missing xAI API key. Set XAI_API_KEY or pass --api-key.");
  expect(missingKey.stderr).not.toContain("SHOULD_NOT_CONSTRUCT");
  expect(requests).toBe(0);
  const authConflict = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7", "--openai-auth", "api-key"], {
    env: { XAI_API_KEY: "xai-env-key" },
  });
  expect(authConflict.exitCode).toBe(1);
  expect(authConflict.stderr).toContain("OpenAI auth preference requires --provider openai");
  const connectionConflict = await run(["-p", "hello", "--provider", "xai", "--base-url", "https://example.test/v1"], {
    env: { XAI_API_KEY: "xai-env-key" },
  });
  expect(connectionConflict.exitCode).toBe(1);
  expect(connectionConflict.stderr).toContain("OpenAI-compatible connection options require --provider openai-compatible");
  const unknown = await run(["-p", "hello", "--provider", "grok"], { env: {} });
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("Unknown provider: grok");
  const urls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "grok-4.7", context_length: 256000, capabilities: { reasoning_effort: ["low", "high"] }, default_reasoning_effort: "high" }] }), { headers: { "content-type": "application/json" } });
  };
  const thinking = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7", "--thinking", "high"], {
    env: { XAI_API_KEY: "xai-env-key" }, fetch, createModel: async () => createScriptedModel({ provider: "xai", id: "grok-4.7", responses: [{ text: "ok" }] }),
  });
  expect(thinking.exitCode).toBe(0);
  expect(urls.filter(url => url.includes("/models"))).toHaveLength(1);
  urls.length = 0;
  const unset = await run(["-p", "hello", "--provider", "xai", "--model", "grok-4.7"], {
    env: { XAI_API_KEY: "xai-env-key" }, fetch, createModel: async () => createScriptedModel({ provider: "xai", id: "grok-4.7", responses: [{ text: "ok" }] }),
  });
  expect(unset.exitCode).toBe(0);
  expect(urls.filter(url => url.includes("/models"))).toHaveLength(0);
});

test("Grok headless uses stored OAuth, refreshes, and maps missing, revoked and plan failures", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  const { encodeXaiSse, XAI_TEXT_EVENTS } = await import("./fixtures/xai.ts");
  const argv = ["--provider", "xai", "--xai-auth", "grok", "--model", "grok-4.7", "-p", "Hello"];
  for (const scenario of ["success", "missing", "revoked", "plan"] as const) {
    const store = fakeCredentialStore(); const urls: string[] = [];
    if (scenario !== "missing") await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "old", refreshToken: "refresh", obtainedAt: 0, ...(scenario !== "plan" ? { expiresAt: 0 } : {}) }));
    const result = await run(argv, { env: { XAI_API_KEY: "billing-sentinel" }, credentialStore: store, fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).startsWith("https://auth.x.ai/")) return Response.json(scenario === "revoked" ? { error: "invalid_grant" } : { access_token: "renewed", expires_in: 3600 }, { status: scenario === "revoked" ? 401 : 200 });
      expect(new Headers(init!.headers).get("Authorization")).toBe(scenario === "plan" ? "Bearer old" : "Bearer renewed");
      return scenario === "plan" ? Response.json({}, { status: 403 }) : new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
    } });
    expect(result.exitCode).toBe(scenario === "success" ? 0 : 1);
    if (scenario === "missing") { expect(result.stderr).toContain("No Grok subscription login found."); expect(urls).toEqual([]); }
    if (scenario === "revoked") expect(result.stderr).toContain("session was revoked or rejected by xAI");
    if (scenario === "plan") expect(result.stderr).toBe("Your Grok plan doesn't include API access. Use an xAI API key instead.\n");
    expect(result.stderr).not.toContain("Alt+L"); expect(result.stderr).not.toContain("billing-sentinel");
  }
  expect((await run(["--provider", "openai", "--xai-auth", "grok", "-p", "hello"])).stderr).toContain("xAI auth preference requires --provider xai");
  expect((await run(["--xai-auth", "bogus", "-p", "hello"])).stderr).toContain("Unknown xAI auth preference: bogus. Use auto, grok, or api-key.");
});

const unguardedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Grok fixtures must not use external network");
    return unguardedFetch(input, init);
  }, { preconnect: unguardedFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedFetch; });
