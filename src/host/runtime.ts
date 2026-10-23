import { mkdir, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runAgentLoop } from "../agent/loop.ts";
import { MAX_TRANSIENT_ATTEMPTS } from "../agent/retry.ts";
import { createContextManager } from "../context/manager.ts";
import { contextPolicySnapshot, STRICT_CONTEXT_POLICY, WORKSPACE_CONTEXT_POLICY, type ContextSourcePolicy } from "../context/policy.ts";
import type { AssistantMessage } from "../conversation/types.ts";
import { createJsonlSession, loadJsonlSession, SessionConflictError, type JsonlSession } from "../session/jsonl.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { createActivateSkillTool } from "../skills/activate.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { HostError, hostCapabilities, type HostClock, type HostOptions, type HostProgressEvent,
  type HostRunAttemptUsage, type HostRunError, type HostRunOptions, type HostRunResult, type HostRunUsage, type HostSessionDeletion,
  type HostRuntime, type HostSession, type HostSessionReference, type HostEntryReference } from "./index.ts";
import { checkAuthReadiness, classifyAuthError, createAuthRouteModel, credentialReferenceForRoute, validateAuthSelection,
  type HostAuthReadiness, type HostAuthRunResult, type HostAuthSelection } from "./auth-routes.ts";
import { acquireSessionLease, type SessionLease } from "./lease.ts";
import { deleteManagedSession, isManagedRetired, markManagedRetired, retiredFilePath } from "./managed-data.ts";
import type { Model, ModelRequest } from "../model/model.ts";
import type { RuntimeEvent } from "../agent/events.ts";

// Fast same-process rejection supplements the cross-process native session lease.
const ownedSessions = new Set<string>();
/** Retired managed contexts that cannot silently reopen in this process. */
const retiredSessions = new Set<string>();
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Default wall-clock bound for one host run, including retries and compaction. */
const DEFAULT_DEADLINE_MS = 300_000;
/** Default transient provider attempts per model turn, matching the harness bound. */
const DEFAULT_MAX_ATTEMPTS = MAX_TRANSIENT_ATTEMPTS;
const MAX_DEADLINE_MS = 86_400_000;
const MAX_ATTEMPTS = 10;

function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HostError("invalid-options");
}

function optionsSnapshot(input: HostOptions): HostOptions & { sourcePolicy: ContextSourcePolicy } {
  keys(input, ["workspaceRoot", "sessionDirectory", "homeDirectory", "context", "tools", "limits", "auth"]);
  keys(input.context, ["policy", "systemPrompt", "sections", "sources", "discovery"]);
  keys(input.tools, ["policy", "definitions", "hostedLookup"]);
  keys(input.limits, ["maxTurns", "maxConcurrentTools", "contextWindow", "maxInputChars", "deadlineMs", "maxAttempts"]);
  if (!["workspace-discovery", "strict", "controlled"].includes(input.context.policy) || input.tools.policy !== "exact" || (input.tools as { hostedLookup?: unknown }).hostedLookup !== "off") throw new HostError("unsupported-policy");
  let sourcePolicy: ContextSourcePolicy;
  if (input.context.policy === "controlled") {
    if (!record(input.context.discovery)) throw new HostError("invalid-options");
    try { sourcePolicy = contextPolicySnapshot(input.context.discovery); } catch { throw new HostError("unsupported-policy"); }
  } else {
    if (input.context.discovery !== undefined) throw new HostError("invalid-options");
    sourcePolicy = input.context.policy === "strict" ? STRICT_CONTEXT_POLICY : WORKSPACE_CONTEXT_POLICY;
  }
  if ([input.workspaceRoot, input.sessionDirectory, input.homeDirectory].some(path => typeof path !== "string" || !isAbsolute(path)) ||
      typeof input.context.systemPrompt !== "string" || !input.context.systemPrompt.trim() ||
      !Array.isArray(input.context.sections) || !Array.isArray(input.tools.definitions)) throw new HostError("invalid-options");
  for (const [key, max] of [["maxTurns", 100], ["maxConcurrentTools", 32], ["contextWindow", 2000000], ["maxInputChars", 1000000]] as const) {
    const n = input.limits[key];
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new HostError("invalid-options");
  }
  const deadlineMs = input.limits.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) throw new HostError("invalid-options");
  const maxAttempts = input.limits.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw new HostError("invalid-options");
  for (const section of input.context.sections) {
    keys(section, ["name", "content"]);
    if (typeof section.name !== "string" || !section.name.trim() || typeof section.content !== "string") throw new HostError("invalid-options");
  }
  const sources = input.context.sources === undefined ? [] : input.context.sources;
  if (!Array.isArray(sources) || sources.length > 64 || input.context.sections.length > 64) throw new HostError("invalid-options");
  const seen = new Set<string>();
  let contextChars = input.context.systemPrompt.length;
  for (const section of input.context.sections) contextChars += section.name.length + section.content.length;
  for (const source of sources) {
    keys(source, ["id", "revision", "content"]);
    if (typeof source.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(source.id) || seen.has(source.id) ||
        typeof source.revision !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(source.revision) || typeof source.content !== "string") throw new HostError("invalid-options");
    seen.add(source.id); contextChars += source.id.length + source.revision.length + source.content.length;
  }
  if (contextChars > 1000000) throw new HostError("invalid-options");
  const definitions: ToolDefinition[] = input.tools.definitions.map(tool => {
    keys(tool, ["name", "description", "inputSchema", "execution", "effect", "execute"]);
    if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) ||
        typeof tool.description !== "string" || typeof tool.execute !== "function" || !record(tool.inputSchema) ||
        typeof tool.execution !== "string" || !["parallel", "exclusive"].includes(tool.execution)) throw new HostError("invalid-options");
    return { ...tool as unknown as ToolDefinition, inputSchema: structuredClone(tool.inputSchema) };
  });
  const admitted = new Set<string>();
  for (const tool of definitions) {
    if (admitted.has(tool.name)) throw new HostError("invalid-options");
    admitted.add(tool.name);
  }
  let authSelection: HostAuthSelection | undefined;
  if (input.auth !== undefined) {
    try { authSelection = validateAuthSelection(input.auth); }
    catch (error) {
      if (error instanceof Error && error.message === "unsupported") throw new HostError("unsupported-policy");
      throw new HostError("invalid-options");
    }
    // Env key/value rules live in validateAuthSelection so direct API users get the same rejection.
  }
  return { sourcePolicy, workspaceRoot: input.workspaceRoot, sessionDirectory: input.sessionDirectory, homeDirectory: input.homeDirectory,
    context: { policy: input.context.policy, systemPrompt: input.context.systemPrompt, sections: structuredClone(input.context.sections), sources: structuredClone(sources) },
    tools: { policy: input.tools.policy, hostedLookup: "off" as const, definitions },
    limits: { ...input.limits, deadlineMs, maxAttempts },
    ...(authSelection ? { auth: { route: authSelection.route, model: authSelection.model,
      ...(authSelection.store ? { store: authSelection.store } : {}),
      ...(authSelection.env ? { env: { ...authSelection.env } } : {}),
      ...(authSelection.fetch ? { fetch: authSelection.fetch } : {}) } } : {}) };
}

function validateReference(reference: HostSessionReference): void {
  if (!record(reference) || Object.keys(reference).some(key => !["id", "branchId"].includes(key)) ||
      typeof reference.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(reference.id) ||
      typeof reference.branchId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference.branchId)) throw new HostError("invalid-reference");
}

/** System wall clock with monotonic durations and abortable waits. */
function systemHostClock(): HostClock {
  return {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (ms <= 0) {
        if (signal?.aborted) throw abortError();
        return;
      }
      if (signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); reject(abortError()); };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function monotonicNow(clock: HostClock): number {
  return clock.monotonicNow ? clock.monotonicNow() : clock.now();
}

/** Cross-realm AbortSignal check: structural when `instanceof` fails across realms. */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (value instanceof AbortSignal) return true;
  return record(value) && typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}

/** Race an untrusted clock sleep against abort so an abort-ignoring clock cannot hang settlement. */
function sleepWithAbort(clock: HostClock, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return clock.sleep(ms);
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort: () => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([clock.sleep(ms, signal), abortPromise]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/** Normalize the trailing submit argument while keeping the legacy AbortSignal form. */
function normalizeRunArgs(signalOrOptions?: AbortSignal | HostRunOptions): { signal?: AbortSignal; clock?: HostClock; onProgress?: (event: HostProgressEvent) => void } {
  if (signalOrOptions === undefined) return {};
  if (isAbortSignal(signalOrOptions)) return { signal: signalOrOptions };
  if (!record(signalOrOptions) || Object.keys(signalOrOptions).some(key => !["signal", "clock", "onProgress"].includes(key))) throw new HostError("invalid-input");
  const { signal, clock, onProgress } = signalOrOptions as HostRunOptions;
  if (signal !== undefined && !isAbortSignal(signal)) throw new HostError("invalid-input");
  if (clock !== undefined && (!record(clock) || typeof (clock as HostClock).now !== "function" || typeof (clock as HostClock).sleep !== "function" ||
      ((clock as HostClock).monotonicNow !== undefined && typeof (clock as HostClock).monotonicNow !== "function"))) throw new HostError("invalid-input");
  if (onProgress !== undefined && typeof onProgress !== "function") throw new HostError("invalid-input");
  return { ...(signal ? { signal } : {}), ...(clock ? { clock: clock as HostClock } : {}), ...(onProgress ? { onProgress: onProgress as (event: HostProgressEvent) => void } : {}) };
}

/** Translate one runtime event into a transient host progress observation. */
function toProgress(event: RuntimeEvent): HostProgressEvent | undefined {
  switch (event.type) {
    case "model.delta": return { type: "delta", text: event.content.text, transient: true as const };
    case "tool.started": return { type: "tool_started", toolCallId: event.toolCallId, name: event.name, transient: true as const };
    case "tool.finished": return { type: "tool_finished", toolCallId: event.toolCallId, name: event.name, status: event.status, transient: true as const };
    case "model.retry": return { type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, message: event.message, transient: true as const };
    case "compaction.started": return { type: "compaction", stage: "started", reason: event.reason, transient: true as const };
    case "compaction.finished": return { type: "compaction", stage: "finished", reason: event.reason, status: event.status, transient: true as const };
    case "model.usage": return { type: "usage", phase: event.phase, usage: structuredClone(event.usage), complete: event.complete, transient: true as const };
    default: return undefined;
  }
}

/** Compose only native engine services after validating this explicitly trusted base-host configuration. */
export async function createHostRuntime(input: HostOptions): Promise<HostRuntime> {
  let options: ReturnType<typeof optionsSnapshot>;
  try { options = optionsSnapshot(input); }
  catch (error) { if (error instanceof HostError) throw error; throw new HostError("invalid-options"); }
  let root: string, home: string, directory: string;
  try {
    root = await realpath(options.workspaceRoot);
    home = await realpath(options.homeDirectory);
    if (!(await stat(root)).isDirectory() || !(await stat(home)).isDirectory()) throw new Error();
    await mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
    directory = await realpath(options.sessionDirectory);
  } catch { throw new HostError("storage"); }
  const workspace = { root, launchCwd: root, extraRoots: [] };
  let tools: ToolRegistry;
  try { tools = createToolRegistry(options.tools.definitions); }
  catch { throw new HostError("invalid-options"); }
  const authSelection: HostAuthSelection | undefined = (options as { auth?: HostAuthSelection }).auth
    ? { ...((options as { auth?: HostAuthSelection }).auth as HostAuthSelection) } : undefined;
  // Preserve store/fetch identity so route-scoped renewal stays single-flight across runs.
  if (authSelection && (options as { auth?: HostAuthSelection }).auth?.store) {
    authSelection.store = (options as { auth?: HostAuthSelection }).auth!.store;
  }
  if (authSelection && (options as { auth?: HostAuthSelection }).auth?.fetch) {
    authSelection.fetch = (options as { auth?: HostAuthSelection }).auth!.fetch;
  }
  const authBinding = authSelection ? Object.freeze({
    route: authSelection.route,
    model: authSelection.model,
    credential: credentialReferenceForRoute(authSelection.route),
    async checkReadiness(): Promise<HostAuthReadiness> {
      return checkAuthReadiness(authSelection);
    },
    async createModel() {
      return createAuthRouteModel(authSelection);
    },
  }) : undefined;
  let closed = false, opening = 0;
  let closing: Promise<void> | undefined;
  const handles = new Map<HostSession, () => boolean>();
  const requireOpen = () => { if (closed) throw new HostError("closed"); };

  function bind(native: JsonlSession, key: string, lease: SessionLease): HostSession {
    let conflict = false;
    const check = () => {
      if (conflict) throw new HostError("conflict");
      if (retiredSessions.has(key)) { conflict = true; throw new HostError("closed"); }
      try {
        if (existsSync(retiredFilePath(directory, native.header.id))) { retiredSessions.add(key); conflict = true; throw new HostError("closed"); }
      } catch (error) {
        if (error instanceof HostError) throw error;
      }
      try { lease.assertOwned(); native.assertCurrent(); }
      catch (error) { if (error instanceof SessionConflictError || error instanceof HostError && error.code === "conflict") { conflict = true; throw new HostError("conflict"); } throw new HostError("storage"); }
      if (native.activeBranchId !== reference.branchId) { conflict = true; throw new HostError("conflict"); }
    };
    // Capture route identity and method once; trusted adapters retain their own private receiver.
    const snapshotModel = (model: Model): Model => {
      const provider = model.provider, id = model.id, stream = model.stream.bind(model);
      return Object.freeze({ provider, id, async *stream(request, call) {
        check();
        for await (const event of stream(structuredCloneRequest(request), call)) yield structuredClone(event);
      } } as Model);
    };
    let disposed = false, busy = false;
    let runAbort: AbortController | null = null;
    const reference = Object.freeze({ id: native.header.id, branchId: native.activeBranchId });
    const context = createContextManager(workspace, { home, contextWindow: options.limits.contextWindow,
      systemPrompt: options.context.systemPrompt, sections: options.context.sections, sources: options.context.sources, policy: options.sourcePolicy });
    const admittedActivation = tools.get("activate_skill");
    const boundActivation = admittedActivation ? createActivateSkillTool(context) : undefined;
    const runTools = createToolRegistry(tools.definitions().map(tool => {
      if (tool.name === "activate_skill" && boundActivation) {
        return { ...boundActivation, execute(input: unknown, toolContext: Parameters<typeof boundActivation.execute>[1]) { check(); return boundActivation.execute(input as { name: string }, toolContext); } };
      }
      return { ...tool, execute(input: unknown, toolContext: Parameters<typeof tool.execute>[1]) { check(); return tool.execute(input, toolContext); } };
    }));
    const requireIdle = () => { requireOpen(); if (disposed) throw new HostError("closed"); if (busy) throw new HostError("busy"); };
    const ref = (entryId: string): HostEntryReference => Object.freeze({ session: reference, entryId });
    const modelIdentity = (model: Model): { readonly provider: string; readonly id: string } =>
      Object.freeze({ provider: model.provider, id: model.id });
    const failureDetail = (message: string, model: { readonly provider: string; readonly id: string }): HostRunError => Object.freeze({
      message: sanitizeDiagnostic(message), model, contextPolicy: options.context.policy, toolPolicy: "exact" as const,
    });
    function validateRouteInput(input: unknown, signal?: AbortSignal): void {
      if (!record(input) || Object.keys(input).some(key => key !== "text") || typeof (input as { text?: unknown }).text !== "string" ||
          !(input as { text: string }).text.trim() || (input as { text: string }).text.length > options.limits.maxInputChars) throw new HostError("invalid-input");
      if (signal?.aborted) throw new HostError("invalid-input");
    }
    /** Run one admitted turn under the finite wall-clock bound with transient progress. */
    async function runBounded(run: (signal: AbortSignal, report: (event: HostProgressEvent) => void, collect: (usage: HostRunAttemptUsage) => void, clock: HostClock) => Promise<{ reason: "completed" | "error" | "cancelled" | "max_turns"; message?: string }>,
      runOptions: { signal?: AbortSignal; clock?: HostClock; onProgress?: (event: HostProgressEvent) => void }): Promise<{ reason: "completed" | "error" | "cancelled" | "max_turns" | "limit_exceeded"; usages: HostRunAttemptUsage[]; totalMs: number; message?: string }> {
      const clock = runOptions.clock ?? systemHostClock();
      const usages: HostRunAttemptUsage[] = [];
      const start = monotonicNow(clock);
      const report = (event: HostProgressEvent): void => {
        try { runOptions.onProgress?.(event); } catch { /* Observer failures never alter the admitted run. */ }
      };
      const collect = (usage: HostRunAttemptUsage): void => { usages.push(usage); };
      const combined = new AbortController();
      const source = runOptions.signal;
      const onSourceAbort = (): void => combined.abort();
      if (source) {
        if (source.aborted) combined.abort();
        else source.addEventListener("abort", onSourceAbort, { once: true });
      }
      // Session cancel shares the same combined signal so late aborts settle cooperatively.
      const previous = runAbort;
      runAbort = combined;
      let deadlineFired = false, settled = false;
      const deadlineStop = new AbortController();
      const deadlineMs = options.limits.deadlineMs ?? DEFAULT_DEADLINE_MS;
      const deadline = sleepWithAbort(clock, deadlineMs, deadlineStop.signal).then(() => {
        if (!settled) { deadlineFired = true; combined.abort(); }
      }, () => undefined);
      try {
        const outcome = await run(combined.signal, report, collect, clock);
        settled = true;
        deadlineStop.abort();
        await deadline.catch(() => undefined);
        if (deadlineFired && outcome.reason !== "completed") return { reason: "limit_exceeded", usages, totalMs: elapsed(clock, start), ...(outcome.message !== undefined ? { message: outcome.message } : {}) };
        // A loop-reported completed already passed the pre-append cancellation check,
        // so its durable entry is committed; trust it over a raced abort or deadline.
        return { ...outcome, usages, totalMs: elapsed(clock, start) };
      } finally {
        settled = true;
        deadlineStop.abort();
        source?.removeEventListener("abort", onSourceAbort);
        runAbort = previous;
      }
    }
    const observe = (event: RuntimeEvent, report: (progress: HostProgressEvent) => void, collect: (usage: HostRunAttemptUsage) => void): { reason?: "completed" | "error" | "cancelled" | "max_turns"; message?: string; category?: unknown } => {
      const progress = toProgress(event);
      if (progress) report(progress);
      if (event.type === "model.usage") collect({ phase: event.phase, usage: structuredClone(event.usage), complete: event.complete });
      if (event.type === "agent.finished") return { reason: event.reason };
      if (event.type === "error") return { message: event.message, category: (event as { category?: unknown }).category };
      return {};
    };
    const usageSummary = (usages: HostRunAttemptUsage[], totalMs: number, completed: boolean): HostRunUsage =>
      Object.freeze({ attempts: Object.freeze([...usages]), complete: completed, totalMs });
    const handle: HostSession = {
      reference,
      async submit(input, model, signalOrOptions) {
        requireIdle();
        const runArgs = normalizeRunArgs(signalOrOptions);
        if (!record(input) || Object.keys(input).some(key => key !== "text") || typeof input.text !== "string" ||
            !input.text.trim() || input.text.length > options.limits.maxInputChars || !model ||
            typeof model.stream !== "function" || typeof model.provider !== "string" || !model.provider ||
            typeof model.id !== "string" || !model.id) throw new HostError("invalid-input");
        if (runArgs.signal?.aborted) throw new HostError("invalid-input");
        check();
        const route = snapshotModel(model);
        const identity = modelIdentity(route);
        busy = true;
        const release = native.acquireOperation();
        try {
          const id = crypto.randomUUID();
          try { native.append({ type: "user", id, content: [{ type: "text", text: input.text }] }); }
          catch (error) { if (error instanceof HostError) throw error; if (error instanceof SessionConflictError) throw new HostError("conflict"); throw new HostError("storage"); }
          const inputReference = ref(id);
          let reason: HostRunResult["outcome"] = "error";
          let usages: HostRunAttemptUsage[] = [];
          let totalMs = 0;
          let lastMessage: string | undefined;
          const bounded = await runBounded(async (signal, report, collect, clock) => {
            let terminal: "completed" | "error" | "cancelled" | "max_turns" = "error";
            let message: string | undefined;
            for await (const event of runAgentLoop({ session: native, model: route, contextManager: context, tools: runTools, workspace,
              maxTurns: options.limits.maxTurns, maxConcurrentTools: options.limits.maxConcurrentTools, maxAttempts: options.limits.maxAttempts,
              signal, webSearch: "off", exactTools: true, clock })) {
              const seen = observe(event, report, collect);
              if (seen.reason) terminal = seen.reason;
              if (seen.message !== undefined) message = seen.message;
            }
            return { reason: terminal, ...(message !== undefined ? { message } : {}) };
          }, runArgs);
          reason = bounded.reason;
          usages = bounded.usages;
          totalMs = bounded.totalMs;
          lastMessage = bounded.message;
          try { check(); } catch (error) { if (error instanceof HostError && error.code === "conflict") throw error; }
          if (conflict) throw new HostError("conflict");
          if (reason === "completed") {
            check();
            const message = native.items.findLast(item => item.type === "assistant");
            if (!message || message.type !== "assistant") throw new HostError("storage");
            return { outcome: reason, input: inputReference, result: ref(message.id), message: structuredClone(message),
              usage: usageSummary(usages, totalMs, true), model: identity };
          }
          return { outcome: reason, input: inputReference, usage: usageSummary(usages, totalMs, false),
            model: identity, error: failureDetail(lastMessage ?? terminalMessage(reason), identity) };
        } finally { release(); busy = false; }
      },
      readResult(result) {
        requireIdle(); check();
        if (!record(result) || Object.keys(result).some(key => !["session", "entryId"].includes(key))) throw new HostError("invalid-reference");
        validateReference(result.session);
        if (result.session.id !== reference.id || result.session.branchId !== reference.branchId ||
            typeof result.entryId !== "string") throw new HostError("invalid-reference");
        const message = native.items.find(item => item.id === result.entryId && item.type === "assistant");
        if (!message) throw new HostError("result-not-found");
        return structuredClone(message as AssistantMessage);
      },
      async submitWithRoute(input, signalOrOptions): Promise<HostAuthRunResult> {
        requireIdle();
        const runArgs = normalizeRunArgs(signalOrOptions);
        validateRouteInput(input, runArgs.signal);
        if (!authSelection || !authBinding) throw new HostError("invalid-options");
        check();
        busy = true;
        const release = native.acquireOperation();
        try {
          const id = crypto.randomUUID();
          try { native.append({ type: "user", id, content: [{ type: "text", text: (input as { text: string }).text }] }); }
          catch (error) { if (error instanceof HostError) throw error; if (error instanceof SessionConflictError) throw new HostError("conflict"); throw new HostError("storage"); }
          const inputReference = ref(id);
          const emptyUsage = (totalMs: number): HostRunUsage => usageSummary([], totalMs, false);
          let readiness: HostAuthReadiness;
          try { readiness = await checkAuthReadiness(authSelection); }
          catch { readiness = classifyAuthError(new Error("Cannot read credential in the OS secure store."), authSelection); }
          if (readiness.status !== "configured-unverified") {
            return { outcome: "error", input: inputReference, auth: readiness, usage: emptyUsage(0) };
          }
          let route: Model;
          try { route = snapshotModel(await createAuthRouteModel(authSelection)); }
          catch (error) {
            if (error instanceof HostError) throw error;
            return { outcome: "error", input: inputReference, auth: classifyAuthError(error, authSelection), usage: emptyUsage(0) };
          }
          let terminal: HostRunResult["outcome"] = "error";
          let lastError: unknown;
          let lastCategory: unknown;
          let usages: HostRunAttemptUsage[] = [];
          let totalMs = 0;
          const bounded = await runBounded(async (signal, report, collect, clock) => {
            let reason: "completed" | "error" | "cancelled" | "max_turns" = "error";
            for await (const event of runAgentLoop({ session: native, model: route, contextManager: context, tools: runTools, workspace,
              maxTurns: options.limits.maxTurns, maxConcurrentTools: options.limits.maxConcurrentTools, maxAttempts: options.limits.maxAttempts,
              signal, webSearch: "off", exactTools: true, clock })) {
              const seen = observe(event, report, collect);
              if (seen.reason) reason = seen.reason;
              if (event.type === "error") {
                // Provider errors arrive as sanitized plain messages without status,
                // so route classification stays message- and category-based (see classifyAuthError).
                lastError = new Error(event.message);
                const category = (event as { category?: unknown }).category;
                if (category !== undefined) lastCategory = category;
                if (typeof lastCategory === "string") {
                  (lastError as { category?: unknown }).category = lastCategory;
                }
              }
            }
            return { reason };
          }, runArgs);
          terminal = bounded.reason;
          usages = bounded.usages;
          totalMs = bounded.totalMs;
          try { check(); } catch (error) { if (error instanceof HostError && error.code === "conflict") throw error; }
          if (conflict) throw new HostError("conflict");
          if (terminal === "completed") {
            check();
            const message = native.items.findLast(item => item.type === "assistant");
            if (!message || message.type !== "assistant") throw new HostError("storage");
            return { outcome: terminal, input: inputReference, result: ref(message.id), message: structuredClone(message),
              observedInference: "observed" as const, usage: usageSummary(usages, totalMs, true) };
          }
          if (terminal === "cancelled" || terminal === "max_turns" || terminal === "limit_exceeded") {
            if (terminal === "limit_exceeded") {
              const auth = classifyAuthError(lastError ?? new Error("Run deadline elapsed."), authSelection);
              return { outcome: terminal, input: inputReference, auth, usage: usageSummary(usages, totalMs, false) };
            }
            const current = await checkAuthReadiness(authSelection).catch(() => classifyAuthError(lastError ?? new Error("cancelled"), authSelection));
            return { outcome: terminal, input: inputReference,
              auth: current.status === "configured-unverified" ? current : classifyAuthError(lastError ?? new Error(String(terminal)), authSelection),
              usage: usageSummary(usages, totalMs, false) };
          }
          const auth = classifyAuthError(lastError ?? new Error("Provider request failed"), authSelection);
          // Preserve retry category when the sanitized message alone is ambiguous.
          if (auth.status === "integration-unavailable" && typeof lastCategory === "string") {
            if (lastCategory === "auth") return { outcome: terminal, input: inputReference, auth: classifyAuthError(new Error("The subscription session was revoked."), authSelection), usage: usageSummary(usages, totalMs, false) };
            if (lastCategory === "credential-store") return { outcome: terminal, input: inputReference, auth: classifyAuthError(new Error("Cannot read credential in the OS secure store."), authSelection), usage: usageSummary(usages, totalMs, false) };
            if (lastCategory === "model") return { outcome: terminal, input: inputReference, auth: { ...auth, status: "model-unavailable" as const, nextAction: `Model ${authSelection.model} is not available on this subscription. Choose a listed model for this route.` }, usage: usageSummary(usages, totalMs, false) };
            if (lastCategory === "rate-limit") return { outcome: terminal, input: inputReference, auth: classifyAuthError(Object.assign(new Error("rate-limited"), { status: 429 }), authSelection), usage: usageSummary(usages, totalMs, false) };
          }
          return { outcome: terminal, input: inputReference, auth, usage: usageSummary(usages, totalMs, false) };
        } finally { release(); busy = false; }
      },
      async compact(model, signalOrOptions) {
        requireIdle();
        const runArgs = normalizeRunArgs(signalOrOptions);
        if (!model || typeof model.stream !== "function" || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) throw new HostError("invalid-input");
        check();
        const route = snapshotModel(model);
        busy = true;
        try {
          let recordId: string | null = null;
          let failed = false;
          let noopBoundary = false;
          const bounded = await runBounded(async (signal, report, collect, _clock) => {
            for (const entry of context.takeUsage()) {
              const sample = { phase: "compaction" as const, usage: structuredClone(entry.usage), complete: entry.complete };
              collect(sample);
              report({ type: "usage", phase: "compaction", usage: structuredClone(entry.usage), complete: entry.complete, transient: true as const });
            }
            report({ type: "compaction", stage: "started", reason: "manual", transient: true as const });
            try {
              const record = await context.compact(native, route, { reason: "manual", signal, onOutcome: result => { if (result === "failed") failed = true; } });
              recordId = record ? record.id : null;
            } catch {
              report({ type: "compaction", stage: "finished", reason: "manual", status: signal.aborted ? "cancelled" : "failed", transient: true as const });
              return { reason: signal.aborted ? "cancelled" as const : "error" as const };
            }
            for (const entry of context.takeUsage()) {
              const sample = { phase: "compaction" as const, usage: structuredClone(entry.usage), complete: entry.complete };
              collect(sample);
              report({ type: "usage", phase: "compaction", usage: structuredClone(entry.usage), complete: entry.complete, transient: true as const });
            }
            // A durable record stays completed even when abort races publication;
            // mirrors context.compact, which preserves completed over a late abort.
            if (recordId) {
              report({ type: "compaction", stage: "finished", reason: "manual", status: "completed", transient: true as const });
              return { reason: "completed" as const };
            }
            if (signal.aborted) {
              report({ type: "compaction", stage: "finished", reason: "manual", status: "cancelled", transient: true as const });
              return { reason: "cancelled" as const };
            }
            if (failed) {
              report({ type: "compaction", stage: "finished", reason: "manual", status: "failed", transient: true as const });
              return { reason: "error" as const };
            }
            noopBoundary = true;
            report({ type: "compaction", stage: "finished", reason: "manual", status: "noop", transient: true as const });
            return { reason: "cancelled" as const };
          }, runArgs);
          check();
          const usages = bounded.usages;
          if (bounded.reason === "completed" && recordId) {
            return { outcome: "completed", result: ref(recordId), usage: usageSummary(usages, bounded.totalMs, true) };
          }
          if (bounded.reason === "limit_exceeded") return { outcome: "limit_exceeded", usage: usageSummary(usages, bounded.totalMs, false) };
          // A manual compaction with no boundary is an explicit noop; an aborted
          // in-flight compaction settles as cancelled through the bounded outcome.
          if (bounded.reason === "cancelled") return noopBoundary
            ? { outcome: "noop", usage: usageSummary(usages, bounded.totalMs, false) }
            : { outcome: "cancelled", usage: usageSummary(usages, bounded.totalMs, false) };
          return { outcome: "error", usage: usageSummary(usages, bounded.totalMs, false) };
        } catch (error) {
          if (conflict || error instanceof SessionConflictError || error instanceof HostError && error.code === "conflict") {
            conflict = true;
            throw new HostError("conflict");
          }
          throw error;
        } finally { busy = false; }
      },
      cancel() {
        // Cooperative cancellation only; synchronous extension code stays outside hard preemption.
        runAbort?.abort();
      },
      async close() {
        if (disposed) return;
        requireIdle();
        lease.release();
        disposed = true;
        ownedSessions.delete(key);
        handles.delete(handle);
      },
      async retire() {
        if (disposed) return;
        requireIdle();
        check();
        await markManagedRetired(directory, reference.id, root);
        retiredSessions.add(key);
        try { lease.release(); } finally {
          disposed = true;
          ownedSessions.delete(key);
          handles.delete(handle);
        }
      },
    };
    handles.set(handle, () => busy);
    return Object.freeze(handle);
  }

  return Object.freeze({
    capabilities: hostCapabilities(),
    ...(authBinding ? { auth: authBinding } : {}),
    async createSession() {
      requireOpen(); opening++;
      try {
        const id = crypto.randomUUID(), key = `${directory}/${id}`;
        const lease = acquireSessionLease(directory, id);
        try {
          const native = await createJsonlSession({ directory, workspace, id, managed: { assertOwnership: lease.assertOwned } });
          ownedSessions.add(key);
          return bind(native, key, lease);
        } catch (error) { ownedSessions.delete(key); lease.release(); throw error; }
      } catch (error) { if (error instanceof HostError) throw error; throw new HostError("storage"); }
      finally { opening--; }
    },
    async openSession(reference: HostSessionReference) {
      requireOpen(); validateReference(reference);
      const selected = { ...reference };
      const key = `${directory}/${selected.id}`;
      if (retiredSessions.has(key)) throw new HostError("closed");
      try {
        if (await isManagedRetired(directory, selected.id)) { retiredSessions.add(key); throw new HostError("closed"); }
      } catch (error) {
        if (error instanceof HostError && error.code === "closed") throw error;
        if (error instanceof HostError) throw error;
      }
      if (ownedSessions.has(key)) throw new HostError("busy");
      ownedSessions.add(key); opening++;
      let lease: SessionLease | undefined;
      try {
        lease = acquireSessionLease(directory, selected.id);
        const native = await loadJsonlSession({ directory, id: selected.id, branchId: selected.branchId, managed: { assertOwnership: lease.assertOwned },
          validateIdentity: (workspaceRoot, extraRoots) => {
            if (workspaceRoot !== root || extraRoots.length) throw new HostError("workspace-mismatch");
          } });
        try {
          if (await isManagedRetired(directory, selected.id)) { retiredSessions.add(key); throw new HostError("closed"); }
        } catch (error) {
          if (error instanceof HostError && error.code === "closed") throw error;
          if (error instanceof HostError) throw error;
        }
        return bind(native, key, lease);
      } catch (error) {
        ownedSessions.delete(key);
        try { lease?.release(); } catch { /* Preserve the original rejection. */ }
        if (error instanceof HostError) throw error;
        if (error instanceof SessionConflictError) throw new HostError("conflict");
        if ((error as { reason?: string })?.reason === "not-found" || (error as Error).message === "Session not found") throw new HostError("storage");
        throw new HostError("storage");
      } finally { opening--; }
    },
    async retireSession(reference: HostSessionReference) {
      requireOpen(); validateReference(reference);
      const key = `${directory}/${reference.id}`;
      if (retiredSessions.has(key)) return;
      if (await isManagedRetired(directory, reference.id).catch(() => false)) { retiredSessions.add(key); return; }
      if (ownedSessions.has(key)) throw new HostError("busy");
      opening++;
      let lease: SessionLease | undefined;
      try {
        try { lease = acquireSessionLease(directory, reference.id); }
        catch (error) { if (error instanceof HostError && error.code === "busy") throw new HostError("busy"); throw new HostError("storage"); }
        try {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const { lstat } = await import("node:fs/promises");
          const path = join(directory, `${reference.id}.jsonl`);
          let headerText: string;
          try {
            const info = await lstat(path);
            if (!info.isFile() || info.nlink !== 1) throw new HostError("conflict");
            headerText = await readFile(path, "utf8");
          } catch (error) {
            if (error instanceof HostError) throw error;
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("storage");
            throw new HostError("storage");
          }
          let header: unknown;
          try { header = JSON.parse(headerText.split("\n", 1)[0] ?? ""); } catch { throw new HostError("conflict"); }
          if (!header || typeof header !== "object" || (header as { id?: unknown }).id !== reference.id) throw new HostError("conflict");
          if ((header as { workspaceRoot?: unknown }).workspaceRoot !== root || !Array.isArray((header as { extraRoots?: unknown }).extraRoots) || ((header as { extraRoots: unknown[] }).extraRoots.length !== 0)) {
            throw new HostError("workspace-mismatch");
          }
          await markManagedRetired(directory, reference.id, root);
          retiredSessions.add(key);
        } finally {
          try { lease.release(); } catch { /* Preserve retirement when release races a moved store. */ }
        }
      } finally { opening--; }
    },
    async deleteSession(reference: HostSessionReference): Promise<HostSessionDeletion> {
      requireOpen(); validateReference(reference);
      const key = `${directory}/${reference.id}`;
      if (ownedSessions.has(key)) {
        return { status: "blocked", session: Object.freeze({ id: reference.id, branchId: reference.branchId }), reason: "busy", nextAction: "Session is busy. Cancel admitted work, close the open session, then retry deletion." };
      }
      let lease: SessionLease | undefined;
      try {
        lease = acquireSessionLease(directory, reference.id);
      } catch (error) {
        if (error instanceof HostError && error.code === "busy") {
          return { status: "blocked", session: Object.freeze({ id: reference.id, branchId: reference.branchId }), reason: "busy", nextAction: "Session is busy. Cancel admitted work, close the open session, then retry deletion." };
        }
        throw new HostError("storage");
      }
      try {
        const result = await deleteManagedSession({ directory, home, workspaceRoot: root, reference: { id: reference.id, branchId: reference.branchId }, releaseLease: () => lease.release() });
        try {
          if (result.status !== "blocked" && await isManagedRetired(directory, reference.id)) retiredSessions.add(key);
        } catch { /* In-memory retirement stays best-effort when the store moved. */ }
        try { lease.release(); } catch { /* Deletion already recorded its honest status. */ }
        return result;
      } catch (error) {
        try { lease.release(); } catch { /* Preserve the original rejection. */ }
        if (error instanceof HostError) throw error;
        if (error instanceof SessionConflictError) {
          return { status: "blocked", session: Object.freeze({ id: reference.id, branchId: reference.branchId }), reason: "conflict", nextAction: "Session ownership changed. Reopen under exclusive ownership, close it, then retry deletion." };
        }
        throw new HostError("storage");
      }
    },
    async close() {
      if (closing) return closing;
      if (closed) return;
      if (opening || [...handles.values()].some(isBusy => isBusy())) throw new HostError("busy");
      const pending = [...handles.keys()].map(handle => handle.close());
      closed = true;
      closing = Promise.all(pending).then(() => undefined).catch(error => { closed = false; throw error; })
        .finally(() => { closing = undefined; });
      return closing;
    },
  });
}

/** Detach mutable request data so a supplied adapter cannot alter the committed ancestry or host policy. */
function structuredCloneRequest(request: ModelRequest): ModelRequest {
  const { signal, ...data } = request;
  return { ...structuredClone(data), ...(signal ? { signal } : {}) };
}

/** Whole nonnegative milliseconds between two monotonic readings. */
function elapsed(clock: HostClock, from: number): number {
  return Math.max(0, Math.round(monotonicNow(clock) - from));
}

/** Keep failure diagnostics terse, single-line and free of secrets or wire payloads.
 * Defense-in-depth over provider text: raw model errors are untrusted, so redact
 * bearer/JWT/key-like credentials here even when an upstream sanitizer also runs. */
function sanitizeDiagnostic(message: string): string {
  const redacted = message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/\b(?:Bearer|Basic|Token)\s+[^\s,"'}]+/gi, "[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9-]+|xai-[A-Za-z0-9-]+)\b/g, "[redacted]")
    .replace(/[A-Za-z0-9_.-]*?(?:api[_-]?key|secret|password|passwd|token|credential|access_token|refresh_token|private[_-]?key|session[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "[redacted]")
    .replace(/([?&](?:[^=&]*(?:key|token|secret|password|auth|credential|code|signature|sig)[^=&]*)=)[^&#\s]*/gi, "$1[redacted]");
  const single = redacted.replace(/\s+/g, " ").trim().slice(0, 500);
  return single.length > 0 ? single : "Provider request failed.";
}

/** Stable terminal message for non-error outcomes without provider text. */
function terminalMessage(reason: "error" | "cancelled" | "max_turns" | "limit_exceeded"): string {
  switch (reason) {
    case "cancelled": return "Run cancelled before durable completion.";
    case "max_turns": return "Run reached its model-round bound before completion.";
    case "limit_exceeded": return "Run reached its wall-clock bound before durable completion.";
    default: return "Provider request failed.";
  }
}
