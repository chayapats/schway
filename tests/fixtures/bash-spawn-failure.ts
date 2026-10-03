import { mkdir, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Run a spawn-failure regression in an isolated process, killing and reaping it if settlement regresses. */
export async function runBashProbe(mode: string, root: string, deadlineMs = 2500) {
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, mode, root], { stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, deadlineMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { expired, exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (mode === "real-pipe-error" || mode === "normal-drain") {
      // The parent also owns cleanup if the isolated fixture hits its external deadline.
      const pid = Number(await readFile(join(root, "probe-pgid"), "utf8").catch(() => ""));
      if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    }
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}

async function openPipe(mode: string, root: string) {
  const { spyOn } = await import("bun:test");
  const childProcess = await import("node:child_process");
  const { EventEmitter, getEventListeners } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 999999999, kill: () => true });
  const original = Object.assign(new Error("original open-pipe failure"), { code: "EIO" });
  const signals: string[] = [];
  let lateErrorSent = false;
  const killSpy = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    signals.push(String(signal));
    if (signal === "SIGTERM" && mode === "exit") queueMicrotask(() => child.emit("exit", null));
    if (signal === "SIGKILL" && mode === "late-error" && !lateErrorSent) {
      lateErrorSent = true;
      // Fail after the normal-exit drain deadline has run, while stderr remains open.
      queueMicrotask(() => child.stdout.destroy(original));
    }
    // Deliberately leave stderr open even after SIGKILL: cleanup must close the local handle.
    return true;
  });
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() => {
    setImmediate(() => {
      child.stdout.write("partial output");
      if (mode === "late-error") { child.emit("exit", 0); return; }
      child.stdout.destroy(original);
      if (mode === "error") child.emit("error", original);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  try {
    const { executeBash } = await import("../../src/tools/bash.ts");
    let sameOriginal = false;
    try { await executeBash({ command: "fixture" }, { workspace: { root, launchCwd: root, extraRoots: [] }, signal: controller.signal }); }
    catch (error) { sameOriginal = error === original; }
    return { sameOriginal, signals, destroyed: [child.stdout.destroyed, child.stderr.destroyed],
      pipeListeners: [child.stdout, child.stderr].map(pipe => ["data", "error", "end", "close"].reduce((count, event) => count + pipe.listenerCount(event), 0)),
      childListeners: child.eventNames(), abortListeners: getEventListeners(controller.signal, "abort").length };
  } finally { child.stdout.destroy(); child.stderr.destroy(); spawnSpy.mockRestore(); killSpy.mockRestore(); }
}

async function normalDrain(root: string) {
  const { spyOn } = await import("bun:test");
  const childProcess = await import("node:child_process");
  const realSpawn = childProcess.spawn;
  let child: ReturnType<typeof realSpawn> | undefined, closed: Promise<void> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false, canResume = false, expired = false, bufferedAtExit = 0;
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof realSpawn>) => {
    child = Reflect.apply(realSpawn, childProcess, args);
    writeFileSync(join(root, "probe-pgid"), String(child.pid));
    closed = new Promise(resolve => child!.once("close", () => resolve()));
    const stdout = child.stdout!, resume = stdout.resume.bind(stdout);
    // Node/Bun may resume pipes on exit; retain controlled backpressure until after the drain deadline.
    stdout.resume = () => paused && !canResume ? stdout : resume();
    child.once("exit", () => {
      bufferedAtExit = stdout.readableLength;
      resumeTimer = setTimeout(() => { canResume = true; stdout.resume(); }, 350);
    });
    return child;
  }) as typeof realSpawn);
  const cleanup = () => {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    child?.stdout?.destroy(); child?.stderr?.destroy();
  };
  const controller = new AbortController();
  const deadline = setTimeout(() => { expired = true; controller.abort(); cleanup(); }, 1500);
  const chunks: Array<{ stream: string; text: string }> = [];
  try {
    const { executeBash } = await import("../../src/tools/bash.ts");
    const result = await executeBash({ command: "printf 'PREFIX\\n'; while [ ! -f release ]; do sleep 0.01; done; printf 'BUFFERED TAIL ไทย 😀\\n'; printf 'tail written\\n' >&2" }, {
      workspace: { root, launchCwd: root, extraRoots: [] }, signal: controller.signal,
      onOutput: chunk => {
        chunks.push(chunk);
        if (!paused && chunk.stream === "stdout" && chunk.text.includes("PREFIX")) {
          paused = true; child!.stdout!.pause(); writeFileSync(join(root, "release"), "go");
        }
      },
    });
    return { result, chunks, expired, bufferedAtExit };
  } finally {
    clearTimeout(deadline);
    if (resumeTimer !== undefined) clearTimeout(resumeTimer);
    cleanup(); await closed; spawnSpy.mockRestore();
  }
}

async function realPipeFailure(root: string) {
  const { spyOn } = await import("bun:test");
  const childProcess = await import("node:child_process");
  const realSpawn = childProcess.spawn;
  const original = Object.assign(new Error("injected stdout read failure"), { code: "EIO" });
  let child: ReturnType<typeof realSpawn> | undefined, closed: Promise<void> | undefined;
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof realSpawn>) => {
    child = Reflect.apply(realSpawn, childProcess, args);
    writeFileSync(join(root, "probe-pgid"), String(child.pid));
    closed = new Promise(resolve => child!.once("close", () => resolve()));
    return child;
  }) as typeof realSpawn);
  const cleanup = () => {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    child?.stdout?.destroy(); child?.stderr?.destroy();
  };
  let expired = false;
  const deadline = setTimeout(() => { expired = true; cleanup(); }, 1500);
  try {
    const { executeBash } = await import("../../src/tools/bash.ts");
    const command = `trap 'exit 0' TERM
bash -c 'trap "" TERM; printf ready > ready; while true; do printf x >> ticks; sleep 0.02; done' &
while [ ! -e ready ]; do sleep 0.01; done
printf 'READY\\n'
wait`;
    let sameOriginal = false;
    try { await executeBash({ command }, { workspace: { root, launchCwd: root, extraRoots: [] }, onOutput: chunk => {
      if (chunk.stream === "stdout" && chunk.text.includes("READY")) child!.stdout!.emit("error", original);
    } }); } catch (error) { sameOriginal = error === original; }
    const before = (await readFile(join(root, "ticks"))).length;
    await Bun.sleep(250);
    const after = (await readFile(join(root, "ticks"))).length;
    return { sameOriginal, expired, before, stable: before === after, stderrDestroyed: child!.stderr!.destroyed,
      pipeListeners: [child!.stdout!, child!.stderr!].map(pipe => ["data", "error", "end", "close"].reduce((count, event) => count + pipe.listenerCount(event), 0)) };
  } finally { cleanup(); await closed; clearTimeout(deadline); spawnSpy.mockRestore(); }
}

async function realFailure(mode: string, root: string) {
  const { executeBash } = await import("../../src/tools/bash.ts");
  const [scenario, cancellation] = mode.split(":");
  const controller = new AbortController();
  const abortTimer = cancellation === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;
  const cwd = scenario === "missing-cwd" ? "missing" : scenario === "file-cwd" ? "file.txt" : undefined;
  if (scenario === "file-cwd") await writeFile(join(root, "file.txt"), "not a directory");
  const emptyPath = join(root, "empty-path"); await mkdir(emptyPath);
  const output: string[] = [];
  try {
    const result = await executeBash({ command: "printf unexpected-output", ...(cwd ? { cwd } : {}), ...(cancellation === "timeout" ? { timeout: 100 } : {}) }, {
      workspace: { root, launchCwd: root, extraRoots: [] }, signal: controller.signal,
      ...(scenario === "missing-shell" ? { env: { PATH: emptyPath } } : {}), onOutput: chunk => output.push(chunk.text),
    });
    return { status: "fulfilled", result, output };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { status: "rejected", name: failure.name, code: failure.code, message: failure.message, output };
  } finally { if (abortTimer !== undefined) clearTimeout(abortTimer); }
}

async function lifecycle(mode: string, root: string) {
  const { spyOn } = await import("bun:test");
  const childProcess = await import("node:child_process");
  const { EventEmitter, getEventListeners } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true });
  const spawnError = Object.assign(new Error("spawn bash ENOENT fixture"), { code: "ENOENT" });
  const pipeError = Object.assign(new Error("pipe failure fixture"), { code: "EIO" });
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() => {
    queueMicrotask(() => {
      const bytes = Buffer.from("ก🙂");
      child.stdout.emit("data", bytes.subarray(0, 2));
      child.stdout.emit("data", bytes.subarray(2));
      child.stdout.emit("data", Buffer.from([0xe2]));
      child.stderr.emit("data", "diagnostic\n");
      if (mode === "spawn-close" || mode === "both-errors") child.emit("error", spawnError);
      if (mode === "stream-error" || mode === "both-errors") child.stdout.emit("error", pipeError);
      if (mode === "abort") controller.abort();
      if (mode === "normal") { child.stdout.emit("end"); child.stderr.emit("end"); }
      child.stdout.emit("close"); child.stderr.emit("close");
      const finish = () => {
        if (mode !== "spawn-close" && mode !== "both-errors") child.emit("exit", mode === "abort" ? null : 0);
        child.emit("close", mode === "spawn-close" || mode === "both-errors" ? -2 : 0);
      };
      if (mode === "stream-error") setImmediate(finish);
      else finish();
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  const { executeBash } = await import("../../src/tools/bash.ts");
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimer>) => { const timer = Reflect.apply(setTimer, globalThis, args) as ReturnType<typeof setTimer>; timers.add(timer); return timer; }) as typeof setTimer);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { timers.delete(timer as ReturnType<typeof setTimeout>); Reflect.apply(clearTimer, globalThis, [timer]); });
  const chunks: Array<{ stream: string; text: string }> = [];
  let outcome: unknown;
  try {
    const result = await executeBash({ command: "fixture", timeout: 1000 }, { workspace: { root, launchCwd: root, extraRoots: [] }, signal: controller.signal, onOutput: chunk => chunks.push(chunk) });
    outcome = { status: "fulfilled", result };
  } catch (error) {
    outcome = { status: "rejected", name: (error as Error).name, code: (error as NodeJS.ErrnoException).code, sameSpawnError: error === spawnError, samePipeError: error === pipeError };
  } finally { spawnSpy.mockRestore(); setSpy.mockRestore(); clearSpy.mockRestore(); }
  return {
    outcome, chunks, timers: timers.size, abortListeners: getEventListeners(controller.signal, "abort").length,
    childListeners: child.eventNames().flatMap(name => Array(child.listenerCount(name)).fill(String(name))),
    pipeListeners: [child.stdout, child.stderr].map(pipe => ["data", "error", "end", "close"].reduce((count, event) => count + pipe.listenerCount(event), 0)),
  };
}

async function agentFailure(root: string) {
  const [{ runAgentLoop }, { createContextManager }, { createSession }, { bashTool }, { createToolRegistry }, { collect, createScriptedModel }] = await Promise.all([
    import("../../src/agent/loop.ts"), import("../../src/context/manager.ts"), import("../../src/session/session.ts"), import("../../src/tools/bash.ts"), import("../../src/tools/registry.ts"), import("../helpers/scripted-model.ts"),
  ]);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "run" }] }]);
  const events = await collect(runAgentLoop({ workspace, session, tools: createToolRegistry([bashTool]), contextManager: createContextManager(workspace), model: createScriptedModel({ responses: [{ toolCalls: [{ id: "spawn", name: "bash", arguments: { command: "printf unexpected-output", cwd: "missing" } }] }, { text: "recovered" }] }) }));
  return { results: session.items.filter(item => item.type === "tool_result"), finished: events.filter(event => event.type === "tool.finished"), started: events.filter(event => event.type === "tool.started").length, lastEvent: events.at(-1), lastItem: session.items.at(-1) };
}

if (import.meta.main) {
  // Keep an unresolved tool promise observable until the parent deadline, even when no child was created.
  const alive = setInterval(() => {}, 1000);
  try {
    const mode = process.argv[2]!, root = process.argv[3]!;
    console.log(JSON.stringify({ stage: "running", mode }));
    console.log(JSON.stringify(mode.startsWith("lifecycle:") ? await lifecycle(mode.slice("lifecycle:".length), root)
      : mode.startsWith("open-pipe:") ? await openPipe(mode.slice("open-pipe:".length), root)
      : mode === "normal-drain" ? await normalDrain(root)
      : mode === "real-pipe-error" ? await realPipeFailure(root) : mode === "agent" ? await agentFailure(root) : await realFailure(mode, root)));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearInterval(alive); }
}
