import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHost, hostCapabilities, HostError, MAX_STEERS_PER_RUN, STEERING_CONTRACT,
  type HostDispatch, type HostOptions, type HostProgressEvent, type HostSession, type Model, type ModelRequest, type ToolDefinition } from "schway/host";
import { runAgentLoop } from "../src/agent/loop.ts";
import { grokSubscriptionIdentity } from "../src/auth/store.ts";
import { createContextManager } from "../src/context/manager.ts";
import { openSteeringWindow } from "../src/host/steering.ts";
import { createSession } from "../src/session/session.ts";
import { collect } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";

async function options(dir: string, limits?: Partial<HostOptions["limits"]>, definitions: ToolDefinition[] = [], auth?: HostOptions["auth"]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted fixture operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions },
    limits: { maxTurns: 4, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 256, ...limits },
    ...(auth ? { auth } : {}) };
}

/** One-shot gate a test opens explicitly, so steer timing never depends on wall-clock waits. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

/** Readable request history: user text, tool results and assistant turns in model order. */
function history(request: ModelRequest): string[] {
  return request.items.map(item => item.type === "user" ? `user:${item.content.map(part => part.type === "text" ? part.text : "[image]").join("")}`
    : item.type === "tool_result" ? `tool:${item.toolCallId}` : "assistant");
}

interface Turn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string }>;
  /** Signalled when this turn's request reaches the model. */
  started?: () => void;
  /** Hold the response until this resolves. */
  hold?: Promise<void>;
  /** Hold until the run is cancelled, then fail as aborted. */
  untilAbort?: boolean;
}

/** Scripted model with per-turn barriers that records every request it receives. */
function stagedModel(turns: Turn[], requests: ModelRequest[]): Model {
  let index = 0;
  return { provider: "scripted", id: "steering", async *stream(request) {
    const turn = turns[index++];
    if (!turn) throw new Error("scripted model has no more responses");
    requests.push(request);
    turn.started?.();
    if (turn.hold) await turn.hold;
    if (turn.untilAbort) {
      await new Promise<void>(resolve => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error;
    }
    if (turn.text) yield { type: "text_delta", text: turn.text };
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [
      ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
      ...(turn.toolCalls ?? []).map(call => ({ type: "tool_call" as const, id: call.id, name: call.name, arguments: {} })),
    ] } };
  } };
}

/** Exclusive fixture tool that blocks on a gate and signals when it starts. */
function blockingTool(started: () => void, release: Promise<void>): ToolDefinition {
  return { name: "wait", description: "Blocks until the test releases it", execution: "exclusive", effect: "read-only",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { started(); await release; return { content: "tool done" }; } };
}

async function saved(config: HostOptions, session: HostSession): Promise<string> {
  return readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
}

test("capabilities advertise the steering contract without inference", () => {
  expect(STEERING_CONTRACT).toBe("schway.host.steering/v1");
  expect(hostCapabilities().steeringContract).toBe(STEERING_CONTRACT);
});

test("a steer during a tool call joins history after that result and before the next model request", async () => {
  await withTempDir(async dir => {
    const toolStarted = gate(), toolRelease = gate();
    const config = await options(dir, {}, [blockingTool(toolStarted.open, toolRelease.opened)]);
    const host = await createHost(config), session = await host.createSession();
    const requests: ModelRequest[] = [], events: HostProgressEvent[] = [];
    const pending = session.submit({ text: "start" }, stagedModel([
      { toolCalls: [{ id: "c1", name: "wait" }] }, { text: "final" },
    ], requests), { onProgress: event => { events.push(event); } });
    await toolStarted.opened;
    expect(session.steer({ id: "s1", text: "also check the logs" })).toEqual({ kind: "queued", id: "s1" });
    // Nothing is appended while the tool batch is still running.
    expect(await saved(config, session)).not.toContain("also check the logs");
    toolRelease.open();
    const result = await pending;
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completion");
    expect(requests).toHaveLength(2);
    expect(history(requests[0]!)).toEqual(["user:start"]);
    expect(history(requests[1]!)).toEqual(["user:start", "assistant", "tool:c1", "user:also check the logs"]);
    expect(result.steering.unapplied).toEqual([]);
    expect(result.steering.uncertain).toEqual([]);
    expect(result.steering.applied).toHaveLength(1);
    const applied = result.steering.applied[0]!;
    expect(applied.id).toBe("s1");
    expect(applied.entry.session).toEqual(session.reference);
    expect(Object.isFrozen(result.steering)).toBe(true);
    const progress = events.filter(event => event.type === "steer_applied");
    expect(progress).toEqual([{ type: "steer_applied", id: "s1", entry: applied.entry, transient: true }]);
    // The progress event follows the tool's completion and precedes the next round's text.
    const order = events.map(event => event.type);
    expect(order.indexOf("tool_finished")).toBeLessThan(order.indexOf("steer_applied"));
    expect(order.lastIndexOf("delta")).toBeGreaterThan(order.indexOf("steer_applied"));
    // After settlement a steer is idle: the application submits an ordinary turn.
    expect(session.steer({ id: "s2", text: "late" })).toEqual({ kind: "idle" });
    await session.close(); await host.close();
  });
});

test("a steer while the model writes a final answer runs one more round that includes it", async () => {
  await withTempDir(async dir => {
    const modelStarted = gate(), modelRelease = gate();
    const host = await createHost(await options(dir)), session = await host.createSession();
    const requests: ModelRequest[] = [];
    const pending = session.submit({ text: "summarize" }, stagedModel([
      { text: "first answer", started: modelStarted.open, hold: modelRelease.opened },
      { text: "revised answer" },
    ], requests));
    await modelStarted.opened;
    expect(session.steer({ id: "focus", text: "focus on errors only" })).toEqual({ kind: "queued", id: "focus" });
    modelRelease.open();
    const result = await pending;
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completion");
    expect(history(requests[1]!)).toEqual(["user:summarize", "assistant", "user:focus on errors only"]);
    expect(result.message.content).toEqual([{ type: "text", text: "revised answer" }]);
    expect(result.steering.applied.map(steer => steer.id)).toEqual(["focus"]);
    expect(result.steering.unapplied).toEqual([]);
    expect(result.usage.attempts.filter(attempt => attempt.phase === "turn")).toHaveLength(2);
    await session.close(); await host.close();
  });
});

test("steers apply in acceptance order exactly once; a repeated id is idempotent and a changed text is rejected", async () => {
  await withTempDir(async dir => {
    const toolStarted = gate(), toolRelease = gate();
    const host = await createHost(await options(dir, {}, [blockingTool(toolStarted.open, toolRelease.opened)]));
    const session = await host.createSession();
    const requests: ModelRequest[] = [];
    const repeats: unknown[] = [];
    const pending = session.submit({ text: "go" }, stagedModel([{ toolCalls: [{ id: "c1", name: "wait" }] },
      { text: "done", started: () => { repeats.push(session.steer({ id: "a", text: "first" })); } }], requests));
    await toolStarted.opened;
    expect(session.steer({ id: "a", text: "first" })).toEqual({ kind: "queued", id: "a" });
    expect(session.steer({ id: "b", text: "second" })).toEqual({ kind: "queued", id: "b" });
    expect(session.steer({ id: "a", text: "first" })).toEqual({ kind: "queued", id: "a" });
    expect(session.steer({ id: "a", text: "different" })).toEqual({ kind: "rejected", id: "a", reason: "id-conflict" });
    toolRelease.open();
    const result = await pending;
    expect(history(requests[1]!)).toEqual(["user:go", "assistant", "tool:c1", "user:first", "user:second"]);
    if (result.outcome !== "completed") throw new Error("expected completion");
    expect(result.steering.applied.map(steer => steer.id)).toEqual(["a", "b"]);
    expect(new Set(result.steering.applied.map(steer => steer.entry.entryId)).size).toBe(2);
    // A repeat after application names the committed entry instead of queueing again.
    expect(repeats).toEqual([{ kind: "applied", id: "a", entry: result.steering.applied[0]!.entry }]);
    await session.close(); await host.close();
  });
});

test("steering rejects malformed input, idles without an admitted run and bounds steers per run", async () => {
  await withTempDir(async dir => {
    const modelStarted = gate(), modelRelease = gate();
    const host = await createHost(await options(dir, { maxInputChars: 32 })), session = await host.createSession();
    expect(session.steer({ id: "idle-1", text: "anyone there" })).toEqual({ kind: "idle" });
    for (const input of [
      { id: "", text: "x" }, { id: "-leading", text: "x" }, { id: "a".repeat(129), text: "x" }, { id: "has space", text: "x" },
      { id: "ok", text: "   " }, { id: "ok", text: "x".repeat(33) }, { id: "ok", text: "x", images: [] }, { id: 1, text: "x" }, null, "text",
    ]) {
      let thrown: unknown;
      try { session.steer(input as never); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(HostError);
      expect((thrown as HostError).code).toBe("invalid-input");
      expect((thrown as Error).message).not.toContain("x".repeat(33));
    }
    const pending = session.submit({ text: "bounded" }, stagedModel([
      { text: "one", started: modelStarted.open, hold: modelRelease.opened }, { text: "two" },
    ], []));
    await modelStarted.opened;
    for (let index = 0; index < MAX_STEERS_PER_RUN; index++) expect(session.steer({ id: `s${index}`, text: `steer ${index}` }).kind).toBe("queued");
    expect(session.steer({ id: "overflow", text: "one too many" })).toEqual({ kind: "rejected", id: "overflow", reason: "limit" });
    // An already accepted id still answers idempotently at the bound.
    expect(session.steer({ id: "s0", text: "steer 0" })).toEqual({ kind: "queued", id: "s0" });
    modelRelease.open();
    const result = await pending;
    if (result.outcome !== "completed") throw new Error("expected completion");
    expect(result.steering.applied).toHaveLength(MAX_STEERS_PER_RUN);
    await session.close();
    expect(() => session.steer({ id: "closed", text: "x" })).toThrow(HostError);
    await host.close();
  });
});

test("steering is idle during explicit compaction, which is not a submitted run", async () => {
  await withTempDir(async dir => {
    const host = await createHost(await options(dir)), session = await host.createSession();
    await session.submit({ text: "seed" }, stagedModel([{ text: "seeded" }], []));
    // Compaction admits synchronously, so the handle is busy compacting when steer runs.
    const compacting = session.compact(stagedModel([{ text: "summary" }], []));
    expect(session.steer({ id: "during-compact", text: "hello" })).toEqual({ kind: "idle" });
    await compacting;
    await session.close(); await host.close();
  });
});

test("cancel with a pending steer reports it unapplied and never appends it", async () => {
  await withTempDir(async dir => {
    const modelStarted = gate();
    const config = await options(dir);
    const host = await createHost(config), session = await host.createSession();
    const pending = session.submit({ text: "long task" }, stagedModel([{ started: modelStarted.open, untilAbort: true }], []));
    await modelStarted.opened;
    expect(session.steer({ id: "s1", text: "never mind this part" })).toEqual({ kind: "queued", id: "s1" });
    session.cancel();
    // Accepted after cancellation but before settlement: still reported, never lost.
    expect(session.steer({ id: "s2", text: "and this" })).toEqual({ kind: "queued", id: "s2" });
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    if (result.outcome !== "cancelled") throw new Error("expected cancellation");
    expect(result.steering).toEqual({ applied: [], unapplied: [{ id: "s1" }, { id: "s2" }], uncertain: [] });
    expect(await saved(config, session)).not.toContain("never mind this part");
    expect(session.steer({ id: "s3", text: "after" })).toEqual({ kind: "idle" });
    await session.close(); await host.close();
  });
});

test("round limits leave a pending steer unapplied after a tool batch or a final answer", async () => {
  await withTempDir(async dir => {
    const toolStarted = gate(), toolRelease = gate();
    const config = await options(dir, { maxTurns: 1 }, [blockingTool(toolStarted.open, toolRelease.opened)]);
    const host = await createHost(config), session = await host.createSession();
    const requests: ModelRequest[] = [];
    const afterTool = session.submit({ text: "one round" }, stagedModel([{ toolCalls: [{ id: "c1", name: "wait" }] }], requests));
    await toolStarted.opened;
    session.steer({ id: "late-tool", text: "steer after tools" });
    toolRelease.open();
    const limited = await afterTool;
    expect(limited.outcome).toBe("max_turns");
    if (limited.outcome !== "max_turns") throw new Error("expected max_turns");
    expect(limited.steering).toEqual({ applied: [], unapplied: [{ id: "late-tool" }], uncertain: [] });
    expect(requests).toHaveLength(1);

    const modelStarted = gate(), modelRelease = gate();
    const answered = session.submit({ text: "answer now" }, stagedModel([{ text: "only answer", started: modelStarted.open, hold: modelRelease.opened }], requests));
    await modelStarted.opened;
    session.steer({ id: "late-answer", text: "steer after answer" });
    modelRelease.open();
    const completed = await answered;
    expect(completed.outcome).toBe("completed");
    if (completed.outcome !== "completed") throw new Error("expected completion");
    expect(completed.message.content).toEqual([{ type: "text", text: "only answer" }]);
    expect(completed.steering).toEqual({ applied: [], unapplied: [{ id: "late-answer" }], uncertain: [] });
    const text = await saved(config, session);
    expect(text).not.toContain("steer after tools");
    expect(text).not.toContain("steer after answer");
    await session.close(); await host.close();
  });
});

test("an applied steer is a committed native entry that a reopened session replays", async () => {
  await withTempDir(async dir => {
    const modelStarted = gate(), modelRelease = gate();
    const config = await options(dir);
    const host = await createHost(config), session = await host.createSession();
    const pending = session.submit({ text: "draft" }, stagedModel([
      { text: "v1", started: modelStarted.open, hold: modelRelease.opened }, { text: "v2" },
    ], []));
    await modelStarted.opened;
    session.steer({ id: "keep", text: "keep it short" });
    modelRelease.open();
    const result = await pending;
    if (result.outcome !== "completed") throw new Error("expected completion");
    const entryId = result.steering.applied[0]!.entry.entryId;
    expect(await saved(config, session)).toContain(entryId);
    const reference = session.reference;
    await session.close(); await host.close();

    const reopenedHost = await createHost(config), reopened = await reopenedHost.openSession(reference);
    const requests: ModelRequest[] = [];
    const next = await reopened.submit({ text: "next" }, stagedModel([{ text: "ok" }], requests));
    expect(next.outcome).toBe("completed");
    expect(history(requests[0]!)).toEqual(["user:draft", "assistant", "user:keep it short", "assistant", "user:next"]);
    expect(requests[0]!.items.find(item => item.id === entryId)).toMatchObject({ type: "user", content: [{ type: "text", text: "keep it short" }] });
    if (next.outcome !== "completed") throw new Error("expected completion");
    expect(next.steering).toEqual({ applied: [], unapplied: [], uncertain: [] });
    await reopened.close(); await reopenedHost.close();
  });
});

test("a route-bound run reports steering and authorizes the extra round's send", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore();
    await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "sentinel-access", refreshToken: "sentinel-refresh",
      obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    const firstSent = gate(), firstRelease = gate();
    const bodies: string[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (bodies.length === 1) { firstSent.open(); await firstRelease.opened; }
      return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
    }) as never;
    const host = await createHost(await options(dir, {}, [], { route: "grok", model: "grok-4.7", store, fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [];
    const pending = session.submitWithRoute({ text: "route task" }, { authorizeDispatch: dispatch => { seen.push(dispatch); } });
    await firstSent.opened;
    expect(session.steer({ id: "route-steer", text: "route follow-up" })).toEqual({ kind: "queued", id: "route-steer" });
    firstRelease.open();
    const result = await pending;
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completion");
    expect(result.steering.applied.map(steer => steer.id)).toEqual(["route-steer"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toContain("route follow-up");
    expect(bodies[1]).toContain("route follow-up");
    // Each model call is authorized on its own; the steered round is a fresh initial send.
    expect(seen.map(dispatch => [dispatch.kind, dispatch.sequence])).toEqual([["initial", 1], ["initial", 1]]);
    expect(result.usage.providerRequests).toEqual({ initialSends: 2, authRetrySends: 0, renewalRequests: 0 });
    expect(session.steer({ id: "after", text: "late" })).toEqual({ kind: "idle" });
    await session.close(); await host.close();
  });
});

test("a failed steer append is reported uncertain, ends the run and leaves later steers unapplied", async () => {
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "start" }] }]);
  const append = session.append.bind(session);
  session.append = (...items) => {
    if (items.some(item => item.type === "user")) throw new Error("disk full");
    append(...items);
  };
  const window = openSteeringWindow(entryId => ({ session: { id: "00000000-0000-4000-8000-000000000000", branchId: "main" }, entryId }));
  window.accept({ id: "a", text: "first" });
  window.accept({ id: "b", text: "second" });
  const requests: ModelRequest[] = [], progress: HostProgressEvent[] = [];
  const events = await collect(runAgentLoop({ session, model: stagedModel([{ text: "never" }], requests),
    contextManager: createContextManager({ root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] }),
    steering: window.source(event => { progress.push(event); }) }));
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  expect(events.some(event => event.type === "error")).toBe(true);
  expect(requests).toHaveLength(0);
  expect(progress).toEqual([]);
  expect(window.accept({ id: "a", text: "first" })).toEqual({ kind: "rejected", id: "a", reason: "uncertain" });
  expect(window.settle()).toEqual({ applied: [], unapplied: [{ id: "b" }], uncertain: [{ id: "a" }] });
  expect(window.accept({ id: "c", text: "after settle" })).toEqual({ kind: "idle" });
});
