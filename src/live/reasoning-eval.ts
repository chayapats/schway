import { resolveProviderCredential } from "../auth/credentials.ts";
import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { resolveSubscriptionRoute } from "../auth/subscription-route.ts";
import { ROUTE_FALLBACK_MODELS } from "../model/catalog.ts";
import { loadProviderModel, type FetchLike, type ProviderLoaderInput } from "../model/loader.ts";
import { isThinkingLevel, type Model, type ModelRequest, type ThinkingLevel } from "../model/model.ts";
import { prepareModelThinking } from "../model/thinking-preflight.ts";
import { boundedSmokeFetch, MAX_SMOKE_DISCOVERY_BYTES } from "./transport.ts";

/** Routes the opt-in reasoning-effort evaluation measures; each uses only its stored credential. */
export const EVAL_ROUTES = ["grok", "xai-api-key"] as const;

/** One evaluated route: the Grok subscription login or the stored xAI API key. */
export type EvalRoute = (typeof EVAL_ROUTES)[number];

/** One evaluation arm: thinking left unset (nothing sent) or an explicit level. */
export type EvalArm = "unset" | ThinkingLevel;

/** Fixed short probe, the same for every arm and run so only the effort differs. */
export const REASONING_EVAL_PROBE = "In two sentences: around 5 pm on a weekday, is it usually faster to drive or take the airport rail link from Siam to Suvarnabhumi airport, and why?";

/** Default output cap; `max_output_tokens` counts reasoning, so it must leave room for reasoning to finish. */
export const DEFAULT_EVAL_MAX_OUTPUT_TOKENS = 16_384;

/** Bounded, secret-free evaluation settings parsed from the command line. */
export interface ReasoningEvalSelection {
  enabled: boolean;
  route: EvalRoute;
  model: string;
  /** Explicit levels compared with leaving thinking unset. */
  levels: ThinkingLevel[];
  runs: number;
  maxOutputTokens: number;
  timeoutMs: number;
  revision: string;
}

/** Outcome of one model call; only `ok` calls count as evidence. */
export type EvalCallStatus = "ok" | "incomplete" | "http_error" | "network_error" | "timeout" | "output_limit" | "error"
  | "unsupported_thinking" | "thinking_capability_unavailable";

/** One measured call: status, provider-reported token counts and times in whole milliseconds, never content or headers. */
export interface ReasoningEvalCall {
  arm: EvalArm;
  run: number;
  status: EvalCallStatus;
  /** Last HTTP status the call received, when it received one. */
  httpStatus?: number;
  reasoningTokens: number | null;
  outputTokens: number | null;
  /** Time to the first text or thinking delta; null when none arrived. */
  firstDeltaMs: number | null;
  totalMs: number;
}

/** Medians over an arm's `ok` calls; null when it has none. */
export interface ReasoningEvalMedians { reasoningTokens: number | null; outputTokens: number | null; firstDeltaMs: number | null; totalMs: number }

/** One arm's calls and medians. */
export interface ReasoningEvalArm { arm: EvalArm; calls: ReasoningEvalCall[]; evidenceCalls: number; medians: ReasoningEvalMedians | null }

/** Whether one level meets #321's bar for a default on this route: accepted without a 4xx, and fewer median reasoning tokens and less median model time than unset. */
export interface ReasoningEvalVerdict { level: ThinkingLevel; accepted: boolean; fewerReasoningTokens: boolean; lessModelTime: boolean; meetsDefaultBar: boolean }

/** Dated JSON evidence tied to revision, route and model; it holds no token, header, endpoint or response text. */
export interface ReasoningEvalReport {
  testedAt: string;
  revision: string;
  route: EvalRoute;
  model: string;
  maxOutputTokens: number;
  runs: number;
  status: "complete" | "incomplete" | "skipped" | "pending" | "failed";
  reason?: string;
  arms: ReasoningEvalArm[];
  verdicts: ReasoningEvalVerdict[];
}

/** Test seams; production reads only the OS secure store and the network. */
export interface ReasoningEvalDependencies {
  createStore?: () => CredentialStore;
  fetch?: FetchLike;
  createModel?: (input: ProviderLoaderInput, fetch: FetchLike) => Promise<Model>;
  now?: () => number;
  signal?: AbortSignal;
}

const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const MAX_CALL_BYTES = 2 * 1024 * 1024;

/** Parse arguments without reading the environment or the credential store. */
export function parseReasoningEvalArgs(argv: readonly string[]): { selection: Omit<ReasoningEvalSelection, "revision"> } | { error: string } {
  const selection: Omit<ReasoningEvalSelection, "revision"> = { enabled: false, route: "grok", model: ROUTE_FALLBACK_MODELS.xai, levels: ["low", "medium"], runs: 3,
    maxOutputTokens: DEFAULT_EVAL_MAX_OUTPUT_TOKENS, timeoutMs: 120_000 };
  let route: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enable-live") { selection.enabled = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) return { error: "Missing value for reasoning evaluation option." };
    if (flag === "--route" && EVAL_ROUTES.includes(value as EvalRoute)) route = value;
    else if (flag === "--model" && SAFE_ID.test(value)) selection.model = value;
    else if (flag === "--levels") {
      const levels = value.split(",");
      if (!levels.every(level => isThinkingLevel(level)) || new Set(levels).size !== levels.length) return { error: "Use --levels with distinct thinking levels, such as low,medium." };
      selection.levels = levels as ThinkingLevel[];
    } else if (flag === "--runs" && /^\d+$/.test(value) && Number(value) >= 3 && Number(value) <= 10) selection.runs = Number(value);
    else if (flag === "--max-output-tokens" && /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65_536) selection.maxOutputTokens = Number(value);
    else if (flag === "--timeout-ms" && /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 300_000) selection.timeoutMs = Number(value);
    else return { error: "Invalid reasoning evaluation option or value." };
  }
  if (!route) return { error: "Select --route grok or --route xai-api-key." };
  selection.route = route as EvalRoute;
  return { selection };
}

/** Run every arm `runs` times in interleaved order through the production loader and adapter, returning bounded evidence. */
export async function runReasoningEval(selection: ReasoningEvalSelection, deps: ReasoningEvalDependencies = {}): Promise<ReasoningEvalReport> {
  const arms: EvalArm[] = ["unset", ...selection.levels];
  const report: ReasoningEvalReport = { testedAt: new Date().toISOString(), revision: SAFE_ID.test(selection.revision) ? selection.revision : "unknown", route: selection.route,
    model: SAFE_ID.test(selection.model) ? selection.model : "invalid-model-id", maxOutputTokens: selection.maxOutputTokens, runs: selection.runs,
    status: "skipped", reason: "live_disabled", arms: arms.map(arm => ({ arm, calls: [], evidenceCalls: 0, medians: null })), verdicts: [] };
  // No credential store is opened and no request is made without the explicit opt-in.
  if (!selection.enabled) return report;
  delete report.reason;
  report.status = "incomplete";
  if (!SAFE_ID.test(selection.model)) return { ...report, status: "failed", reason: "invalid_settings" };
  const store = (deps.createStore ?? createNativeCredentialStore)();
  const base = await storedInput(selection, store);
  if ("reason" in base) return { ...report, status: base.reason === "missing_credentials" ? "skipped" : "pending", reason: base.reason };
  const now = deps.now ?? (() => performance.now());
  const capabilities = new Map<EvalArm, ProviderLoaderInput["modelCapability"] | EvalCallStatus>();
  for (let run = 1; run <= selection.runs; run++) {
    for (const entry of report.arms) {
      if (deps.signal?.aborted) return finish({ ...report, status: "pending", reason: "cancelled" });
      entry.calls.push(await measure(selection, base, entry.arm, run, capabilities, now, deps));
    }
  }
  return finish(report);
}

/** Resolve only stored credentials for the selected route; environment keys are ignored. */
async function storedInput(selection: ReasoningEvalSelection, store: CredentialStore): Promise<ProviderLoaderInput | { reason: string }> {
  if (selection.route === "grok") {
    const resolved = await resolveSubscriptionRoute({ provider: "grok", model: selection.model, maxTokens: selection.maxOutputTokens, store, env: {} });
    return "reason" in resolved ? { reason: resolved.reason } : resolved.input;
  }
  const credential = await resolveProviderCredential({ provider: "xai", env: {}, store });
  if ("error" in credential) return { reason: credential.error.startsWith("Cannot read credential") ? "credential_store_unavailable" : "missing_credentials" };
  return { provider: "xai", apiKey: credential.apiKey, model: selection.model, maxTokens: selection.maxOutputTokens };
}

/** One bounded call; an explicit level first needs the route's listed capability, exactly as production requires. */
async function measure(selection: ReasoningEvalSelection, base: ProviderLoaderInput, arm: EvalArm, run: number,
  capabilities: Map<EvalArm, ProviderLoaderInput["modelCapability"] | EvalCallStatus>, now: () => number, deps: ReasoningEvalDependencies): Promise<ReasoningEvalCall> {
  const call: ReasoningEvalCall = { arm, run, status: "error", reasoningTokens: null, outputTokens: null, firstDeltaMs: null, totalMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), selection.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  let outputLimit = false;
  const transport = { signal, fetch: deps.fetch, onLimit: () => { outputLimit = true; controller.abort(); },
    onProgress: (event: { type: "request" } | { type: "response"; status: number }) => { if (event.type === "response") call.httpStatus = event.status; } };
  const input: ProviderLoaderInput = { ...base, ...(arm === "unset" ? {} : { thinking: arm }) };
  try {
    if (arm !== "unset") {
      if (!capabilities.has(arm)) {
        const probe = { ...input };
        const refused = await prepareModelThinking(probe, boundedSmokeFetch({ ...transport, maxBytes: MAX_SMOKE_DISCOVERY_BYTES }), signal);
        capabilities.set(arm, refused ?? probe.modelCapability);
        delete call.httpStatus;
      }
      const capability = capabilities.get(arm);
      if (typeof capability === "string") { call.status = capability; return call; }
      input.modelCapability = capability;
    }
    const fetch = boundedSmokeFetch({ ...transport, maxBytes: MAX_CALL_BYTES });
    const model = await (deps.createModel ?? loadProviderModel)(input, fetch);
    const request: ModelRequest = { systemPrompt: "You are a concise assistant. Answer directly.", context: [],
      items: [{ type: "user", id: `probe-${run}`, content: [{ type: "text", text: REASONING_EVAL_PROBE }] }], signal };
    const started = now();
    let usage = false;
    try {
      for await (const event of model.stream(request)) {
        if ((event.type === "text_delta" || event.type === "thinking_delta") && call.firstDeltaMs === null) call.firstDeltaMs = Math.max(0, Math.round(now() - started));
        if (event.type === "usage") { usage = true; call.reasoningTokens = event.usage.reasoningTokens ?? null; call.outputTokens = event.usage.outputTokens; }
        if (event.type === "message_complete") call.status = "ok";
      }
    } catch (error) {
      // A response that stopped at the output cap still reports usage, but it is not evidence.
      call.status = outputLimit ? "output_limit" : controller.signal.aborted ? "timeout" : usage && /response incomplete$/.test(error instanceof Error ? error.message : "") ? "incomplete"
        : typeof (error as { status?: unknown })?.status === "number" ? "http_error" : call.httpStatus === undefined ? "network_error" : "error";
    } finally { call.totalMs = Math.max(0, Math.round(now() - started)); }
  } catch {
    call.status = controller.signal.aborted ? "timeout" : call.httpStatus !== undefined && call.httpStatus >= 400 ? "http_error" : "network_error";
  } finally { clearTimeout(timer); }
  return call;
}

/** Fill medians and verdicts; a level meets the bar only with at least three `ok` calls in both arms and no 4xx. */
function finish(report: ReasoningEvalReport): ReasoningEvalReport {
  for (const arm of report.arms) {
    const ok = arm.calls.filter(call => call.status === "ok");
    arm.evidenceCalls = ok.length;
    arm.medians = ok.length ? { reasoningTokens: median(ok.map(call => call.reasoningTokens)), outputTokens: median(ok.map(call => call.outputTokens)),
      firstDeltaMs: median(ok.map(call => call.firstDeltaMs)), totalMs: median(ok.map(call => call.totalMs))! } : null;
  }
  const unset = report.arms.find(arm => arm.arm === "unset")!;
  report.verdicts = report.arms.filter(arm => arm.arm !== "unset").map(arm => {
    const accepted = arm.calls.length > 0 && arm.calls.every(call => call.status !== "unsupported_thinking" && call.status !== "thinking_capability_unavailable"
      && !(call.httpStatus !== undefined && call.httpStatus >= 400 && call.httpStatus < 500));
    const enough = arm.evidenceCalls >= 3 && unset.evidenceCalls >= 3;
    const fewerReasoningTokens = enough && arm.medians?.reasoningTokens != null && unset.medians?.reasoningTokens != null && arm.medians.reasoningTokens < unset.medians.reasoningTokens;
    const lessModelTime = enough && !!arm.medians && !!unset.medians && arm.medians.totalMs < unset.medians.totalMs;
    return { level: arm.arm as ThinkingLevel, accepted, fewerReasoningTokens, lessModelTime, meetsDefaultBar: accepted && fewerReasoningTokens && lessModelTime };
  });
  if (report.status === "skipped" || report.status === "pending") return report;
  const failed = report.arms.some(arm => arm.calls.some(call => call.status === "http_error" && (call.httpStatus ?? 0) >= 500 || call.status === "network_error" || call.status === "error"));
  report.status = report.arms.every(arm => arm.evidenceCalls === report.runs) ? "complete" : failed ? "failed" : "incomplete";
  return report;
}

/** Median of reported values; null when none were reported. */
function median(values: readonly (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Run the explicit opt-in command: 0 when every call produced evidence, 2 when skipped or incomplete, 1 on failure or a usage error. */
export async function runReasoningEvalCli(argv: readonly string[], io: { revision: string; signal?: AbortSignal; out: (text: string) => void; err: (text: string) => void },
  deps: ReasoningEvalDependencies = {}): Promise<number> {
  const parsed = parseReasoningEvalArgs(argv);
  if ("error" in parsed) { io.err(`${parsed.error}\nSee docs/live-providers.md.\n`); return 1; }
  const report = await runReasoningEval({ ...parsed.selection, revision: io.revision }, { ...deps, signal: io.signal ?? deps.signal });
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
    process.exitCode = await runReasoningEvalCli(process.argv.slice(2), { revision: await revision(), signal: controller.signal,
      out: text => void process.stdout.write(text), err: text => void process.stderr.write(text) });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
