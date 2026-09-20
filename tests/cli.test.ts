import { expect, test } from "bun:test";
import { runCli } from "../src/cli/main.ts";
import type { Model } from "../src/model/model.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

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

async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    model?: Model;
    createModel?: (input: { apiKey: string }) => Promise<Model>;
  } = {},
) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli(argv, {
    stdout,
    stderr,
    env: options.env ?? { ANTHROPIC_API_KEY: "sk-test" },
    cwd: options.cwd ?? process.cwd(),
    model: options.model,
    createModel: options.createModel,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
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

test("secrets are not printed when a run fails", async () => {
  const secret = "sk-secret-do-not-print";
  const result = await run(["-p", "hello", "--api-key", secret], {
    env: {},
    model: createScriptedModel({ error: `unauthorized ${secret}` }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.includes(secret)).toBe(false);
  expect(result.stderr.includes(secret)).toBe(false);
  expect(result.stderr).toContain("unauthorized");
});

test("provider stream failure exits non-zero with an actionable error", async () => {
  const result = await run(["-p", "hello"], {
    model: createScriptedModel({ error: "connection reset" }),
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("connection reset");
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

test("partial streamed text is terminated before an error diagnostic", async () => {
  const result = await run(["-p", "hello"], {
    model: {
      provider: "scripted",
      id: "scripted",
      async *stream() {
        yield { type: "text_delta" as const, text: "Hel" };
        throw new Error("connection reset");
      },
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("Hel\n");
  expect(result.stderr).toContain("connection reset");
});
