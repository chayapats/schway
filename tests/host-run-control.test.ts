import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHost, HostError, type HostClock, type HostOptions, type HostProgressEvent, type Model } from "schway/host";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

async function options(dir: string, limits?: Partial<HostOptions["limits"]>): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted fixture operator", sections: [], sources: [{ id: "evidence", revision: "v1", content: "inert" }] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096, ...limits } };
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Manual clock where sleeps resolve only when advanced, so deadline and backoff overlap exactly. */
function manualClock() {
  let t = 0;
  const timers: Array<{ at: number; resolve: () => void; reject: (error: Error) => void }> = [];
  const clock: HostClock & { advance: (ms: number) => Promise<void> } = {
    now: () => 1_700_000_000_000 + t,
    monotonicNow: () => t,
    sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const entry = { at: t + ms, resolve, reject };
      timers.push(entry);
      signal?.addEventListener("abort", () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
        reject(abortError());
      }, { once: true });
    }),
    advance: async (ms: number) => {
      const target = t + ms;
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        t = next.at;
        next.resolve();
        await new Promise(resolve => setImmediate(resolve));
      }
      t = target;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  return clock;
}

async function drive<T>(clock: { advance: (ms: number) => Promise<void> }, work: Promise<T>, steps = 50): Promise<T> {
  let settled = false;
  void work.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < steps && !settled; i++) await clock.advance(100);
  return work;
}

test("capabilities advertise the run-control contract without inference", async () => {
  const { hostCapabilities } = await import("schway/host");
  expect(hostCapabilities().runContract).toBe("schway.host.run-control/v1");
});

test("malformed or unlimited bounds fail admission before any session exists", async () => {
  await withTempDir(async dir => {
    const base = await options(dir);
    for (const limits of [
      { ...base.limits, deadlineMs: 0 }, { ...base.limits, deadlineMs: -5 },
      { ...base.limits, deadlineMs: Number.POSITIVE_INFINITY }, { ...base.limits, deadlineMs: Number.NaN },
      { ...base.limits, deadlineMs: 1.5 }, { ...base.limits, deadlineMs: 100_000_000 },
      { ...base.limits, maxAttempts: 0 }, { ...base.limits, maxAttempts: 11 },
      { ...base.limits, maxAttempts: Number.POSITIVE_INFINITY }, { ...base.limits, maxAttempts: 1.5 },
      { ...base.limits, maxTurns: Number.POSITIVE_INFINITY }, { ...base.limits, maxConcurrentTools: 0 },
    ]) {
      await expect(createHost({ ...base, limits })).rejects.toBeInstanceOf(HostError);
      expect(await Bun.file(join(base.sessionDirectory, "not-created")).exists()).toBe(false);
    }
    const bounded = await createHost({ ...base, limits: { ...base.limits, deadlineMs: 60_000, maxAttempts: 2 } });
    await bounded.close();
  });
});

test("deadline during retry backoff settles as limit-exceeded with incomplete usage and released ownership", async () => {
  await withTempDir(async dir => {
    const config = await options(dir, { deadlineMs: 500, maxAttempts: 3 });
    const host = await createHost(config), session = await host.createSession();
    const events: HostProgressEvent[] = [];
    const result = await session.submit({ text: "deadline backoff" },
      createScriptedModel({ responses: [
        { error: "overloaded", status: 503, headers: { "retry-after": "30" } },
        { text: "must not publish" },
      ] }), { onProgress: event => { events.push(event); } });
    expect(result.outcome).toBe("limit_exceeded");
    if (result.outcome !== "limit_exceeded") throw new Error("Expected limit_exceeded");
    expect("result" in result).toBe(false);
    expect(result.input.session).toEqual(session.reference);
    expect(result.model).toMatchObject({ id: "scripted" });
    expect(result.usage.complete).toBe(false);
    expect(result.usage.attempts.length).toBeGreaterThan(0);
    for (const attempt of result.usage.attempts) {
      expect(attempt.usage.inputTokens === null || Number.isSafeInteger(attempt.usage.inputTokens)).toBe(true);
    }
    expect(result.error.contextPolicy).toBe("strict");
    expect(result.error.toolPolicy).toBe("exact");
    expect(events.some(event => event.type === "retry" && event.transient)).toBe(true);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).toContain("deadline backoff");
    expect(saved).not.toContain("must not publish");
    // Released ownership: a follow-up run and idle close both succeed.
    expect(await session.submit({ text: "after deadline" }, createScriptedModel({ text: "recovered" }))).toMatchObject({ outcome: "completed" });
    await session.close();
    await host.close();
  });
});

test("manual-clock deadline fires during backoff and counts retries against the run bound", async () => {
  await withTempDir(async dir => {
    const config = await options(dir, { deadlineMs: 500, maxAttempts: 3 });
    const host = await createHost(config), session = await host.createSession();
    const clock = manualClock();
    const pending = session.submit({ text: "manual deadline" },
      createScriptedModel({ responses: [
        { error: "overloaded", status: 503 },
        { text: "late success" },
      ] }), { clock });
    const result = await drive(clock, pending);
    expect(result.outcome).toBe("limit_exceeded");
    if (result.outcome !== "limit_exceeded") throw new Error("Expected limit_exceeded");
    expect(result.usage.complete).toBe(false);
    expect("result" in result).toBe(false);
    await session.close();
    await host.close();
  });
});

test("cancel before input persistence rejects without model calls or durable input", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(session.submit({ text: "never accepted" },
      createScriptedModel({ responses: [() => { calls++; return { text: "bad" }; }] }), controller.signal)).rejects.toMatchObject({ code: "invalid-input" });
    expect(calls).toBe(0);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).not.toContain("never accepted");
    expect(await session.submit({ text: "after rejected cancel" }, createScriptedModel({ text: "ok" }))).toMatchObject({ outcome: "completed" });
    await session.close();
    await host.close();
  });
});

test("cancel after input persistence settles as cancelled with no late accepted answer", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const controller = new AbortController();
    const deltas: HostProgressEvent[] = [];
    const pending = session.submit({ text: "cancel me" },
      createScriptedModel({ chunks: ["par"], waitForAbort: true, text: "late" }), {
        signal: controller.signal,
        onProgress: event => {
          deltas.push(event);
          if (event.type === "delta") controller.abort();
        },
      });
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    if (result.outcome !== "cancelled") throw new Error("Expected cancelled");
    expect("result" in result).toBe(false);
    expect(result.input.session).toEqual(session.reference);
    expect(result.usage.complete).toBe(false);
    expect(result.usage.attempts.some(attempt => attempt.complete === false)).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every(event => event.transient)).toBe(true);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).toContain("cancel me");
    expect(saved).not.toContain("late");
    expect(await session.submit({ text: "after cancel" }, createScriptedModel({ text: "recovered" }))).toMatchObject({ outcome: "completed" });
    await session.close();
    await host.close();
  });
});

test("a provider callback that ignores cancellation cannot flip the terminal outcome or append late output", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const controller = new AbortController();
    const late: Model = { provider: "scripted", id: "late",
      async *stream(request) {
        yield { type: "text_delta", text: "partial" };
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 5));
        void request.signal;
        yield { type: "message_complete", message: { type: "assistant", id: "late-answer", content: [{ type: "text", text: "late answer" }] } };
      } };
    const result = await session.submit({ text: "late callback" }, late, controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect("result" in result).toBe(false);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).toContain("late callback");
    expect(saved).not.toContain("late answer");
    expect(await session.submit({ text: "next" }, createScriptedModel({ text: "ok" }))).toMatchObject({ outcome: "completed" });
    await session.close();
    await host.close();
  });
});

test("session cancel aborts retry waits and settles cooperative tools before releasing ownership", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    config.tools.definitions = [{ name: "cooperative", description: "Abort-aware fixture", execution: "exclusive" as const,
      effect: "read-only" as const, inputSchema: { type: "object" },
      async execute(_input, ctx) {
        await new Promise<void>((_resolve, reject) => {
          if (ctx.signal?.aborted) { reject(abortError()); return; }
          ctx.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
        return { content: "cooperative done" };
      } }];
    const host = await createHost(config), session = await host.createSession();
    const pending = session.submit({ text: "cooperative tools" }, createScriptedModel({ responses: [
      { toolCalls: [{ id: "coop", name: "cooperative", arguments: {} }] },
      { text: "must not run" },
    ] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    session.cancel();
    session.cancel();
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect("result" in result).toBe(false);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved).toContain("cooperative tools");
    expect(saved).not.toContain("must not run");
    // Repeated cancel and dispose stay safe; ownership releases after settlement.
    session.cancel();
    await session.close();
    await session.close();
    await host.close();
    await host.close();
  });
});

test("progress deltas are transient and dropping them never duplicates or completes a run", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const seen: HostProgressEvent[] = [];
    const throwing = (_event: HostProgressEvent): void => { throw new Error("observer failed"); };
    const result = await session.submit({ text: "transient progress" },
      createScriptedModel({ responses: [{ chunks: ["hel", "lo"] }, { text: "done" }] }),
      { onProgress: event => { seen.push(event); throwing(event); } });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("Expected completed");
    expect(result.result.entryId).toBe(result.message.id);
    expect(result.result.session).toEqual(session.reference);
    expect(result.usage.complete).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(event => event.transient)).toBe(true);
    expect(seen.some(event => event.type === "delta")).toBe(true);
    const saved = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    expect(saved.match(/transient progress/g)?.length).toBe(1);
    await session.close();
    await host.close();
  });
});

test("usage keeps null counters, per-attempt and compaction samples and completeness flags", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const nullUsage: Model = { provider: "scripted", id: "null-usage", async *stream() {
      yield { type: "usage", usage: { inputTokens: null, outputTokens: null } };
      yield { type: "text_delta", text: "answer" };
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: null, cachedInputTokens: null } };
      yield { type: "message_complete", message: { type: "assistant", id: "null-usage-answer", content: [{ type: "text", text: "answer" }] } };
    } };
    const completed = await session.submit({ text: "honest usage" }, nullUsage);
    expect(completed.outcome).toBe("completed");
    if (completed.outcome !== "completed") throw new Error("Expected completed");
    expect(completed.usage.complete).toBe(true);
    expect(completed.usage.attempts.length).toBeGreaterThan(0);
    expect(completed.usage.attempts.some(attempt => attempt.usage.outputTokens === null)).toBe(true);
    expect(JSON.stringify(completed.usage)).not.toContain('"inputTokens":0');
    expect(completed.message.telemetry?.usage.inputTokens === null || typeof completed.message.telemetry?.usage.inputTokens === "number").toBe(true);
    const failed = await session.submit({ text: "failed usage" }, createScriptedModel({ error: "fixture rejected", status: 400 }));
    expect(failed.outcome).toBe("error");
    if (failed.outcome !== "error") throw new Error("Expected error");
    expect(failed.usage.complete).toBe(false);
    expect(failed.error.message.length).toBeGreaterThan(0);
    expect(failed.error.contextPolicy).toBe("strict");
    expect(failed.error.toolPolicy).toBe("exact");
    await session.close();
    await host.close();
  });
});

test("failures preserve effective policy and sanitized diagnostics without secrets", async () => {
  await withTempDir(async dir => {
    const config = await options(dir, { maxTurns: 1 }), host = await createHost(config), session = await host.createSession();
    const failed = await session.submit({ text: "policy failure" }, createScriptedModel({ error: "fixture model unavailable", status: 404 }));
    expect(failed.outcome).toBe("error");
    if (failed.outcome !== "error") throw new Error("Expected error");
    expect(failed.model).toMatchObject({ provider: "scripted", id: "scripted" });
    expect(failed.error).toMatchObject({ contextPolicy: "strict", toolPolicy: "exact" });
    expect(failed.error.message).not.toMatch(/eyJ|Bearer|secret/i);
    const limited = await session.submit({ text: "round limit" }, createScriptedModel({ toolCalls: [{ id: "t", name: "missing", arguments: {} }] }));
    expect(limited.outcome).toBe("max_turns");
    await session.close();
    await host.close();
  });
});

test("failure diagnostics redact bearer/JWT/secret material defense-in-depth", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const raw = `upstream failure Bearer sentinel-bearer-abc123 ${jwt} secret=sentinel-secret-value sk-sentinel-key-xyz api_key="sentinel-api-value" ?token=sentinel-query-value`;
    const failed = await session.submit({ text: "secret leak" }, createScriptedModel({ error: raw, status: 400 }));
    expect(failed.outcome).toBe("error");
    if (failed.outcome !== "error") throw new Error("Expected error");
    for (const sentinel of ["sentinel-bearer-abc123", "sentinel-secret-value", "sentinel-key-xyz", "sentinel-api-value", "sentinel-query-value"]) {
      expect(failed.error.message).not.toContain(sentinel);
    }
    expect(failed.error.message).not.toMatch(/eyJ|Bearer/i);
    expect(failed.error.message).toContain("[redacted]");
    expect(failed.error.message).not.toContain("\n");
    expect(failed.error.message.length).toBeLessThanOrEqual(500);
    await session.close();
    await host.close();
  });
});

test("compact under deadline settles as limit-exceeded without durable summary", async () => {
  await withTempDir(async dir => {
    const config = await options(dir, { deadlineMs: 300 }), host = await createHost(config), session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const before = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
    const clock = manualClock();
    const slow: Model = { provider: "scripted", id: "slow-summary",
      async *stream(request) {
        if (request.signal?.aborted) return;
        await new Promise<void>(resolve => {
          if (request.signal?.aborted) { resolve(); return; }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } };
    const pending = session.compact(slow, { clock });
    const result = await drive(clock, pending);
    expect(result.outcome).toBe("limit_exceeded");
    expect("result" in result).toBe(false);
    expect(result.usage.complete).toBe(false);
    expect(await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8")).toBe(before);
    await session.close();
    await host.close();
  });
});

test("abort-ignoring clock still terminates settlement", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const ignoring: HostClock = {
      now: () => Date.now(),
      monotonicNow: () => performance.now(),
      sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    };
    const controller = new AbortController();
    const pending = session.submit({ text: "ignoring clock" },
      createScriptedModel({ waitForAbort: true }), { signal: controller.signal, clock: ignoring });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect("result" in result).toBe(false);
    await session.close();
    await host.close();
  });
});

test("busy handles reject new work while cancel settles and close stays idle-only", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    const controller = new AbortController();
    const pending = session.submit({ text: "busy run" }, createScriptedModel({ waitForAbort: true }), controller.signal);
    await expect(session.submit({ text: "queued" }, createScriptedModel())).rejects.toMatchObject({ code: "busy" });
    await expect(session.close()).rejects.toMatchObject({ code: "busy" });
    await expect(host.close()).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    expect((await pending).outcome).toBe("cancelled");
    expect(await session.submit({ text: "after busy" }, createScriptedModel({ text: "ok" }))).toMatchObject({ outcome: "completed" });
    await session.close();
    await host.close();
  });
});
