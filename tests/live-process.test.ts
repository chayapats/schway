import Ajv from "ajv";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLiveProcesses } from "../src/live/process.ts";
import { parseWorkerInput, runWorker } from "../src/live/worker.ts";
import type { SmokeDiagnostics } from "../src/live/diagnostics.ts";
import { withTempDir } from "./helpers.ts";
import { manualClock } from "./helpers/manual-clock.ts";

const fixture = join(import.meta.dir, "fixtures/live-process.ts");
const revision = "0123456789012345678901234567890123456789";
const settings = (providers: Array<"compatible" | "openai-api-key">, timeoutMs = 600) => ({
  enabled: true, revision, timeoutMs, providers, env: {} as Record<string, string>,
});
// Real-time bounds nest so a stuck lane fails with its own message, never the test timeout:
// a fixture barrier wait (6 s; two in sequence stay below the backstop) < the lane backstop (15 s)
// < the lane test timeout (30 s).
const BARRIER_WAIT_MS = 6_000;
// Stops a stuck or abandoned lane, killing its process group and removing its workspace. It is far
// beyond any lane's own work, and a test fails whenever it fires, so it never decides an outcome.
const LANE_BACKSTOP_MS = 15_000;
// One backstop plus reaping, one barrier wait and the test's own work.
const LANE_TEST_TIMEOUT_MS = 30_000;
// Production and protocol workers keep their own real-time deadline. This budget keeps it beyond
// the backstop, so only the supervisor's test clock or backstop can expire a lane.
const WORKER_BUDGET_MS = 60_000;
// The installed command cannot take a test clock. Its budget only bounds a stuck run, far beyond
// the observed sub-second ARM64 runs, so it never decides an outcome.
const INSTALLED_BUDGET_MS = 10_000;
/** Cover each installed run's budget plus reaping and start-up, so a stuck run reports before the test times out. */
const installedTimeout = (runs: number) => runs * (INSTALLED_BUDGET_MS + 5_000) + 5_000;
// Backstops that fired during the current test. A held lane must end through its explicit expiry
// or its worker's own outcome; a backstop timeout could hide a broken supervisor deadline.
let backstopsFired = 0;
afterEach(() => {
  const fired = backstopsFired;
  backstopsFired = 0;
  if (fired) throw Error(`${fired} held lane(s) ended at the real-time backstop`);
});
/** Lane deadlines that expire when a test advances them past an explicit barrier; the real-time backstop only cleans up a stuck lane, and fails its test. */
const heldDeadline = () => {
  const clock = manualClock();
  let fired = false;
  const sleep = (ms: number, signal: AbortSignal) => Promise.race([clock.sleep(ms, signal), new Promise<void>(resolve => {
    const backstop = setTimeout(() => { fired = true; backstopsFired++; resolve(); }, LANE_BACKSTOP_MS);
    signal.addEventListener("abort", () => clearTimeout(backstop), { once: true });
  })]);
  return { clock: { now: clock.now, sleep }, expire: clock.advance, backstopFired: () => fired };
};
/** A held lane no test expires, so the worker's own behavior decides the outcome; its backstop only cleans up. */
const backstopOnly = () => heldDeadline().clock;
/** Expire a held lane once `barrier` passes or fails, then require that this explicit expiry, not the backstop, ended it. */
async function expireAfterBarrier<T>(pending: Promise<T>, deadline: ReturnType<typeof heldDeadline>, ms: number,
  barrier: () => Promise<unknown>): Promise<T> {
  // Expiring on failure too still stops the worker group and removes its workspace.
  try { await barrier(); }
  finally { await deadline.expire(ms); await pending; }
  if (deadline.backstopFired()) throw Error("held lane ended at its real-time backstop, not its explicit expiry");
  return pending;
}
const gone = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
/** Poll a fixture barrier. The bound only names a stuck fixture; no outcome under test depends on it. */
async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const end = Date.now() + BARRIER_WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw Error(`fixture never reached: ${what}`);
    await Bun.sleep(10);
  }
}
/** Wait for a complete, positive PID; an absent or partial file never reads as process group 0. */
const waitForPid = (path: string) => until(async () => {
  const pid = Number(await readFile(path, "utf8").catch(() => ""));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}, `PID in ${path}`);
/** Wait until a worker records in its workspace that its model stream started. */
const waitForModelStart = (workspace: () => string) => until(async () =>
  workspace() ? access(join(workspace(), ".model-started")).then(() => true, () => undefined) : undefined, "model start");
/** Wait until a worker's private checkpoint reaches the given progress. */
const waitForProgress = (workspace: () => string, ready: (diagnostics: SmokeDiagnostics) => boolean) => until(async () => {
  if (!workspace()) return;
  const progress = await readFile(join(workspace(), ".smoke-progress.json"), "utf8").then(JSON.parse, () => undefined) as
    { diagnostics?: SmokeDiagnostics } | undefined;
  return progress?.diagnostics && ready(progress.diagnostics) ? true : undefined;
}, "checkpoint progress");

/** Replay a sentinel read request, then return its actual tool result as compatible SSE. */
async function sentinelSse(request: Request, id = "fixture"): Promise<string> {
  const body = await request.json() as { messages: Array<{ role: string; content?: string }> };
  const marker = body.messages.find(message => message.role === "tool")?.content?.match(/1\|([a-f0-9]{40})/)?.[1];
  const delta = marker ? { content: marker } : { tool_calls: [{ index: 0, id: "read1", type: "function", function: {
    name: "read", arguments: '{"path":"smoke-sentinel.txt"}' } }] };
  const chunk = (payload: object, finish_reason: string | null) => ({ id, object: "chat.completion.chunk", created: 0,
    model: "gpt-4o", choices: [{ index: 0, delta: payload, finish_reason }] });
  return [chunk(delta, null), chunk({}, marker ? "stop" : "tool_calls")]
    .map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
}

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
  const result = await runLiveProcesses({ ...settings(["openai-api-key"]), enabled: false, env: { OPENAI_API_KEY: "PRIVATE_SECRET" } },
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
      const selection = { ...settings(["openai-api-key"]), signal: controller.signal,
        env: { SCHWAY_FIXTURE_MODE: "hang", SCHWAY_FIXTURE_PID_FILE: pidPath, OPENAI_API_KEY: "PRIVATE_SECRET" } };
      // Setup takes no lane time until the workspace callback cancels or spends the whole budget.
      let elapsed = 0;
      try {
        report = await runLiveProcesses(selection, { workerFile: fixture, now: () => elapsed, onWorkspace: path => {
          root = path;
          if (mode === "cancelled") controller.abort();
          else elapsed = selection.timeoutMs;
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

test("hard-stop progress rejects malformed, oversized and symlinked checkpoints without leaking content", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const secretPath = join(temp, "private.json");
    const diagnostics = { modelAttemptsStarted: 1, modelRoundsCompleted: 0, toolResultsCompleted: 0,
      providerRetries: 0, httpRequestsStarted: 1, httpResponsesReceived: 1, lastHttpStatus: 503 };
    const progress = { authSource: "env", diagnostics };
    await writeFile(secretPath, JSON.stringify(progress));
    const invalid = [
      JSON.stringify({ ...progress, authSource: "PRIVATE_SECRET" }),
      JSON.stringify({ ...progress, status: "passed", toolRoundTrip: true }),
      JSON.stringify({ ...progress, diagnostics: { ...diagnostics, providerBody: "PRIVATE_SECRET" } }),
      JSON.stringify({ ...progress, diagnostics: { ...diagnostics, lastHttpStatus: "PRIVATE_SECRET" } }),
      JSON.stringify({ ...progress, diagnostics: { ...diagnostics, httpRequestsStarted: -1 } }),
      JSON.stringify({ ...progress, diagnostics: { ...diagnostics, modelRoundsCompleted: 2 } }),
      "PRIVATE_SECRET".repeat(100),
      "symlink",
    ];
    for (const checkpoint of invalid) {
      let root = "";
      const deadline = heldDeadline();
      const pending = runLiveProcesses({ ...settings(["openai-api-key"], 200), env: { SCHWAY_FIXTURE_MODE: "hang-stream" } },
        { workerFile: fixture, ...deadline.clock, onWorkspace: path => {
          root = path;
          if (checkpoint === "symlink") symlinkSync(secretPath, join(path, ".smoke-progress.json"));
          else writeFileSync(join(path, ".smoke-progress.json"), checkpoint);
        } });
      // Expire the lane only once the worker has recorded that its model stream started.
      const report = await expireAfterBarrier(pending, deadline, 200, () => waitForModelStart(() => root));
      expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout", authSource: "unavailable", toolRoundTrip: false });
      expect(report.scenarios[0]).not.toHaveProperty("diagnostics");
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SECRET|private\.json/);
      await expect(access(root)).rejects.toThrow();
    }
    expect(await readFile(secretPath, "utf8")).toBe(JSON.stringify(progress));
  });
}, LANE_TEST_TIMEOUT_MS);

test("framed replies reject malformed numeric diagnostics without publishing provider content", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const workerFile = join(temp, "bad-diagnostics.ts");
    await writeFile(workerFile, `let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
const input = JSON.parse(raw);
console.log(JSON.stringify({ provider: input.provider, model: input.model, authSource: "env", status: "passed", reason: "verified",
  durationMs: 1, toolRoundTrip: true, diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1,
    providerRetries: 0, httpRequestsStarted: 2, httpResponsesReceived: 2, lastHttpStatus: 200, providerBody: "PRIVATE_SECRET" } }));`);
    const report = await runLiveProcesses(settings(["openai-api-key"]), { workerFile, ...backstopOnly() });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error", toolRoundTrip: false });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
  });
}, LANE_TEST_TIMEOUT_MS);

test("supervised timeout retains HTTP 503 and Schway retry counts without retaining the error body", async () => {
  if (process.platform === "win32") return;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    // The second 503 asks for a long backoff, so no third request can start between the barrier and expiry.
    return Response.json({ error: { message: "PRIVATE_PROVIDER_BODY", code: 503 } },
      { status: 503, headers: calls === 2 ? { "retry-after": "30" } : {} });
  } });
  try {
    const deadline = heldDeadline();
    let root = "";
    const pending = runLiveProcesses({ ...settings(["compatible", "openai-api-key"], WORKER_BUDGET_MS),
      compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "none" } }, { ...deadline.clock, onWorkspace: path => { root = path; } });
    // Expire the lane during the backoff after the second 503, once the worker has checkpointed that retry.
    const report = await expireAfterBarrier(pending, deadline, WORKER_BUDGET_MS,
      () => waitForProgress(() => root, diagnostics => diagnostics.providerRetries === 2));
    expect(calls).toBe(2);
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout", authSource: "none", toolRoundTrip: false,
      diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 0, toolResultsCompleted: 0,
        providerRetries: 2, httpRequestsStarted: 2, httpResponsesReceived: 2, lastHttpStatus: 503 } });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_PROVIDER_BODY|127\.0\.0\.1/);
  } finally { server.stop(true); }
}, LANE_TEST_TIMEOUT_MS);

test("real non-cooperative process and same-group descendant die, workspace removed, no later provider starts", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const roots: string[] = [];
    const deadline = heldDeadline();
    const reportPromise = runLiveProcesses({ ...settings(["openai-api-key", "compatible"], 450), env: {
      SCHWAY_FIXTURE_MODE: "hang-with-descendant", SCHWAY_FIXTURE_PID_FILE: pidPath, OPENAI_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, ...deadline.clock, onWorkspace: root => roots.push(root) });
    // Expire the lane only once the worker and its same-group descendant have both published their PIDs.
    let pid = 0, descendant = 0;
    const report = await expireAfterBarrier(reportPromise, deadline, 450, async () => {
      pid = await waitForPid(pidPath);
      descendant = await waitForPid(`${pidPath}.descendant`);
    });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "timeout" });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(roots).toHaveLength(1);
    expect(gone(pid)).toBe(true);
    expect(gone(descendant)).toBe(true);
    await expect(access(roots[0]!)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_SECRET|worker\.pid|schway-live-/);
  });
}, LANE_TEST_TIMEOUT_MS);

test("the default real-time deadline stops a worker group that never replies", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const roots: string[] = [];
    // Production hooks and a short real budget. This worker never replies or records a stream start,
    // so the lane can only end as a runner timeout, however early or late the deadline fires.
    const report = await runLiveProcesses({ ...settings(["openai-api-key", "compatible"], 300), env: {
      SCHWAY_FIXTURE_MODE: "hang-with-descendant", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, onWorkspace: root => roots.push(root) });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "timeout" });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    // Without a barrier, either process may have been stopped before publishing; any published PID must be gone.
    for (const path of [pidPath, `${pidPath}.descendant`]) {
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (pid > 0) expect(gone(pid)).toBe(true);
    }
    expect(roots.length).toBeLessThanOrEqual(1);
    for (const root of roots) await expect(access(root)).rejects.toThrow();
  });
}, LANE_TEST_TIMEOUT_MS);

test("started model process that ignores abort is classified as provider timeout after hard kill", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const deadline = heldDeadline();
    const pending = runLiveProcesses({ ...settings(["openai-api-key", "compatible"], 350), env: {
      SCHWAY_FIXTURE_MODE: "hang-stream", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, ...deadline.clock, onWorkspace: path => { root = path; } });
    // The stream-start evidence is what makes this a provider timeout, so expire only after it exists.
    let pid = 0;
    const report = await expireAfterBarrier(pending, deadline, 350, async () => {
      pid = await waitForPid(pidPath);
      await waitForModelStart(() => root);
    });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout" });
    expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(gone(pid)).toBe(true);
    await expect(access(root)).rejects.toThrow();
  });
}, LANE_TEST_TIMEOUT_MS);

test("a worker cannot report pass while its descendant remains alive", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const report = await runLiveProcesses({ ...settings(["openai-api-key"]), env: {
      SCHWAY_FIXTURE_MODE: "orphan", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, ...backstopOnly(), onWorkspace: path => { root = path; } });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "process_group_leak" });
    expect(gone(await waitForPid(`${pidPath}.descendant`))).toBe(true);
    await expect(access(root)).rejects.toThrow();
  });
}, LANE_TEST_TIMEOUT_MS);

test("non-cooperative output-limit worker is hard stopped without changing provider failure to timeout", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const roots: string[] = [];
    const report = await runLiveProcesses({ ...settings(["openai-api-key"], 1200), env: {
      SCHWAY_FIXTURE_MODE: "deferred-output", SCHWAY_FIXTURE_PID_FILE: pidPath,
    } }, { workerFile: fixture, ...backstopOnly(), onWorkspace: root => roots.push(root) });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit" });
    expect(report.scenarios[0]).not.toHaveProperty("cleanup");
    expect(roots).toHaveLength(1);
    expect(gone(await waitForPid(pidPath))).toBe(true);
    expect(gone(await waitForPid(`${pidPath}.descendant`))).toBe(true);
    await expect(access(roots[0]!)).rejects.toThrow();
  });
}, LANE_TEST_TIMEOUT_MS);

test("oversized stdout and malformed worker response are rejected without echo, cleaned up and reaped", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    let root = "";
    const report = await runLiveProcesses({ ...settings(["openai-api-key"]), env: {
      SCHWAY_FIXTURE_MODE: "oversized", SCHWAY_FIXTURE_PID_FILE: pidPath, OPENAI_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, ...backstopOnly(), onWorkspace: path => { root = path; } });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
    expect(gone(await waitForPid(pidPath))).toBe(true);
    await expect(access(root)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
    const forged = await runLiveProcesses({ ...settings(["openai-api-key"]), env: {
      SCHWAY_FIXTURE_MODE: "forged", OPENAI_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, ...backstopOnly() });
    expect(forged.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
    expect(JSON.stringify(forged)).not.toContain("PRIVATE_SECRET");
    const fakeTimeout = await runLiveProcesses({ ...settings(["openai-api-key"]), env: {
      SCHWAY_FIXTURE_MODE: "fake-timeout",
    } }, { workerFile: fixture, ...backstopOnly() });
    expect(fakeTimeout.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
  });
}, LANE_TEST_TIMEOUT_MS);

test("cancellation kills the non-cooperative worker before cleanup or another provider launch", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const pidPath = join(temp, "worker.pid");
    const controller = new AbortController();
    const roots: string[] = [];
    const pending = runLiveProcesses({ ...settings(["openai-api-key", "compatible"], 1500), signal: controller.signal,
      env: { SCHWAY_FIXTURE_MODE: "hang", SCHWAY_FIXTURE_PID_FILE: pidPath } },
    { workerFile: fixture, ...backstopOnly(), onWorkspace: root => roots.push(root) });
    const pid = await waitForPid(pidPath);
    controller.abort();
    const report = await pending;
    expect(report.scenarios.map(item => item.reason)).toEqual(["cancelled", "cancelled"]);
    expect(gone(pid)).toBe(true);
    expect(roots).toHaveLength(1);
    await expect(access(roots[0]!)).rejects.toThrow();
  });
}, LANE_TEST_TIMEOUT_MS);

test("selected worker fake succeeds without loading a sibling or printing an injected credential", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    const roots: string[] = [];
    const report = await runLiveProcesses({ ...settings(["openai-api-key"]), env: {
      SCHWAY_FIXTURE_PID_FILE: join(temp, "worker.pid"), OPENAI_API_KEY: "PRIVATE_SECRET",
    } }, { workerFile: fixture, ...backstopOnly(), onWorkspace: root => roots.push(root) });
    expect(report.aggregate).toBe("passed");
    expect(report.scenarios).toMatchObject([{ status: "passed", provider: "openai-api-key", toolRoundTrip: true }]);
    expect(roots).toHaveLength(1);
    await expect(access(roots[0]!)).rejects.toThrow();
    expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
  });
}, LANE_TEST_TIMEOUT_MS);

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
    return new Response(await sentinelSse(request), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const proc = Bun.spawn([process.execPath, "run", "live-smoke", "--enable-live", "--provider", "compatible", "--base-url",
      `http://127.0.0.1:${server.port}/v1`, "--auth", "none", "--timeout-ms", String(INSTALLED_BUDGET_MS)], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: "LOCAL_FAKE_SECRET" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("error:");
    expect(calls).toBe(2);
    expect(stdout + stderr).not.toContain("LOCAL_FAKE_SECRET");
    expect(JSON.parse(stdout)).toMatchObject({ aggregate: "passed", scenarios: [{ status: "passed", toolRoundTrip: true, authSource: "none" }] });
  } finally { server.stop(true); }
}, installedTimeout(1));

test("supervised shared deadline preserves the completed tool round and second request progress", async () => {
  if (process.platform === "win32") return;
  let calls = 0;
  const deadline = heldDeadline();
  // Each held response spends three fifths of the lane budget: either fits alone, but their sum does not.
  const share = WORKER_BUDGET_MS * 3 / 5;
  let holding = true;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let secondStarted!: () => void;
  const secondRequest = new Promise<"second request">(resolve => { secondStarted = () => resolve("second request"); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const sse = await sentinelSse(request, "private-generation-id");
    if (holding && calls === 1) await deadline.expire(share);
    else if (holding) { secondStarted(); await released; }
    return new Response(sse, { headers: { "content-type": "text/event-stream", "x-request-id": "PRIVATE_HEADER" } });
  } });
  try {
    const selection = { ...settings(["compatible", "openai-api-key"], WORKER_BUDGET_MS),
      compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "none" as const },
      models: { compatible: "gpt-4o" }, env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: "PRIVATE_KEY" } };
    const pending = runLiveProcesses(selection, deadline.clock);
    // Barrier: the first round and its tool result completed and the second request started, all within budget.
    const timed = await expireAfterBarrier(pending, deadline, share, async () =>
      expect(await Promise.race([secondRequest, pending.then(() => "lane ended")])).toBe("second request"));
    expect(calls).toBe(2);
    expect(timed.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout", authSource: "none", toolRoundTrip: false,
      diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 1, toolResultsCompleted: 1, providerRetries: 0,
        httpRequestsStarted: 2, httpResponsesReceived: 1, lastHttpStatus: 200 } });
    expect(timed.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_timeout" });
    expect(JSON.stringify(timed)).not.toMatch(/PRIVATE_KEY|PRIVATE_HEADER|private-generation-id|smoke-sentinel|127\.0\.0\.1|schway-live-/);
    holding = false;
    const passed = await runLiveProcesses({ ...selection, providers: ["compatible"] }, backstopOnly());
    expect(passed.scenarios[0]).toMatchObject({ status: "passed", reason: "verified", toolRoundTrip: true,
      diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1, providerRetries: 0,
        httpRequestsStarted: 2, httpResponsesReceived: 2, lastHttpStatus: 200 } });
    expect(calls).toBe(4);
  } finally { release(); server.stop(true); }
}, LANE_TEST_TIMEOUT_MS);

test("checkpoint write or rename failures do not change a verified supervised round trip", async () => {
  if (process.platform === "win32") return;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    return new Response(await sentinelSse(request), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    for (const blockedPath of [".smoke-progress.json.tmp", ".smoke-progress.json"]) {
      let root = "";
      const before = calls;
      const report = await runLiveProcesses({ ...settings(["compatible"], WORKER_BUDGET_MS), models: { compatible: "gpt-4o" },
        compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "none" } }, { ...backstopOnly(), onWorkspace: path => {
        root = path;
        // A directory deterministically rejects writing the temp file or renaming onto the destination.
        mkdirSync(join(path, blockedPath));
      } });
      expect(report.scenarios[0]).toMatchObject({ status: "passed", reason: "verified", toolRoundTrip: true, authSource: "none",
        diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1,
          httpRequestsStarted: 2, httpResponsesReceived: 2 } });
      expect(calls - before).toBe(2);
      await expect(access(root)).rejects.toThrow();
    }
  } finally { server.stop(true); }
}, LANE_TEST_TIMEOUT_MS);

test("private worker validates the shared thinking enum before any credential or catalog lookup", async () => {
  const safe = { provider: "grok", model: "grok-4.7", timeoutMs: 500, workspaceRoot: join(tmpdir(), "schway-live-fixture") };
  expect(parseWorkerInput({ ...safe, thinking: "medium" })).toMatchObject({ thinking: { grok: "medium" } });
  expect(parseWorkerInput(safe)).not.toHaveProperty("thinking");
  for (const thinking of [null, {}, ["medium"], 1, "MEDIUM", "medium\nPRIVATE_SECRET", "x".repeat(8192)]) {
    expect(() => parseWorkerInput({ ...safe, thinking })).toThrow("invalid instruction");
    let lookups = 0;
    await expect(runWorker(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...safe, thinking }))); controller.close();
    } }), {}, { createStore: () => { lookups++; throw Error("unexpected store"); },
      fetch: async () => { lookups++; throw Error("unexpected catalog"); } })).rejects.toThrow();
    expect(lookups).toBe(0);
  }
});

test("supervised production worker carries exact thinking into both real adapter requests, preserving omission", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    for (const provider of ["openai-api-key", "codex", "compatible", "grok", "xai-api-key"] as const) {
      const model = provider === "compatible" ? "meta/muse-spark-1.3-contributor" : provider === "codex" ? "gpt-6-sol"
        : provider === "openai-api-key" ? "gpt-6-luna" : "grok-4.7";
      const level = provider === "openai-api-key" ? "high" : "medium";
      for (const explicit of [true, false]) {
        const requestFile = join(temp, `${provider}-${explicit}.json`);
        const report = await runLiveProcesses({ enabled: true, providers: [provider], revision, timeoutMs: WORKER_BUDGET_MS,
          models: { [provider]: model }, ...(explicit ? { thinking: { [provider]: level } } : {}),
          compatible: { baseUrl: "https://openrouter.ai/api/v1", auth: "none" }, env: {
            SCHWAY_FIXTURE_MODE: "protocol", SCHWAY_FIXTURE_REQUEST_FILE: requestFile,
            OPENAI_API_KEY: "PRIVATE_KEY", XAI_API_KEY: "PRIVATE_XAI_KEY",
          } }, { workerFile: fixture, ...backstopOnly() });
        expect(report.scenarios[0]).toMatchObject({ provider, model, status: "passed", toolRoundTrip: true });
        if (explicit) expect(report.scenarios[0]?.thinking).toBe(level);
        else expect(report.scenarios[0]).not.toHaveProperty("thinking");
        const requests = JSON.parse(await readFile(requestFile, "utf8")) as Array<{ url: string; body?: Record<string, unknown> }>;
        const inference = requests.filter(request => request.body);
        expect(inference).toHaveLength(2);
        for (const request of inference) {
          const tools = request.body?.tools as Array<{ name?: string; parameters?: Record<string, unknown>;
            function?: { name?: string; parameters?: Record<string, unknown> } }>;
          const read = provider === "compatible" ? tools[0]?.function : tools[0];
          expect(read?.name).toBe("read");
          const validate = new Ajv().compile(read!.parameters!);
          expect(validate({ path: "smoke-sentinel.txt" })).toBe(true);
          // The exact absolute-path pattern observed in #189 must be disallowed on the wire.
          expect(validate({ path: "/tmp/schway-live-fixture/smoke-sentinel.txt", limit: 5 })).toBe(false);
        }
        expect(inference.map(request => request.body?.model)).toEqual([model, model]);
        expect(inference.map(request => request.body?.reasoning)).toEqual(explicit
          ? [provider === "compatible" ? { effort: level } : { effort: level, summary: "auto" },
            provider === "compatible" ? { effort: level } : { effort: level, summary: "auto" }]
          : [undefined, undefined]);
        expect(requests.filter(request => !request.body)).toHaveLength(explicit && provider !== "openai-api-key" ? 1 : 0);
        expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|smoke-sentinel|openrouter\.ai|schway-live-/);
      }
    }
  });
}, LANE_TEST_TIMEOUT_MS);

test("supervised account and endpoint discovery refuses unsupported or absent capabilities before inference", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    for (const provider of ["codex", "compatible", "grok", "xai-api-key"] as const) {
      for (const catalogMode of ["unsupported", "missing", "failure"]) {
        const requestFile = join(temp, `${provider}-${catalogMode}.json`);
        const report = await runLiveProcesses({ enabled: true, providers: [provider], revision, timeoutMs: WORKER_BUDGET_MS,
          models: { [provider]: provider === "compatible" ? "meta/muse-spark-1.3-contributor" : provider === "codex" ? "gpt-6-sol" : "grok-4.7" },
          thinking: { [provider]: "medium" }, compatible: { baseUrl: "https://openrouter.ai/api/v1", auth: "none" },
          env: { SCHWAY_FIXTURE_MODE: "protocol", SCHWAY_FIXTURE_REQUEST_FILE: requestFile,
            SCHWAY_FIXTURE_CATALOG_MODE: catalogMode, XAI_API_KEY: "PRIVATE_KEY" },
        }, { workerFile: fixture, ...backstopOnly() });
        expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", thinking: "medium", toolRoundTrip: false,
          reason: catalogMode === "failure" ? "thinking_capability_unavailable" : "unsupported_thinking" });
        const requests = JSON.parse(await readFile(requestFile, "utf8")) as Array<{ body?: unknown }>;
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body).toBeUndefined();
        expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|openrouter\.ai|schway-live-/);
      }
    }
  });
}, LANE_TEST_TIMEOUT_MS);

test("supervisor rejects dropped, changed, invalid or unsolicited thinking in bounded replies", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    for (const [expected, returned] of [["medium", undefined], ["medium", "high"], ["medium", "PRIVATE_SECRET"],
      ["medium", {}], [undefined, "off"]] as const) {
      const workerFile = join(temp, "reply.ts");
      await writeFile(workerFile, `let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
const input = JSON.parse(raw);
console.log(JSON.stringify({ provider: input.provider, model: input.model, thinking: ${JSON.stringify(returned) ?? "undefined"},
authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));`);
      const report = await runLiveProcesses({ ...settings(["openai-api-key"]),
        ...(expected ? { thinking: { "openai-api-key": expected } } : {}) }, { workerFile, ...backstopOnly() });
      expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error", toolRoundTrip: false });
      if (expected) expect(report.scenarios[0]?.thinking).toBe(expected);
      else expect(report.scenarios[0]).not.toHaveProperty("thinking");
      expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
    }
  });
}, LANE_TEST_TIMEOUT_MS);

test("supervisor preserves explicit thinking on timeout and later pending lanes", async () => {
  if (process.platform === "win32") return;
  let root = "";
  const deadline = heldDeadline();
  const pending = runLiveProcesses({ ...settings(["openai-api-key", "compatible"], 250),
    thinking: { "openai-api-key": "high", compatible: "medium" }, env: { SCHWAY_FIXTURE_MODE: "hang-stream" } },
  { workerFile: fixture, ...deadline.clock, onWorkspace: path => { root = path; } });
  const report = await expireAfterBarrier(pending, deadline, 250, () => waitForModelStart(() => root));
  expect(report.scenarios).toMatchObject([{ thinking: "high", status: "failed_provider", reason: "timeout" },
    { thinking: "medium", status: "pending", reason: "prior_run_timeout" }]);
}, LANE_TEST_TIMEOUT_MS);

test("installed thinking option reaches the production worker and unsupported compatible levels make no request", async () => {
  if (process.platform === "win32") return;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const body = await request.clone().json() as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    return new Response(await sentinelSse(request), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    for (const level of ["off", "medium"]) {
      const before = calls;
      const proc = Bun.spawn([process.execPath, "run", "live-smoke", "--enable-live", "--provider", "compatible",
        "--thinking", `compatible=${level}`, "--base-url", `http://127.0.0.1:${server.port}/v1`, "--auth", "none", "--timeout-ms", String(INSTALLED_BUDGET_MS)], {
        cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENAI_COMPATIBLE_API_KEY: "PRIVATE_UNUSED_KEY" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(exit).toBe(level === "off" ? 0 : 1);
      expect(calls - before).toBe(level === "off" ? 2 : 0);
      expect(JSON.parse(stdout).scenarios[0]).toMatchObject({ thinking: level, status: level === "off" ? "passed" : "failed_runner",
        reason: level === "off" ? "verified" : "unsupported_thinking" });
      expect(stdout + stderr).not.toContain("PRIVATE_UNUSED_KEY");
    }
  } finally { server.stop(true); }
}, installedTimeout(2));

test("supervised discovery accepts production-size catalogs before both inference rounds", async () => {
  if (process.platform === "win32") return;
  await withTempDir(async temp => {
    for (const [provider, catalogBytes, model] of [
      ["codex", 522_290, "gpt-6-sol"],
      ["compatible", 762_009, "meta/muse-spark-1.3-contributor"],
    ] as const) {
      const requestFile = join(temp, `${provider}.json`);
      const report = await runLiveProcesses({ enabled: true, providers: [provider], revision, timeoutMs: WORKER_BUDGET_MS,
        models: { [provider]: model }, thinking: { [provider]: "medium" },
        compatible: { baseUrl: "https://openrouter.ai/api/v1", auth: "none" },
        env: { SCHWAY_FIXTURE_MODE: "protocol", SCHWAY_FIXTURE_REQUEST_FILE: requestFile,
          SCHWAY_FIXTURE_CATALOG_BYTES: String(catalogBytes) },
      }, { workerFile: fixture, ...backstopOnly() });
      expect(report.scenarios[0]).toMatchObject({ status: "passed", reason: "verified", toolRoundTrip: true,
        diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1,
          httpRequestsStarted: 3, httpResponsesReceived: 3 } });
      const requests = JSON.parse(await readFile(requestFile, "utf8")) as Array<{ body?: Record<string, unknown> }>;
      expect(requests.filter(request => request.body).map(request => request.body?.model)).toEqual([model, model]);
    }
  });
}, LANE_TEST_TIMEOUT_MS);
