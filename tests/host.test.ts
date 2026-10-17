import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHost, hostCapabilities, HostError, type HostOptions, type HostSessionReference, type HostEntryReference } from "schway/host";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "workspace-discovery", systemPrompt: "Trusted fixture operator", sections: [{ name: "host-evidence", content: "fixture-source" }] },
    tools: { policy: "include-skill-activation", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 } };
}

async function externalConsumer(dir: string, input: { options: HostOptions; reference?: HostSessionReference; previous?: HostEntryReference; discovery?: boolean }) {
  const consumer = join(dir, "consumer");
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  try { await symlink(resolve(import.meta.dir, ".."), join(consumer, "node_modules/schway"), "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const script = join(consumer, "consumer.ts");
  await Bun.write(script, await Bun.file(join(import.meta.dir, "fixtures/host-consumer.ts")).text());
  const guard = join(consumer, "guard.ts");
  await Bun.write(guard, `await Bun.plugin({name:'host-import-guard',setup(builder) {
    builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/}, () => { throw new Error('Forbidden provider or TUI initialization'); });
    ${input.discovery ? "builder.onLoad({filter:/[/\\\\]src[/\\\\](?:agent|context|session|tools)[/\\\\]/},()=>{throw new Error('Discovery loaded runtime composition');});" : ""}
  }});`);
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guard, script], { cwd: consumer,
    env: buildIsolatedCliEnv(input.options.homeDirectory), stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0); expect(stderr).toBe("");
  return JSON.parse(stdout);
}

test("public import and static capabilities initialize no runtime, TUI or provider and make no inference claims", async () => {
  await withTempDir(async dir => {
    const result = await externalConsumer(dir, { options: await options(dir), discovery: true });
    expect(result).toEqual(hostCapabilities());
    expect(result.contract).toBe("schway.host.base/v1");
    expect(result.observedInference).toBe("not-checked");
  });
});

test("disposable external public-only consumer runs native tools, persists a result and reopens in a fresh process", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const first = await externalConsumer(dir, { options: config });
    expect(first.result.outcome).toBe("completed");
    expect(first.result.message.content).toEqual([{ type: "text", text: "persisted" }]);
    expect(first.calls).toBe(2); expect(first.executions).toBe(1);
    const reopened = await externalConsumer(dir, { options: config, reference: first.reference, previous: first.result.result });
    expect(reopened.reference).toEqual(first.reference);
    expect(reopened.previous).toEqual(first.result.message);
    expect(reopened.result.message.content).toEqual([{ type: "text", text: "continued" }]);
    expect(reopened.executions).toBe(0);
    const jsonl = await readFile(join(config.sessionDirectory, `${first.reference.id}.jsonl`), "utf8");
    expect(JSON.parse(jsonl.split("\n")[0]!).version).toBe(4);
    expect(jsonl).toContain(first.result.result.entryId);
  });
});

test("malformed options and unsupported requested restrictions fail before a session or model call", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    for (const altered of [
      { ...config, context: { ...config.context, policy: "strict" } },
      { ...config, tools: { ...config.tools, policy: "exact" } },
      { ...config, context: { ...config.context, skills: false } },
      { ...config, limits: { ...config.limits, maxTurns: Infinity } },
      { ...config, limits: { ...config.limits, maxConcurrentTools: 0 } },
      { ...config, workspaceRoot: "." },
    ]) await expect(createHost(altered as HostOptions)).rejects.toBeInstanceOf(HostError);
    expect(await Bun.file(join(config.sessionDirectory, "not-created")).exists()).toBe(false);
  });
});

test("base policy is explicit about discovered context and implicit skill activation", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    await Bun.write(join(config.workspaceRoot, "AGENTS.md"), "Trusted workspace fixture instructions");
    await Bun.write(join(config.homeDirectory, ".schway/SYSTEM.md"), "Home prompt must not replace explicit operator");
    const host = await createHost(config), session = await host.createSession();
    const result = await session.submit({ text: "show policy" }, createScriptedModel({ responses: [request => {
      expect(request.systemPrompt).toBe("Trusted fixture operator");
      expect(request.context.some(s => s.name === "project-instructions" && s.content.includes("Trusted workspace fixture"))).toBe(true);
      expect(request.context.some(s => s.name === "host-evidence")).toBe(true);
      expect(request.tools?.map(t => t.name)).toEqual(["activate_skill"]);
      return { text: "base behavior" };
    }] }));
    expect(result.outcome).toBe("completed");
    await host.close();
    await expect(session.submit({ text: "closed" }, createScriptedModel())).rejects.toMatchObject({ code: "closed" });
  });
});

test("input persists before inference; failed writes produce no model calls or false result", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    let calls = 0;
    const model = createScriptedModel({ responses: [request => {
      calls++;
      expect(request.items.at(-1)).toMatchObject({ type: "user", content: [{ type: "text", text: "durable first" }] });
      return { text: "ok" };
    }] });
    const first = await session.submit({ text: "durable first" }, model);
    expect(first.outcome).toBe("completed"); expect(calls).toBe(1);
    await rename(config.sessionDirectory, `${config.sessionDirectory}-unavailable`);
    await expect(session.submit({ text: "must not infer" }, model)).rejects.toMatchObject({ code: "storage" });
    expect(calls).toBe(1);
    await host.close();
  });
});

test("busy handles conflict in process; idle close releases exact references and returned results are detached", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), other = await createHost(config);
    const session = await host.createSession();
    await expect(other.openSession(session.reference)).rejects.toMatchObject({ code: "busy" });
    const controller = new AbortController();
    const pending = session.submit({ text: "wait" }, createScriptedModel({ waitForAbort: true }), controller.signal);
    await expect(session.submit({ text: "competing" }, createScriptedModel())).rejects.toMatchObject({ code: "busy" });
    await expect(session.close()).rejects.toMatchObject({ code: "busy" });
    await expect(host.close()).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
    const completed = await session.submit({ text: "after cancel" }, createScriptedModel({ text: "stable" }));
    if (completed.outcome !== "completed") throw new Error("Expected completion");
    completed.message.content[0] = { type: "text", text: "tamper" };
    expect(session.readResult(completed.result).content).toEqual([{ type: "text", text: "stable" }]);
    await session.close();
    const reopened = await other.openSession(session.reference);
    expect(reopened.readResult(completed.result).content).toEqual([{ type: "text", text: "stable" }]);
    await other.close(); await host.close();
  });
});

test("failed and round-limited native runs return no final assistant reference", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    config.limits.maxTurns = 1;
    const host = await createHost(config), session = await host.createSession();
    const failed = await session.submit({ text: "fail" }, createScriptedModel({ error: "fixture authentication rejected", status: 401 }));
    expect(failed.outcome).toBe("error"); expect("result" in failed).toBe(false);
    const limited = await session.submit({ text: "one round" }, createScriptedModel({ toolCalls: [{ id: "unknown-tool", name: "not_registered", arguments: {} }] }));
    expect(limited.outcome).toBe("max_turns"); expect("result" in limited).toBe(false);
    await expect(host.openSession({ id: "../escape", branchId: "main" })).rejects.toMatchObject({ code: "invalid-reference" });
    await host.close();
  });
});

for (const scenario of ["torn-tail", "interrupted-call", "attached-root"] as const) {
  test(`wrong managed identity rejects before ${scenario} recovery can mutate native bytes`, async () => {
    await withTempDir(async dir => {
      const config = await options(join(dir, "owner"));
      if (scenario === "interrupted-call") config.tools.definitions = [{ name: "interrupt_storage", description: "Fixture storage failure",
        execution: "exclusive", effect: "mutating", inputSchema: { type: "object" },
        async execute() { await rename(config.sessionDirectory, `${config.sessionDirectory}-offline`); return { content: "never committed" }; } }];
      const host = await createHost(config), session = await host.createSession();
      const run = await session.submit({ text: "fixture input" }, createScriptedModel(scenario === "interrupted-call"
        ? { toolCalls: [{ id: "interrupted", name: "interrupt_storage", arguments: {} }] } : { text: "persisted" }));
      if (scenario === "interrupted-call") {
        expect(run.outcome).toBe("error");
        await rename(`${config.sessionDirectory}-offline`, config.sessionDirectory);
      }
      const reference = session.reference;
      await session.close();
      const path = join(config.sessionDirectory, `${reference.id}.jsonl`);
      if (scenario === "attached-root") {
        // Deliberately malformed managed-store fixture; production hosts never rewrite JSONL.
        const lines = (await readFile(path, "utf8")).split("\n");
        lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), extraRoots: [config.homeDirectory] });
        await Bun.write(path, lines.join("\n"));
      }
      if (scenario !== "interrupted-call") await appendFile(path, "{torn");
      const before = await readFile(path);
      const other = await options(join(dir, "other"));
      const foreign = await createHost({ ...other, sessionDirectory: config.sessionDirectory,
        ...(scenario === "attached-root" ? { workspaceRoot: config.workspaceRoot } : {}) });
      await expect(foreign.openSession(reference)).rejects.toMatchObject({ code: "workspace-mismatch" });
      expect(await readFile(path)).toEqual(before);
      await foreign.close();
      if (scenario !== "attached-root") {
        const recovered = await host.openSession(reference);
        if (run.outcome === "completed") expect(recovered.readResult(run.result)).toEqual(run.message);
        else expect((await recovered.submit({ text: "after native recovery" }, createScriptedModel({ text: "recovered" }))).outcome).toBe("completed");
        await recovered.close();
      }
      await host.close();
    });
  });
}
