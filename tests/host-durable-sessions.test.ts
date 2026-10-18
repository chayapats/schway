import { expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rename, symlink, unlink, link, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHost, hostCapabilities, HostError, type HostOptions, type HostSessionReference, type Model } from "schway/host";
import { createJsonlSession } from "../src/session/jsonl.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Immutable operator", sections: [], sources: [{ id: "evidence", revision: "v1", content: "inert evidence" }] },
    tools: { policy: "include-skill-activation", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 } };
}

async function consumer(dir: string, input: { options: HostOptions; reference: HostSessionReference; action: "hold" | "crash-tool" | "continue" | "fault-input" | "fault-provider" | "fault-tool"; effectPath?: string }) {
  const location = join(dir, crypto.randomUUID());
  await mkdir(join(location, "node_modules"), { recursive: true });
  await symlink(resolve(import.meta.dir, ".."), join(location, "node_modules/schway"), "dir");
  await Bun.write(join(location, "consumer.ts"), await Bun.file(join(import.meta.dir, "fixtures/host-durable-consumer.ts")).text());
  const child = Bun.spawn([process.execPath, "--no-env-file", join(location, "consumer.ts")], { cwd: location,
    env: buildIsolatedCliEnv(input.options.homeDirectory), stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let pending = "";
  return { child, async next() {
    while (!pending.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Consumer ended: ${await new Response(child.stderr).text()}`);
      pending += new TextDecoder().decode(chunk.value);
    }
    const newline = pending.indexOf("\n"), line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    return JSON.parse(line);
  }, async stop() { child.kill("SIGKILL"); await child.exited; reader.releaseLock(); } };
}

test("durable contract admits exactly one canonical session owner across simultaneous external consumers", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const reference = session.reference; await host.close();
    const alias = join(dir, "session-alias"); await symlink(config.sessionDirectory, alias, "dir");
    const pair = await Promise.all([consumer(dir, { options: config, reference, action: "hold" }),
      consumer(dir, { options: { ...config, sessionDirectory: alias }, reference, action: "hold" })]);
    try {
      const results = await Promise.all(pair.map(worker => worker.next()));
      expect(results.map(r => r.state).sort()).toEqual(["accepted", "rejected"]);
      expect(results.find(r => r.state === "rejected")).toMatchObject({ code: "busy", calls: 0, executions: 0 });
      const saved = await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8");
      expect(saved.match(/external accepted input/g)?.length).toBe(1);
      expect(hostCapabilities().sessionContract).toBe("schway.host.durable-sessions/v1");
    } finally { await Promise.all(pair.map(worker => worker.stop())); }
    // The killed owner is positively stopped, so a fresh process may reclaim its exact ancestry.
    const resumed = await consumer(dir, { options: config, reference, action: "continue" });
    try { expect(await resumed.next()).toMatchObject({ state: "finished", calls: 1, executions: 0, reference }); }
    finally { await resumed.stop(); }
  });
});

test("two host handles race before a second input is accepted; independent specialists stay isolated", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), first = await createHost(config), second = await createHost(config);
    const seed = await first.createSession(), reference = seed.reference; await seed.close();
    const results = await Promise.allSettled([first.openSession(reference), second.openSession(reference)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "busy" } });
    const owned = results.find(r => r.status === "fulfilled")!;
    if (owned.status !== "fulfilled") throw new Error("Missing owner");
    const independent = await second.createSession();
    const runs = await Promise.all([owned.value.submit({ text: "specialist A" }, createScriptedModel({ text: "answer A" })),
      independent.submit({ text: "specialist B" }, createScriptedModel({ text: "answer B" }))]);
    expect(owned.value.reference.id).not.toBe(independent.reference.id);
    for (const run of runs) expect(run.outcome).toBe("completed");
    const a = runs[0]!; if (a.outcome !== "completed") throw new Error("Missing result");
    expect(() => independent.readResult(a.result)).toThrow();
    const bFile = await readFile(join(config.sessionDirectory, `${independent.reference.id}.jsonl`), "utf8");
    expect(bFile).not.toContain("specialist A");
    await first.close(); await second.close();
  });
});

test("crash after a non-idempotent tool effect reopens with metadata and one interrupted settlement without replay", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const reference = session.reference; await host.close();
    const effectPath = join(dir, "effects");
    const worker = await consumer(dir, { options: config, reference, action: "crash-tool", effectPath });
    try { expect(await worker.next()).toMatchObject({ state: "effect", reference }); }
    finally { await worker.stop(); }
    const reopened = await consumer(dir, { options: config, reference, action: "continue" });
    try {
      const result = await reopened.next();
      expect(result).toMatchObject({ state: "finished", calls: 1, executions: 0 });
      expect(result.ancestry).toContainEqual(expect.objectContaining({ type: "assistant", providerMetadata: { opaque: "provider-response" },
        content: [{ type: "tool_call", id: "effect-call", name: "effect", arguments: {}, providerMetadata: { opaque: "call-replay" } }] }));
      expect(result.ancestry.filter((item: { type: string }) => item.type === "tool_result")).toEqual([
        expect.objectContaining({ toolCallId: "effect-call", isError: true })]);
      expect(await readFile(effectPath, "utf8")).toBe("effect\n");
      expect(result.run.result.entryId).toBe(result.run.message.id);
    } finally { await reopened.stop(); }
  });
});

test("fresh public consumers reopen the requested sibling ancestry rather than the last active branch", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const native = await createJsonlSession({ directory: config.sessionDirectory, workspace: { root: config.workspaceRoot, launchCwd: config.workspaceRoot, extraRoots: [] } });
    native.append({ type: "user", id: "user-root", content: [{ type: "text", text: "shared" }] },
      { type: "assistant", id: "answer-root", content: [{ type: "text", text: "shared result" }] });
    const sibling = native.forkBranch("answer-root", "specialist");
    native.append({ type: "user", id: "sibling-input", content: [{ type: "text", text: "sibling-only" }] });
    native.selectBranch("main"); native.append({ type: "user", id: "main-input", content: [{ type: "text", text: "main-only" }] });
    for (const branchId of [sibling, "main"]) {
      const worker = await consumer(dir, { options: config, reference: { id: native.header.id, branchId }, action: "continue" });
      try {
        const result = await worker.next();
        expect(result.state).toBe("finished");
        const text = JSON.stringify(result.ancestry);
        expect(text).toContain(branchId === "main" ? "main-only" : "sibling-only");
        expect(text).not.toContain(branchId === "main" ? "sibling-only" : "main-only");
        expect(result.run.result.session.branchId).toBe(branchId);
      } finally { await worker.stop(); }
    }
  });
});

for (const stage of ["before-input", "after-provider", "after-tool"] as const) {
  test(`native failure ${stage} publishes no uncommitted result and reopen never replays effects`, async () => {
    await withTempDir(async dir => {
      const config = await options(dir);
      let effects = 0, calls = 0;
      config.tools.definitions = [{ name: "effect", description: "Move storage after execution", execution: "exclusive", effect: "mutating", inputSchema: { type: "object" },
        async execute() { effects++; await rename(config.sessionDirectory, `${config.sessionDirectory}-offline`); return { content: "effect happened" }; } }];
      const host = await createHost(config), session = await host.createSession(), reference = session.reference;
      const model: Model = { provider: "scripted", id: "failure", async *stream() {
        calls++;
        if (stage === "after-provider") await rename(config.sessionDirectory, `${config.sessionDirectory}-offline`);
        yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: stage === "after-tool"
          ? [{ type: "tool_call", id: "once", name: "effect", arguments: {} }] : [{ type: "text", text: "uncommitted" }] } };
      } };
      if (stage === "before-input") await rename(config.sessionDirectory, `${config.sessionDirectory}-offline`);
      if (stage === "before-input") await expect(session.submit({ text: "not accepted" }, model)).rejects.toMatchObject({ code: "storage" });
      else expect(await session.submit({ text: "accepted" }, model)).toMatchObject({ outcome: "error", input: { session: reference } });
      expect(calls).toBe(stage === "before-input" ? 0 : 1);
      await rename(`${config.sessionDirectory}-offline`, config.sessionDirectory);
      const saved = await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8");
      expect(saved).not.toContain("uncommitted");
      if (stage === "before-input") expect(saved).not.toContain("not accepted");
      await session.close();
      const reopened = await host.openSession(reference);
      expect((await reopened.submit({ text: "continue" }, createScriptedModel({ text: "recovered" }))).outcome).toBe("completed");
      expect(effects).toBe(stage === "after-tool" ? 1 : 0);
      await host.close();
    });
  });
}

test("external branch writes conflict before a result or next request can mix ancestries", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    let calls = 0;
    const model: Model = { provider: "scripted", id: "writer-conflict", async *stream() {
      calls++;
      await appendFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), JSON.stringify({ type: "branch_fork", version: 1,
        branchId: "foreign-branch", headId: session.reference.id }) + "\n");
      yield { type: "message_complete", message: { type: "assistant", id: "must-not-commit", content: [{ type: "text", text: "mixed" }] } };
    } };
    await expect(session.submit({ text: "bound ancestry" }, model)).rejects.toMatchObject({ code: "conflict" });
    await expect(session.submit({ text: "again" }, model)).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toBe(1);
    expect(await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8")).not.toContain("must-not-commit");
    await host.close();
  });
});

test("one accepted run captures model method, options and tools and detaches requests from durable history", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    let effects = 0, calls = 0;
    const tool = { name: "effect", description: "Captured tool", execution: "exclusive" as const, inputSchema: { type: "object" }, async execute() { effects++; return { content: "original" }; } };
    config.tools.definitions = [tool];
    const host = await createHost(config), session = await host.createSession();
    const model: Model = { provider: "scripted", id: "captured", async *stream(request) {
      calls++;
      expect(request.systemPrompt).toBe("Immutable operator");
      expect(request.tools?.map(t => t.name)).toEqual(["effect"]);
      expect(request.items[0]).toMatchObject({ type: "user", content: [{ type: "text", text: "original input" }] });
      (request.items[0] as { content: unknown }).content = [{ type: "text", text: "mutated request" }];
      if (calls === 1) {
        config.context.systemPrompt = "changed"; config.limits.maxTurns = 1;
        tool.execute = async () => { throw new Error("Replaced tool"); };
        model.stream = async function* () { throw new Error("Replaced route"); };
      }
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: calls === 1
        ? [{ type: "tool_call", id: "captured", name: "effect", arguments: {} }] : [{ type: "text", text: "stable" }] } };
    } };
    expect((await session.submit({ text: "original input" }, model)).outcome).toBe("completed");
    expect(calls).toBe(2); expect(effects).toBe(1);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).not.toContain("mutated request");
    await host.close();
  });
});

for (const action of ["fault-input", "fault-provider", "fault-tool"] as const) {
  test(`partial append ${action} repairs only the torn record and never replays an effect`, async () => {
    await withTempDir(async dir => {
      const config = await options(dir), host = await createHost(config), session = await host.createSession();
      const reference = session.reference; await host.close();
      const effectPath = join(dir, "effects");
      const writer = await consumer(dir, { options: config, reference, action, effectPath });
      try {
        const result = await writer.next();
        if (action === "fault-input") expect(result).toMatchObject({ state: "rejected", code: "storage", calls: 0, executions: 0 });
        else expect(result).toMatchObject({ state: "finished", run: { outcome: "error", input: { session: reference } }, calls: 1,
          executions: action === "fault-tool" ? 1 : 0 });
        expect(result.run?.result).toBeUndefined();
      } finally { await writer.stop(); }
      const reopened = await consumer(dir, { options: config, reference, action: "continue" });
      try {
        const result = await reopened.next();
        expect(result).toMatchObject({ state: "finished", run: { outcome: "completed" }, calls: 1, executions: 0 });
        expect(result.ancestry.filter((item: { type: string }) => item.type === "tool_result")).toHaveLength(action === "fault-tool" ? 1 : 0);
        if (action === "fault-tool") expect(await readFile(effectPath, "utf8")).toBe("effect\n");
      } finally { await reopened.stop(); }
    });
  });
}

test("uncertain, live, malformed and abandoned-admission ownership never expires by age", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const reference = session.reference; await session.close();
    const leasePath = join(config.sessionDirectory, `${reference.id}.host-lease`);
    for (const owner of ["{torn", "null", JSON.stringify({ version: 1, host: "another-machine", pid: 123, token: "old" }),
      JSON.stringify({ version: 1, host: (await import("node:os")).hostname(), pid: process.pid, token: "old" })]) {
      await Bun.write(leasePath, owner);
      await expect(host.openSession(reference)).rejects.toMatchObject({ code: "busy" });
      expect(await readFile(leasePath, "utf8")).toBe(owner);
      await unlink(leasePath);
    }
    await mkdir(`${leasePath}.admission`);
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "busy" });
    await host.close();
  });
});

test("lost writer token conflicts before inference and close preserves replacement ownership", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const path = join(config.sessionDirectory, `${session.reference.id}.host-lease`);
    const replacement = JSON.stringify({ version: 1, host: "replacement", pid: process.pid, token: "replacement" });
    await Bun.write(path, replacement);
    let calls = 0;
    await expect(session.submit({ text: "must not accept" }, createScriptedModel({ responses: [() => { calls++; return { text: "bad" }; }] })))
      .rejects.toMatchObject({ code: "conflict" });
    expect(calls).toBe(0);
    expect(await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8")).not.toContain("must not accept");
    await host.close();
    expect(await readFile(path, "utf8")).toBe(replacement);
  });
});

test("session file symlinks and hard links cannot bypass ownership through a different store", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), owner = await createHost(config), session = await owner.createSession();
    const source = join(config.sessionDirectory, `${session.reference.id}.jsonl`);
    for (const alias of [symlink, link]) {
      const directory = join(dir, crypto.randomUUID()); await mkdir(directory);
      const target = join(directory, `${session.reference.id}.jsonl`);
      await alias(source, target);
      const other = await createHost({ ...config, sessionDirectory: directory });
      await expect(other.openSession(session.reference)).rejects.toMatchObject({ code: "conflict" });
      await unlink(target); await other.close();
    }
    expect((await session.submit({ text: "still exclusive" }, createScriptedModel({ text: "ok" }))).outcome).toBe("completed");
    await owner.close();
  });
});

test.skipIf(process.getuid?.() === 0)("lease release I/O failure leaves host close retryable", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config);
    await host.createSession();
    await chmod(config.sessionDirectory, 0o500);
    try { await expect(host.close()).rejects.toMatchObject({ code: "storage" }); }
    finally { await chmod(config.sessionDirectory, 0o700); }
    await host.close();
    const reopened = await createHost(config); await reopened.close();
  });
});

for (const changed of ["file", "ownership"] as const) {
  test(`explicit compaction preserves typed ${changed} conflicts raised after summary inference`, async () => {
    await withTempDir(async dir => {
      const config = await options(dir), host = await createHost(config), session = await host.createSession();
      try {
        for (let turn = 0; turn < 12; turn++) {
          expect((await session.submit({ text: `retained ${turn}` }, createScriptedModel({ text: "retained output" }))).outcome).toBe("completed");
        }
        const path = join(config.sessionDirectory, `${session.reference.id}.jsonl`);
        const before = await readFile(path, "utf8");
        let calls = 0;
        const model: Model = { provider: "scripted", id: "summary-conflict", async *stream() {
          calls++;
          if (changed === "file") await appendFile(path, "\n");
          else {
            const leasePath = join(config.sessionDirectory, `${session.reference.id}.host-lease`);
            const owner = JSON.parse(await readFile(leasePath, "utf8"));
            await Bun.write(leasePath, JSON.stringify({ ...owner, token: "replacement-owner" }));
          }
          yield { type: "message_complete", message: { type: "assistant", id: "uncommitted-summary",
            content: [{ type: "text", text: "summary must not be committed" }] } };
        } };
        const pending = session.compact(model);
        await expect(pending).rejects.toBeInstanceOf(HostError);
        await expect(pending).rejects.toMatchObject({ code: "conflict" });
        expect(calls).toBe(1);
        expect(await readFile(path, "utf8")).toBe(before + (changed === "file" ? "\n" : ""));
        await expect(session.submit({ text: "must remain fenced" }, createScriptedModel())).rejects.toMatchObject({ code: "conflict" });
      } finally { await host.close(); }
    });
  });
}

test("malformed lease tokens stay busy even when their owner process is positively stopped", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const reference = session.reference; await session.close();
    const stopped = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    expect(await stopped.exited).toBe(0);
    const owner = { version: 1, host: (await import("node:os")).hostname(), pid: stopped.pid };
    const leasePath = join(config.sessionDirectory, `${reference.id}.host-lease`);
    const path = join(config.sessionDirectory, `${reference.id}.jsonl`), before = await readFile(path, "utf8");
    try {
      for (const token of [undefined, null, false, 42, {}, [], "", " ", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
        const saved = JSON.stringify({ ...owner, token });
        await Bun.write(leasePath, saved);
        await expect(host.openSession(reference)).rejects.toMatchObject({ code: "busy" });
        expect(await readFile(leasePath, "utf8")).toBe(saved);
        expect(await readFile(path, "utf8")).toBe(before);
      }
      await Bun.write(leasePath, JSON.stringify({ ...owner, token: crypto.randomUUID() }));
      const reopened = await host.openSession(reference);
      expect(reopened.reference).toEqual(reference);
      await reopened.close();
    } finally { await host.close(); }
  });
});
