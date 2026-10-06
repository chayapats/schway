import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { streamModelTurn, type AgentClock } from "../src/agent/retry.ts";
import { createHistoryTelemetryFold } from "../src/history/telemetry.ts";
import { runCli } from "../src/cli/runtime.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createHistoryCollector, historyTurnIdentity } from "../src/history/collector.ts";
import { MAX_HISTORY_RECORD_BYTES, parseHistoryLine, serializeHistoryFinalize, type HistoryCommand, type HistoryTelemetry, type HistoryTurnFinalize } from "../src/history/records.ts";
import { historyFilePath, openHistoryStore } from "../src/history/store.ts";
import { buildHistoryTimeline, type HistoryTurn } from "../src/history/timeline.ts";
import type { Model, ModelRequest } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { TuiController } from "../src/tui/controller.ts";
import { historyCacheLabel, historyCommandLine, historyDetailsText, historyTimingLine, historyTimingSegments } from "../src/tui/controller-history.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-history-telemetry-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const total = (value: number, reportedCalls: number) => ({ total: value, reportedCalls });
/** Telemetry for the 8.4-minute turn: 12 calls, 162 s of model time and 342 s of tool time. */
const TELEMETRY: HistoryTelemetry = { modelCalls: 12, modelMs: 162_000, firstDelta: { minMs: 4700, maxMs: 31_000, calls: 12 }, retries: 1, retryWaitMs: 1000,
  toolCalls: 30, toolMs: 342_000, approvalWaitMs: 0,
  tokens: { input: total(530_000, 12), cachedInput: total(429_300, 12), output: total(9000, 12), reasoning: total(7000, 12) } };
const finalize = (overrides: Partial<HistoryTurnFinalize> = {}): HistoryTurnFinalize => ({ type: "turn_finalize", version: 1, turnId: "user-1", attemptId: "attempt-1", revision: 1,
  outcome: "completed", finishedAt: "2026-01-15T09:38:24.000Z", activeMs: 504_000, toolResults: 30, failedTools: 0,
  commands: { total: 0, exitZero: 0, nonzero: 0, unknown: 0, truncated: false, items: [] }, files: { total: 0, truncated: false, items: [] }, git: { status: "captured" }, ...overrides });
/** A turn_finalize line exactly as builds before telemetry wrote it. */
const LEGACY_FINALIZE = '{"type":"turn_finalize","version":1,"turnId":"user-1","attemptId":"attempt-1","revision":1,"outcome":"completed","finishedAt":"2026-01-15T09:31:00.000Z","activeMs":60000,"toolResults":1,"failedTools":0,"commands":{"total":1,"exitZero":1,"nonzero":0,"unknown":0,"truncated":false,"items":[{"id":"0123456789abcdef","command":"bun test","exitCode":0,"ended":"exit","status":"success"}]},"files":{"total":0,"truncated":false,"items":[]},"git":{"status":"captured"}}';

/** A recorded turn whose attempts carry the given telemetry. */
const turnWith = (...telemetry: (HistoryTelemetry | undefined)[]): HistoryTurn => ({ turnId: "user-1", ordinal: 1, taskTruncated: false, taskHidden: false, evidence: "recorded",
  outcome: "completed", activeMs: 504_000, unknownDurations: 0, incompleteAttempts: 0, toolResults: 30, failedTools: 0,
  attempts: telemetry.map((entry, index) => ({ attemptId: `attempt-${index}`, mode: "tui", workspaceRoot: "/work", startedAt: "2026-01-15T09:30:00.000Z", outcome: "completed",
    activeMs: 504_000, git: { status: "captured" }, ...(entry ? { telemetry: entry } : {}) })),
  commands: { total: 0, exitZero: 0, nonzero: 0, unknown: 0, truncated: false, items: [] }, files: { total: 0, truncated: false, items: [] }, oversized: 0, undo: [] });

test("finalize records with telemetry and command durations round-trip, and invalid telemetry is rejected strictly", () => {
  const command: HistoryCommand = { id: "0123456789abcdef", command: "curl -s example.test", exitCode: 0, ended: "exit", status: "success", durationMs: 49_800, approvalWaitMs: 1200 };
  const record = finalize({ telemetry: TELEMETRY, commands: { total: 1, exitZero: 1, nonzero: 0, unknown: 0, truncated: false, items: [command] } });
  expect(parseHistoryLine(serializeHistoryFinalize(record).trim())).toEqual(record);
  const reject = (telemetry: unknown) => expect(parseHistoryLine(JSON.stringify({ ...record, telemetry }))).toBeUndefined();
  reject({ ...TELEMETRY, modelMs: -1 });
  reject({ ...TELEMETRY, toolMs: 1.5 });
  reject({ ...TELEMETRY, firstDelta: { minMs: 9, maxMs: 3, calls: 1 } });
  reject({ ...TELEMETRY, firstDelta: { minMs: 1, maxMs: 3, calls: 13 } });
  reject({ ...TELEMETRY, tokens: { ...TELEMETRY.tokens, cachedInput: total(1, 13) } });
  reject({ ...TELEMETRY, tokens: { ...TELEMETRY.tokens, reasoning: undefined } });
  reject("fast");
  expect(parseHistoryLine(JSON.stringify({ ...record, commands: { ...record.commands, items: [{ ...command, approvalWaitMs: 60_000 }] } }))).toBeUndefined();
});

test("a pre-telemetry finalize line still parses and its turn shows timings as unknown, never zeros", async () => {
  const parsed = parseHistoryLine(LEGACY_FINALIZE) as HistoryTurnFinalize;
  expect(parsed.telemetry).toBeUndefined();
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root, launchCwd: root, extraRoots: [] } });
  session.append({ type: "user", id: "user-1", content: [{ type: "text", text: "Check" }] }, { type: "assistant", id: "a1", content: [{ type: "text", text: "Done." }] });
  const store = openHistoryStore({ home });
  await store.start(session.rootId, { type: "turn_start", version: 1, turnId: "user-1", attemptId: "attempt-1", ordinal: 1, branchId: "main", parentId: session.rootId,
    workspaceRoot: root, mode: "tui", startedAt: "2026-01-15T09:30:00.000Z", task: "Check" });
  await Bun.write(historyFilePath(home, session.rootId), `${await readFile(historyFilePath(home, session.rootId), "utf8")}${LEGACY_FINALIZE}\n`);
  const turn = buildHistoryTimeline(await store.read(session.rootId), session).turns[0]!;
  expect(turn.outcome).toBe("completed");
  expect(turn.attempts[0]!.telemetry).toBeUndefined();
  expect(historyTimingLine(turn, 120)).toBe("");
  expect(historyCommandLine(turn.commands.items[0]!).text).toBe("bun test · Exit 0");
  const details = historyDetailsText({ unsaved: {} }, turn);
  expect(details).toContain("Timing and token details were not recorded for this attempt.");
  expect(details).not.toContain("Token counts are what the provider reported");
});

test("a duplicate finalization with different timings adds no revision", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root, launchCwd: root, extraRoots: [] } });
  session.append({ type: "user", id: "user-1", content: [{ type: "text", text: "Retry" }] });
  let now = 0;
  const collector = createHistoryCollector({ store: openHistoryStore({ home }), identity: historyTurnIdentity(session, root, "tui")!, clock: () => now });
  await collector.start();
  collector.observe({ type: "model.started", provider: "scripted", model: "timed" });
  collector.observe({ type: "model.retry", attempt: 1, maxAttempts: 3, delayMs: 1000, message: "unavailable", cause: "provider" });
  collector.observe({ type: "model.usage", phase: "turn", usage: { inputTokens: null, outputTokens: null }, complete: false, firstDeltaMs: null, attemptMs: 200, retryWaitMs: 1000 });
  collector.observe({ type: "model.started", provider: "scripted", model: "timed" });
  collector.observe({ type: "model.usage", phase: "turn", usage: { inputTokens: null, outputTokens: null }, complete: true, firstDeltaMs: 40, attemptMs: 300 });
  collector.observe({ type: "tool.finished", toolCallId: "b1", name: "bash", status: "success", content: "ok", details: { command: "date", exitCode: 0 }, startedAt: "2026-01-15T09:30:01.500Z", durationMs: 400 });
  now = 1900;
  await collector.finalize({ observation: { status: "unavailable", reason: "not-captured" } });
  // A late duplicate delivery with another duration is ignored, and only the active time moved on.
  collector.observe({ type: "tool.finished", toolCallId: "b1", name: "bash", status: "success", content: "ok", details: { command: "date", exitCode: 0 }, startedAt: "2026-01-15T09:30:01.500Z", durationMs: 9000 });
  now = 5000;
  await collector.finalize({ observation: { status: "unavailable", reason: "not-captured" } });
  const read = await openHistoryStore({ home }).read(session.rootId);
  expect(read.finalizes.map(record => [record.revision, record.activeMs, record.telemetry?.retries, record.telemetry?.retryWaitMs, record.telemetry?.modelMs, record.telemetry?.toolMs,
    record.commands.items[0]?.durationMs])).toEqual([[1, 1900, 1, 1000, 500, 400, 400]]);
});

test("cancelling during a retry backoff records the time waited but no retry", async () => {
  let t = 0;
  // The user stops the turn 25 s into a 30 s backoff.
  const clock: AgentClock = { now: () => Date.parse("2026-01-15T09:30:00.000Z") + t, monotonicNow: () => t,
    sleep: async () => { t += 25_000; throw Object.assign(new Error("aborted"), { name: "AbortError" }); } };
  const limited = Object.assign(new Error("Too many requests"), { status: 429, headers: { "retry-after": "30" } });
  const model: Model = { provider: "scripted", id: "timed", async *stream() { t += 300; throw limited; } };
  const events: RuntimeEvent[] = [];
  const generator = streamModelTurn({ model, request: { systemPrompt: "", context: [], items: [] }, clock });
  let next = await generator.next();
  while (!next.done) { events.push(next.value); next = await generator.next(); }
  expect(next.value).toEqual({ kind: "cancelled" });
  expect(events.find(event => event.type === "model.retry")).toMatchObject({ delayMs: 30_000 });
  expect(events.find(event => event.type === "model.usage")).toMatchObject({ complete: false, attemptMs: 300, retryWaitMs: 25_000 });
  const fold = createHistoryTelemetryFold();
  for (const event of events) fold.observe(event);
  expect(fold.summary()).toMatchObject({ modelCalls: 1, modelMs: 300, retries: 0, retryWaitMs: 25_000 });
  expect(historyDetailsText({ unsaved: {} }, turnWith(fold.summary()))).toContain("  Model: 1 call · 0.3s · no text or thinking before completion · no retries · 25s backoff before stop");
});

test("a call whose cached count exceeds its own input makes the cache share unreported, whatever other calls report", () => {
  const fold = createHistoryTelemetryFold();
  fold.observe({ type: "model.usage", phase: "turn", complete: true, attemptMs: 10, firstDeltaMs: 5, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 150, reasoningTokens: 4 } });
  fold.observe({ type: "model.usage", phase: "turn", complete: true, attemptMs: 10, firstDeltaMs: 5, usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 30 } });
  const summary = fold.summary();
  // The totals alone (1,100 input, 150 cached) would have shown 13% cached.
  expect(summary.tokens).toEqual({ input: total(1100, 2), cachedInput: { total: 0, reportedCalls: 1, inconsistentCalls: 1 }, output: total(30, 2),
    reasoning: { total: 4, reportedCalls: 1, inconsistentCalls: 1 } });
  expect(historyCacheLabel(summary)).toBe("Cache not reported");
  expect(historyTimingLine(turnWith(summary), 120)).toBe("Model 0.0s · Cache not reported");
  const details = historyDetailsText({ unsaved: {} }, turnWith(summary));
  expect(details).toContain("cached input 0 (1 of 2 calls counted; 1 call ignored, cached above input)");
  expect(details).toContain("reasoning 4 (1 of 2 calls counted; 1 call ignored, reasoning above output)");
  expect(details).toContain("is ignored for that count.");
  // Every call ignored, and more than one: one note names the bound with a plural count.
  const all = { ...summary, tokens: { ...summary.tokens, cachedInput: { total: 0, reportedCalls: 0, inconsistentCalls: 2 } } };
  expect(historyDetailsText({ unsaved: {} }, turnWith(all))).toContain("cached input unusable (2 calls ignored, cached above input)");
  // Records keep the flag, and coverage plus inconsistent calls cannot exceed the call count.
  const record = finalize({ telemetry: summary });
  expect((parseHistoryLine(serializeHistoryFinalize(record).trim()) as HistoryTurnFinalize).telemetry).toEqual(summary);
  expect(parseHistoryLine(JSON.stringify({ ...record, telemetry: { ...summary, tokens: { ...summary.tokens, cachedInput: { total: 0, reportedCalls: 2, inconsistentCalls: 1 } } } }))).toBeUndefined();
  for (const key of ["input", "output"] as const)
    expect(parseHistoryLine(JSON.stringify({ ...record, telemetry: { ...summary, tokens: { ...summary.tokens, [key]: { ...summary.tokens[key], inconsistentCalls: 1 } } } }))).toBeUndefined();
  // Valid per-call counts keep the share.
  const valid = createHistoryTelemetryFold();
  valid.observe({ type: "model.usage", phase: "turn", complete: true, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 100 } });
  valid.observe({ type: "model.usage", phase: "turn", complete: true, usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0 } });
  expect(historyCacheLabel(valid.summary())).toBe("9% cached");
});

test("worst-case telemetry and command timings stay within 128 KiB", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const telemetry: HistoryTelemetry = { modelCalls: max, modelMs: max, firstDelta: { minMs: max, maxMs: max, calls: max }, retries: max, retryWaitMs: max, toolCalls: max, toolMs: max,
    approvalWaitMs: max, tokens: { input: total(max, max), cachedInput: total(max, max), output: total(max, max), reasoning: total(max, max) } };
  const commands = Array.from({ length: 50 }, (_, index): HistoryCommand => ({ id: index.toString(16).padStart(16, "0"), command: "ก้".repeat(100), commandTruncated: true,
    exitCode: max, ended: "exit", status: "success", durationMs: max, approvalWaitMs: max }));
  const files = Array.from({ length: 200 }, (_, index) => ({ path: `${index}/${"ก้".repeat(600)}`, source: "tool" as const, added: max, removed: max }));
  const line = serializeHistoryFinalize(finalize({ activeMs: max, toolResults: max, failedTools: max, oversized: max, telemetry,
    commands: { total: max, exitZero: max, nonzero: max, unknown: max, truncated: false, items: commands }, files: { total: max, truncated: false, items: files } }));
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_HISTORY_RECORD_BYTES);
  const parsed = parseHistoryLine(line.trim()) as HistoryTurnFinalize;
  expect(parsed.telemetry).toEqual(telemetry);
  expect(parsed.commands.items.length).toBeGreaterThan(0);
});

test("the detail line shows model time, tool time and the cache share, dropping the cache share first when narrow", () => {
  const turn = turnWith(TELEMETRY);
  expect(historyTimingLine(turn, 120)).toBe("Model 2m 42s · Tools 5m 42s · 81% cached");
  expect(historyTimingLine(turn, 30)).toBe("Model 2m 42s · Tools 5m 42s");
  expect(historyTimingSegments(turnWith(undefined))).toEqual({ times: [], cache: "" });
  // An attempt without telemetry makes every total a lower bound.
  expect(historyTimingLine(turnWith(TELEMETRY, undefined), 120)).toBe("Model 2m 42s+ · Tools 5m 42s+ · 429,300+ tokens cached");
  expect(historyTimingLine(turnWith({ ...TELEMETRY, toolCalls: 0, toolMs: 0 }), 120)).toBe("Model 2m 42s · 81% cached");
});

test("the cache share needs every call to report input and cached counts, otherwise it is a lower bound or not reported", () => {
  const tokens = (input: [number, number], cached: [number, number]) => ({ ...TELEMETRY, tokens: { ...TELEMETRY.tokens, input: total(...input), cachedInput: total(...cached) } });
  expect(historyCacheLabel(tokens([1000, 12], [810, 12]))).toBe("81% cached");
  expect(historyCacheLabel(tokens([1000, 12], [0, 12]))).toBe("0% cached");
  expect(historyCacheLabel(tokens([1000, 12], [0, 0]))).toBe("Cache not reported");
  expect(historyCacheLabel(tokens([1000, 12], [400, 5]))).toBe("40%+ cached");
  expect(historyCacheLabel(tokens([1000, 7], [4000, 5]))).toBe("4,000+ tokens cached");
  expect(historyCacheLabel(tokens([1000, 12], [1200, 12]))).toBe("Cache not reported");
  expect(historyCacheLabel({ ...TELEMETRY, modelCalls: 0 })).toBe("");
});

test("F2 details list per-attempt timing, tokens with coverage and the caveats, with singular and plural counts", () => {
  const details = historyDetailsText({ unsaved: {} }, turnWith(TELEMETRY));
  expect(details).toContain("  Model: 12 calls · 2m 42s · first output 4.7s–31s · 1 retry, 1.0s backoff");
  expect(details).toContain("  Tools: 30 timed calls · 5m 42s wall time");
  expect(details).toContain("  Tokens: input 530,000 · cached input 429,300 · output 9,000 · reasoning 7,000");
  expect(details).toContain("Token counts are what the provider reported, not billing.");
  expect(details).toContain("parallel tools count once");
  expect(details).toContain("No first output means no text or thinking arrived before the call completed.");
  const single: HistoryTelemetry = { modelCalls: 1, modelMs: 900, firstDelta: null, retries: 0, retryWaitMs: 0, toolCalls: 1, toolMs: 4800, approvalWaitMs: 3000,
    tokens: { input: total(100, 1), cachedInput: total(0, 0), output: total(5, 1), reasoning: total(0, 0) } };
  const one = historyDetailsText({ unsaved: {} }, turnWith(single));
  expect(one).toContain("  Model: 1 call · 0.9s · no text or thinking before completion · no retries");
  expect(one).toContain("  Tools: 1 timed call · 4.8s wall time · 3.0s approval wait");
  expect(one).toContain("  Tokens: input 100 · cached input not reported · output 5 · reasoning not reported");
  const partial: HistoryTelemetry = { ...TELEMETRY, retries: 2, retryWaitMs: 3000, firstDelta: { minMs: 800, maxMs: 800, calls: 1 },
    tokens: { ...TELEMETRY.tokens, cachedInput: total(4000, 1) } };
  const some = historyDetailsText({ unsaved: {} }, turnWith(partial));
  expect(some).toContain("first output 0.8s (1 of 12 calls) · 2 retries, 3.0s backoff");
  expect(some).toContain("cached input 4,000 (1 of 12 calls reported)");
  expect(historyDetailsText({ unsaved: {} }, turnWith({ ...single, modelCalls: 0, toolCalls: 0, tokens: { ...single.tokens, input: total(0, 0), output: total(0, 0) } })))
    .toContain("  Model: no calls\n  Tools: no timed calls");
});

test("a command line shows its run time without the approval wait", () => {
  const command: HistoryCommand = { id: "0".repeat(16), command: "bun test", exitCode: 1, ended: "exit", status: "success", durationMs: 4800, approvalWaitMs: 3000 };
  expect(historyCommandLine(command).text).toBe("bun test · Exit 1 · 1.8s");
  expect(historyCommandLine({ ...command, status: "cancelled", exitCode: null, ended: "stopped", approvalWaitMs: undefined }).text).toBe("bun test · Stopped · 4.8s");
});

/** Deterministic clock whose monotonic reading advances a fixed step per read, so identical code paths read identical times. */
function tickingClock(): AgentClock {
  let t = 0;
  return { now: () => Date.parse("2026-01-15T09:30:00.000Z") + t, monotonicNow: () => (t += 7), sleep: async () => {} };
}

/** Model that writes a file, then answers, reporting usage with cached and reasoning subsets. */
function usageModel(): Model {
  let round = 0;
  return { provider: "scripted", id: "scripted", async *stream(_request: ModelRequest) {
    round++;
    yield { type: "thinking_delta", text: "Plan" };
    yield { type: "usage", usage: { inputTokens: 1000 * round, outputTokens: 50, cachedInputTokens: round === 1 ? null : 800, reasoningTokens: 20 } };
    yield { type: "message_complete", message: round === 1
      ? { type: "assistant", id: crypto.randomUUID(), content: [{ type: "tool_call", id: "w1", name: "write", arguments: { path: "h.txt", content: "h\n" } }] }
      : { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Done." }] } };
  } };
}

test("headless and TUI attempts of the same scripted turn record the same aggregates", async () => {
  const dir = await temp();
  const headlessHome = join(dir, "headless"), tuiHome = join(dir, "tui"), headlessRoot = join(dir, "headless-work"), tuiRoot = join(dir, "tui-work");
  await mkdir(headlessRoot, { recursive: true });
  await mkdir(tuiRoot, { recursive: true });
  const out: string[] = [];
  expect(await runCli(["-p", "Write h", "--json"], { stdout: { write: text => { out.push(text); } }, stderr: { write: () => {} }, env: { HOME: headlessHome }, cwd: headlessRoot,
    model: usageModel(), credentialStore: fakeCredentialStore(), clock: tickingClock() })).toBe(0);
  const headlessId = (JSON.parse(out.join("").split("\n")[0]!) as { sessionId: string }).sessionId;
  // Headless --json carries the optional timing fields because they are part of RuntimeEvent.
  const events = out.join("").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  expect(events.find(event => event.type === "model.usage")).toMatchObject({ phase: "turn", firstDeltaMs: expect.any(Number), attemptMs: expect.any(Number), startedAt: expect.any(String),
    usage: { inputTokens: 1000, outputTokens: 50, cachedInputTokens: null, reasoningTokens: 20 } });
  expect(events.find(event => event.type === "tool.finished")).toMatchObject({ name: "write", durationMs: expect.any(Number), startedAt: expect.any(String) });
  const headlessRecord = (await openHistoryStore({ home: headlessHome }).read(headlessId)).finalizes.at(-1)!;

  const workspace = { root: tuiRoot, launchCwd: tuiRoot, extraRoots: [] };
  const session = await createJsonlSession({ directory: sessionsDirectory(tuiHome), workspace });
  const c = new TuiController({ session, workspace, home: tuiHome, sessionId: session.header.id, provider: "scripted", modelId: "scripted", model: usageModel(),
    contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool]), changeTracking: "off", activityClock: () => 0, agentClock: tickingClock() });
  cleanups.push(() => c.dispose());
  expect(await c.submit("Write h")).toBe(true);
  const tuiRecord = (await openHistoryStore({ home: tuiHome }).read(session.rootId)).finalizes.at(-1)!;

  expect(headlessRecord.telemetry).toMatchObject({ modelCalls: 2, retries: 0, toolCalls: 1, firstDelta: { calls: 2 },
    tokens: { input: total(3000, 2), cachedInput: total(800, 1), output: total(100, 2), reasoning: total(40, 2) } });
  expect(headlessRecord.telemetry!.modelMs).toBeGreaterThan(0);
  expect(headlessRecord.telemetry!.toolMs).toBeGreaterThan(0);
  expect(tuiRecord.telemetry).toEqual(headlessRecord.telemetry!);
  // The saved conversation carries the same per-item telemetry in both modes.
  const headlessSession = await loadJsonlSession({ directory: sessionsDirectory(headlessHome), id: headlessId });
  const telemetryOf = (items: readonly { type: string; telemetry?: unknown }[]) => items.flatMap(item => "telemetry" in item ? [item.telemetry] : []);
  expect(telemetryOf(session.items)).toEqual(telemetryOf(headlessSession.items));
  expect(telemetryOf(session.items)).toHaveLength(3);
});
