import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { runCli } from "../src/cli/main.ts";
import type { Model } from "../src/model/model.ts";
import { DEFAULT_MODEL_IDS } from "../src/model/catalog.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { encodeSse as encodeAnthropicSse, TEXT_STREAM_EVENTS as ANTHROPIC_TEXT } from "./fixtures/anthropic.ts";
import { encodeSse as encodeOpenAISse, TEXT_STREAM_EVENTS as OPENAI_TEXT } from "./fixtures/openai.ts";
import {
  encodeChatCompletionsSse,
  TEXT_STREAM_CHUNKS,
} from "./fixtures/openai-compatible.ts";

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

type CreateModelInput = {
  apiKey?: string;
  provider: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: "required" | "optional" | "none";
};

/** Run `runCli` against an in-memory IO harness with an isolated HOME. */
async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    model?: Model;
    createModel?: (input: CreateModelInput) => Promise<Model>;
    fetch?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
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
      createModel: options.createModel,
      fetch: options.fetch,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text, home: isolatedHome };
  } finally {
    if (options.env?.HOME === undefined) {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
}

test("zero-config headless runs without creating config.json", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(project);
    const result = await run(["-p", "hello"], {
      env: { HOME: home, ANTHROPIC_API_KEY: "sk-test" },
      cwd: project,
      model: createScriptedModel({ text: "ok" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(await readdir(project)).toEqual([]);
    const homeEntries = await readdir(home);
    expect(homeEntries.includes("config.json")).toBe(false);
    expect(homeEntries.includes(".schway")).toBe(true);
  });
});

test("project config selects provider and model; CLI flags override them", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({
        provider: "openai",
        model: "from-project",
        maxTurns: 9,
      }),
    );

    let fromConfig: CreateModelInput | undefined;
    const configured = await run(["-p", "hello"], {
      env: { OPENAI_API_KEY: "sk-openai" },
      cwd: dir,
      createModel: async (input) => {
        fromConfig = input;
        return createScriptedModel({ text: "ok" });
      },
    });
    expect(configured.exitCode).toBe(0);
    expect(fromConfig).toMatchObject({
      provider: "openai",
      model: "from-project",
      apiKey: "sk-openai",
    });

    let fromCli: CreateModelInput | undefined;
    const overridden = await run(
      ["-p", "hello", "--provider", "anthropic", "--model", "from-cli"],
      {
        env: { ANTHROPIC_API_KEY: "sk-anthropic", OPENAI_API_KEY: "sk-openai" },
        cwd: dir,
        createModel: async (input) => {
          fromCli = input;
          return createScriptedModel({ text: "ok" });
        },
      },
    );
    expect(overridden.exitCode).toBe(0);
    expect(fromCli).toMatchObject({
      provider: "anthropic",
      model: "from-cli",
      apiKey: "sk-anthropic",
    });
  });
});

test("user-global config applies when the project has none", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(project);
    await writeFile(
      join(home, ".schway", "config.json"),
      JSON.stringify({ provider: "openai", model: "from-user" }),
    );
    let used: CreateModelInput | undefined;
    const result = await run(["-p", "hello"], {
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      cwd: project,
      createModel: async (input) => {
        used = input;
        return createScriptedModel({ text: "ok" });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(used).toMatchObject({ provider: "openai", model: "from-user" });
  });
});

test("invalid and misspelled project config exit non-zero with the setting name", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({ modell: "nope" }),
    );
    const result = await run(["-p", "hello"], {
      cwd: dir,
      model: createScriptedModel({ text: "nope" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("modell");
    expect(result.stderr).toContain("model");
  });
});

test("API keys in config.json are rejected and not printed", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({ apiKey: "sk-config-secret" }),
    );
    const result = await run(["-p", "hello"], {
      cwd: dir,
      env: { ANTHROPIC_API_KEY: "sk-env" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("API key");
    expect(result.stderr.includes("sk-config-secret")).toBe(false);
    expect(result.stderr.includes("sk-env")).toBe(false);
  });
});

test("project config is loaded from the Git workspace root", async () => {
  await withTempDir(async (dir) => {
    await $`git init`.cwd(dir).quiet();
    await mkdir(join(dir, ".schway"));
    await mkdir(join(dir, "pkg"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({ provider: "openai", model: "from-root" }),
    );
    let used: CreateModelInput | undefined;
    const result = await run(["-p", "hello"], {
      env: { OPENAI_API_KEY: "sk-openai" },
      cwd: join(dir, "pkg"),
      createModel: async (input) => {
        used = input;
        return createScriptedModel({ text: "ok" });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(used).toMatchObject({ provider: "openai", model: "from-root" });
  });
});

test("--max-turns from CLI bounds the agent loop", async () => {
  const result = await run(["-p", "hello", "--json", "--max-turns", "2"], {
    model: createScriptedModel({
      responses: [
        {
          toolCalls: [
            { id: "t1", name: "unknown-tool", arguments: {} },
          ],
        },
        {
          toolCalls: [
            { id: "t2", name: "unknown-tool", arguments: {} },
          ],
        },
        { text: "should-not-run" },
      ],
    }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"reason":"max_turns"');
  expect(result.stdout.includes("should-not-run")).toBe(false);
});

test("config maxTurns bounds the agent loop", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({ maxTurns: 1 }),
    );
    const result = await run(["-p", "hello", "--json"], {
      cwd: dir,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              { id: "t1", name: "unknown-tool", arguments: {} },
            ],
          },
          { text: "should-not-run" },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"reason":"max_turns"');
  });
});

test("invalid --max-turns and unknown options fail with actionable errors", async () => {
  const zero = await run(["-p", "hello", "--max-turns", "0"]);
  expect(zero.exitCode).toBe(1);
  expect(zero.stderr).toContain("--max-turns");

  const missing = await run(["-p", "hello", "--env-file"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("Missing value for --env-file");
});

test("--env-file supplies credentials and is outranked by --api-key", async () => {
  await withTempDir(async (dir) => {
    const envFile = join(dir, "keys.env");
    await writeFile(envFile, "ANTHROPIC_API_KEY=sk-from-file\n");

    let fromFile: string | undefined;
    const loaded = await run(["-p", "hello", "--env-file", envFile], {
      env: {},
      cwd: dir,
      createModel: async ({ apiKey }) => {
        fromFile = apiKey;
        return createScriptedModel({ text: "ok" });
      },
    });
    expect(loaded.exitCode).toBe(0);
    expect(fromFile).toBe("sk-from-file");

    let fromFlag: string | undefined;
    const overridden = await run(
      ["-p", "hello", "--env-file", envFile, "--api-key", "sk-runtime"],
      {
        env: { ANTHROPIC_API_KEY: "sk-env" },
        cwd: dir,
        createModel: async ({ apiKey }) => {
          fromFlag = apiKey;
          return createScriptedModel({ text: "ok" });
        },
      },
    );
    expect(overridden.exitCode).toBe(0);
    expect(fromFlag).toBe("sk-runtime");
  });
});

test("--env-file overrides process environment keys", async () => {
  await withTempDir(async (dir) => {
    const envFile = join(dir, "keys.env");
    await writeFile(envFile, "ANTHROPIC_API_KEY=sk-from-file\n");
    let used: string | undefined;
    const result = await run(["-p", "hello", "--env-file", envFile], {
      env: { ANTHROPIC_API_KEY: "sk-env" },
      cwd: dir,
      createModel: async ({ apiKey }) => {
        used = apiKey;
        return createScriptedModel({ text: "ok" });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(used).toBe("sk-from-file");
  });
});

test("missing --env-file path fails without loading a project .env", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-from-dotenv\n");
    const result = await run(["-p", "hello", "--env-file", join(dir, "missing.env")], {
      env: {},
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing.env");
    expect(result.stderr.includes("sk-from-dotenv")).toBe(false);
  });
});

test("compatible connection options from config reach createModel", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({
        provider: "openai-compatible",
        model: "llama3.2",
        baseUrl: "http://127.0.0.1:11434/v1",
        headers: { "X-Test": "ok" },
        extraBody: { temperature: 0.2 },
        auth: "optional",
      }),
    );
    let used: CreateModelInput | undefined;
    const result = await run(["-p", "hello", "--api-key", "sk-compat"], {
      env: { OPENAI_API_KEY: "sk-openai" },
      cwd: dir,
      createModel: async (input) => {
        used = input;
        return createScriptedModel({ text: "ok" });
      },
    });
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
  });
});

test("Anthropic config overrides appear in the prepared provider request", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({
        provider: "anthropic",
        model: "claude-secret-lab",
        maxOutput: 2048,
      }),
    );
    const captured: { body?: unknown; calls: number } = { calls: 0 };
    const result = await run(["-p", "hello"], {
      cwd: dir,
      env: { ANTHROPIC_API_KEY: "sk-anthropic" },
      fetch: async (_input, init) => {
        captured.calls += 1;
        captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(encodeAnthropicSse(ANTHROPIC_TEXT), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(captured.calls).toBe(1);
    const body = captured.body as { model: string; max_tokens: number };
    expect(body.model).toBe("claude-secret-lab");
    expect(body.max_tokens).toBe(2048);
    expect(result.stdout).toContain("Hello");
  });
});

test("OpenAI CLI overrides appear in the prepared provider request", async () => {
  const captured: { body?: unknown; calls: number } = { calls: 0 };
  const result = await run(
    [
      "-p",
      "hello",
      "--provider",
      "openai",
      "--model",
      "my-custom-gpt",
      "--max-output",
      "1024",
    ],
    {
      env: { OPENAI_API_KEY: "sk-openai" },
      fetch: async (_input, init) => {
        captured.calls += 1;
        captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(encodeOpenAISse(OPENAI_TEXT), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const body = captured.body as { model: string; max_output_tokens: number };
  expect(body.model).toBe("my-custom-gpt");
  expect(body.max_output_tokens).toBe(1024);
});

test("OpenAI-compatible config overrides appear in the prepared provider request", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".schway"));
    await writeFile(
      join(dir, ".schway", "config.json"),
      JSON.stringify({
        provider: "openai-compatible",
        model: "llama3.2",
        baseUrl: "http://127.0.0.1:11434/v1",
        headers: { "X-Test": "ok" },
        extraBody: { temperature: 0.2 },
        auth: "required",
        maxOutput: 512,
      }),
    );
    const captured: {
      url?: string;
      headers?: Headers;
      body?: unknown;
      calls: number;
    } = { calls: 0 };
    const result = await run(["-p", "hello", "--api-key", "sk-compat"], {
      env: { OPENAI_API_KEY: "sk-openai" },
      cwd: dir,
      fetch: async (input, init) => {
        captured.calls += 1;
        captured.url = String(input);
        captured.headers = new Headers(init?.headers);
        captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(captured.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(captured.headers?.get("X-Test")).toBe("ok");
    expect(captured.headers?.get("Authorization")).toBe("Bearer sk-compat");
    const body = captured.body as {
      model: string;
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe("llama3.2");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
  });
});

test("unknown catalog models still run with conservative max output", async () => {
  const captured: { body?: unknown } = {};
  const result = await run(
    ["-p", "hello", "--provider", "openai", "--model", "not-in-catalog"],
    {
      env: { OPENAI_API_KEY: "sk-openai" },
      fetch: async (_input, init) => {
        captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(encodeOpenAISse(OPENAI_TEXT), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const body = captured.body as { model: string; max_output_tokens: number };
  expect(body.model).toBe("not-in-catalog");
  expect(body.max_output_tokens).toBe(16_384);
});

test("zero-config Anthropic request uses the catalog default model", async () => {
  const captured: { body?: unknown } = {};
  const result = await run(["-p", "hello"], {
    env: { ANTHROPIC_API_KEY: "sk-anthropic" },
    fetch: async (_input, init) => {
      captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(encodeAnthropicSse(ANTHROPIC_TEXT), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  expect(result.exitCode).toBe(0);
  const body = captured.body as { model: string; max_tokens: number };
  expect(body.model).toBe(DEFAULT_MODEL_IDS.anthropic);
  expect(body.max_tokens).toBe(16_384);
});
