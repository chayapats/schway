import { resolveProviderCredential } from "../auth/credentials.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { resolveSubscriptionRoute } from "../auth/subscription-route.ts";
import type { ConversationItem } from "../conversation/types.ts";
import { ROUTE_FALLBACK_MODELS } from "../model/catalog.ts";
import { loadProviderModel, type FetchLike, type ProviderLoaderInput } from "../model/loader.ts";
import type { Model, ModelCallOptions, ModelRequest } from "../model/model.ts";
import { promptCacheKey } from "../model/prompt-cache-key.ts";
import { createSession } from "../session/session.ts";
import { boundedSmokeFetch } from "./transport.ts";

/** Routes the opt-in prompt-cache probe measures: the routes that send a conversation key. */
export const PROBE_ROUTES = ["grok", "xai-api-key"] as const;

/** One probed route: the Grok subscription login or the stored xAI API key. */
export type ProbeRoute = (typeof PROBE_ROUTES)[number];

/** One probe arm: requests carry a conversation key, or the probe withholds it. */
export type ProbeArm = "key" | "no-key";

/** Default output cap; it counts reasoning, so it leaves room for a short answer after reasoning. */
export const DEFAULT_PROBE_MAX_OUTPUT_TOKENS = 4096;

/** Lines in the fixed shared prefix; about 20k tokens in all. */
export const PROBE_PREFIX_RECORDS = 1000;

/** Bounded, secret-free probe settings parsed from the command line. */
export interface PromptCacheProbeSelection {
  enabled: boolean;
  route: ProbeRoute;
  model: string;
  runs: number;
  maxOutputTokens: number;
  timeoutMs: number;
  revision: string;
}

/** Outcome of one model call; only `ok` calls count toward a complete run. */
export type ProbeCallStatus = "ok" | "incomplete" | "http_error" | "network_error" | "timeout" | "output_limit" | "error";

/** One measured call: status, provider-reported token counts and whole-millisecond times, never content, keys or headers. */
export interface PromptCacheProbeCall {
  arm: ProbeArm;
  run: number;
  turn: 1 | 2;
  status: ProbeCallStatus;
  /** Last HTTP status the call received, when it received one. */
  httpStatus?: number;
  inputTokens: number | null;
  /** Provider-reported cached part of `inputTokens` (G1's `cachedInputTokens`); null when not reported. */
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** Time to the first text or thinking delta; null when none arrived. */
  firstDeltaMs: number | null;
  totalMs: number;
}

/** Per-arm turn-2 cache outcome; a hit is turn 2 reporting `cachedInputTokens > 0`. */
export interface PromptCacheProbeSummary {
  keyTurn2Hits: number;
  noKeyTurn2Hits: number;
  /** True when at least one keyed turn 2 reported cached input tokens. */
  cacheHit: boolean;
}

/** Dated JSON evidence tied to revision, route and model; it holds no token, key, header, endpoint, prompt or response text. */
export interface PromptCacheProbeReport {
  testedAt: string;
  revision: string;
  route: ProbeRoute;
  model: string;
  maxOutputTokens: number;
  runs: number;
  status: "complete" | "incomplete" | "skipped" | "pending" | "failed";
  reason?: string;
  calls: PromptCacheProbeCall[];
  summary: PromptCacheProbeSummary;
}

/** Test seams; production reads only the OS secure store and the network. */
export interface PromptCacheProbeDependencies {
  createStore?: () => CredentialStore;
  fetch?: FetchLike;
  createModel?: (input: ProviderLoaderInput, fetch: FetchLike) => Promise<Model>;
  now?: () => number;
  signal?: AbortSignal;
}

const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const MAX_CALL_BYTES = 2 * 1024 * 1024;

/** Parse arguments without reading the environment or the credential store. */
export function parsePromptCacheProbeArgs(argv: readonly string[]): { selection: Omit<PromptCacheProbeSelection, "revision"> } | { error: string } {
  const selection: Omit<PromptCacheProbeSelection, "revision"> = { enabled: false, route: "grok", model: ROUTE_FALLBACK_MODELS.xai, runs: 1,
    maxOutputTokens: DEFAULT_PROBE_MAX_OUTPUT_TOKENS, timeoutMs: 120_000 };
  let route: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enable-live") { selection.enabled = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) return { error: "Missing value for prompt-cache probe option." };
    if (flag === "--route" && PROBE_ROUTES.includes(value as ProbeRoute)) route = value;
    else if (flag === "--model" && SAFE_ID.test(value)) selection.model = value;
    else if (flag === "--runs" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 5) selection.runs = Number(value);
    else if (flag === "--max-output-tokens" && /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65_536) selection.maxOutputTokens = Number(value);
    else if (flag === "--timeout-ms" && /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 300_000) selection.timeoutMs = Number(value);
    else return { error: "Invalid prompt-cache probe option or value." };
  }
  if (!route) return { error: "Select --route grok or --route xai-api-key." };
  selection.route = route as ProbeRoute;
  return { selection };
}

/** Fixed reference text of about 20k tokens; identical in every run, so only the nonce before it differs. */
export function probePrefix(): string {
  const lines: string[] = [];
  for (let i = 1; i <= PROBE_PREFIX_RECORDS; i++) {
    const code = ((i * 2_654_435_761) >>> 0).toString(16).padStart(8, "0");
    lines.push(`Record ${String(i).padStart(4, "0")}: code ${code} maps to shelf ${(i * 37) % 101}, bin ${(i * 53) % 17} and weight ${(i * 7919) % 1000} grams.`);
  }
  return lines.join("\n");
}

/** The two requests of one arm-run; a fresh nonce leads the system prompt so arms and runs never share a cacheable prefix. */
export function probeTurns(nonce: string, prefix = probePrefix()): [ModelRequest, ModelRequest] {
  const systemPrompt = `Probe ${nonce}. You are a concise assistant. Answer with exactly the word requested.`;
  const first: ConversationItem = { type: "user", id: "probe-turn-1", content: [{ type: "text", text: `${prefix}\n\nReply with the single word READY.` }] };
  const reply: ConversationItem = { type: "assistant", id: "probe-reply-1", content: [{ type: "text", text: "READY" }] };
  const second: ConversationItem = { type: "user", id: "probe-turn-2", content: [{ type: "text", text: "Reply with the single word DONE." }] };
  return [{ systemPrompt, context: [], items: [first] }, { systemPrompt, context: [], items: [first, reply, second] }];
}

/** Run both arms `runs` times, alternating which goes first, through the production loader and adapter. */
export async function runPromptCacheProbe(selection: PromptCacheProbeSelection, deps: PromptCacheProbeDependencies = {}): Promise<PromptCacheProbeReport> {
  const report: PromptCacheProbeReport = { testedAt: new Date().toISOString(), revision: SAFE_ID.test(selection.revision) ? selection.revision : "unknown",
    route: selection.route, model: SAFE_ID.test(selection.model) ? selection.model : "invalid-model-id", maxOutputTokens: selection.maxOutputTokens,
    runs: selection.runs, status: "skipped", reason: "live_disabled", calls: [], summary: { keyTurn2Hits: 0, noKeyTurn2Hits: 0, cacheHit: false } };
  // No credential store is opened and no request is made without the explicit opt-in.
  if (!selection.enabled) return report;
  delete report.reason;
  report.status = "incomplete";
  if (!SAFE_ID.test(selection.model)) return { ...report, status: "failed", reason: "invalid_settings" };
  const store = (deps.createStore ?? createNativeCredentialStore)();
  const base = await storedInput(selection, store);
  if ("reason" in base) return { ...report, status: base.reason === "missing_credentials" ? "skipped" : "pending", reason: base.reason };
  const now = deps.now ?? (() => performance.now());
  const prefix = probePrefix();
  for (let run = 1; run <= selection.runs; run++) {
    const arms: ProbeArm[] = run % 2 === 1 ? ["key", "no-key"] : ["no-key", "key"];
    for (const arm of arms) {
      // A probe-only session identity: the same key as a real conversation would derive, never persisted.
      const call: ModelCallOptions | undefined = arm === "key" ? { promptCacheKey: promptCacheKey(createSession()) } : undefined;
      const turns = probeTurns(crypto.randomUUID(), prefix);
      for (const [index, request] of turns.entries()) {
        if (deps.signal?.aborted) return finish({ ...report, status: "pending", reason: "cancelled" });
        report.calls.push(await measure(selection, base, request, call, { arm, run, turn: index === 0 ? 1 : 2 }, now, deps));
      }
    }
  }
  return finish(report);
}

/** Resolve only stored credentials for the selected route; environment keys are ignored. */
async function storedInput(selection: PromptCacheProbeSelection, store: CredentialStore): Promise<ProviderLoaderInput | { reason: string }> {
  if (selection.route === "grok") {
    const resolved = await resolveSubscriptionRoute({ provider: "grok", model: selection.model, maxTokens: selection.maxOutputTokens, store, env: {} });
    return "reason" in resolved ? { reason: resolved.reason } : resolved.input;
  }
  const credential = await resolveProviderCredential({ provider: "xai", env: {}, store });
  if ("error" in credential) return { reason: credential.error.startsWith("Cannot read credential") ? "credential_store_unavailable" : "missing_credentials" };
  return { provider: "xai", apiKey: credential.apiKey, model: selection.model, maxTokens: selection.maxOutputTokens };
}

/** One bounded call with its own deadline and response budget; thinking stays unset so no capability discovery runs. */
async function measure(selection: PromptCacheProbeSelection, base: ProviderLoaderInput, request: ModelRequest, call: ModelCallOptions | undefined,
  position: { arm: ProbeArm; run: number; turn: 1 | 2 }, now: () => number, deps: PromptCacheProbeDependencies): Promise<PromptCacheProbeCall> {
  const result: PromptCacheProbeCall = { ...position, status: "error", inputTokens: null, cachedInputTokens: null, outputTokens: null, firstDeltaMs: null, totalMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), selection.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  let outputLimit = false;
  const fetch = boundedSmokeFetch({ signal, fetch: deps.fetch, maxBytes: MAX_CALL_BYTES, onLimit: () => { outputLimit = true; controller.abort(); },
    onProgress: event => { if (event.type === "response") result.httpStatus = event.status; } });
  const started = now();
  try {
    const model = await (deps.createModel ?? loadProviderModel)({ ...base }, fetch);
    let usage = false;
    try {
      for await (const event of model.stream({ ...request, signal }, call)) {
        if ((event.type === "text_delta" || event.type === "thinking_delta") && result.firstDeltaMs === null) result.firstDeltaMs = Math.max(0, Math.round(now() - started));
        if (event.type === "usage") {
          usage = true;
          result.inputTokens = event.usage.inputTokens;
          result.cachedInputTokens = event.usage.cachedInputTokens ?? null;
          result.outputTokens = event.usage.outputTokens;
        }
        if (event.type === "message_complete") result.status = "ok";
      }
    } catch (error) {
      result.status = outputLimit ? "output_limit" : controller.signal.aborted ? "timeout" : usage && /response incomplete$/.test(error instanceof Error ? error.message : "") ? "incomplete"
        : typeof (error as { status?: unknown })?.status === "number" ? "http_error" : result.httpStatus === undefined ? "network_error" : "error";
    }
  } catch {
    // Setup failures (such as building the adapter) carry no provider evidence.
    result.status = controller.signal.aborted ? "timeout" : result.httpStatus !== undefined && result.httpStatus >= 400 ? "http_error" : "error";
  } finally {
    result.totalMs = Math.max(0, Math.round(now() - started));
    clearTimeout(timer);
  }
  return result;
}

/** Count turn-2 hits per arm and settle the run status. */
function finish(report: PromptCacheProbeReport): PromptCacheProbeReport {
  const hits = (arm: ProbeArm) => report.calls.filter(call => call.arm === arm && call.turn === 2 && (call.cachedInputTokens ?? 0) > 0).length;
  report.summary = { keyTurn2Hits: hits("key"), noKeyTurn2Hits: hits("no-key"), cacheHit: hits("key") > 0 };
  if (report.status === "skipped" || report.status === "pending") return report;
  const failed = report.calls.some(call => call.status === "http_error" && (call.httpStatus ?? 0) >= 500 || call.status === "network_error" || call.status === "error");
  report.status = report.calls.length === report.runs * 4 && report.calls.every(call => call.status === "ok") ? "complete" : failed ? "failed" : "incomplete";
  return report;
}

/** Run the explicit opt-in command: 0 when every call completed, 2 when skipped or incomplete, 1 on failure or a usage error. */
export async function runPromptCacheProbeCli(argv: readonly string[], io: { revision: string; signal?: AbortSignal; out: (text: string) => void; err: (text: string) => void },
  deps: PromptCacheProbeDependencies = {}): Promise<number> {
  const parsed = parsePromptCacheProbeArgs(argv);
  if ("error" in parsed) { io.err(`${parsed.error}\nSee docs/live-providers.md.\n`); return 1; }
  const report = await runPromptCacheProbe({ ...parsed.selection, revision: io.revision }, { ...deps, signal: io.signal ?? deps.signal });
  io.out(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "complete" ? 0 : report.status === "failed" ? 1 : 2;
}

/** Read only the tested checkout revision. */
async function revision(): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: process.cwd(), stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    return await proc.exited === 0 && /^[a-f0-9]{40}$/.test(text) ? text : "unknown";
  } catch { return "unknown"; }
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    process.exitCode = await runPromptCacheProbeCli(process.argv.slice(2), { revision: await revision(), signal: controller.signal,
      out: text => void process.stdout.write(text), err: text => void process.stderr.write(text) });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
