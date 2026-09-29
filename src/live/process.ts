import { constants } from "node:fs";
import { access, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTE_FALLBACK_MODELS } from "../model/catalog.ts";
import type { SmokeProvider, SmokeReport, SmokeScenario, SmokeSelection } from "./smoke.ts";
import { isSmokeAuthSource, parseSmokeDiagnostics, parseSmokeProgress, type SmokeProgress } from "./diagnostics.ts";

const MAX_REPLY_BYTES = 8192;
const REAP_MS = 1500;
const safeId = /^[a-zA-Z0-9._:/-]{1,100}$/;
const reasons = new Set(["verified", "missing_credentials", "credential_store_unavailable", "missing_subscription",
  "subscription_requires_login", "integration_unavailable", "compatible_endpoint_required", "timeout", "timeout_unsettled",
  "output_limit", "provider_error", "runner_error", "turn_limit", "no_final_response", "missing_tool_evidence",
  "invalid_settings", "cancelled", "cleanup_failed", "disallowed_tool"]);
const statuses = new Set(["passed", "skipped", "pending", "failed_provider", "failed_runner"]);

/** Private fixture seam; installed execution uses the production worker and inherited environment. */
export interface LiveProcessOptions {
  workerFile?: string;
  onWorkspace?: (path: string) => void;
}

function scenario(provider: SmokeProvider, model: string, status: SmokeScenario["status"], reason: string, durationMs = 0): SmokeScenario {
  return { provider, model: safeId.test(model) ? model : "invalid-model-id", authSource: "unavailable", status, reason, durationMs, toolRoundTrip: false };
}

function validReply(text: string, provider: SmokeProvider, model: string, timeoutMs: number): SmokeScenario | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    const diagnostics = data.diagnostics === undefined ? undefined : parseSmokeDiagnostics(data.diagnostics);
    if (Object.keys(data).some(key => !["provider", "model", "authSource", "status", "reason", "durationMs", "toolRoundTrip", "cleanup", "diagnostics"].includes(key))
      || data.provider !== provider || data.model !== model
      || !isSmokeAuthSource(data.authSource) || !statuses.has(data.status as string)
      || typeof data.reason !== "string" || !reasons.has(data.reason)
      || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0 || data.durationMs > timeoutMs + REAP_MS
      || typeof data.toolRoundTrip !== "boolean" || (data.cleanup !== undefined && data.cleanup !== "deferred")
      || (data.diagnostics !== undefined && !diagnostics)
      || (data.status === "passed" && (data.reason !== "verified" || data.toolRoundTrip !== true || data.cleanup !== undefined))) return;
    return { provider, model, authSource: data.authSource, status: data.status as SmokeScenario["status"],
      reason: data.reason, durationMs: data.durationMs, toolRoundTrip: data.toolRoundTrip,
      ...(data.cleanup === "deferred" ? { cleanup: "deferred" as const } : {}), ...(diagnostics ? { diagnostics } : {}) };
  } catch { return; }
}

async function readProgress(workspace: string): Promise<SmokeProgress | undefined> {
  // Read only after proven process-group stop; never follow a worker-created symlink or allocate an unbounded file.
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(workspace, ".smoke-progress.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return;
    const bytes = new Uint8Array(1025);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) return;
    return parseSmokeProgress(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
  } catch { return; }
  finally { await file?.close(); }
}

async function boundedOutput(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REPLY_BYTES) throw Error("oversized worker output");
      const endOfReply = value.indexOf(10);
      if (endOfReply >= 0) {
        if (endOfReply !== value.byteLength - 1) throw Error("invalid worker output frame");
        chunks.push(value.subarray(0, endOfReply));
        length--;
        break;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { reader.releaseLock(); }
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Kill and reap a dedicated POSIX process group; return false if the OS cannot prove it stopped. */
async function stopChild(child: ReturnType<typeof Bun.spawn>, force: boolean): Promise<boolean> {
  const pid = child.pid;
  const posix = process.platform !== "win32";
  if (force || (posix && groupAlive(pid))) {
    if (posix) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Verify below instead of trusting kill. */ }
    } else {
      try { child.kill("SIGKILL"); } catch { /* Verify below. */ }
    }
  }
  const end = performance.now() + REAP_MS;
  let exited = false;
  while (performance.now() < end) {
    exited = await Promise.race([child.exited.then(() => true, () => false), Bun.sleep(15).then(() => false)]);
    if (exited && (!posix || !groupAlive(pid))) break;
    if (posix && groupAlive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Verify on next iteration. */ }
    }
  }
  // Windows kill only reaps the direct child; descendants cannot be certified after forced termination.
  return exited && (posix ? !groupAlive(pid) : !force);
}

/** Run selected lanes one at a time in isolated OS workers, refusing another launch without proven stop. */
export async function runLiveProcesses(selection: SmokeSelection, options: LiveProcessOptions = {}): Promise<SmokeReport> {
  const scenarios: SmokeScenario[] = [];
  let stopped = true;
  let timedOut = false;
  for (const provider of [...new Set(selection.providers)]) {
    const model = selection.models?.[provider] ?? ({ "openai-api-key": ROUTE_FALLBACK_MODELS.openai, "xai-api-key": ROUTE_FALLBACK_MODELS.xai, compatible: ROUTE_FALLBACK_MODELS["openai-compatible"],
      codex: ROUTE_FALLBACK_MODELS.openai, grok: ROUTE_FALLBACK_MODELS.xai } as const)[provider];
    if (!selection.enabled) { scenarios.push(scenario(provider, model, "skipped", "live_disabled")); continue; }
    // Bun cannot certify or kill a Windows descendant tree without a Job Object. Never spend a call on a best-effort stop.
    if (process.platform === "win32") { scenarios.push(scenario(provider, model, "pending", "supervision_unavailable")); continue; }
    if (!stopped) { scenarios.push(scenario(provider, model, "pending", "prior_run_unsettled")); continue; }
    if (timedOut) { scenarios.push(scenario(provider, model, "pending", "prior_run_timeout")); continue; }
    if (selection.signal?.aborted) { scenarios.push(scenario(provider, model, "pending", "cancelled")); continue; }
    const start = performance.now();
    let workspace: string | undefined;
    let result = scenario(provider, model, "failed_runner", "runner_error");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let reason: "timeout" | "cancelled" | undefined;
    let hardDeadline = false;
    const guardSetup = () => {
      const stop = selection.signal?.aborted ? "cancelled" : performance.now() - start >= selection.timeoutMs ? "timeout" : undefined;
      if (stop) { reason = stop; if (stop === "timeout") timedOut = true; throw Error("setup stopped"); }
    };
    try {
      if (!safeId.test(model) || !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1 || selection.timeoutMs > 120_000) {
        result.reason = "invalid_settings";
      } else {
        workspace = await mkdtemp(join(tmpdir(), "schway-live-"));
        guardSetup();
        options.onWorkspace?.(workspace);
        // There is no await between this guard and spawn: cancellation during mkdir
        // or an onWorkspace callback must never start a selected paid worker.
        guardSetup();
        // No secrets enter argv or stdin: provider credentials are resolved inside this worker.
        child = Bun.spawn([process.execPath, "--no-env-file", options.workerFile ?? fileURLToPath(new URL("./worker.ts", import.meta.url))], {
          cwd: workspace, env: selection.env, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true,
        });
        const input = JSON.stringify({ provider, model, timeoutMs: selection.timeoutMs, compatible: provider === "compatible" ? selection.compatible : undefined, workspaceRoot: workspace });
        if (input.length > 8192) throw Error("instruction too large");
        if (!child.stdin || typeof child.stdin === "number" || !child.stdout || typeof child.stdout === "number") throw Error("worker pipes unavailable");
        child.stdin.write(input);
        child.stdin.end();
        const output = boundedOutput(child.stdout);
        const deadline = new Promise<{ reason: "timeout" | "cancelled" }>(resolve => {
          const remaining = Math.max(0, selection.timeoutMs - (performance.now() - start));
          timer = setTimeout(() => resolve({ reason: "timeout" }), remaining);
          abort = () => resolve({ reason: "cancelled" });
          selection.signal?.addEventListener("abort", abort, { once: true });
          if (selection.signal?.aborted) resolve({ reason: "cancelled" });
        });
        const first = await Promise.race([output, deadline]);
        if (typeof first !== "string") {
          reason = first.reason;
          if (reason === "timeout") { timedOut = true; hardDeadline = true; }
          result = scenario(provider, model, reason === "cancelled" ? "pending" : "failed_runner", reason);
        } else {
          const reply = validReply(first, provider, model, selection.timeoutMs);
          // A deferred reply is already a real provider outcome. Hard-stop its
          // uncooperative worker now, rather than waiting for exit/deadline and erasing it.
          const exit = reply?.cleanup === "deferred" ? 0 : await Promise.race([child.exited, deadline]);
          if (typeof exit !== "number") {
            reason = exit.reason;
            if (reason === "timeout") { timedOut = true; hardDeadline = true; }
            result = scenario(provider, model, reason === "cancelled" ? "pending" : "failed_runner", reason);
          } else if (performance.now() - start >= selection.timeoutMs) {
            timedOut = true;
            hardDeadline = true;
            result = scenario(provider, model, "failed_runner", "timeout");
          } else result = exit === 0 ? reply ?? result : result;
        }
      }
    } catch {
      result = reason && !child ? scenario(provider, model, reason === "cancelled" ? "pending" : "failed_runner", reason)
        : scenario(provider, model, "failed_runner", "runner_error");
    }
    finally {
      if (timer) clearTimeout(timer);
      if (result.reason === "timeout" || result.reason === "timeout_unsettled") timedOut = true;
      if (abort) selection.signal?.removeEventListener("abort", abort);
      if (child) {
        // Even a successful direct-child exit cannot authorize another paid call if a descendant remains.
        const unexpectedGroup = result.status === "passed" && groupAlive(child.pid);
        stopped = await stopChild(child, reason !== undefined || result.reason === "runner_error" || result.cleanup === "deferred");
        if (!stopped) {
          result = scenario(provider, model, "failed_runner", "process_stop_unverified");
          result.cleanup = "deferred";
        } else if (unexpectedGroup) {
          result = scenario(provider, model, "failed_runner", "process_group_leak");
        } else if (result.reason === "timeout_unsettled") {
          result.reason = "timeout";
        }
      }
      if (workspace && stopped && hardDeadline) {
        const progress = await readProgress(workspace);
        if (progress) {
          result.authSource = progress.authSource;
          result.diagnostics = progress.diagnostics;
        }
        try { await access(join(workspace, ".model-started")); result.status = "failed_provider"; }
        catch { /* No stream-start evidence: a setup deadline is a runner failure. */ }
      }
      if (workspace && stopped) {
        try { await rm(workspace, { recursive: true, force: true }); delete result.cleanup; }
        catch { result = scenario(provider, model, "failed_runner", "cleanup_failed"); result.cleanup = "deferred"; }
      }
      result.durationMs = Math.round(performance.now() - start);
      scenarios.push(result);
    }
  }
  const aggregate = scenarios.some(s => s.status === "failed_provider" || s.status === "failed_runner") ? "failed"
    : scenarios.length > 0 && scenarios.every(s => s.status === "passed") ? "passed" : "incomplete";
  return { testedAt: new Date().toISOString(), revision: safeId.test(selection.revision) ? selection.revision : "unknown", aggregate, scenarios };
}
