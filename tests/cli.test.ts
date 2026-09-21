import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
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
        throw new Error("connection reset");
      },
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("Hel\n");
  expect(result.stderr).toContain("connection reset");
});
