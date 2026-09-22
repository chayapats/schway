import { expect, test } from "bun:test";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/main.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withIsolatedCliDirs } from "./helpers.ts";

test("repeatable extension flags preserve order in interactive and headless arguments", () => {
  for (const argv of [[], ["-p", "hello"]]) {
    const parsed = parseArgs([...argv, "--extension", "first.ts", "--extension=second.ts"]);
    expect(parsed).toMatchObject({ args: { extensions: ["first.ts", "second.ts"] } });
  }
  expect(parseArgs(["--extension"])).toEqual({ error: "Missing value for --extension" });
  expect(parseArgs(["--extension="])).toEqual({ error: "Missing value for --extension" });
});

test("headless loop loads ordered extensions from the primary workspace before its first model request", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await mkdir(join(work, ".git"));
    const nested = join(work, "nested");
    await mkdir(nested);
    await Bun.write(join(work, "first.ts"), `export default async (ctx) => {
      await Promise.resolve();
      ctx.registerTool({ name: 'first', description: 'First', execution: 'parallel', inputSchema: { type: 'object' },
        async execute() { return { content: 'first' }; } });
    };`);
    await Bun.write(join(work, "second.ts"), `export default (ctx) => {
      ctx.registerTool({ name: 'greet', description: 'Greet', execution: 'exclusive',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        async execute({ name }, ctx) {
          ctx.onOutput?.({ stream: 'stdout', text: 'greeting' });
          return { content: 'Hello ' + name, details: { custom: true } };
        } });
    };`);
    let requests = 0;
    const model = createScriptedModel({ responses: [
      (request) => {
        requests++;
        expect(request.tools?.filter((tool) => tool.name === "first" || tool.name === "greet")
          .map((tool) => tool.name)).toEqual(["first", "greet"]);
        return { toolCalls: [{ id: "greeting-call", name: "greet", arguments: { name: "Ada" } }] };
      },
      (request) => {
        requests++;
        expect(request.items.filter((item) => item.type === "tool_result"))
          .toMatchObject([{ toolCallId: "greeting-call", content: "Hello Ada", isError: false }]);
        return { text: "Greeting complete" };
      },
    ] });
    let stdout = "";
    let stderr = "";
    const code = await runCli(["-p", "greet Ada", "--json", "--extension", "first.ts", "--extension", "second.ts"], {
      cwd: nested, env: { HOME: home }, model,
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(requests).toBe(2);
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "tool.finished")).toMatchObject([
      { toolCallId: "greeting-call", status: "success", content: "Hello Ada" },
    ]);
    const sessionDir = join(home, ".schway/sessions");
    const files = await readdir(sessionDir);
    const saved = (await Bun.file(join(sessionDir, files[0]!)).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(saved.filter((item) => item.type === "tool_result")).toHaveLength(1);
    expect(saved.some((item) => item.type === "tool.delta")).toBe(false);
  });
});

for (const mode of ["headless", "interactive"]) {
  test(`${mode} extension initialization failure is actionable and creates no session`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await Bun.write(join(work, "broken.ts"), `throw new Error('failed with private-key');`);
      let stderr = "";
      let modelLoads = 0;
      const code = await runCli([...(mode === "headless" ? ["-p", "hello"] : []), "--extension", "broken.ts"], {
        cwd: work, env: { HOME: home, ANTHROPIC_API_KEY: "private-key" },
        stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } },
        createModel: async () => { modelLoads++; return createScriptedModel(); },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("broken.ts");
      expect(stderr).toContain("failed with ***");
      expect(stderr).not.toContain("private-key");
      expect(modelLoads).toBe(0);
      await expect(stat(join(home, ".schway/sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
}

test("headless /skills awaits ordered extension initializers without constructing a model or session", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const marker = join(work, "initialization-order.txt");
    await Bun.write(join(work, "first.ts"), `export default async () => {
      await Bun.write(${JSON.stringify(marker)}, 'first\\n');
    };`);
    await Bun.write(join(work, "second.ts"), `export default async () => {
      const before = await Bun.file(${JSON.stringify(marker)}).text();
      await Bun.write(${JSON.stringify(marker)}, before + 'second\\n');
    };`);
    let stdout = "";
    let stderr = "";
    let modelLoads = 0;
    const code = await runCli(["--extension", "first.ts", "--extension", "second.ts", "-p", "/skills"], {
      cwd: work, env: { HOME: home },
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
      createModel: async () => { modelLoads++; return createScriptedModel(); },
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("No skills are installed.");
    expect(await Bun.file(marker).text()).toBe("first\nsecond\n");
    expect(modelLoads).toBe(0);
    await expect(stat(join(home, ".schway/sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("headless /skills reports a failed extension initializer without listing or creating a session", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await Bun.write(join(work, "throwing.ts"), `export default async () => { throw new Error('failed with private-key'); };`);
    let stdout = "";
    let stderr = "";
    let modelLoads = 0;
    const code = await runCli(["--extension", "throwing.ts", "-p", "/skills"], {
      cwd: work, env: { HOME: home, ANTHROPIC_API_KEY: "private-key" },
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
      createModel: async () => { modelLoads++; return createScriptedModel(); },
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("throwing.ts");
    expect(stderr).toContain("failed with ***");
    expect(stderr).not.toContain("private-key");
    expect(modelLoads).toBe(0);
    await expect(stat(join(home, ".schway/sessions"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

for (const deny of [false, true]) {
  test(`headless native request hooks ${deny ? "deny safely" : "reach the actual model"} with clean JSONL`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await Bun.write(join(work, "context.ts"), `export default ctx => {
        ctx.registerPrompt({ name: 'extension', content: 'registered context' });
        ctx.beforeAgent(() => ({ context: [{ name: 'turn', content: 'turn context' }] }));
        ctx.context(({ context }) => [...context, { name: 'waterfall', content: 'prepared context' }]);
        ctx.beforeModel(request => ${deny ? "({ deny: 'request denied by policy' })" : "({ ...request, systemPrompt: request.systemPrompt + '\\nrequest transformed' })"});
      };`);
      let requests = 0;
      let stdout = "";
      let stderr = "";
      const code = await runCli(["-p", "hello", "--json", "--extension", "context.ts"], {
        cwd: work, env: { HOME: home }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
        model: createScriptedModel({ responses: [request => {
          requests++;
          expect(request.systemPrompt).toContain("request transformed");
          expect(request.context.map(s => s.name)).toEqual(["environment", "extension", "turn", "waterfall"]);
          return { text: "done" };
        }] }),
      });
      expect(code).toBe(deny ? 1 : 0);
      expect(requests).toBe(deny ? 0 : 1);
      if (deny) expect(stderr).toContain("request denied by policy");
      else expect(stderr).toBe("");
      const events = stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: deny ? "error" : "completed" });
      if (deny) expect(events.find(e => e.type === "error")?.message).toContain("request denied by policy");
    });
  });
}
