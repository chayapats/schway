import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpath, symlink } from "node:fs/promises";
import { scheduleToolCalls } from "../src/agent/scheduler.ts";
import type { ToolCallContent } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { executeToolCall } from "../src/tools/executor.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";

test("explicit local extension registers a plain-schema tool through the existing executor", async () => {
  await withTempDir(async (dir) => {
    await Bun.write(join(dir, "greet.ts"), `export default ({ registerTool }) => {
      registerTool({ name: 'greet', description: 'Greet someone', execution: 'parallel',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        async execute({ name }, ctx) {
          ctx.onOutput?.({ stream: 'stdout', text: 'working' });
          return { content: 'Hello ' + name + ' from ' + ctx.workspace.root };
        }
      });
    };`);
    const workspace = await resolveWorkspace(dir);
    const base = createToolRegistry();
    const { tools } = await loadExtensions({ modules: ["greet.ts"], workspace, tools: base });
    expect(base.definitions()).toHaveLength(0);
    expect(tools.definitions().map((tool) => tool.name)).toEqual(["greet"]);
    const chunks: string[] = [];
    const result = await executeToolCall({
      registry: tools, workspace,
      call: { type: "tool_call", id: "call-1", name: "greet", arguments: { name: "Ada" } },
      onOutput: (chunk) => chunks.push(chunk.text),
    });
    expect(result.result.content).toBe(`Hello Ada from ${workspace.root}`);
    expect(chunks).toEqual(["working"]);
    const invalid = await executeToolCall({
      registry: tools, workspace,
      call: { type: "tool_call", id: "call-2", name: "greet", arguments: { name: 7 } },
      onOutput: (chunk) => chunks.push(chunk.text),
    });
    expect(invalid.status).toBe("error");
    expect(invalid.result.content).toContain("Invalid arguments");
    expect(chunks).toEqual(["working"]);
  });
});

const VALID_TOOL = `{ name: 'custom', description: 'Custom tool', execution: 'parallel',
  inputSchema: { type: 'object' }, async execute() { return { content: 'ok' }; } }`;

for (const [label, failure, diagnostic] of [
  ["throw", `throw new Error('initialization broke')`, "initialization broke"],
  ["duplicate", `ctx.registerTool(${VALID_TOOL})`, "already registered"],
  ["schema", `ctx.registerTool({ ...${VALID_TOOL}, name: 'bad', inputSchema: { $ref: '#' } })`, "$ref"],
  ["swallowed schema error", `try { ctx.registerTool({ ...${VALID_TOOL}, name: 'bad', inputSchema: { $ref: '#' } }); } catch {}`, "$ref"],
  ["invalid execution", `ctx.registerTool({ ...${VALID_TOOL}, name: 'bad', execution: 'sometimes' })`, "execution"],
  ["missing execute", `ctx.registerTool({ ...${VALID_TOOL}, name: 'bad', execute: null })`, "execute"],
  ["reserved native", `ctx.registerTool({ ...${VALID_TOOL}, name: 'activate_skill' })`, "reserved"],
] as const) {
  test(`${label} fails startup with identity and no partial registrations`, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "broken.ts");
      await Bun.write(path, `export default (ctx) => { ctx.registerTool(${VALID_TOOL}); ${failure}; };`);
      const tools = createToolRegistry();
      await expect(loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools }))
        .rejects.toThrow(diagnostic);
      await expect(loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools }))
        .rejects.toThrow("broken.ts");
      expect(tools.definitions()).toHaveLength(0);
    });
  });
}

test("registration is sealed after initialization and registered metadata is detached", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "retained.ts");
    await Bun.write(path, `let ctx; const tool = ${VALID_TOOL};
      export default (context) => { ctx = context; ctx.registerTool(tool); };
      export function late() { ctx.registerTool({ ...tool, name: 'late' }); }
      export function mutate() { tool.name = 'mutated'; tool.execution = 'exclusive'; tool.inputSchema.type = 'string'; }
    `);
    const { tools } = await loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools: createToolRegistry() });
    const module = await import(pathToFileURL(await realpath(path)).href);
    expect(() => module.late()).toThrow("closed");
    module.mutate();
    expect(tools.definitions().map((tool) => tool.name)).toEqual(["custom"]);
    expect(tools.get("custom")!.definition.execution).toBe("parallel");
    expect(tools.get("custom")!.definition.inputSchema.type).toBe("object");
  });
});

test("extension returns, thrown errors, and live output are bounded and redact known credentials", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "output.ts");
    await Bun.write(path, `export default ({ registerTool }) => {
      for (const name of ['large', 'throwing', 'malformed']) registerTool({ ...${VALID_TOOL}, name,
        async execute(input, ctx) {
          if (name === 'throwing') throw new Error('private-key-' + 'x'.repeat(60000));
          if (name === 'malformed') return { content: 42 };
          ctx.onOutput?.({ stream: 'stdout', text: 'private-key-' + 'a'.repeat(60000) });
          ctx.onOutput?.({ stream: 'stdout', text: 'later' });
          return { content: 'private-key-' + 'x'.repeat(60000), details: { key: 'private-key' } };
        }
      });
    };`);
    const workspace = await resolveWorkspace(dir);
    const { tools } = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry(), secrets: ["private-key"] });
    const chunks: string[] = [];
    for (const name of ["large", "throwing", "malformed"]) {
      const result = await executeToolCall({ registry: tools, workspace,
        call: { type: "tool_call", id: name, name, arguments: {} },
        onOutput: (chunk) => chunks.push(chunk.text),
      });
      expect(result.result.content.length).toBeLessThanOrEqual(50_000);
      expect(result.result.content).not.toContain("private-key");
      if (name === "malformed") {
        expect(result.result.content).toContain("content string");
      } else {
        expect(result.result.content).toContain("truncated");
      }
      expect(result.status).toBe(name === "large" ? "success" : "error");
      if (name === "large") expect(result.details).toEqual({ key: "***" });
    }
    expect(chunks.join("").length).toBeLessThanOrEqual(50_000);
    expect(chunks.join("")).not.toContain("private-key");
    expect(chunks.join("")).not.toContain("later");
  });
});

test("canonical duplicates fail before import; unmentioned modules execute no code", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "module.ts");
    const marker = join(dir, "executed");
    await Bun.write(path, `await Bun.write(${JSON.stringify(marker)}, 'executed'); export default () => {};`);
    await symlink(path, join(dir, "alias.ts"));
    const options = { workspace: await resolveWorkspace(dir), tools: createToolRegistry() };
    await loadExtensions({ ...options, modules: [] });
    expect(await Bun.file(marker).exists()).toBe(false);
    await expect(loadExtensions({ ...options, modules: ["module.ts", "alias.ts"] })).rejects.toThrow("Duplicate extension identity");
    expect(await Bun.file(marker).exists()).toBe(false);
    await loadExtensions({ ...options, modules: ["alias.ts"] });
    expect(await Bun.file(marker).text()).toBe("executed");
  });
});

test("extension calls honor concurrency limits, exclusive barriers, and cancellation through the native scheduler", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "gates.ts");
    await Bun.write(path, `export const started = []; const gates = new Map();
      export function finish(id) { gates.get(id)?.(); }
      export default ({ registerTool }) => {
        for (const execution of ['parallel', 'exclusive']) registerTool({ ...${VALID_TOOL}, name: execution, execution,
          async execute({ id }, ctx) {
            started.push(id);
            await new Promise(resolve => {
              gates.set(id, resolve);
              ctx.signal?.addEventListener('abort', resolve, { once: true });
            });
            if (ctx.signal?.aborted) throw new DOMException('aborted', 'AbortError');
            return { content: id };
          }
        });
      };
    `);
    const workspace = await resolveWorkspace(dir);
    const { tools: registry } = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry() });
    const module = await import(pathToFileURL(await realpath(path)).href);
    const calls: ToolCallContent[] = ["parallel", "parallel", "parallel", "exclusive", "parallel"].map((name, index) => ({
      type: "tool_call", id: String(index), name, arguments: { id: String(index) },
    }));
    const signal = new AbortController();
    const scheduler = scheduleToolCalls({ registry, workspace, calls, signal: signal.signal, maxConcurrentTools: 2 });
    const finished: string[] = [];
    while (true) {
      const next = await scheduler.next();
      if (next.done) {
        expect(next.value.map((item) => item.status)).toEqual(["success", "success", "success", "cancelled", "cancelled"]);
        expect(next.value.map((item) => item.result.toolCallId)).toEqual(["0", "1", "2", "3", "4"]);
        break;
      }
      if (next.value.type === "tool.started") {
        const id = next.value.toolCallId;
        if (id === "0") expect(module.started).toEqual(["0", "1"]);
        if (id === "1") { module.finish("0"); module.finish("1"); }
        if (id === "2") { expect(module.started).toEqual(["0", "1", "2"]); module.finish("2"); }
        if (id === "3") {
          expect(finished).toEqual(["0", "1", "2"]);
          expect(module.started).toEqual(["0", "1", "2", "3"]);
          signal.abort();
        }
      }
      if (next.value.type === "tool.finished") finished.push(next.value.toolCallId);
    }
    expect(module.started).toEqual(["0", "1", "2", "3"]);
    expect(finished).toEqual(["0", "1", "2", "3", "4"]);
  });
});

test("invalid extension arguments produce one bounded error without executing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "validate.ts");
    await Bun.write(path, `export default ({ registerTool }) => registerTool({ ...${VALID_TOOL},
      inputSchema: { type: 'array', items: { type: 'number' } },
      async execute() { throw new Error('should not execute'); }
    });`);
    const workspace = await resolveWorkspace(dir);
    const { tools: registry } = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry() });
    const result = await executeToolCall({ registry, workspace,
      call: { type: "tool_call", id: "invalid", name: "custom", arguments: Array(5000).fill("invalid") },
    });
    expect(result.status).toBe("error");
    expect(result.result.content).toContain("Invalid arguments");
    expect(result.result.content).not.toContain("should not execute");
    expect(result.result.content.length).toBeLessThanOrEqual(50_000);
  });
});

test("live extension output redacts credentials split across chunks", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "stream.ts");
    await Bun.write(path, `export default ({ registerTool }) => registerTool({ ...${VALID_TOOL},
      async execute(input, ctx) {
        for (const text of ['before pri', 'vate', '-key after']) ctx.onOutput?.({ stream: 'stdout', text });
        return { content: 'done' };
      }
    });`);
    const workspace = await resolveWorkspace(dir);
    const { tools: registry } = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry(), secrets: ["private-key"] });
    let output = "";
    const result = await executeToolCall({ registry, workspace,
      call: { type: "tool_call", id: "stream", name: "custom", arguments: {} },
      onOutput: (chunk) => { output += chunk.text; },
    });
    expect(result.status).toBe("success");
    expect(output).toBe("before *** after");
  });
});

test("load failures and cross-module duplicates identify the module and preserve existing tools", async () => {
  await withTempDir(async (dir) => {
    const workspace = await resolveWorkspace(dir);
    const tools = createToolRegistry([{ name: "existing", description: "Existing", execution: "parallel",
      inputSchema: { type: "object" }, async execute() { return { content: "existing" }; },
    }]);
    const validator = tools.get("existing")!.validate;
    await Bun.write(join(dir, "first.ts"), `export default ctx => ctx.registerTool(${VALID_TOOL});`);
    await Bun.write(join(dir, "duplicate.ts"), `export default ctx => ctx.registerTool(${VALID_TOOL});`);
    await Bun.write(join(dir, "missing-default.ts"), "export const wrong = true;");
    for (const modules of [["absent.ts"], ["missing-default.ts"], ["first.ts", "duplicate.ts"]]) {
      await expect(loadExtensions({ modules, workspace, tools })).rejects.toThrow(modules.at(-1)!);
      expect(tools.definitions().map((tool) => tool.name)).toEqual(["existing"]);
      expect(tools.get("existing")!.validate).toBe(validator);
    }
    const { tools: loaded } = await loadExtensions({ modules: ["first.ts"], workspace, tools });
    expect(loaded.definitions().map((tool) => tool.name)).toEqual(["existing", "custom"]);
    expect(loaded.get("existing")!.validate).toBe(validator);
  });
});
