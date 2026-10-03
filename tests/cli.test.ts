import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSse as encodeOpenAISse, TEXT_STREAM_EVENTS as OPENAI_TEXT } from "./fixtures/openai.ts";
import { runCli, type CliIo } from "../src/cli/main.ts";
import { formatDoctorHelp, formatHelp } from "../src/cli/help.ts";
import { sessionsHelp } from "../src/cli/sessions.ts";
import { ANTHROPIC_REMOVED_MESSAGE } from "../src/config/removed-provider.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { credentialIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
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

test("models dispatch uses only its selected identity without a task, terminal or model factory", async () => {
  await withTempDir(async home => {
    const reads: string[] = [], requests: string[] = [];
    const store: CredentialStore = {
      async get(identity) { expect(this).toBe(store); reads.push(identity.account); return "selected-key"; },
      async set() { throw new Error("Unexpected credential write"); },
      async delete() { throw new Error("Unexpected credential deletion"); },
    };
    const result = await run(["models", "list", "--provider", "openai", "--openai-auth", "api-key", "--json"], {
      cwd: home, env: { HOME: home }, credentialStore: store,
      createModel: async () => { throw new Error("Discovery cannot create an execution model"); },
      fetch: async (url, init) => {
        requests.push(String(url)); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer selected-key");
        return Response.json({ data: [{ id: "gpt-4o" }] });
      },
    });
    expect(result.exitCode, result.stderr).toBe(0); expect(result.stderr).toBe("");
    expect(reads).toEqual([credentialIdentity({ provider: "openai" }).account]); expect(requests).toEqual(["https://api.openai.com/v1/models"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ provider: "openai", route: "api-key", status: "complete", models: [{ id: "gpt-4o" }] });
    expect(await readdir(home)).toEqual([]);
  });
});

test("models production config preserves one deprecation warning per physical file without changing JSON or bytes", async () => {
  await withTempDir(async home => {
    await mkdir(join(home, ".schway"));
    const path = join(home, ".schway/config.json"), text = JSON.stringify({ legacyProvider: "xai" });
    await writeFile(path, text);
    const stdout = capture(), stderr = capture();
    const exit = await runCli(["models", "list", "--offline", "--json"], {
      cwd: home, env: { HOME: home }, stdout, stderr,
      configDeprecations: [{ key: "legacyProvider", replacement: "provider", since: "1.0.0", removeIn: "2.0.0" }],
      credentialStore: { get: async () => { throw new Error("Unexpected credentials"); }, set: async () => { throw new Error("Unexpected write"); }, delete: async () => { throw new Error("Unexpected delete"); } },
    });
    expect(exit).toBe(0); expect(JSON.parse(stdout.text)).toMatchObject({ provider: "xai", route: "unresolved", status: "complete" });
    expect(stderr.text.trim().split("\n")).toHaveLength(1); expect(stderr.text).toContain('"legacyProvider"');
    expect(stderr.text).toContain('use "provider"'); expect(stderr.text).toContain("2.0.0");
    expect(await Bun.file(path).text()).toBe(text);
  });
});

test("concurrent models entry calls preserve the original store's shared Grok renewal identity", async () => {
  await withTempDir(async home => {
    const { GROK_TOKEN_URL } = await import("../src/model/providers/grok-subscription.ts");
    const identity = grokSubscriptionIdentity(), started = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const abort = new AbortController();
    let reads = 0, writes = 0, renewals = 0, catalogs = 0, expired = false;
    let raw = JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", expiresAt: 0, obtainedAt: 0 });
    const store: CredentialStore = {
      async get(selected) { expect(this).toBe(store); expect(selected).toEqual(identity); if (++reads === 3) joined.resolve(); return raw; },
      async set(selected, value) { expect(this).toBe(store); expect(selected).toEqual(identity); writes++; raw = value; },
      async delete() { throw new Error("Unexpected credential deletion"); },
    };
    const fetch: NonNullable<CliIo["fetch"]> = async (url, init) => {
      if (String(url) === GROK_TOKEN_URL) {
        renewals++; started.resolve(); await release.promise;
        return Response.json({ access_token: "shared-access", refresh_token: "shared-refresh", expires_in: 3600 });
      }
      catalogs++; expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer shared-access");
      return Response.json({ data: [{ id: "grok-safe" }] });
    };
    const list = () => run(["models", "list", "--provider", "xai", "--xai-auth", "grok", "--json"], {
      cwd: home, env: { HOME: home }, credentialStore: store, fetch, signal: abort.signal,
    });
    const pending: ReturnType<typeof list>[] = [];
    const watchdog = setTimeout(() => { expired = true; abort.abort(); started.resolve(); joined.resolve(); release.resolve(); }, 1500);
    try {
      pending.push(list()); await started.promise;
      pending.push(list()); await joined.promise; release.resolve();
      for (const result of await Promise.all(pending)) {
        expect(result.exitCode, result.stderr).toBe(0); expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({ route: "grok", status: "complete", models: [{ id: "grok-safe" }] });
      }
      expect(expired).toBe(false); expect(renewals).toBe(1); expect(writes).toBe(1); expect(catalogs).toBe(2);
      expect(await readdir(home)).toEqual([]);
    } finally {
      clearTimeout(watchdog); abort.abort(); release.resolve(); await Promise.allSettled(pending);
    }
  });
});

test("headless prompts, JSON output and subcommands never create interactive splash state", async () => {
  await withTempDir(async home => {
    for (const args of [["--model", "test-model", "-p", "hello"], ["--model", "test-model", "-p", "hello", "--json"], ["--help"]]) {
      const result = await run(args, { env: { HOME: home, SCHWAY_MOTION: "full", OPENAI_API_KEY: "fixture-key" }, model: createScriptedModel({ text: "hello" }) });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await Bun.file(join(home, ".schway/ui-state.json")).exists()).toBe(false);
    }
  });
});

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

for (const command of [[], ["doctor"]]) {
  for (const flag of ["--help", "-h"]) {
    test(`${["schway", ...command, flag].join(" ")} prints help without setup or files`, async () => {
      await withTempDir(async (home) => {
        const result = await run([...command, flag], {
          env: { HOME: home }, cwd: home,
          credentialStore: {
            async get() { throw new Error("Help must not read credentials"); },
            async set() { throw new Error("Help must not save credentials"); },
            async delete() { throw new Error("Help must not delete credentials"); },
          },
          createModel: async () => { throw new Error("Help must not load a model"); },
        });
        expect(result).toEqual({
          exitCode: 0,
          stdout: command.length ? formatDoctorHelp() : formatHelp(),
          stderr: "",
        });
        expect(await readdir(home)).toEqual([]);
      });
    });
  }
}

test("invalid options print only the command-specific error and help hint", async () => {
  expect(await run(["--bogus"], { env: {} })).toEqual({
    exitCode: 1, stdout: "",
    stderr: "Unknown option: --bogus\nRun 'schway --help' for usage.\n",
  });
  expect(await run(["doctor", "--bogus"], { env: {} })).toEqual({
    exitCode: 2, stdout: "",
    stderr: "Unknown option: --bogus\nRun 'schway doctor --help' for usage.\n",
  });
  expect(await run(["doctor", "--max-turns"], { env: {} })).toEqual({
    exitCode: 2, stdout: "",
    stderr: "Missing value for --max-turns\nRun 'schway doctor --help' for usage.\n",
  });
});

test("help needs neither HOME nor an accessible workspace", async () => {
  for (const argv of [["--help"], ["-h"], ["doctor", "--help"], ["doctor", "-h"]]) {
    const stdout = capture();
    const stderr = capture();
    expect(await runCli(argv, { stdout, stderr, env: {}, cwd: "/missing-help-workspace" })).toBe(0);
    expect(stdout.text).toBe(argv[0] === "doctor" ? formatDoctorHelp() : formatHelp());
    expect(stderr.text).toBe("");
  }
});

test("session discovery dispatch bypasses interactive setup and owns its option errors", async () => {
  expect(formatHelp()).toContain("schway sessions list");
  expect(await run(["sessions", "--help"], { env: { HOME: undefined }, cwd: "/missing-workspace" }))
    .toEqual({ exitCode: 0, stdout: sessionsHelp(), stderr: "" });
  for (const flags of [["--version"], ["--provider", "openai"], ["-p", ""]]) {
    const result = await run(["sessions", "list", ...flags], { env: {} });
    expect(result.exitCode).toBe(2); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("schway sessions --help");
  }
  await withTempDir(async home => {
    const result = await run(["sessions", "list", "--all", "--json"], { env: { HOME: home }, cwd: "/missing-workspace",
      createModel: async () => { throw new Error("Session listing loaded a model"); },
      credentialStore: { get: async () => { throw new Error("Session listing read credentials"); }, set: async () => { throw new Error("Unexpected credential write"); }, delete: async () => false },
    });
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, status: "complete", sessions: [] });
    expect(await readdir(home)).toEqual([]);
  });
});

test("removed-provider notices still print alone for both commands", async () => {
  for (const command of [[], ["doctor"]]) {
    expect(await run([...command, "--provider", "anthropic"], { env: {} })).toEqual({
      exitCode: 1, stdout: "", stderr: `${ANTHROPIC_REMOVED_MESSAGE}\n`,
    });
  }
});

test("provider-option conflicts print a two-line error with the main help hint", async () => {
  for (const flags of [
    ["--provider", "openai", "--base-url", "http://localhost/v1"],
    ["--provider", "xai", "--openai-auth", "auto"],
    ["--provider", "openai", "--xai-auth", "auto"],
    ["--base-url", "http://localhost/v1"],
    ["--xai-auth", "auto"],
  ]) {
    const result = await run(["-p", "hello", ...flags], { env: {}, model: createScriptedModel({ text: "unused" }) });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(2);
    expect(result.stderr).toEndWith("Run 'schway --help' for usage.\n");
  }
});

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
    "session.ready",
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
  const result = await run(["-p", "hello", "--json", "--provider", "openai", "--model", "gpt-5.4"], { env: {} });
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
    const sessionId = JSON.parse(first.stdout.split("\n")[0]!) as { type: string; sessionId: string };
    expect(sessionId.type).toBe("session.ready");
    expect(sessionId.sessionId).toBe(files[0]!.slice(0, -".jsonl".length));
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
      ["-p", "remind me", "--resume", sessionId.sessionId, "--json"],
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
    expect(JSON.parse(second.stdout.split("\n")[0]!)).toEqual(sessionId);
    expect(second.stdout).toContain("from-saved-workspace");
    const savedRoot = await realpath(project);
    expect(second.stdout).toContain(`Workspace root: ${savedRoot}`);
    expect(second.stdout.includes(await realpath(other))).toBe(false);
  });
});

test("--json keeps exact session IDs and suppresses session.ready when an ID would leak a secret", async () => {
  await withTempDir(async (home) => {
    const exact = await run(["-p", "hello", "--json"], {
      env: { HOME: home, OPENAI_API_KEY: "sk-fixture-key" },
      model: createScriptedModel({ text: "ok" }),
    });
    expect(exact.exitCode).toBe(0);
    const ready = JSON.parse(exact.stdout.split("\n")[0]!) as { type: string; sessionId: string };
    expect(ready).toEqual({ type: "session.ready", sessionId: expect.any(String) });
    expect(ready.sessionId.includes("***")).toBe(false);
    expect(await Bun.file(join(home, ".schway", "sessions", `${ready.sessionId}.jsonl`)).exists()).toBe(true);

    // A secret that is a UUID hyphen would previously mangled every sessionId via redactSecrets.
    const colliding = await run(["-p", "hello", "--json"], {
      env: { HOME: home, OPENAI_API_KEY: "-" },
      model: createScriptedModel({ text: "ok" }),
    });
    expect(colliding.exitCode).toBe(0);
    const lines = colliding.stdout.trim().split("\n").filter(Boolean);
    expect(lines.some((line) => JSON.parse(line).type === "session.ready")).toBe(false);
    expect(lines[0] && JSON.parse(lines[0]).type).toBe("agent.started");
    const files = (await readdir(join(home, ".schway", "sessions"))).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(1);
  });
});

test("--json exposes a resumable session ID after a failed turn with saved history", async () => {
  await withTempDir(async (home) => {
    const prompt = "private task text";
    const secret = "sk-private-token";
    const first = await run(["-p", prompt, "--json", "--api-key", secret], {
      env: { HOME: home, OPENAI_API_KEY: secret },
      model: createScriptedModel({ error: `Authentication failed: ${secret}`, status: 401 }),
    });
    expect(first.exitCode).toBe(1);
    const events = first.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events[0]).toEqual({ type: "session.ready", sessionId: expect.any(String) });
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
    expect(first.stdout).not.toContain(prompt);
    expect(first.stdout).not.toContain(secret);
    expect(first.stderr).not.toContain(secret);

    const id = events[0].sessionId as string;
    const saved = (await Bun.file(join(home, ".schway", "sessions", `${id}.jsonl`)).text())
      .split("\n").filter(Boolean).flatMap(decodeStoredLine);
    expect(saved.map(record => record.type)).toEqual(["session", "user"]);
    const resumed = await run(["-p", "continue", "--resume", id, "--json"], {
      env: { HOME: home, OPENAI_API_KEY: secret },
      model: createScriptedModel({ text: "done" }),
    });
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout.split("\n")[0]!)).toEqual(events[0]);
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
  expect(missingModel.stderr.trim()).toBe("No model configured · Pass --provider and --model, or set them in config");
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
  expect((await run(["--xai-auth", "bogus", "-p", "hello"])).stderr).toContain("Unknown xAI auth preference: bogus · Use auto, grok, or api-key");
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


test("headless read-only denial is JSON-visible, ordered, and leaves exit code zero and files unchanged", async () => {
  await withTempDir(async dir => {
    const output = await run(["-p", "write it", "--approval", "read-only", "--json"], { cwd: dir,
      model: createScriptedModel({ responses: [{ toolCalls: [{ id: "write-call", name: "write", arguments: { path: "note.txt", content: "changed" } }] }, { text: "done" }] }) });
    expect(output.exitCode, output.stderr).toBe(0);
    expect(await Bun.file(join(dir, "note.txt")).exists()).toBe(false);
    const events = output.stdout.trim().split("\n").map(line => JSON.parse(line));
    const index = events.findIndex(event => event.type === "tool.denied");
    expect(events[index]).toEqual({ type: "tool.denied", toolCallId: "write-call", name: "write", mode: "read-only", reason: "Read-only mode: this tool changes files or runs commands. Run without --approval read-only to allow it." });
    expect(events[index + 1]).toMatchObject({ type: "tool.finished", status: "error" });
  });
});

test("approval user config and stricter-only project notice apply once and CLI overrides both ways", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), project = join(dir, "work");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(project, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ approval: { mode: "read-only" } }));
    await writeFile(join(project, ".schway/config.json"), JSON.stringify({ approval: { mode: "auto" } }));
    for (const flag of [[], ["--approval=auto"], ["--approval=read-only"]]) {
      const output = await run(["-p", "write it", "--json", ...flag], { cwd: project, env: { HOME: home },
        model: createScriptedModel({ responses: [{ toolCalls: [{ id: "write-call", name: "write", arguments: { path: "note.txt", content: "changed" } }] }, { text: "done" }] }) });
      expect(output.exitCode, output.stderr).toBe(0);
      const notice = `Ignored approval.mode "auto" in ${join(project, ".schway/config.json")}: project config can only make approval stricter than your "read-only" setting.`;
      expect(output.stderr.split(notice)).toHaveLength(2);
      expect(output.stdout.includes('"type":"tool.denied"')).toBe(flag[0] !== "--approval=auto");
    }
  });
});

for (const [flags, error] of [
  [["--approval"], "Missing value for --approval"],
  [["--approval="], "Missing value for --approval"],
  [["--approval=invalid"], "Unknown approval mode: invalid. Use auto, ask, or read-only."],
] as const) test(`invalid approval flags ${flags.join(" ")} fail with usage`, async () => {
  const result = await run([...flags]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toStartWith(error + "\n");
  expect(result.stderr).toContain("[--approval <auto|ask|read-only>]");
});


test("headless ask denies a write immediately without input or a failing exit", async () => {
  await withTempDir(async dir => {
    const output = await Promise.race([
      run(["-p", "write it", "--approval", "ask", "--json"], { cwd: dir,
        model: createScriptedModel({ responses: [{ toolCalls: [{ id: "write-call", name: "write", arguments: { path: "note.txt", content: "changed" } }] }, { text: "done" }] }) }),
      Bun.sleep(1000).then(() => { throw new Error("headless approval waited for input"); }),
    ]);
    expect(output.exitCode, output.stderr).toBe(0);
    expect(await Bun.file(join(dir, "note.txt")).exists()).toBe(false);
    const events = output.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "tool.denied")).toEqual({ type: "tool.denied", toolCallId: "write-call", name: "write", mode: "ask", reason: "approval required; headless cannot ask" });
    expect(events.find(event => event.type === "tool.finished")).toMatchObject({ status: "error", content: "approval required; headless cannot ask" });
  });
});

test("headless deprecation warning stays on stderr once across OpenAI config reloads", async () => {
  await withTempDir(async home => {
    await mkdir(join(home, ".schway"));
    const path = join(home, ".schway/config.json");
    await writeFile(path, JSON.stringify({ oldModel: "gpt-4.1", provider: "openai", openaiAuth: "api-key" }));
    await mkdir(join(home, ".schway/skills/example"), { recursive: true });
    await writeFile(join(home, ".schway/skills/example/SKILL.md"), "---\nname: example\ndescription: DEPRECATED_CONFIG_SKILL\n---\nDo a task.\n");
    const stdout = capture(), stderr = capture();
    const exit = await runCli(["-p", "hello", "--json"], {
      cwd: home, env: { HOME: home, OPENAI_API_KEY: "fixture-key" }, stdout, stderr,
      configDeprecations: [{ key: "oldModel", replacement: "model", since: "1.1.0", removeIn: "2.0" }],
      credentialStore: fakeCredentialStore(),
      fetch: async (_url, init) => {
        expect(String(init?.body)).toContain("DEPRECATED_CONFIG_SKILL");
        return new Response(encodeOpenAISse(OPENAI_TEXT), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    expect(exit, stderr.text + stdout.text).toBe(0);
    expect(stderr.text).toBe(`Config: "oldModel" in ${path} is deprecated; use "model". It will be removed in 2.0.\n`);
    expect(stdout.text).not.toContain("deprecated");
    const events = stdout.text.trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.type === "agent.finished")).toBe(true);
  });
});
