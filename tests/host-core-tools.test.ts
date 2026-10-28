import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CORE_TOOLS_CONTRACT, coreToolDefinitions, createHost, hostCapabilities, localExecutionBackend,
  type ExecutionSpawnResult, type HostOptions, type ToolDefinition,
} from "schway/host";
import { bashTool, MAX_BASH_BYTES } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { executeToolCall } from "../src/tools/executor.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { runParityFixtures } from "./fixtures/core-tools-parity.ts";
import { memoryBackend } from "./helpers/memory-backend.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

const repo = resolve(import.meta.dir, "..");
const ctx = (root = "/host/workspace") => ({ workspace: { root, launchCwd: root, extraRoots: [] } });
const byName = (definitions: readonly ToolDefinition[]) => Object.fromEntries(definitions.map(tool => [tool.name, tool]));

test("core definitions equal the CLI core tools in schema, description, scheduling and effect", () => {
  const cli = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool];
  const shape = (tool: ToolDefinition) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execution: tool.execution, effect: tool.effect,
  });
  const local = coreToolDefinitions(localExecutionBackend("/tmp"));
  expect(local.map(shape)).toEqual(cli.map(shape));
  expect(coreToolDefinitions(memoryBackend().backend).map(shape)).toEqual(cli.map(shape));
  for (const tool of local) expect(Object.keys(tool).sort()).toEqual(["description", "effect", "execute", "execution", "inputSchema", "name"]);
});

test("CLI tools and the local backend reproduce the pre-backend golden byte for byte", async () => {
  const golden = JSON.parse(await readFile(join(import.meta.dir, "fixtures/core-tools-golden.json"), "utf8"));
  expect(await runParityFixtures("cli")).toEqual(golden);
  expect(await runParityFixtures("host")).toEqual(golden);
}, 30_000);

test("bash through a fake backend cuts 120 KB Thai/ASCII stdout at a code point and spills through the backend", async () => {
  const unit = "ASCII ภาษาไทย 🙂\n";
  const stdout = unit.repeat(Math.ceil(120_000 / utf8ByteLength(unit)));
  const memory = memoryBackend({ spawn: async () => ({ stdout, stderr: "warn ไทย\n", exitCode: 0, timedOut: false }) });
  const tools = byName(coreToolDefinitions(memory.backend));
  const result = await tools.bash!.execute({ command: "produce" }, ctx());
  const details = result.details as { stdout: string; stderr: string; outputPath: string; shownBytes: number; totalBytes: number; truncated: boolean };
  expect(details.truncated).toBe(true);
  expect(utf8ByteLength(details.stdout)).toBeLessThanOrEqual(MAX_BASH_BYTES);
  expect(utf8ByteLength(details.stdout)).toBeGreaterThan(MAX_BASH_BYTES - 4);
  expect(stdout.startsWith(details.stdout)).toBe(true);
  expect(details.stdout).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(details.stderr).toBe("");
  expect(details.outputPath).toMatch(/^\/tmp\/schway-bash-[0-9a-f-]{36}\.log$/);
  expect(memory.calls.filter(call => call.op === "writePrivateFile")).toEqual([{ op: "writePrivateFile", target: details.outputPath }]);
  expect(memory.text(details.outputPath)).toBe(`stdout:\n${stdout}\nstderr:\nwarn ไทย\n\n`);
  expect(result.content.endsWith(`\n\n[Output truncated: showing ${details.shownBytes} of ${details.totalBytes} bytes. Full output: ${details.outputPath}. Use read with offset to see the rest.]`)).toBe(true);
  expect(details.totalBytes).toBe(utf8ByteLength(stdout) + utf8ByteLength("warn ไทย\n"));
  expect(result.isError).toBeUndefined();

  // The notice is actionable: read opens the spill through the same backend, outside the workspace root.
  const spill = await tools.read!.execute({ path: details.outputPath, offset: 2, limit: 1 }, ctx());
  expect(spill.content).toStartWith("     2|ASCII ภาษาไทย 🙂\n... truncated: ");
  expect(spill.isError).toBeUndefined();
  const other = await tools.read!.execute({ path: "/tmp/other.log" }, ctx());
  expect(other).toMatchObject({ content: "Path is outside the workspace: /tmp/other.log", isError: true });
});

test("a non-zero exit is result data and output bounds hold for every backend", async () => {
  const memory = memoryBackend({
    spawn: async () => ({ stdout: "", stderr: "😀".repeat(20_000), exitCode: 7, timedOut: false }),
    files: { "thai.txt": `${"ไทย🙂".repeat(10_000)}\nnext\n` },
  });
  const tools = byName(coreToolDefinitions(memory.backend));
  const failed = await tools.bash!.execute({ command: "exit 7" }, ctx());
  expect(failed.isError).toBeUndefined();
  expect(failed.content.startsWith("Exit code: 7\n\nstderr:\n")).toBe(true);
  const details = failed.details as { stderr: string; exitCode: number };
  expect(details.exitCode).toBe(7);
  expect(utf8ByteLength(details.stderr)).toBe(MAX_BASH_BYTES);
  expect([...details.stderr].every(character => character === "😀")).toBe(true);
  const read = await tools.read!.execute({ path: "thai.txt" }, ctx());
  const firstLine = read.content.split("\n")[0]!;
  expect(utf8ByteLength(firstLine)).toBeLessThanOrEqual(MAX_BASH_BYTES);
  expect(firstLine).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(read.content).toContain("... truncated: 1 lines remaining. Use offset=2 to continue.");
});

test("edit with a stale observation reports today's conflict and writes nothing", async () => {
  let interfere = true;
  const memory = memoryBackend({
    files: { "notes.txt": "alpha\nbeta\n" },
    afterObserve: path => { if (interfere) { interfere = false; memory.setFile(path, "alpha\nbeta\nconcurrent\n"); } },
  });
  const tools = byName(coreToolDefinitions(memory.backend));
  const result = await tools.edit!.execute({ path: "notes.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, ctx());
  expect(result).toEqual({
    content: "File changed before replacement: /workspace/notes.txt",
    isError: true,
    details: { path: "notes.txt", resolvedPath: "/workspace/notes.txt" },
  });
  expect(memory.text("/workspace/notes.txt")).toBe("alpha\nbeta\nconcurrent\n");

  // The same stale edit through the local backend produces the same model-visible error.
  await withTempDir(async dir => {
    const root = await realpath(dir);
    await writeFile(join(root, "notes.txt"), "alpha\nbeta\n");
    const local = localExecutionBackend(root);
    const observeFile = local.observeFile.bind(local);
    const raced = { ...local, observeFile: async (...args: Parameters<typeof observeFile>) => {
      const observed = await observeFile(...args);
      await writeFile(join(root, "notes.txt"), "alpha\nbeta\nconcurrent\n");
      return observed;
    } };
    const edited = await byName(coreToolDefinitions(raced)).edit!.execute({ path: "notes.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, ctx(root));
    expect(edited).toEqual({ content: `File changed before replacement: ${join(root, "notes.txt")}`, isError: true,
      details: { path: "notes.txt", resolvedPath: join(root, "notes.txt") } });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("alpha\nbeta\nconcurrent\n");
  });
});

test("traversal is refused before any backend call and symlink escapes before any read, write or spawn", async () => {
  const memory = memoryBackend({
    files: { "inside.txt": "ok\n", "/etc/passwd": "root:x:0:0\n" },
    links: { "/workspace/escape": "/etc", "/workspace/passwd-link": "/etc/passwd", "/workspace/inner": "/workspace/sub" },
  });
  memory.setFile("/workspace/sub/file.txt", "inner\n");
  const tools = byName(coreToolDefinitions(memory.backend));
  for (const [tool, input] of [
    ["read", { path: "../../etc/passwd" }], ["read", { path: "/etc/passwd" }], ["write", { path: "../outside.txt", content: "x" }],
    ["edit", { path: "../../etc/passwd", edits: [{ oldText: "root", newText: "x" }] }], ["ls", { path: ".." }],
    ["find", { pattern: "*", path: "../etc" }], ["grep", { pattern: "root", path: "/etc" }], ["bash", { command: "id", cwd: ".." }],
  ] as Array<[string, { path?: string; cwd?: string }]>) {
    const result = await tools[tool]!.execute(input, ctx());
    expect(result).toMatchObject({ content: `Path is outside the workspace: ${input.path ?? input.cwd}`, isError: true });
  }
  expect(memory.calls).toEqual([]);

  for (const [tool, input] of [
    ["read", { path: "passwd-link" }], ["read", { path: "escape/passwd" }], ["write", { path: "escape/new.txt", content: "x" }],
    ["edit", { path: "passwd-link", edits: [{ oldText: "root", newText: "x" }] }], ["ls", { path: "escape" }],
    ["find", { pattern: "*", path: "escape" }], ["grep", { pattern: "root", path: "escape" }], ["bash", { command: "id", cwd: "escape" }],
  ] as Array<[string, unknown]>) {
    const result = await tools[tool]!.execute(input, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("Path is outside the workspace: ");
  }
  expect(new Set(memory.calls.map(call => call.op))).toEqual(new Set(["realpath"]));
  expect(memory.text("/etc/passwd")).toBe("root:x:0:0\n");
  expect(memory.text("/etc/new.txt")).toBeUndefined();

  memory.calls.length = 0;
  expect(await tools.read!.execute({ path: "inner/file.txt" }, ctx())).toMatchObject({ content: "     1|inner" });
  expect((await tools.write!.execute({ path: "inner/deep/new.txt", content: "ok" }, ctx())).isError).toBeUndefined();
  expect(memory.text("/workspace/sub/deep/new.txt")).toBe("ok");
});

test("local backend refuses traversal and real symlink escapes before touching the outside file", async () => {
  await withTempDir(async dir => {
    const base = await realpath(dir);
    const root = join(base, "work"), outside = join(base, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(root, "escape"));
    const tools = byName(coreToolDefinitions(localExecutionBackend(root)));
    expect(await tools.read!.execute({ path: "../outside/secret.txt" }, ctx(root))).toMatchObject({ isError: true, content: "Path is outside the workspace: ../outside/secret.txt" });
    expect(await tools.read!.execute({ path: "escape/secret.txt" }, ctx(root))).toMatchObject({ isError: true, content: "Path is outside the workspace: escape/secret.txt" });
    expect(await tools.write!.execute({ path: "escape/secret.txt", content: "changed" }, ctx(root))).toMatchObject({ isError: true });
    expect(await tools.write!.execute({ path: "escape/new/file.txt", content: "changed" }, ctx(root))).toMatchObject({ isError: true });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
    expect(await Bun.file(join(outside, "new/file.txt")).exists()).toBe(false);
    // The CLI keeps its unconfined behavior.
    expect(await readTool.execute({ path: "escape/secret.txt" }, ctx(root))).toMatchObject({ content: "     1|secret" });
  });
});

test("an aborted signal reaches spawn, the call settles cancelled and a late result is not published", async () => {
  let release!: (result: ExecutionSpawnResult) => void;
  let observed: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  const memory = memoryBackend({
    spawn: request => {
      observed = request.signal;
      started.resolve();
      // A backend that ignores cancellation and resolves later must not have its result published.
      return new Promise(resolve => { release = resolve; });
    },
  });
  const registry = createToolRegistry(coreToolDefinitions(memory.backend));
  const controller = new AbortController();
  const pending = executeToolCall({
    registry, call: { type: "tool_call", id: "b1", name: "bash", arguments: { command: "sleep 60" } },
    workspace: ctx().workspace, signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  expect(observed?.aborted).toBe(true);
  release({ stdout: "late output", stderr: "", exitCode: 0, timedOut: false });
  const settled = await pending;
  expect(settled.status).toBe("cancelled");
  expect(settled.result.content).toBe("Tool call cancelled");
  expect(JSON.stringify(settled)).not.toContain("late output");

  const rejecting = memoryBackend({ spawn: request => new Promise((_, reject) => {
    request.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }) });
  const second = new AbortController();
  const call = executeToolCall({
    registry: createToolRegistry(coreToolDefinitions(rejecting.backend)),
    call: { type: "tool_call", id: "b2", name: "bash", arguments: { command: "sleep 60" } }, workspace: ctx().workspace, signal: second.signal,
  });
  await Bun.sleep(1);
  second.abort();
  expect((await call).status).toBe("cancelled");
});

test("host env option replaces the per-call environment and invalid backends fail with invalid-options", async () => {
  const seen: unknown[] = [];
  const memory = memoryBackend({ spawn: async request => { seen.push(request.env); return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; } });
  await byName(coreToolDefinitions(memory.backend, { env: { PATH: "/usr/bin" } })).bash!.execute({ command: "env" }, { ...ctx(), env: { SECRET: "x" } });
  await byName(coreToolDefinitions(memory.backend)).bash!.execute({ command: "env" }, ctx());
  expect(seen).toEqual([{ PATH: "/usr/bin" }, undefined]);
  expect(() => coreToolDefinitions({ ...memory.backend, workspaceRoot: "relative" })).toThrow(expect.objectContaining({ code: "invalid-options" }));
  expect(() => coreToolDefinitions({ ...memory.backend, spawn: undefined } as never)).toThrow(expect.objectContaining({ code: "invalid-options" }));
  expect(() => coreToolDefinitions(memory.backend, { env: { A: 1 } } as never)).toThrow(expect.objectContaining({ code: "invalid-options" }));
  expect(() => localExecutionBackend("relative/root")).toThrow(expect.objectContaining({ code: "invalid-options" }));
});

async function hostOptions(dir: string, definitions: readonly ToolDefinition[]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Operator", sections: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions },
    limits: { maxTurns: 4, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 } };
}

test("core tools are admitted only when passed explicitly; unadmitted bash executes nothing", async () => {
  await withTempDir(async dir => {
    const memory = memoryBackend();
    coreToolDefinitions(memory.backend);
    const host = await createHost(await hostOptions(dir, []));
    const session = await host.createSession();
    const result = await session.submit({ text: "run" }, createScriptedModel({ responses: [
      request => { expect(request.tools ?? []).toEqual([]); return { toolCalls: [{ id: "b", name: "bash", arguments: { command: "id" } }] }; },
      request => {
        const results = request.items.filter(item => item.type === "tool_result");
        expect(results).toEqual([expect.objectContaining({ content: "Unknown tool: bash", isError: true })]);
        return { text: "held" };
      },
    ] }));
    expect(result.outcome).toBe("completed");
    expect(memory.calls).toEqual([]);
    await session.close(); await host.close();
  });
});

test("admitted core tools run bash and write through the backend in a host run", async () => {
  await withTempDir(async dir => {
    const memory = memoryBackend({ spawn: async request => ({ stdout: `ran ${request.command} in ${request.cwd}\n`, stderr: "", exitCode: 0, timedOut: false }) });
    const host = await createHost(await hostOptions(dir, coreToolDefinitions(memory.backend)));
    const session = await host.createSession();
    const result = await session.submit({ text: "go" }, createScriptedModel({ responses: [
      request => {
        expect(request.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
        return { toolCalls: [{ id: "b", name: "bash", arguments: { command: "make" } }, { id: "w", name: "write", arguments: { path: "out/report.md", content: "done\n" } }] };
      },
      request => {
        const results = request.items.filter(item => item.type === "tool_result");
        expect(results).toEqual([
          expect.objectContaining({ toolCallId: "b", content: "Exit code: 0\n\nstdout:\nran make in /workspace\n", isError: false }),
          expect.objectContaining({ toolCallId: "w", content: "Wrote out/report.md", isError: false }),
        ]);
        return { text: "finished" };
      },
    ] }));
    expect(result.outcome).toBe("completed");
    expect(memory.text("/workspace/out/report.md")).toBe("done\n");
    expect(await Bun.file(join(dir, "work/out/report.md")).exists()).toBe(false);
    await session.close(); await host.close();
  });
});

test("capabilities advertise core-tools/v1 in release/v2 without loading tool, provider or TUI code", async () => {
  expect(hostCapabilities()).toMatchObject({ coreToolsContract: "schway.host.core-tools/v1", releaseContract: "schway.host.release/v2" });
  expect(CORE_TOOLS_CONTRACT).toBe("schway.host.core-tools/v1");
  await withTempDir(async dir => {
    const guard = join(dir, "guard.ts"), probe = join(dir, "probe.ts");
    await Bun.write(guard, `await Bun.plugin({name:'core-tools-guard',setup(builder){
      builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Forbidden provider or TUI load');});
      builder.onLoad({filter:/[/\\\\]src[/\\\\](?:tools|agent|context|session)[/\\\\]/},(args)=>{
        if (!globalThis.allowTools) throw new Error('Discovery loaded runtime: ' + args.path);
        return { contents: require('fs').readFileSync(args.path, 'utf8'), loader: 'ts' };
      });
    }});`);
    await Bun.write(probe, `import { coreToolDefinitions, hostCapabilities } from ${JSON.stringify(join(repo, "src/host/index.ts"))};
      const caps = hostCapabilities();
      globalThis.allowTools = true;
      const names = coreToolDefinitions({ workspaceRoot: "/w", temporaryDirectory: "/t",
        ...Object.fromEntries(["realpath","stat","readFile","observeFile","writeFileAtomically","writePrivateFile","list","glob","search","spawn"].map(name => [name, () => { throw new Error("unused"); }])) }).map(tool => tool.name);
      console.log(JSON.stringify({ core: caps.coreToolsContract, release: caps.releaseContract, names }));`);
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guard, probe], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ core: "schway.host.core-tools/v1", release: "schway.host.release/v2",
      names: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
  });
});

test("with a non-local backend the core tools call no host filesystem or process API", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", join(import.meta.dir, "fixtures/deny-host-io.ts"),
    join(import.meta.dir, "fixtures/core-tools-no-host-io.ts")], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  const report = JSON.parse(stdout) as { denied: string[]; outcomes: Record<string, { isError: boolean; content: string }>; probe: string };
  expect(report.probe).toBe("denied");
  expect(report.denied).toEqual([]);
  expect(Object.keys(report.outcomes).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "spill-read", "write"]);
  for (const [name, outcome] of Object.entries(report.outcomes)) expect(outcome.isError, `${name}: ${outcome.content}`).toBe(false);
});
