import { expect, test } from "bun:test";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHost, hostCapabilities, HostError, type HostOptions } from "schway/host";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { resolveToolPath } from "../src/tools/path.ts";
import { ExtensionToolHooks } from "../src/extensions/tool-hooks.ts";
import { ExtensionHooks } from "../src/extensions/hooks.ts";
import { readTool } from "../src/tools/read.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const operator = "Trusted operator: exact tools only.";
async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "workspace-discovery", systemPrompt: operator, sections: [{ name: "owner", content: "explicit" }] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 4, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 } };
}

async function externalPolicy(dir: string, config: HostOptions, mode: "empty" | "narrow", reference?: { id: string; branchId: string }) {
  const consumer = join(dir, `policy-${mode}-${crypto.randomUUID()}`);
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  try { await symlink(resolve(import.meta.dir, ".."), join(consumer, "node_modules/schway"), "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await Bun.write(join(consumer, "consumer.ts"), await Bun.file(join(import.meta.dir, "fixtures/host-tool-policy-consumer.ts")).text());
  const guard = join(consumer, "guard.ts");
  await Bun.write(guard, `await Bun.plugin({name:'policy-guard',setup(builder) {
    builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/}, () => { throw new Error('Forbidden provider or TUI init'); });
  }});`);
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guard, join(consumer, "consumer.ts")], { cwd: consumer,
    env: buildIsolatedCliEnv(config.homeDirectory), stdin: new Blob([JSON.stringify({ options: config, mode, reference })]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0); expect(stderr).toBe("");
  return JSON.parse(stdout) as { result: { outcome: string }; reference: { id: string; branchId: string }; requests: Array<{ tools: string[]; hostedTools: unknown[] }>; executions: number };
}

test("capabilities advertise exact tool contract with lookup disabled", () => {
  expect(hostCapabilities().toolContract).toBe("schway.host.tool-policy/v1");
  expect(hostCapabilities().toolPolicies).toEqual(["exact"]);
  expect(hostCapabilities().hostedLookup).toBe("disabled-only");
});

test("empty registry advertises zero tools and denies forbidden built-ins without execution", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config), session = await host.createSession();
    let executions = 0;
    const result = await session.submit({ text: "try forbidden" }, createScriptedModel({ responses: [
      request => {
        expect(request.tools ?? []).toEqual([]);
        expect(request.hostedTools ?? []).toEqual([]);
        return { toolCalls: [
          { id: "b", name: "bash", arguments: {} }, { id: "w", name: "write", arguments: {} },
          { id: "e", name: "edit", arguments: {} }, { id: "f", name: "web_fetch", arguments: {} },
          { id: "a", name: "activate_skill", arguments: { name: "repo-skill" } },
        ] };
      },
      request => {
        const results = request.items.filter(item => item.type === "tool_result");
        expect(results).toHaveLength(5);
        for (const item of results) {
          expect(item).toMatchObject({ type: "tool_result", isError: true });
          expect((item as { content: string }).content).toContain("Unknown tool");
        }
        expect(executions).toBe(0);
        return { text: "held" };
      },
    ] }));
    expect(result.outcome).toBe("completed");
    await session.close(); await host.close();
  });
});

test("narrow registry exposes only admitted defs; unknown rejected and duplicates/unsupported fail startup", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const admitted = { name: "read_note", description: "Read fixture", execution: "parallel" as const, effect: "read-only" as const,
      inputSchema: { type: "object", additionalProperties: false }, async execute() { return { content: "fixture-note" }; } };
    const host = await createHost({ ...config, tools: { policy: "exact", hostedLookup: "off", definitions: [admitted] } });
    const session = await host.createSession();
    const result = await session.submit({ text: "narrow" }, createScriptedModel({ responses: [
      request => {
        expect(request.tools?.map(tool => tool.name)).toEqual(["read_note"]);
        expect(request.hostedTools ?? []).toEqual([]);
        return { toolCalls: [{ id: "ok", name: "read_note", arguments: {} }, { id: "no", name: "bash", arguments: {} }] };
      },
      request => {
        const items = request.items.filter(item => item.type === "tool_result");
        expect(items.find(item => item.toolCallId === "ok")).toMatchObject({ content: "fixture-note", isError: false });
        expect(items.find(item => item.toolCallId === "no")).toMatchObject({ isError: true });
        expect((items.find(item => item.toolCallId === "no") as unknown as { content: string }).content).toContain("Unknown tool");
        return { text: "held" };
      },
    ] }));
    expect(result.outcome).toBe("completed");
    await session.close(); await host.close();
    const duplicate = { ...admitted };
    await expect(createHost({ ...config, tools: { policy: "exact", hostedLookup: "off", definitions: [admitted, duplicate] } })).rejects.toBeInstanceOf(HostError);
    await expect(createHost({ ...config, tools: { policy: "exact", hostedLookup: "off", definitions: [{
      name: "bad", description: "bad", execution: "parallel" as const, effect: "read-only" as const,
      inputSchema: { type: "not-an-object" } as unknown as Record<string, unknown>, async execute() { return { content: "x" }; } }] } })).rejects.toBeInstanceOf(HostError);
    for (const tools of [{ policy: "include-skill-activation", hostedLookup: "off", definitions: [] },
      { policy: "exact", hostedLookup: "auto" as unknown as "off", definitions: [] },
      { policy: "exact", definitions: [] }] as unknown as HostOptions["tools"][]) {
      await expect(createHost({ ...config, tools })).rejects.toBeInstanceOf(HostError);
    }
  });
});

test("explicitly admitted activation binds to session policy; strict still denies", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    let sentinel = 0;
    const activation = { name: "activate_skill", description: "admitted", execution: "exclusive" as const,
      effect: "read-only" as const, inputSchema: { type: "object" },
      async execute() { sentinel++; return { content: "sentinel" }; } };
    const strict = await createHost({ ...config, context: { ...config.context, policy: "strict" },
      tools: { policy: "exact", hostedLookup: "off", definitions: [activation] } });
    const strictSession = await strict.createSession();
    const strictResult = await strictSession.submit({ text: "activate" }, createScriptedModel({ responses: [
      request => {
        expect(request.tools?.map(tool => tool.name)).toEqual(["activate_skill"]);
        return { toolCalls: [{ id: "a", name: "activate_skill", arguments: { name: "repo-skill" } }] };
      },
      request => {
        expect(request.items.at(-1)).toMatchObject({ type: "tool_result", isError: true });
        return { text: "held" };
      },
    ] }));
    expect(strictResult.outcome).toBe("completed"); expect(sentinel).toBe(0);
    await strictSession.close(); await strict.close();
  });
});

test("public consumer keeps empty and narrow registries authoritative in a fresh process", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const empty = await externalPolicy(dir, config, "empty");
    expect(empty.result.outcome).toBe("completed");
    expect(empty.requests).toHaveLength(2);
    for (const request of empty.requests) { expect(request.tools).toEqual([]); expect(request.hostedTools).toEqual([]); }
    expect(empty.executions).toBe(0);
    const narrow = await externalPolicy(dir, config, "narrow");
    expect(narrow.result.outcome).toBe("completed");
    for (const request of narrow.requests) { expect(request.tools).toEqual(["read_note"]); expect(request.hostedTools).toEqual([]); }
    expect(narrow.executions).toBe(1);
  });
});

test("retry, overflow and reopen keep the exact registry and hosted-off", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config), session = await host.createSession();
    const seen: Array<{ tools: string[]; hosted: unknown }> = [];
    const retry = await session.submit({ text: "retry" }, createScriptedModel({ responses: [
      () => { throw Object.assign(new Error("temporarily unavailable"), { status: 503, headers: { "retry-after": "0" } }); },
      request => { seen.push({ tools: request.tools?.map(t => t.name) ?? [], hosted: request.hostedTools ?? [] }); return { text: "recovered" }; },
    ] }));
    expect(retry.outcome).toBe("completed");
    expect(seen).toHaveLength(1); expect(seen[0]!.tools).toEqual([]); expect(seen[0]!.hosted).toEqual([]);
    for (let i = 0; i < 12; i++) {
      const seeded = await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
      expect(seeded.outcome).toBe("completed");
    }
    const overflowSeen: Array<{ tools: string[]; hosted: unknown }> = [];
    let overflowAttempts = 0;
    const overflow = await session.submit({ text: "overflow" }, createScriptedModel({ responses: [
      request => {
        if (request.systemPrompt !== operator) return { text: "Historical summary for overflow recovery." };
        overflowAttempts++;
        if (overflowAttempts === 1) throw Object.assign(new Error("maximum context length exceeded"), { status: 400, code: "context_length_exceeded" });
        overflowSeen.push({ tools: request.tools?.map(t => t.name) ?? [], hosted: request.hostedTools ?? [] });
        return { text: "after overflow" };
      },
      request => {
        if (request.systemPrompt !== operator) return { text: "Historical summary for overflow recovery." };
        overflowSeen.push({ tools: request.tools?.map(t => t.name) ?? [], hosted: request.hostedTools ?? [] });
        return { text: "after overflow" };
      },
      request => {
        if (request.systemPrompt !== operator) return { text: "Historical summary for overflow recovery." };
        overflowSeen.push({ tools: request.tools?.map(t => t.name) ?? [], hosted: request.hostedTools ?? [] });
        return { text: "after overflow" };
      },
    ] }));
    expect(overflow.outcome).toBe("completed");
    expect(overflowSeen.length).toBeGreaterThan(0);
    for (const entry of overflowSeen) { expect(entry.tools).toEqual([]); expect(entry.hosted).toEqual([]); }
    const reference = session.reference;
    await session.close();
    const reopened = await host.openSession(reference);
    let reopenedTools: string[] | undefined;
    const after = await reopened.submit({ text: "after reopen" }, createScriptedModel({ responses: [request => {
      reopenedTools = request.tools?.map(t => t.name) ?? []; expect(request.hostedTools ?? []).toEqual([]);
      return { toolCalls: [{ id: "x", name: "bash", arguments: {} }] };
    }, request => {
      expect(request.tools?.map(t => t.name) ?? []).toEqual([]);
      expect(request.items.filter(item => item.type === "tool_result")).toHaveLength(1);
      return { text: "held" };
    }] }));
    expect(after.outcome).toBe("completed"); expect(reopenedTools).toEqual([]);
    await reopened.close(); await host.close();
  });
});

test("hooks cannot enlarge the registry or set hosted lookup; effective args still pass approval", async () => {
  const workspace = { root: "/tmp/policy", launchCwd: "/tmp/policy", extraRoots: [] as string[] };
  const manager = createContextManager(workspace, { systemPrompt: operator });
  const registry = createToolRegistry([{ name: "read_note", description: "note", execution: "parallel" as const,
    effect: "read-only" as const, inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    async execute(input: unknown) { return { content: `read:${(input as { path?: string }).path ?? ""}` }; } }]);
  const hooks = new ExtensionHooks(new AbortController().signal);
  hooks.beforeModel("test", request => ({ ...request, tools: [...(request.tools ?? []),
    { name: "bash", description: "forged", inputSchema: {} }] }));
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "hook" }] }]);
  const events = await collect(runAgentLoop({ session, model: createScriptedModel({ text: "done" }),
    contextManager: manager, tools: registry, workspace, exactTools: true, webSearch: "off",
    extensions: { hooks, toolHooks: new ExtensionToolHooks(new AbortController().signal), signal: new AbortController().signal,
      eventPublisher: () => undefined, active: true } as unknown as Parameters<typeof runAgentLoop>[0]["extensions"] }));
  expect(events.some(event => event.type === "error" && event.message.includes("unchanged registered"))).toBe(true);
  const hookAttempt = new ExtensionHooks(new AbortController().signal);
  hookAttempt.beforeModel("test", request => ({ ...request, hostedTools: ["web_search"] }) as unknown as typeof request);
  const session2 = createSession([{ type: "user", id: "u2", content: [{ type: "text", text: "hook" }] }]);
  const events2 = await collect(runAgentLoop({ session: session2, model: createScriptedModel({ text: "done" }),
    contextManager: manager, tools: registry, workspace, exactTools: true, webSearch: "off",
    extensions: { hooks: hookAttempt, toolHooks: new ExtensionToolHooks(new AbortController().signal), signal: new AbortController().signal,
      eventPublisher: () => undefined, active: true } as unknown as Parameters<typeof runAgentLoop>[0]["extensions"] }));
  expect(events2.some(event => event.type === "error" && event.message.includes("unsupported field"))).toBe(true);
  const toolHooks = new ExtensionToolHooks(new AbortController().signal);
  toolHooks.beforeTool("test", input => ({ arguments: { ...(input.arguments as Record<string, unknown>), path: "mutated.txt" } }));
  const seen: unknown[] = [];
  const session3 = createSession([{ type: "user", id: "u3", content: [{ type: "text", text: "hook args" }] }]);
  await collect(runAgentLoop({ session: session3, model: createScriptedModel({ responses: [
    { toolCalls: [{ id: "p", name: "read_note", arguments: { path: "original.txt" } }] }, { text: "done" },
  ] }), contextManager: manager, tools: registry, workspace, exactTools: true, webSearch: "off",
    extensions: { hooks: new ExtensionHooks(new AbortController().signal),
      toolHooks, signal: new AbortController().signal, eventPublisher: () => undefined, active: true } as unknown as Parameters<typeof runAgentLoop>[0]["extensions"],
    approval: { interactive: false, mode: () => { seen.push("checked"); return "read-only"; } } }));
  const result = session3.items.find(item => item.type === "tool_result");
  expect(result).toMatchObject({ type: "tool_result", isError: false });
  expect((result as unknown as { content: string }).content).toBe("read:mutated.txt");
  expect(seen.length).toBeGreaterThan(0);
  const mutating = createToolRegistry([{ name: "mut", description: "mut", execution: "exclusive" as const,
    effect: "mutating" as const, inputSchema: { type: "object", additionalProperties: false },
    async execute() { throw new Error("must not run"); } }]);
  const session4 = createSession([{ type: "user", id: "u4", content: [{ type: "text", text: "deny" }] }]);
  await collect(runAgentLoop({ session: session4, model: createScriptedModel({ responses: [
    { toolCalls: [{ id: "m", name: "mut", arguments: {} }] }, { text: "done" },
  ] }), contextManager: manager, tools: mutating, workspace, exactTools: true, webSearch: "off",
    approval: { interactive: false, mode: () => "read-only" } }));
  expect(session4.items.find(item => item.type === "tool_result")).toMatchObject({ isError: true });
});

test("selected-provider bodies carry no hosted search even where an allowlist would admit it", async () => {
  const bodies: string[] = [];
  const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: "https://xai.test/v1",
    fetch: async (_url, init) => { bodies.push(String(init!.body)); return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } }); } });
  const workspace = { root: "/tmp/policy", launchCwd: "/tmp/policy", extraRoots: [] as string[] };
  const allowlist = [{ provider: "xai" as const, route: "api-key" as const, model: "grok-4.7", tool: "web_search" as const, evidence: "protocol fixture" }];
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "hello" }] }]);
  await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace),
    tools: createToolRegistry([readTool]), workspace, webSearch: "off", exactTools: true }, { hostedToolAllowlist: allowlist }));
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0]!).tools).toEqual([expect.objectContaining({ type: "function", name: "read" })]);
  const summaryBodies: string[] = [];
  const summaryModel = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: "https://xai.test/v1",
    fetch: async (_url, init) => { summaryBodies.push(String(init!.body)); return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } }); } });
  const summarySession = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "hello" }] }]);
  await collect(runAgentLoop({ session: summarySession, model: summaryModel, contextManager: createContextManager(workspace),
    tools: createToolRegistry([]), workspace, webSearch: "off", exactTools: true }, { hostedToolAllowlist: allowlist }));
  for (const body of [...bodies, ...summaryBodies]) expect(body).not.toContain("web_search");
});

test("relative tool paths keep primary-workspace-root semantics under exact policy", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    expect(resolveToolPath(config.workspaceRoot, "notes/a.md")).toBe(join(await realpath(config.workspaceRoot), "notes/a.md"));
    const host = await createHost({ ...config, tools: { policy: "exact", hostedLookup: "off", definitions: [{
      name: "show_path", description: "Show resolved path", execution: "parallel" as const, effect: "read-only" as const,
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      async execute(input, ctx) { return { content: resolveToolPath(ctx.workspace.root, (input as { path: string }).path) }; },
    }] } });
    const session = await host.createSession();
    const result = await session.submit({ text: "resolve" }, createScriptedModel({ responses: [
      { toolCalls: [{ id: "p", name: "show_path", arguments: { path: "notes/a.md" } }] }, { text: "done" },
    ] }));
    expect(result.outcome).toBe("completed");
    await session.close(); await host.close();
  });
});
