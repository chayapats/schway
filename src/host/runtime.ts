import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { runAgentLoop } from "../agent/loop.ts";
import { createContextManager } from "../context/manager.ts";
import { contextPolicySnapshot, STRICT_CONTEXT_POLICY, WORKSPACE_CONTEXT_POLICY, type ContextSourcePolicy } from "../context/policy.ts";
import type { AssistantMessage } from "../conversation/types.ts";
import { createJsonlSession, loadJsonlSession, SessionConflictError, type JsonlSession } from "../session/jsonl.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { createActivateSkillTool } from "../skills/activate.ts";
import type { ToolDefinition } from "../tools/types.ts";
import { HostError, hostCapabilities, type HostOptions, type HostRuntime, type HostSession, type HostSessionReference,
  type HostEntryReference, type HostRunResult } from "./index.ts";
import { acquireSessionLease, type SessionLease } from "./lease.ts";
import type { Model, ModelRequest } from "../model/model.ts";

// Fast same-process rejection supplements the cross-process native session lease.
const ownedSessions = new Set<string>();
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HostError("invalid-options");
}

function optionsSnapshot(input: HostOptions): HostOptions & { sourcePolicy: ContextSourcePolicy } {
  keys(input, ["workspaceRoot", "sessionDirectory", "homeDirectory", "context", "tools", "limits"]);
  keys(input.context, ["policy", "systemPrompt", "sections", "sources", "discovery"]);
  keys(input.tools, ["policy", "definitions", "hostedLookup"]);
  keys(input.limits, ["maxTurns", "maxConcurrentTools", "contextWindow", "maxInputChars"]);
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
  return { sourcePolicy, workspaceRoot: input.workspaceRoot, sessionDirectory: input.sessionDirectory, homeDirectory: input.homeDirectory,
    context: { policy: input.context.policy, systemPrompt: input.context.systemPrompt, sections: structuredClone(input.context.sections), sources: structuredClone(sources) },
    tools: { policy: input.tools.policy, hostedLookup: "off" as const, definitions }, limits: { ...input.limits } };
}

function validateReference(reference: HostSessionReference): void {
  if (!record(reference) || Object.keys(reference).some(key => !["id", "branchId"].includes(key)) ||
      typeof reference.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(reference.id) ||
      typeof reference.branchId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference.branchId)) throw new HostError("invalid-reference");
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
  let closed = false, opening = 0;
  let closing: Promise<void> | undefined;
  const handles = new Map<HostSession, () => boolean>();
  const requireOpen = () => { if (closed) throw new HostError("closed"); };

  function bind(native: JsonlSession, key: string, lease: SessionLease): HostSession {
    let conflict = false;
    const check = () => {
      if (conflict) throw new HostError("conflict");
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
    const handle: HostSession = {
      reference,
      async submit(input, model, signal) {
        requireIdle();
        if (!record(input) || Object.keys(input).some(key => key !== "text") || typeof input.text !== "string" ||
            !input.text.trim() || input.text.length > options.limits.maxInputChars || !model ||
            typeof model.stream !== "function" || typeof model.provider !== "string" || !model.provider ||
            typeof model.id !== "string" || !model.id) throw new HostError("invalid-input");
        if (signal?.aborted) throw new HostError("invalid-input");
        check();
        const route = snapshotModel(model);
        busy = true;
        const release = native.acquireOperation();
        try {
          const id = crypto.randomUUID();
          try { native.append({ type: "user", id, content: [{ type: "text", text: input.text }] }); }
          catch (error) { if (error instanceof HostError) throw error; if (error instanceof SessionConflictError) throw new HostError("conflict"); throw new HostError("storage"); }
          const inputReference = ref(id);
          let outcome: HostRunResult["outcome"] = "error";
          for await (const event of runAgentLoop({ session: native, model: route, contextManager: context, tools: runTools, workspace,
            maxTurns: options.limits.maxTurns, maxConcurrentTools: options.limits.maxConcurrentTools, signal, webSearch: "off", exactTools: true })) {
            if (event.type === "agent.finished") outcome = event.reason;
          }
          try { check(); } catch (error) { if (error instanceof HostError && error.code === "conflict") throw error; }
          if (conflict) throw new HostError("conflict");
          if (outcome === "completed") {
            check();
            const message = native.items.findLast(item => item.type === "assistant");
            if (!message || message.type !== "assistant") throw new HostError("storage");
            return { outcome, input: inputReference, result: ref(message.id), message: structuredClone(message) };
          }
          return { outcome, input: inputReference };
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
      async compact(model, signal) {
        requireIdle();
        if (!model || typeof model.stream !== "function" || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) throw new HostError("invalid-input");
        check();
        const route = snapshotModel(model);
        busy = true;
        try {
          let failed = false;
          const record = await context.compact(native, route, { reason: "manual", signal, onOutcome: result => { if (result === "failed") failed = true; } });
          check();
          return record ? { outcome: "completed", result: ref(record.id) } : { outcome: failed ? "error" : signal?.aborted ? "cancelled" : "noop" };
        } catch (error) {
          if (conflict || error instanceof SessionConflictError || error instanceof HostError && error.code === "conflict") {
            conflict = true;
            throw new HostError("conflict");
          }
          return { outcome: signal?.aborted ? "cancelled" : "error" };
        } finally { busy = false; }
      },
      async close() {
        if (disposed) return;
        requireIdle();
        lease.release();
        disposed = true;
        ownedSessions.delete(key);
        handles.delete(handle);
      },
    };
    handles.set(handle, () => busy);
    return Object.freeze(handle);
  }

  return Object.freeze({
    capabilities: hostCapabilities(),
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
      if (ownedSessions.has(key)) throw new HostError("busy");
      ownedSessions.add(key); opening++;
      let lease: SessionLease | undefined;
      try {
        lease = acquireSessionLease(directory, selected.id);
        const native = await loadJsonlSession({ directory, id: selected.id, branchId: selected.branchId, managed: { assertOwnership: lease.assertOwned },
          validateIdentity: (workspaceRoot, extraRoots) => {
            if (workspaceRoot !== root || extraRoots.length) throw new HostError("workspace-mismatch");
          } });
        return bind(native, key, lease);
      } catch (error) {
        ownedSessions.delete(key);
        lease?.release();
        if (error instanceof HostError) throw error;
        if (error instanceof SessionConflictError) throw new HostError("conflict");
        throw new HostError("storage");
      } finally { opening--; }
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
