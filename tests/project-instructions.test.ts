import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import type { UserMessage } from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { makeDir, makeSymlink, withTempDir } from "./helpers.ts";
import {
  collect,
  createScriptedModel,
  type ScriptedTurnFactory,
} from "./helpers/scripted-model.ts";

/** Build a single-text user message for loop tests. */
function user(text: string): UserMessage {
  return { type: "user", id: "u1", content: [{ type: "text", text }] };
}

/** Capture every prepared model request from a scripted loop. */
async function captureRequests(
  workspace: { root: string; launchCwd: string; extraRoots: string[] },
  options: {
    home?: string;
    responses: ScriptedTurnFactory[];
    tools?: boolean;
  },
): Promise<ModelRequest[]> {
  const session = createSession([user("hello")]);
  const requests: ModelRequest[] = [];
  const responses = options.responses.map((factory) => {
    if (typeof factory === "function") {
      return (request: ModelRequest) => {
        requests.push(request);
        return factory(request);
      };
    }
    return (request: ModelRequest) => {
      requests.push(request);
      return factory;
    };
  });
  await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({ responses }),
      contextManager: createContextManager(workspace, { home: options.home }),
      tools: options.tools ? createToolRegistry([readTool]) : undefined,
      workspace,
    }),
  );
  return requests;
}

/** Project-instructions section text, or empty when the section is absent. */
function instructionsOf(request: ModelRequest | undefined): string {
  return (
    request?.context.find((section) => section.name === "project-instructions")
      ?.content ?? ""
  );
}

test("root AGENTS.md appears in the first prepared request", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "AGENTS.md"), "ROOT_RULE_BETA\n");
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      responses: [{ text: "ok" }],
    });

    expect(instructionsOf(requests[0])).toContain("ROOT_RULE_BETA");
    expect(JSON.stringify(requests[0]?.items).includes("ROOT_RULE_BETA")).toBe(
      false,
    );
  });
});

test("missing optional instructions leave the default prompt and no project section", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    const project = await makeDir(join(dir, "project"));
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      responses: [{ text: "ok" }],
    });

    expect(requests[0]?.systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
    expect(instructionsOf(requests[0])).toBe("");
    expect(requests[0]?.context.map((section) => section.name)).toEqual([
      "environment",
    ]);
  });
});

test("launch inside a Git subtree assembles parent instructions before nested ones", async () => {
  await withTempDir(async (dir) => {
    const repo = await nestedRepo(dir);
    const workspace = await resolveWorkspace(join(repo, "apps", "web"));
    const requests = await captureRequests(workspace, {
      responses: [{ text: "ok" }],
    });

    const text = instructionsOf(requests[0]);
    expect(text).toContain("ROOT_RULE_BETA");
    expect(text).toContain("APPS_RULE_GAMMA");
    expect(text).toContain("WEB_RULE_DELTA");
    expect(text.includes("API_RULE_EPSILON")).toBe(false);
    expect(text.indexOf("ROOT_RULE_BETA")).toBeLessThan(
      text.indexOf("APPS_RULE_GAMMA"),
    );
    expect(text.indexOf("APPS_RULE_GAMMA")).toBeLessThan(
      text.indexOf("WEB_RULE_DELTA"),
    );
  });
});

test("nested AGENTS.md is discovered lazily after work enters that subtree", async () => {
  await withTempDir(async (dir) => {
    const repo = await nestedRepo(dir);
    const workspace = { root: repo, launchCwd: repo, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      tools: true,
      responses: [
        {
          toolCalls: [
            {
              id: "call-read",
              name: "read",
              arguments: { path: "apps/web/index.ts" },
            },
          ],
        },
        { text: "done" },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(instructionsOf(requests[0])).toContain("ROOT_RULE_BETA");
    expect(instructionsOf(requests[0]).includes("WEB_RULE_DELTA")).toBe(false);
    expect(instructionsOf(requests[0]).includes("API_RULE_EPSILON")).toBe(
      false,
    );
    expect(instructionsOf(requests[1])).toContain("ROOT_RULE_BETA");
    expect(instructionsOf(requests[1])).toContain("WEB_RULE_DELTA");
    expect(instructionsOf(requests[1]).includes("API_RULE_EPSILON")).toBe(
      false,
    );
    expect(instructionsOf(requests[1]).indexOf("ROOT_RULE_BETA")).toBeLessThan(
      instructionsOf(requests[1]).indexOf("WEB_RULE_DELTA"),
    );
  });
});

test("sibling and similar-prefix directories do not leak instructions", async () => {
  await withTempDir(async (dir) => {
    const repo = await nestedRepo(dir);
    const workspace = { root: repo, launchCwd: repo, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      tools: true,
      responses: [
        {
          toolCalls: [
            {
              id: "call-read",
              name: "read",
              arguments: { path: "apps/web/index.ts" },
            },
          ],
        },
        { text: "done" },
      ],
    });

    const later = instructionsOf(requests[1]);
    expect(later).toContain("WEB_RULE_DELTA");
    expect(later.includes("API_RULE_EPSILON")).toBe(false);
    expect(later.includes("WEBSITE_RULE_ZETA")).toBe(false);
  });
});

test("scope selection follows canonical target paths through symlinks", async () => {
  await withTempDir(async (dir) => {
    const repo = await nestedRepo(dir);
    await makeSymlink(join(repo, "apps", "web"), join(repo, "apps", "current"));
    const workspace = { root: repo, launchCwd: repo, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      tools: true,
      responses: [
        {
          toolCalls: [
            {
              id: "call-read",
              name: "read",
              arguments: { path: "apps/current/index.ts" },
            },
          ],
        },
        { text: "done" },
      ],
    });

    const later = instructionsOf(requests[1]);
    expect(later).toContain("WEB_RULE_DELTA");
    expect(later.includes("API_RULE_EPSILON")).toBe(false);
  });
});

test("global AGENTS.md is assembled before repository instructions", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway", "AGENTS.md"), "GLOBAL_RULE_ALPHA\n");
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "AGENTS.md"), "ROOT_RULE_BETA\n");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      responses: [{ text: "ok" }],
    });

    const text = instructionsOf(requests[0]);
    expect(text).toContain("GLOBAL_RULE_ALPHA");
    expect(text).toContain("ROOT_RULE_BETA");
    expect(text.indexOf("GLOBAL_RULE_ALPHA")).toBeLessThan(
      text.indexOf("ROOT_RULE_BETA"),
    );
  });
});

test("user-global SYSTEM.md replaces the base prompt and keeps tools and AGENTS.md", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "SYSTEM.md"),
      "REPLACEMENT_PROMPT_THETA\n",
    );
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "AGENTS.md"), "ROOT_RULE_BETA\n");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      tools: true,
      responses: [{ text: "ok" }],
    });

    expect(requests[0]?.systemPrompt).toContain("REPLACEMENT_PROMPT_THETA");
    expect(requests[0]?.systemPrompt.includes("You are Schway")).toBe(false);
    expect(instructionsOf(requests[0])).toContain("ROOT_RULE_BETA");
    expect(requests[0]?.tools?.some((tool) => tool.name === "read")).toBe(true);
  });
});

test("user-global APPEND_SYSTEM.md appends to the base prompt", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "APPEND_SYSTEM.md"),
      "APPEND_PROMPT_IOTA\n",
    );
    const project = await makeDir(join(dir, "project"));
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      responses: [{ text: "ok" }],
    });

    expect(requests[0]?.systemPrompt).toContain("You are Schway");
    expect(requests[0]?.systemPrompt).toContain("APPEND_PROMPT_IOTA");
    expect(requests[0]?.systemPrompt.indexOf("You are Schway")).toBeLessThan(
      requests[0]!.systemPrompt.indexOf("APPEND_PROMPT_IOTA"),
    );
  });
});

test("SYSTEM.md replacement still receives APPEND_SYSTEM.md and project instructions", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "SYSTEM.md"),
      "REPLACEMENT_PROMPT_THETA\n",
    );
    await writeFile(
      join(home, ".schway", "APPEND_SYSTEM.md"),
      "APPEND_PROMPT_IOTA\n",
    );
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "AGENTS.md"), "ROOT_RULE_BETA\n");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      responses: [{ text: "ok" }],
    });

    expect(requests[0]?.systemPrompt).toContain("REPLACEMENT_PROMPT_THETA");
    expect(requests[0]?.systemPrompt).toContain("APPEND_PROMPT_IOTA");
    expect(
      requests[0]!.systemPrompt.indexOf("REPLACEMENT_PROMPT_THETA"),
    ).toBeLessThan(requests[0]!.systemPrompt.indexOf("APPEND_PROMPT_IOTA"));
    expect(instructionsOf(requests[0])).toContain("ROOT_RULE_BETA");
  });
});

test("project-local system prompt files do not replace or append the base prompt", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "SYSTEM.md"), "PROJECT_SYSTEM_KAPPA\n");
    await writeFile(
      join(project, "APPEND_SYSTEM.md"),
      "PROJECT_APPEND_LAMBDA\n",
    );
    await mkdir(join(project, ".schway"), { recursive: true });
    await writeFile(
      join(project, ".schway", "SYSTEM.md"),
      "PROJECT_SCHWAY_SYSTEM_MU\n",
    );
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const requests = await captureRequests(workspace, {
      home,
      responses: [{ text: "ok" }],
    });

    expect(requests[0]?.systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
    expect(requests[0]?.systemPrompt.includes("PROJECT_SYSTEM_KAPPA")).toBe(
      false,
    );
    expect(requests[0]?.systemPrompt.includes("PROJECT_APPEND_LAMBDA")).toBe(
      false,
    );
    expect(
      requests[0]?.systemPrompt.includes("PROJECT_SCHWAY_SYSTEM_MU"),
    ).toBe(false);
  });
});

test("headless CLI loads HOME prompt files and workspace AGENTS.md", async () => {
  await withTempDir(async (dir) => {
    const home = await makeDir(join(dir, "home"));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "SYSTEM.md"),
      "REPLACEMENT_PROMPT_THETA\n",
    );
    await writeFile(
      join(home, ".schway", "AGENTS.md"),
      "GLOBAL_RULE_ALPHA\n",
    );
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "AGENTS.md"), "ROOT_RULE_BETA\n");
    let request: ModelRequest | undefined;
    const sink = { write() {} };
    const exitCode = await runCli(["-p", "hello"], {
      stdout: sink,
      stderr: sink,
      env: { HOME: home, ANTHROPIC_API_KEY: "sk-test" },
      cwd: project,
      model: createScriptedModel({
        responses: [
          (captured) => {
            request = captured;
            return { text: "ok" };
          },
        ],
      }),
    });

    expect(exitCode).toBe(0);
    expect(request?.systemPrompt).toContain("REPLACEMENT_PROMPT_THETA");
    expect(instructionsOf(request)).toContain("GLOBAL_RULE_ALPHA");
    expect(instructionsOf(request)).toContain("ROOT_RULE_BETA");
  });
});

test("project instructions stay out of durable JSONL records", async () => {
  await withTempDir(async (dir) => {
    const project = await makeDir(join(dir, "project"));
    await writeFile(join(project, "AGENTS.md"), "ROOT_RULE_BETA\n");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const session = await createJsonlSession({
      directory: join(dir, "sessions"),
      workspace,
    });
    session.append(user("hello"));
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({ text: "ok" }),
        contextManager: createContextManager(workspace),
      }),
    );
    const records = await Bun.file(
      join(dir, "sessions", `${session.header.id}.jsonl`),
    ).text();
    expect(records.includes("ROOT_RULE_BETA")).toBe(false);
    expect(records.includes("project-instructions")).toBe(false);
    expect(records.includes('"name":"environment"')).toBe(false);
  });
});

/** Nested Git repo used by scoping tests. */
async function nestedRepo(dir: string): Promise<string> {
  await $`git init`.cwd(dir).quiet();
  await writeFile(join(dir, "AGENTS.md"), "ROOT_RULE_BETA\n");
  await makeDir(join(dir, "apps", "web"));
  await makeDir(join(dir, "apps", "api"));
  await makeDir(join(dir, "apps", "website"));
  await writeFile(join(dir, "apps", "AGENTS.md"), "APPS_RULE_GAMMA\n");
  await writeFile(join(dir, "apps", "web", "AGENTS.md"), "WEB_RULE_DELTA\n");
  await writeFile(join(dir, "apps", "web", "index.ts"), "web-file\n");
  await writeFile(join(dir, "apps", "api", "AGENTS.md"), "API_RULE_EPSILON\n");
  await writeFile(join(dir, "apps", "api", "index.ts"), "api-file\n");
  await writeFile(
    join(dir, "apps", "website", "AGENTS.md"),
    "WEBSITE_RULE_ZETA\n",
  );
  await writeFile(join(dir, "apps", "website", "index.ts"), "website-file\n");
  return dir;
}
