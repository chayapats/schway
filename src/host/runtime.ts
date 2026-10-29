import { mkdir, realpath, stat } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { deleteManagedSession, isManagedRetired, isManagedRetiredSync, markManagedRetired, readManagedHeader } from "./managed-data.ts";
import { SESSION_FORMAT_VERSION } from "../session/jsonl.ts";
import { MAX_SNAPSHOT_ARTIFACT_BYTES, MAX_SNAPSHOT_SESSIONS, MAX_SNAPSHOT_TOTAL_BYTES, SNAPSHOT_CONTRACT, SNAPSHOT_NATIVE_FORMAT_VERSION, hashSnapshotBytes, snapshotGuidance, validateSnapshotShape,
  type HostSessionSnapshot, type HostSnapshotArtifact, type HostSnapshotOptions, type HostSnapshotQuarantineReason, type HostSnapshotRestoreOptions,
  type HostSnapshotRestoreResult, type HostSnapshotSession, type HostSnapshotValidation } from "./snapshot.ts";
import type { Model, ModelRequest } from "../model/model.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { getEffectiveConversation } from "../context/compaction.ts";
import { HostImageError, MAX_IMAGE_BYTES, inputImages, requestImages, validateImageBytes } from "../conversation/images.ts";
import { imageProbeRecords, type HostImageRoute } from "./image-input.ts";

// Fast same-process rejection supplements the cross-process native session lease.
const ownedSessions = new Set<string>();
/** Retired managed contexts that cannot silently reopen in this process (file tombstone stays authoritative). */
const retiredSessions = new Map<string, true>();
/** Bound on the retired-context cache; eviction only drops the fast path, never the tombstone. */
const MAX_RETIRED_SESSIONS = 1024;
/** Record one retired context, evicting the oldest entry past the bound. */
function rememberRetired(key: string): void {
  retiredSessions.delete(key);
  retiredSessions.set(key, true);
  while (retiredSessions.size > MAX_RETIRED_SESSIONS) {
    const oldest = retiredSessions.keys().next();
    if (oldest.done) break;
    retiredSessions.delete(oldest.value);
  }
}
/** Whether one context retired, refreshing its recency without touching the tombstone. */
function isRetired(key: string): boolean {
  if (!retiredSessions.has(key)) return false;
  retiredSessions.delete(key);
  retiredSessions.set(key, true);
  return true;
}
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
  keys(input, ["workspaceRoot", "sessionDirectory", "homeDirectory", "context", "tools", "limits", "auth", "images"]);
  let images: HostOptions["images"];
  if (input.images !== undefined) {
    keys(input.images, ["probes", "resolve"]);
    if (typeof input.images.resolve !== "function") throw new HostError("invalid-options");
    images = { resolve: input.images.resolve, probes: imageProbeRecords(input.images.probes) };
  }
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
  return { sourcePolicy, ...(images ? { images } : {}), workspaceRoot: input.workspaceRoot, sessionDirectory: input.sessionDirectory, homeDirectory: input.homeDirectory,
    context: { policy: input.context.policy, systemPrompt: input.context.systemPrompt, sections: structuredClone(input.context.sections), sources: structuredClone(sources) },
    tools: { policy: input.tools.policy, hostedLookup: "off" as const, definitions },
    limits: { ...input.limits, deadlineMs, maxAttempts },
    ...(authSelection ? { auth: { route: authSelection.route, model: authSelection.model,
      ...(authSelection.store ? { store: authSelection.store } : {}),
      ...(authSelection.env ? { env: { ...authSelection.env } } : {}),
      ...(authSelection.fetch ? { fetch: authSelection.fetch } : {}),
      ...(authSelection.credentialWriteGuard ? { credentialWriteGuard: authSelection.credentialWriteGuard } : {}) } } : {}) };
}

function validateReference(reference: HostSessionReference): void {
  if (!record(reference) || Object.keys(reference).some(key => !["id", "branchId"].includes(key)) ||
      typeof reference.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference.id) ||
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
function normalizeRunArgs(signalOrOptions?: AbortSignal | HostRunOptions): HostRunOptions {
  if (signalOrOptions === undefined) return {};
  if (isAbortSignal(signalOrOptions)) return { signal: signalOrOptions };
  if (!record(signalOrOptions) || Object.keys(signalOrOptions).some(key => !["signal", "clock", "onProgress", "imageRoute"].includes(key))) throw new HostError("invalid-input");
  const imageRoute = signalOrOptions.imageRoute;
  if (imageRoute !== undefined && imageRoute !== "codex" && imageRoute !== "grok") throw new HostError("invalid-input");
  const { signal, clock, onProgress } = signalOrOptions as HostRunOptions;
  if (signal !== undefined && !isAbortSignal(signal)) throw new HostError("invalid-input");
  if (clock !== undefined && (!record(clock) || typeof (clock as HostClock).now !== "function" || typeof (clock as HostClock).sleep !== "function" ||
      ((clock as HostClock).monotonicNow !== undefined && typeof (clock as HostClock).monotonicNow !== "function"))) throw new HostError("invalid-input");
  if (onProgress !== undefined && typeof onProgress !== "function") throw new HostError("invalid-input");
  return { ...(imageRoute ? { imageRoute } : {}), ...(signal ? { signal } : {}), ...(clock ? { clock: clock as HostClock } : {}), ...(onProgress ? { onProgress: onProgress as (event: HostProgressEvent) => void } : {}) };
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
  // Preserve guard identity alongside store/fetch so the fence stays attached across runs.
  if (authSelection && (options as { auth?: HostAuthSelection }).auth?.credentialWriteGuard) {
    authSelection.credentialWriteGuard = (options as { auth?: HostAuthSelection }).auth!.credentialWriteGuard;
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
    let conflict = false, retiredClosed = false;
    const check = () => {
      if (conflict) throw new HostError("conflict");
      // A retired context stays closed; retirement never flips the conflict latch.
      if (retiredClosed || isRetired(key)) { retiredClosed = true; throw new HostError("closed"); }
      if (isManagedRetiredSync(directory, native.header.id)) { rememberRetired(key); retiredClosed = true; throw new HostError("closed"); }
      try { lease.assertOwned(); native.assertCurrent(); }
      catch (error) { if (error instanceof SessionConflictError || error instanceof HostError && error.code === "conflict") { conflict = true; throw new HostError("conflict"); } throw new HostError("storage"); }
      if (native.activeBranchId !== reference.branchId) { conflict = true; throw new HostError("conflict"); }
    };
    // Capture route identity and method once; trusted adapters retain their own private receiver.
    const imageState: { failure?: HostImageError } = {};
    const getImageFailure = (): HostImageError | undefined => imageState.failure;
    const imageSupported = (route: HostImageRoute | undefined, model: string) =>
      options.images?.probes.some(probe => probe.route === route && probe.model === model && probe.verdict === "pass") === true;
    const hasImages = (images: readonly import("../conversation/types.ts").ImageContent[]) =>
      images.length > 0 || getEffectiveConversation(native.items).some(item => item.type === "user" && item.content.some(block => block.type === "image"));
    const snapshotModel = (model: Model, imageRoute?: HostImageRoute): Model => {
      const provider = model.provider, id = model.id, stream = model.stream.bind(model);
      return Object.freeze({ provider, id, async *stream(request, call) {
        check();
        const detached = structuredCloneRequest(request);
        try {
          const images = requestImages(detached.items);
          if (images.length) {
            if (!imageSupported(imageRoute, id)) throw new HostImageError("images-unavailable");
            const imageData = new Map<string, Uint8Array>();
            for (const image of images) {
              detached.signal?.throwIfAborted();
              let data: Uint8Array | null;
              try { data = await options.images!.resolve(Object.freeze({ ...image }), detached.signal); }
              catch { detached.signal?.throwIfAborted(); throw new HostImageError("images-unavailable"); }
              detached.signal?.throwIfAborted();
              if (!(data instanceof Uint8Array)) throw new HostImageError("images-unavailable");
              if (data.byteLength > MAX_IMAGE_BYTES) throw new HostImageError("image-byte-limit");
              if (data.byteLength !== image.byteLength) throw new HostImageError("images-unavailable");
              const bytes = new Uint8Array(data);
              validateImageBytes(image, bytes);
              imageData.set(image.sha256, bytes);
            }
            detached.imageData = imageData;
          }
        } catch (error) {
          if (error instanceof HostImageError) imageState.failure = error;
          throw error;
        }
        check();
        for await (const event of stream(detached, call)) yield structuredClone(event);
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
      if (!record(input) || Object.keys(input).some(key => !["text", "images"].includes(key)) || typeof (input as { text?: unknown }).text !== "string" ||
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
        if (!record(input) || Object.keys(input).some(key => !["text", "images"].includes(key)) || typeof input.text !== "string" ||
            !input.text.trim() || input.text.length > options.limits.maxInputChars || !model ||
            typeof model.stream !== "function" || typeof model.provider !== "string" || !model.provider ||
            typeof model.id !== "string" || !model.id) throw new HostError("invalid-input");
        if (runArgs.signal?.aborted) throw new HostError("invalid-input");
        check();
        const images = inputImages(input.images);
        const route = snapshotModel(model, runArgs.imageRoute);
        const identity = modelIdentity(route);
        if (hasImages(images) && !imageSupported(runArgs.imageRoute, route.id)) return { outcome: "images-unsupported", model: identity, usage: usageSummary([], 0, false) };
        delete imageState.failure;
        busy = true;
        const release = native.acquireOperation();
        try {
          const id = crypto.randomUUID();
          try { native.append({ type: "user", id, content: [{ type: "text", text: input.text }, ...images] }); }
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
          const imageFailure = getImageFailure();
          if (imageFailure && reason !== "completed" && reason !== "cancelled" && reason !== "limit_exceeded") {
            if (imageFailure.code !== "images-unavailable") throw imageFailure;
            return { outcome: "images-unavailable", input: inputReference, model: identity, usage: usageSummary(usages, totalMs, false) };
          }
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
        if (runArgs.imageRoute !== undefined && runArgs.imageRoute !== authSelection.route) throw new HostError("invalid-input");
        const images = inputImages(input.images);
        check();
        const imageIdentity = { provider: authSelection.route === "codex" ? "codex-subscription" : "xai", id: authSelection.model };
        if (hasImages(images) && !imageSupported(authSelection.route, authSelection.model)) return { outcome: "images-unsupported", model: imageIdentity, usage: usageSummary([], 0, false) };
        delete imageState.failure;
        busy = true;
        const release = native.acquireOperation();
        try {
          const id = crypto.randomUUID();
          try { native.append({ type: "user", id, content: [{ type: "text", text: input.text }, ...images] }); }
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
          try { route = snapshotModel(await createAuthRouteModel(authSelection), authSelection.route); }
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
          const imageFailure = getImageFailure();
          if (imageFailure && terminal !== "completed" && terminal !== "cancelled" && terminal !== "limit_exceeded") {
            if (imageFailure.code !== "images-unavailable") throw imageFailure;
            return { outcome: "images-unavailable", input: inputReference, model: imageIdentity, usage: usageSummary(usages, totalMs, false) };
          }
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
        try {
          lease.release();
        } finally {
          disposed = true;
          ownedSessions.delete(key);
          handles.delete(handle);
        }
      },
      async retire() {
        if (disposed) return;
        requireIdle();
        check();
        await markManagedRetired(directory, reference.id, root);
        rememberRetired(key);
        retiredClosed = true;
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
    capabilities: hostCapabilities(options.images?.probes),
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
      if (isRetired(key)) throw new HostError("closed");
      if (await isManagedRetired(directory, selected.id)) { rememberRetired(key); throw new HostError("closed"); }
      if (ownedSessions.has(key)) throw new HostError("busy");
      ownedSessions.add(key); opening++;
      let lease: SessionLease | undefined;
      try {
        lease = acquireSessionLease(directory, selected.id);
        const native = await loadJsonlSession({ directory, id: selected.id, branchId: selected.branchId, managed: { assertOwnership: lease.assertOwned },
          validateIdentity: (workspaceRoot, extraRoots) => {
            if (workspaceRoot !== root || extraRoots.length) throw new HostError("workspace-mismatch");
          } });
        if (await isManagedRetired(directory, selected.id)) { rememberRetired(key); throw new HostError("closed"); }
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
      if (isRetired(key)) return;
      if (await isManagedRetired(directory, reference.id)) { rememberRetired(key); return; }
      if (ownedSessions.has(key)) throw new HostError("busy");
      opening++;
      let lease: SessionLease | undefined;
      try {
        try { lease = acquireSessionLease(directory, reference.id); }
        catch (error) { if (error instanceof HostError && error.code === "busy") throw new HostError("busy"); throw new HostError("storage"); }
        try {
          const header = await readManagedHeader(directory, reference.id);
          if (header.workspaceRoot !== root || header.extraRoots.length !== 0) throw new HostError("workspace-mismatch");
        } catch (error) {
          // A missing conversation stays storage; an alias stays conflict; faults already throw storage.
          if (error instanceof HostError) throw error;
          if ((error as { code?: string }).code === "missing") throw new HostError("storage");
          throw new HostError("conflict");
        }
        await markManagedRetired(directory, reference.id, root);
        rememberRetired(key);
      } finally {
        try { lease?.release(); } catch { /* Preserve retirement when release races a moved store. */ }
        opening--;
      }
    },
    async deleteSession(reference: HostSessionReference): Promise<HostSessionDeletion> {
      requireOpen(); validateReference(reference);
      const key = `${directory}/${reference.id}`;
      if (ownedSessions.has(key)) {
        return { status: "blocked", session: Object.freeze({ id: reference.id, branchId: reference.branchId }), reason: "busy", nextAction: "Session is busy. Cancel admitted work, close the open session, then retry deletion." };
      }
      // The delete lease is owned inside deleteManagedSession, which inventories before admitting
      // ownership so the self-created lease never appears in the removed set.
      const result = await deleteManagedSession({ directory, home, workspaceRoot: root, reference: { id: reference.id, branchId: reference.branchId } });
      try {
        if (result.status !== "blocked" && await isManagedRetired(directory, reference.id)) rememberRetired(key);
      } catch { /* In-memory retirement stays best-effort when the store moved. */ }
      return result;
    },
    async snapshotSessions(references: readonly HostSessionReference[], options?: HostSnapshotOptions): Promise<HostSessionSnapshot> {
      requireOpen();
      if (SESSION_FORMAT_VERSION !== SNAPSHOT_NATIVE_FORMAT_VERSION) throw new HostError("storage");
      const excludeRetired = snapshotOption(options);
      if (!Array.isArray(references) || references.length < 1 || references.length > MAX_SNAPSHOT_SESSIONS) throw new HostError("invalid-input");
      for (const reference of references) validateReference(reference);
      const ids = references.map(reference => reference.id);
      if (new Set(ids).size !== ids.length) throw new HostError("invalid-input");
      for (const id of ids) {
        if (ownedSessions.has(`${directory}/${id}`)) throw new HostError("busy");
      }
      opening++;
      const held = new Map<string, SessionLease>();
      const releaseAll = (): void => {
        for (const lease of held.values()) {
          try { lease.release(); } catch { /* Preserve the snapshot verdict. */ }
        }
        held.clear();
      };
      try {
        for (const id of [...ids].sort()) {
          try {
            held.set(id, acquireSessionLease(directory, id));
          } catch (error) {
            if (error instanceof HostError && error.code === "busy") throw new HostError("busy");
            throw new HostError("storage");
          }
        }
        const captured: HostSnapshotSession[] = [];
        let totalCaptured = 0;
        for (const reference of references) {
          const id = reference.id;
          let header: { workspaceRoot: string; extraRoots: readonly string[] };
          try {
            header = await readManagedHeader(directory, id);
          } catch (error) {
            if (error instanceof HostError) throw error;
            if ((error as { code?: string }).code === "missing") throw new HostError("storage");
            throw new HostError("conflict");
          }
          if (header.workspaceRoot !== root || header.extraRoots.length !== 0) throw new HostError("workspace-mismatch");
          let retired = false;
          try {
            retired = await isManagedRetired(directory, id);
          } catch {
            throw new HostError("storage");
          }
          if (retired && excludeRetired) {
            try { held.get(id)?.release(); } catch { /* Preserve the snapshot verdict. */ }
            held.delete(id);
            continue;
          }
          const conversationPath = join(directory, `${id}.jsonl`);
          let conversation: Uint8Array;
          try {
            conversation = await readOwnedSnapshotBytes(conversationPath);
          } catch (error) {
            if (error instanceof HostError) throw error;
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("storage");
            throw new HostError("storage");
          }
          if (conversation.length < 1 || conversation.length > MAX_SNAPSHOT_ARTIFACT_BYTES) throw new HostError("storage");
          totalCaptured += conversation.length;
          if (totalCaptured > MAX_SNAPSHOT_TOTAL_BYTES) throw new HostError("storage");
          let firstLine: string;
          let parsedHeader: { version?: unknown; createdAt?: unknown };
          try {
            firstLine = Buffer.from(conversation).toString("utf8").split("\n", 1)[0] ?? "";
            parsedHeader = JSON.parse(firstLine) as { version?: unknown; createdAt?: unknown };
          } catch {
            throw new HostError("conflict");
          }
          if (typeof parsedHeader.version !== "number" || !Number.isSafeInteger(parsedHeader.version) ||
              parsedHeader.version < 1 || parsedHeader.version > SESSION_FORMAT_VERSION ||
              typeof parsedHeader.createdAt !== "string" || !Number.isFinite(Date.parse(parsedHeader.createdAt))) {
            throw new HostError("conflict");
          }
          const metadataPath = `${conversationPath}.meta`;
          let metadata: Uint8Array | undefined;
          try {
            const candidate = await readOwnedSnapshotBytes(metadataPath);
            if (candidate.length > MAX_SNAPSHOT_ARTIFACT_BYTES) throw new HostError("storage");
            if (candidate.length > 0) {
              metadata = candidate;
              totalCaptured += metadata.length;
              if (totalCaptured > MAX_SNAPSHOT_TOTAL_BYTES) throw new HostError("storage");
            }
          } catch (error) {
            if (error instanceof HostError) throw error;
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage");
          }
          const artifacts: HostSnapshotArtifact[] = [];
          artifacts.push(Object.freeze({
            kind: "conversation" as const,
            size: conversation.length,
            sha256: hashSnapshotBytes(conversation),
            dataBase64: Buffer.from(conversation).toString("base64"),
          }));
          if (metadata) {
            artifacts.push(Object.freeze({
              kind: "metadata" as const,
              size: metadata.length,
              sha256: hashSnapshotBytes(metadata),
              dataBase64: Buffer.from(metadata).toString("base64"),
            }));
          }
          // Re-verify the lease, retirement and bytes before reporting a coherent set.
          try {
            held.get(id)?.assertOwned();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("storage");
            throw new HostError("conflict");
          }
          let retiredNow = false;
          try {
            retiredNow = await isManagedRetired(directory, id);
          } catch {
            throw new HostError("storage");
          }
          if (retiredNow !== retired) throw new HostError("conflict");
          let reread: Uint8Array;
          try {
            reread = await readOwnedSnapshotBytes(conversationPath);
          } catch (error) {
            if (error instanceof HostError) throw error;
            throw new HostError("storage");
          }
          if (reread.length !== conversation.length || !Buffer.from(reread).equals(Buffer.from(conversation))) throw new HostError("conflict");
          let rereadMeta: Uint8Array | undefined;
          try {
            const candidate = await readOwnedSnapshotBytes(metadataPath);
            if (candidate.length > 0) rereadMeta = candidate;
          } catch (error) {
            if (error instanceof HostError) throw error;
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage");
          }
          const metaMatches = (metadata === undefined && rereadMeta === undefined) ||
            (metadata !== undefined && rereadMeta !== undefined &&
              rereadMeta.length === metadata.length && Buffer.from(rereadMeta).equals(Buffer.from(metadata)));
          if (!metaMatches) throw new HostError("conflict");
          captured.push(Object.freeze({
            id,
            branchId: reference.branchId,
            workspaceRoot: header.workspaceRoot,
            headerCreatedAt: parsedHeader.createdAt as string,
            nativeFormatVersion: parsedHeader.version as number,
            retired,
            artifacts: Object.freeze(artifacts),
          }));
        }
        return Object.freeze({
          snapshotContract: SNAPSHOT_CONTRACT,
          nativeFormatVersion: SESSION_FORMAT_VERSION,
          createdAt: new Date().toISOString(),
          sessions: Object.freeze(captured),
        });
      } finally {
        releaseAll();
        opening--;
      }
    },
    validateSessionSnapshot(snapshot: unknown): HostSnapshotValidation {
      requireOpen();
      const verdict = validateSnapshotShape(snapshot);
      if (verdict.status !== "valid") return verdict;
      const record = snapshot as { sessions: readonly { workspaceRoot: string }[] };
      for (const session of record.sessions) {
        if (session.workspaceRoot !== root) {
          return Object.freeze({ status: "quarantined" as const, reason: "workspace-mismatch" as const, nextAction: snapshotGuidance("quarantined", "workspace-mismatch") });
        }
      }
      return verdict;
    },
    async restoreSessionSnapshot(snapshot: unknown, options?: HostSnapshotRestoreOptions): Promise<HostSnapshotRestoreResult> {
      requireOpen();
      if (SESSION_FORMAT_VERSION !== SNAPSHOT_NATIVE_FORMAT_VERSION) throw new HostError("storage");
      const excludeRetired = snapshotOption(options);
      let isolated: unknown;
      try {
        isolated = structuredClone(snapshot);
      } catch {
        return Object.freeze({ status: "quarantined" as const, reason: "incomplete" as const, nextAction: snapshotGuidance("quarantined", "incomplete") });
      }
      const verdict = validateSnapshotShape(isolated);
      if (verdict.status !== "valid") {
        return Object.freeze({ status: "quarantined" as const, reason: verdict.reason, nextAction: verdict.nextAction });
      }
      const source = isolated as HostSessionSnapshot;
      for (const session of source.sessions) {
        if (session.workspaceRoot !== root) {
          return Object.freeze({ status: "quarantined" as const, reason: "workspace-mismatch" as const, nextAction: snapshotGuidance("quarantined", "workspace-mismatch") });
        }
      }
      const wanted = source.sessions.filter(session => !(excludeRetired && session.retired));
      if (wanted.length === 0) {
        return Object.freeze({ status: "restored" as const, sessions: Object.freeze([]), nextAction: snapshotGuidance("restored") });
      }
      for (const session of wanted) {
        if (ownedSessions.has(`${directory}/${session.id}`)) {
          return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "busy") });
        }
      }
      opening++;
      const held = new Map<string, SessionLease>();
      const releaseAll = (): void => {
        for (const lease of held.values()) {
          try { lease.release(); } catch { /* Preserve the restore verdict. */ }
        }
        held.clear();
      };
      try {
        try {
          if (!(await stat(directory)).isDirectory()) throw new HostError("storage");
        } catch (error) {
          if (error instanceof HostError) throw error;
          throw new HostError("storage");
        }
        for (const id of wanted.map(session => session.id).sort()) {
          try {
            held.set(id, acquireSessionLease(directory, id));
          } catch {
            const acquired = [...held.values()];
            for (const lease of acquired) {
              try { lease.release(); } catch { /* Preserve the restore verdict. */ }
            }
            held.clear();
            return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "busy") });
          }
        }
        const decoded = new Map<string, { conversation: Uint8Array; metadata?: Uint8Array }>();
        for (const session of wanted) {
          const conversationEntry = session.artifacts.find(artifact => artifact.kind === "conversation");
          if (!conversationEntry) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "incomplete" as const, nextAction: snapshotGuidance("quarantined", "incomplete") });
          }
          const metadataEntry = session.artifacts.find(artifact => artifact.kind === "metadata");
          let conversation: Uint8Array;
          try {
            conversation = Buffer.from(conversationEntry.dataBase64, "base64");
          } catch {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "corrupt" as const, nextAction: snapshotGuidance("quarantined", "corrupt") });
          }
          if (conversation.length !== conversationEntry.size || conversation.length < 1 ||
              conversation.length > MAX_SNAPSHOT_ARTIFACT_BYTES ||
              hashSnapshotBytes(conversation) !== conversationEntry.sha256) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "corrupt" as const, nextAction: snapshotGuidance("quarantined", "corrupt") });
          }
          let metadata: Uint8Array | undefined;
          if (metadataEntry) {
            try {
              metadata = Buffer.from(metadataEntry.dataBase64, "base64");
            } catch {
              releaseAll();
              return Object.freeze({ status: "quarantined" as const, reason: "corrupt" as const, nextAction: snapshotGuidance("quarantined", "corrupt") });
            }
            if (metadata.length !== metadataEntry.size || metadata.length < 1 ||
                metadata.length > MAX_SNAPSHOT_ARTIFACT_BYTES ||
                hashSnapshotBytes(metadata) !== metadataEntry.sha256) {
              releaseAll();
              return Object.freeze({ status: "quarantined" as const, reason: "corrupt" as const, nextAction: snapshotGuidance("quarantined", "corrupt") });
            }
          }
          decoded.set(session.id, { conversation, ...(metadata ? { metadata } : {}) });
        }
        const restored: HostSnapshotSession[] = [];
        const needsWrite = new Map<string, boolean>();
        for (const session of wanted) {
          const expected = decoded.get(session.id);
          if (!expected) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "incomplete" as const, nextAction: snapshotGuidance("quarantined", "incomplete") });
          }
          const conversationPath = join(directory, `${session.id}.jsonl`);
          const metadataPath = `${conversationPath}.meta`;
          let existing: Uint8Array | undefined;
          try {
            existing = await readOwnedSnapshotBytes(conversationPath);
          } catch (error) {
            if (error instanceof HostError) {
              releaseAll();
              return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
            }
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage");
          }
          let existingMeta: Uint8Array | undefined;
          try {
            const candidate = await readOwnedSnapshotBytes(metadataPath);
            if (candidate.length > 0) existingMeta = candidate;
          } catch (error) {
            if (error instanceof HostError) {
              releaseAll();
              return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
            }
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage");
          }
          let retiredExists = false;
          try {
            retiredExists = await isManagedRetired(directory, session.id);
          } catch {
            throw new HostError("storage");
          }
          if (existing !== undefined) {
            const conversationMatches = existing.length === expected.conversation.length &&
              Buffer.from(existing).equals(Buffer.from(expected.conversation));
            const metaMatches = (expected.metadata === undefined && existingMeta === undefined) ||
              (expected.metadata !== undefined && existingMeta !== undefined &&
                existingMeta.length === expected.metadata.length &&
                Buffer.from(existingMeta).equals(Buffer.from(expected.metadata)));
            if (conversationMatches && metaMatches) {
              if (retiredExists && !session.retired) {
                releaseAll();
                return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
              }
              needsWrite.set(session.id, false);
              restored.push(session);
              continue;
            }
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
          }
          if (existingMeta !== undefined && expected.metadata === undefined) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
          }
          if (retiredExists && !session.retired) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "conflict" as const, nextAction: snapshotGuidance("quarantined", "conflict", "target-exists") });
          }
          needsWrite.set(session.id, true);
        }
        const pending = wanted.filter(session => needsWrite.get(session.id) !== false);
        for (const session of pending) {
          const bytes = decoded.get(session.id);
          if (!bytes) {
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason: "incomplete" as const, nextAction: snapshotGuidance("quarantined", "incomplete") });
          }
          try {
            await writeSnapshotFile(join(directory, `${session.id}.jsonl`), bytes.conversation);
            if (bytes.metadata) await writeSnapshotFile(join(directory, `${session.id}.jsonl.meta`), bytes.metadata);
            const written = await readOwnedSnapshotBytes(join(directory, `${session.id}.jsonl`));
            if (written.length !== bytes.conversation.length ||
                !Buffer.from(written).equals(Buffer.from(bytes.conversation)) ||
                hashSnapshotBytes(written) !== hashSnapshotBytes(bytes.conversation)) {
              throw new HostError("storage");
            }
            if (bytes.metadata) {
              const writtenMeta = await readOwnedSnapshotBytes(join(directory, `${session.id}.jsonl.meta`));
              if (writtenMeta.length !== bytes.metadata.length ||
                  !Buffer.from(writtenMeta).equals(Buffer.from(bytes.metadata))) {
                throw new HostError("storage");
              }
            }
          } catch (error) {
            if (error instanceof HostError && error.code !== "storage") throw error;
            const done = restored.map(entry => Object.freeze({ id: entry.id, branchId: entry.branchId }));
            const remaining = wanted.filter(entry => !restored.some(doneEntry => doneEntry.id === entry.id))
              .map(entry => Object.freeze({ id: entry.id, branchId: entry.branchId }));
            // Keep coherent writes; partial never auto-runs model calls or tools.
            releaseAll();
            return Object.freeze({ status: "partial" as const, restored: Object.freeze(done), remaining: Object.freeze(remaining), nextAction: snapshotGuidance("partial") });
          }
          restored.push(session);
        }
        for (const session of restored) {
          try {
            const lease = held.get(session.id);
            await loadJsonlSession({ directory, id: session.id, branchId: session.branchId,
              managed: lease ? { assertOwnership: () => lease.assertOwned() } : undefined,
              validateIdentity: (workspaceRoot, extraRoots) => {
                if (workspaceRoot !== root || extraRoots.length) throw new HostError("workspace-mismatch");
              } });
          } catch (error) {
            if (error instanceof HostError && error.code === "workspace-mismatch") {
              for (const entry of restored) {
                try { await unlink(join(directory, `${entry.id}.jsonl`)); } catch { /* Preserve quarantine. */ }
                try { await unlink(join(directory, `${entry.id}.jsonl.meta`)); } catch { /* Preserve quarantine. */ }
              }
              releaseAll();
              return Object.freeze({ status: "quarantined" as const, reason: "workspace-mismatch" as const, nextAction: snapshotGuidance("quarantined", "workspace-mismatch") });
            }
            const message = error instanceof Error ? error.message : String(error);
            const reason: HostSnapshotQuarantineReason = /Unsupported session format version|Unsupported or invalid session format transition|requires a valid branch operation/i.test(message)
              ? "unsupported-version" : "corrupt";
            for (const entry of restored) {
              try { await unlink(join(directory, `${entry.id}.jsonl`)); } catch { /* Preserve quarantine. */ }
              try { await unlink(join(directory, `${entry.id}.jsonl.meta`)); } catch { /* Preserve quarantine. */ }
            }
            releaseAll();
            return Object.freeze({ status: "quarantined" as const, reason, nextAction: snapshotGuidance("quarantined", reason) });
          }
        }
        for (const session of restored) {
          if (!session.retired) continue;
          try {
            await markManagedRetired(directory, session.id, root);
            rememberRetired(`${directory}/${session.id}`);
          } catch {
            try { await unlink(join(directory, `${session.id}.jsonl`)); } catch { /* Preserve partial inventory. */ }
            try { await unlink(join(directory, `${session.id}.jsonl.meta`)); } catch { /* Preserve partial inventory. */ }
            const done = restored.filter(entry => entry.id !== session.id).map(entry => Object.freeze({ id: entry.id, branchId: entry.branchId }));
            const remaining = wanted.filter(entry => entry.id === session.id || !done.some(entry2 => entry2.id === entry.id))
              .map(entry => Object.freeze({ id: entry.id, branchId: entry.branchId }));
            releaseAll();
            return Object.freeze({ status: "partial" as const, restored: Object.freeze(done), remaining: Object.freeze(remaining), nextAction: snapshotGuidance("partial") });
          }
        }
        const references = wanted.filter(session => restored.some(entry => entry.id === session.id))
          .map(session => Object.freeze({ id: session.id, branchId: session.branchId }));
        releaseAll();
        return Object.freeze({ status: "restored" as const, sessions: Object.freeze(references), nextAction: snapshotGuidance("restored") });
      } finally {
        releaseAll();
        opening--;
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

/** Validate snapshot/restore options carrying only the retired filter. */
function snapshotOption(options: HostSnapshotOptions | HostSnapshotRestoreOptions | undefined): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "excludeRetired")) throw new HostError("invalid-input");
  const excludeRetired = (options as { excludeRetired?: unknown }).excludeRetired ?? false;
  if (typeof excludeRetired !== "boolean") throw new HostError("invalid-input");
  return excludeRetired;
}

/** Read one owned snapshot artifact through a pinned descriptor that never follows a symlink. */
async function readOwnedSnapshotBytes(path: string): Promise<Uint8Array> {
  let file;
  try {
    file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw error;
    if (code === "ELOOP") throw new HostError("conflict");
    throw new HostError("storage");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new HostError("conflict");
    return await file.readFile();
  } catch (error) {
    if (error instanceof HostError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new HostError("storage");
  } finally {
    await file.close();
  }
}

/** Write one restored artifact exclusively so a second restore cannot mix generations. */
async function writeSnapshotFile(path: string, bytes: Uint8Array): Promise<void> {
  const file = await openFile(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
