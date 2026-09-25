import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../agent/loop.ts";
import { resolveProviderCredential, selectOpenAITransport } from "../auth/credentials.ts";
import { codexSubscriptionIdentity, createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { createContextManager } from "../context/manager.ts";
import { DEFAULT_MODEL_IDS } from "../model/catalog.ts";
import { loadProviderModel, type ProviderLoaderInput } from "../model/loader.ts";
import type { Model } from "../model/model.ts";
import { createSession } from "../session/session.ts";
import { readTool, type ReadInput } from "../tools/read.ts";
import { createToolRegistry } from "../tools/registry.ts";
import type { ToolDefinition } from "../tools/types.ts";
import type { Workspace } from "../workspace/workspace.ts";

/** Independently selectable provider/auth lanes; API-key OpenAI never silently switches to subscription billing. */
export type SmokeProvider = "anthropic" | "openai-api-key" | "compatible" | "codex";
/** Explicit opt-in selection and bounded execution settings, with no implicit credential discovery. */
export interface SmokeSelection {
  enabled: boolean;
  providers: readonly SmokeProvider[];
  revision: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  compatible?: {
    baseUrl: string;
    auth: "required" | "none";
    profile?: string;
    credentialEnv?: string;
    credentialIdentity?: string;
  };
  models?: Partial<Record<SmokeProvider, string>>;
  /** Optional programmatic runtime key overrides, scoped to one selected provider. */
  runtimeKeys?: Partial<Record<SmokeProvider, string>>;
}
/** Private test seams; production defaults load only selected adapters and the native secure store. */
export interface SmokeDependencies {
  createStore?: () => CredentialStore;
  createModel?: (input: ProviderLoaderInput) => Promise<Model>;
  onWorkspace?: (workspace: Workspace) => void;
  /** Script a bounded sentinel read in offline tests without changing the only allowed path. */
  readSentinel?: ToolDefinition<ReadInput>["execute"];
}
/** Bounded, secret-free scenario classification; no arbitrary provider messages are serialized. */
export interface SmokeScenario {
  provider: SmokeProvider;
  model: string;
  authSource: "runtime" | "env" | "stored" | "stored-subscription" | "none" | "unavailable";
  status: "passed" | "skipped" | "pending" | "failed_provider" | "failed_runner";
  reason: string;
  durationMs: number;
  toolRoundTrip: boolean;
  /** Deferred means an uncooperative stream still owns its temporary workspace. */
  cleanup?: "deferred";
}
/** Dated evidence tied to revision and model selections; incomplete never masquerades as pass. */
export interface SmokeReport {
  testedAt: string;
  revision: string;
  aggregate: "passed" | "incomplete" | "failed";
  scenarios: SmokeScenario[];
}

const SENTINEL_FILE = "smoke-sentinel.txt";
function sentinelReadTool(execute: ToolDefinition<ReadInput>["execute"]): ToolDefinition<ReadInput> {
  return {
    ...readTool,
    execute: async (input, context) => input.path === SENTINEL_FILE
      ? await execute(input, context)
      : { content: "Only the smoke sentinel may be read.", isError: true },
  };
}
const MAX_OUTPUT_CHARS = 4096;
const SETTLEMENT_GRACE_MS = 40;
const MAX_TURNS = 2;
const MAX_TOKENS = 256;
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const DEFAULT_MODELS: Record<SmokeProvider, string> = {
  anthropic: DEFAULT_MODEL_IDS.anthropic,
  "openai-api-key": DEFAULT_MODEL_IDS.openai,
  compatible: DEFAULT_MODEL_IDS["openai-compatible"],
  codex: DEFAULT_MODEL_IDS.openai,
};

/** Execute only explicitly enabled lanes through Schway's real streaming loop and isolated read tool. */
export async function runLiveSmoke(selection: SmokeSelection, deps: SmokeDependencies = {}): Promise<SmokeReport> {
  const scenarios: SmokeScenario[] = [];
  let priorUnsettled = false;
  for (const provider of [...new Set(selection.providers)]) {
    const start = performance.now();
    const requestedModel = selection.models?.[provider] ?? DEFAULT_MODELS[provider];
    const scenario: SmokeScenario = {
      provider, model: SAFE_ID.test(requestedModel) ? requestedModel : "invalid-model-id",
      authSource: "unavailable", status: "skipped", reason: "live_disabled", durationMs: 0, toolRoundTrip: false,
    };
    if (priorUnsettled) { scenario.status = "pending"; scenario.reason = "prior_run_unsettled"; }
    else if (selection.enabled) await runScenario(selection, provider, scenario, deps);
    scenario.durationMs = Math.round(performance.now() - start);
    scenarios.push(scenario);
    if (scenario.cleanup === "deferred") priorUnsettled = true;
  }
  const aggregate = scenarios.some(s => s.status === "failed_provider" || s.status === "failed_runner") ? "failed"
    : scenarios.length > 0 && scenarios.every(s => s.status === "passed") ? "passed" : "incomplete";
  return { testedAt: new Date().toISOString(), revision: SAFE_ID.test(selection.revision) ? selection.revision : "unknown", aggregate, scenarios };
}

/** Bound the entire selected lane and always drain the cooperative loop before removing its workspace. */
async function runScenario(selection: SmokeSelection, provider: SmokeProvider, result: SmokeScenario, deps: SmokeDependencies): Promise<void> {
  if (selection.signal?.aborted) { result.status = "pending"; result.reason = "cancelled"; return; }
  if (!SAFE_ID.test(result.model) || !Number.isInteger(selection.timeoutMs) || selection.timeoutMs < 1 || selection.timeoutMs > 120_000) {
    result.status = "failed_runner"; result.reason = "invalid_settings"; return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), selection.timeoutMs);
  const signal = selection.signal ? AbortSignal.any([controller.signal, selection.signal]) : controller.signal;
  let directory: string | undefined;
  let startedModel = false;
  let stream: Promise<void> | undefined;
  let unsettled = false;
  let outputLimit = false;
  try {
    // OS keychain reads are not cancellable; do not allow a late resolution
    // to mutate an already-published timeout report.
    const resolved: SmokeScenario = { ...result };
    const input = await awaitSetup(resolveInput(selection, provider, resolved, deps), signal);
    if (!signal.aborted) Object.assign(result, resolved);
    if (!input || signal.aborted) {
      if (signal.aborted) { result.status = selection.signal?.aborted ? "pending" : "failed_runner"; result.reason = selection.signal?.aborted ? "cancelled" : "timeout"; }
      return;
    }
    const model = await awaitSetup((deps.createModel ?? (input => loadProviderModel(input)))(input), signal);
    result.model = SAFE_ID.test(model.id) ? model.id : "invalid-model-id";
    // The loop registers activate_skill whenever it has a workspace. Do not
    // advertise that unrelated tool to the selected smoke transport.
    const smokeModel: Model = {
      provider: model.provider, id: model.id,
      stream: request => model.stream({ ...request, tools: request.tools?.filter(tool => tool.name === "read") }),
    };
    directory = await mkdtemp(join(tmpdir(), "schway-live-"));
    // Never promote an ancestor Git root if TMPDIR happens to live inside a repository.
    const root = await realpath(directory);
    const workspace: Workspace = { root, launchCwd: root, extraRoots: [] };
    deps.onWorkspace?.(workspace);
    const marker = randomBytes(20).toString("hex");
    await writeFile(join(directory, SENTINEL_FILE), `${marker}\n`, { flag: "wx", mode: 0o600 });
    const session = createSession([{
      type: "user", id: crypto.randomUUID(), content: [{ type: "text", text:
        `Use the read tool to read ${SENTINEL_FILE} in this workspace. Then reply with only the exact value on its first line. Do not guess.` }],
    }]);
    let error = false;
    let needsLogin = false;
    let finished: string | undefined;
    let chars = 0;
    stream = (async () => {
      for await (const event of runAgentLoop({ session, model: smokeModel, workspace, contextManager: createContextManager(workspace),
        tools: createToolRegistry([sentinelReadTool(deps.readSentinel ?? readTool.execute)]), signal, maxTurns: MAX_TURNS })) {
        if (event.type === "model.started") startedModel = true;
        if (event.type === "model.delta") chars += event.content.text.length;
        // A completed model message is yielded before the loop schedules its tool calls.
        // This caps assembled arguments at the runner seam, not provider wire bytes.
        if (event.type === "model.finished") {
          const last = session.items.at(-1);
          if (last?.type === "assistant") chars += JSON.stringify(last).length;
        }
        if (event.type === "tool.finished") chars += event.content.length;
        if (chars > MAX_OUTPUT_CHARS) { outputLimit = true; controller.abort(); break; }
        if (event.type === "error") {
          error = true;
          needsLogin = provider === "codex" && /Sign in again in interactive mode|subscription session (expired|was revoked)/i.test(event.message);
        }
        if (event.type === "agent.finished") finished = event.reason;
      }
    })();
    // Abort bounds the report even if an adapter ignores it. Never remove the workspace
    // before the still-running stream and any accepted tool I/O have actually settled.
    await awaitSetup(stream, signal);
    if (selection.signal?.aborted) { result.status = "pending"; result.reason = "cancelled"; return; }
    if (outputLimit) { result.status = "failed_provider"; result.reason = "output_limit"; return; }
    if (controller.signal.aborted) { result.status = startedModel ? "failed_provider" : "failed_runner"; result.reason = "timeout"; return; }
    if (error || finished === "error") {
      result.status = needsLogin ? "pending" : startedModel ? "failed_provider" : "failed_runner";
      result.reason = needsLogin ? "subscription_requires_login" : startedModel ? "provider_error" : "runner_error";
      return;
    }
    if (finished !== "completed") { result.status = "failed_provider"; result.reason = finished === "max_turns" ? "turn_limit" : "no_final_response"; return; }
    const calls = session.items.filter(item => item.type === "assistant").flatMap(item => item.type === "assistant" ? item.content.filter(block => block.type === "tool_call") : []);
    const results = session.items.filter(item => item.type === "tool_result");
    const final = session.items.at(-1);
    result.toolRoundTrip = calls.length === 1 && calls[0]?.type === "tool_call" && calls[0].name === "read"
      && typeof calls[0].arguments === "object" && calls[0].arguments !== null
      && (calls[0].arguments as { path?: unknown }).path === SENTINEL_FILE
      && results.length === 1 && results[0]?.type === "tool_result" && results[0].toolCallId === calls[0].id
      && !results[0].isError && results[0].content.includes(marker);
    const answer = final?.type === "assistant" ? final.content.filter(block => block.type === "text").map(block => block.text).join("") : "";
    result.status = result.toolRoundTrip && answer === marker ? "passed" : "failed_provider";
    result.reason = result.status === "passed" ? "verified" : "missing_tool_evidence";
  } catch {
    if (stream && signal.aborted) {
      // Cooperative adapters get a short, bounded chance to finish cancellation.
      // A non-cooperative adapter cannot block the report or authorize deleting its workspace.
      const settled = await Promise.race([
        stream.then(() => true, () => true),
        Bun.sleep(SETTLEMENT_GRACE_MS).then(() => false),
      ]);
      unsettled = !settled;
    }
    result.status = selection.signal?.aborted ? "pending" : controller.signal.aborted && startedModel ? "failed_provider" : "failed_runner";
    result.reason = outputLimit ? "output_limit" : selection.signal?.aborted ? "cancelled"
      : controller.signal.aborted ? (unsettled ? "timeout_unsettled" : "timeout") : "runner_error";
  } finally {
    clearTimeout(timer);
    if (directory) {
      if (unsettled && stream) {
        result.cleanup = "deferred";
        const retained = directory;
        // Keep the workspace if the stream never settles; a settled stream releases it.
        void stream.then(() => rm(retained, { recursive: true, force: true }),
          () => rm(retained, { recursive: true, force: true })).catch(() => {});
      } else {
        try { await rm(directory, { recursive: true, force: true }); }
        catch { result.status = "failed_runner"; result.reason = "cleanup_failed"; }
      }
    }
  }
}

/** Resolve auth only for the selected lane, without an interactive flow or billing fallback. */
async function resolveInput(selection: SmokeSelection, provider: SmokeProvider, result: SmokeScenario, deps: SmokeDependencies): Promise<ProviderLoaderInput | undefined> {
  const model = result.model;
  if (provider === "compatible" && (!selection.compatible || !isSafeEndpoint(selection.compatible.baseUrl))) {
    result.status = "pending"; result.reason = "compatible_endpoint_required"; return;
  }
  const store = provider === "compatible" && selection.compatible?.auth === "none"
    ? undefined : (deps.createStore ?? createNativeCredentialStore)();
  if (provider === "codex") {
    const selected = await selectOpenAITransport({ openaiAuth: "codex", env: selection.env, store: store! });
    if ("error" in selected) { result.status = "pending"; result.reason = selected.error.startsWith("No ChatGPT") ? "missing_subscription" : "credential_store_unavailable"; return; }
    let integration: typeof import("../model/providers/codex-subscription.ts");
    try { integration = await import("../model/providers/codex-subscription.ts"); }
    catch { result.status = "pending"; result.reason = "integration_unavailable"; return; }
    // Separate an unavailable OS keychain from malformed/expired stored login data.
    let raw: string | null;
    try { raw = await store!.get(codexSubscriptionIdentity()); }
    catch { result.status = "pending"; result.reason = "credential_store_unavailable"; return; }
    let tokens;
    try { tokens = raw?.trim() ? integration.parseSubscriptionTokens(raw) : null; }
    catch { result.status = "pending"; result.reason = "subscription_requires_login"; return; }
    if (!tokens || (integration.subscriptionAccessExpired(tokens) && !tokens.refreshToken)) {
      result.status = "pending"; result.reason = "subscription_requires_login"; return;
    }
    result.authSource = "stored-subscription";
    return { provider: "openai", openaiAuth: "codex", model, maxTokens: MAX_TOKENS, codexStore: store };
  }
  const family = provider === "openai-api-key" ? "openai" : provider === "compatible" ? "openai-compatible" : "anthropic";
  const credential = await resolveProviderCredential({
    provider: family, baseUrl: selection.compatible?.baseUrl, auth: selection.compatible?.auth,
    profile: selection.compatible?.profile, credentialEnv: selection.compatible?.credentialEnv,
    credentialIdentity: selection.compatible?.credentialIdentity,
    runtimeApiKey: selection.runtimeKeys?.[provider], env: selection.env,
    store: store ?? { get: async () => null, set: async () => {}, delete: async () => false },
  });
  if ("error" in credential) {
    result.status = "skipped";
    result.reason = credential.error.startsWith("Cannot read credential") ? "credential_store_unavailable" : "missing_credentials";
    return;
  }
  result.authSource = credential.source;
  return { provider: family, apiKey: credential.apiKey, model, maxTokens: MAX_TOKENS,
    ...(family === "openai" ? { openaiAuth: "api-key" as const } : {}),
    ...(family === "openai-compatible" ? { baseUrl: selection.compatible!.baseUrl, auth: selection.compatible!.auth } : {}),
  };
}

/** Stop waiting for non-cancellable setup (such as an OS keychain read) before any model stream begins. */
async function awaitSetup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw new Error("setup aborted"); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("setup aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Accept only HTTP(S) compatible endpoints without URL-embedded secrets or fragments. */
export function isSafeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
