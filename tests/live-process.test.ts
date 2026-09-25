import { expect, spyOn, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLiveProcesses } from "../src/live/process.ts";
import { parseWorkerInput, runWorker } from "../src/live/worker.ts";
import { withTempDir } from "./helpers.ts";

const fixture = join(import.meta.dir, "fixtures/live-process.ts");
const revision = "0123456789012345678901234567890123456789";
const settings = (providers: Array<"compatible" | "anthropic">, timeoutMs = 600) => ({
  enabled: true, revision, timeoutMs, providers, env: {} as Record<string, string>,
});
const gone = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
const waitForPid = async (path: string) => {
  for (let i = 0; i < 80; i++) {
    try { return Number(await readFile(path, "utf8")); } catch { await Bun.sleep(10); }
  }
  throw Error("fixture did not start");
};

test("worker rejects secrets, commands and oversize private instructions before credential lookup", async () => {
  const safe = { provider: "compatible", model: "gpt-4o", timeoutMs: 500, workspaceRoot: join(tmpdir(), "schway-live-fixture"),
    compatible: { baseUrl: "http://127.0.0.1:1234/v1", auth: "none" } };
  expect(parseWorkerInput(safe).providers).toEqual(["compatible"]);
  const unsafe = { ...safe, compatible: { ...safe.compatible, auth: "required" } };
  expect(() => parseWorkerInput(unsafe)).toThrow();
  await expect(runWorker(new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(new TextEncoder().encode(JSON.stringify(unsafe)));
    stream.close();
  } }), { OPENAI_COMPATIBLE_API_KEY: "fixture-key-not-real" })).rejects.toThrow("invalid instruction");
  expect(() => parseWorkerInput({ ...safe, compatible: { ...safe.compatible, baseUrl: "http://example.org/v1" } })).toThrow();
  expect(() => parseWorkerInput({ ...safe, apiKey: "PRIVATE_SECRET" })).toThrow();
  expect(() => parseWorkerInput({ ...safe, model: "secret\nhello" })).toThrow();
  expect(() => parseWorkerInput({ ...safe, workspaceRoot: "/tmp/other" })).toThrow();
  const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(8193)); c.close(); } });
  await expect(runWorker(oversized, {})).rejects.toThrow("instruction too large");
});

test("disabled supervision does not spawn or discover credentials", async () => {
  const result = await runLiveProcesses({ ...settings(["anthropic"]), enabled: false, env: { ANTHROPIC_API_KEY: "PRIVATE_SECRET" } },
    { workerFile: "/invalid/nonexistent-worker.ts", onWorkspace: () => { throw Error("unexpected workspace"); } });
  expect(result.scenarios[0]).toMatchObject({ status: "skipped", reason: "live_disabled" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
});

test("cancelled or expired workspace setup never spawns a paid worker", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    for (const mode of ["cancelled", "expired"] as const) {
      const launches = spyOn(Bun, "spawn");
      const pidPath = join(temp, `${mode}.pid`);
      const controller = new AbortController();
      let root = "";
      let report;
      let spawned = 0;
      try {
        report = await runLiveProcesses({ ...settings(["anthropic"], mode === "cancelled" ? 600 : 30), signal: controller.signal,
          env: { SCHWAY_FIXTURE_MODE: "hang", SCHWAY_FIXTURE_PID_FILE: pidPath, ANTHROPIC_API_KEY: "PRIVATE_SECRET" } },
        { workerFile: fixture, onWorkspace: path => {
          root = path;
          if (mode === "cancelled") controller.abort();
          else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 55);
        } });
        spawned = launches.mock.calls.length;
      } finally { launches.mockRestore(); }
      expect(spawned).toBe(0);
      expect(report.scenarios[0]).toMatchObject({ status: mode === "cancelled" ? "pending" : "failed_runner",
        reason: mode === "cancelled" ? "cancelled" : "timeout" });
      expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
      await expect(access(pidPath)).rejects.toThrow();
      await expect(access(root)).rejects.toThrow();
    }
  });
}, 10_000);

test("real non-cooperative process and same-group descendant die, workspace removed, no later provider starts", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const roots: string[] = [];
    const reportPromise = runLiveProcesses({ ...settings(["anthropic", "compatible"], 450), env: {
      SCHWAY_FIXTURE_MODE: "hang-with-descendant", SCHWAY_FIXTURE_PID_FILE: pidPath, ANTHROPIC_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, onWorkspace: root => roots.push(root) });
    const pid = await waitForPid(pidPath);
    const descendant = await waitForPid(`${pidPath}.descendant`);
    const report = await reportPromise;
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "timeout" });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(roots).toHaveLength(1);
    expect(gone(pid)).toBe(true);
    expect(gone(descendant)).toBe(true);
    await expect(access(roots[0]!)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SECRET|worker\.pid|schway-live-/);
  });
}, 10_000);

test("started model process that ignores abort is classified as provider timeout after hard kill", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const pending = runLiveProcesses({ ...settings(["anthropic", "compatible"], 350), env: {
      SCHWAY_FIXTURE_MODE: "hang-stream", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, onWorkspace: path => { root = path; } });
    const pid = await waitForPid(pidPath);
    const report = await pending;
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout" });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(gone(pid)).toBe(true);
    await expect(access(root)).rejects.toThrow();
  });
}, 10_000);

test("a worker cannot report pass while its descendant remains alive", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const report = await runLiveProcesses({ ...settings(["anthropic"]), env: {
      SCHWAY_FIXTURE_MODE: "orphan", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, onWorkspace: path => { root = path; } });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "process_group_leak" });
    expect(gone(await waitForPid(`${pidPath}.descendant`))).toBe(true);
    await expect(access(root)).rejects.toThrow();
  });
}, 10_000);

test("non-cooperative output-limit worker is hard stopped without changing provider failure to timeout", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const roots: string[] = [];
    const report = await runLiveProcesses({ ...settings(["anthropic"], 1200), env: {
      SCHWAY_FIXTURE_MODE: "deferred-output", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, onWorkspace: root => roots.push(root) });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit" });
    expect(report.scenarios[0]).not.toHaveProperty("cleanup");
    expect(roots).toHaveLength(1);
    expect(gone(await waitForPid(pidPath))).toBe(true);
    expect(gone(await waitForPid(`${pidPath}.descendant`))).toBe(true);
    await expect(access(roots[0]!)).rejects.toThrow();
  });
}, 10_000);

test("oversized stdout and malformed worker response are rejected without echo, cleaned up and reaped", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const report = await runLiveProcesses({ ...settings(["anthropic"]), env: {
      SCHWAY_FIXTURE_MODE: "oversized", SCHWAY_FIXTURE_PID_FILE: pidPath, ANTHROPIC_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, onWorkspace: path => { root = path; } });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
    expect(gone(Number(await readFile(pidPath, "utf8")))).toBe(true);
    await expect(access(root)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
    const forged = await runLiveProcesses({ ...settings(["anthropic"]), env: {
      SCHWAY_FIXTURE_MODE: "forged", ANTHROPIC_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture });
    expect(forged.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
    expect(JSON.stringify(forged)).not.toContain("PRIVATE_SECRET");
    const fakeTimeout = await runLiveProcesses({ ...settings(["anthropic"]), env: {
      SCHWAY_FIXTURE_MODE: "fake-timeout",
    } }, { workerFile: fixture });
    expect(fakeTimeout.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
  });
});

test("cancellation kills the non-cooperative worker before cleanup or another provider launch", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const controller = new AbortController();
    const roots: string[] = [];
    const pending = runLiveProcesses({ ...settings(["anthropic", "compatible"], 1500), signal: controller.signal,
      env: { SCHWAY_FIXTURE_MODE: "hang", SCHWAY_FIXTURE_PID_FILE: pidPath } },
    { workerFile: fixture, onWorkspace: root => roots.push(root) });
    const pid = await waitForPid(pidPath);
    controller.abort();
    const report = await pending;
    expect(report.scenarios.map(item => item.reason)).toEqual(["cancelled", "cancelled"]);
    expect(gone(pid)).toBe(true);
    expect(roots).toHaveLength(1);
    await expect(access(roots[0]!)).rejects.toThrow();
  });
}, 10_000);

test("selected worker fake succeeds without loading a sibling or printing an injected credential", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const roots: string[] = [];
    const report = await runLiveProcesses({ ...settings(["anthropic"]), env: {
      SCHWAY_FIXTURE_PID_FILE: join(temp, "worker.pid"), ANTHROPIC_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, onWorkspace: root => roots.push(root) });
    expect(report.aggregate).toBe("passed");
    expect(report.scenarios).toMatchObject([{ status: "passed", provider: "anthropic", toolRoundTrip: true }]);
    expect(roots).toHaveLength(1);
    await expect(access(roots[0]!)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
  });
});

test("installed live command rejects credentialed HTTP before a local fake endpoint receives any request", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    return new Response("not a model", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const secret = "fixture-key-not-real";
    const proc = Bun.spawn([process.execPath, "run", "live-smoke", "--enable-live", "--provider", "compatible",
      "--base-url", `http://127.0.0.1:${server.port}/v1`, "--auth", "required", "--timeout-ms", "1000"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: secret }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(1);
    expect(calls).toBe(0);
    expect(stderr).toContain("HTTPS");
    expect(stdout + stderr).not.toContain(secret);
  } finally { server.stop(true); }
}, 15_000);

test("installed command uses supervised child and local fake compatible HTTP transport for actual tool evidence", async () => {
  if (process.platform === "win32") return;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    expect(request.headers.get("authorization")).toBeNull();
    const body = await request.json() as { messages: Array<{ role: string; content?: string }> };
    const tool = body.messages.find(message => message.role === "tool")?.content;
    const marker = tool?.match(/1\|([a-f0-9]{40})/)?.[1];
    const delta = marker ? { content: marker } : { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: '{"path":"smoke-sentinel.txt"}' } }] };
    const chunk = (payload: object, finish_reason: string | null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "gpt-4o",
      choices: [{ index: 0, delta: payload, finish_reason }] });
    const sse = [chunk(delta, null), chunk({}, marker ? "stop" : "tool_calls")].map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const proc = Bun.spawn([process.execPath, "run", "live-smoke", "--enable-live", "--provider", "compatible", "--base-url",
      `http://127.0.0.1:${server.port}/v1`, "--auth", "none", "--timeout-ms", "5000"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: "LOCAL_FAKE_SECRET" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("error:");
    expect(calls).toBe(2);
    expect(stdout + stderr).not.toContain("LOCAL_FAKE_SECRET");
    expect(JSON.parse(stdout)).toMatchObject({ aggregate: "passed", scenarios: [{ status: "passed", toolRoundTrip: true, authSource: "none" }] });
  } finally { server.stop(true); }
}, 15_000);
