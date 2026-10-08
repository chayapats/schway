import { createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";
import { resolveSubscriptionRoute } from "../auth/subscription-route.ts";
import type { AssistantMessage, ConversationItem } from "../conversation/types.ts";
import { HOSTED_ITEMS_KEY, keptHostedItems } from "../model/hosted-tools.ts";
import { ROUTE_FALLBACK_MODELS } from "../model/catalog.ts";
import { loadProviderModel, type FetchLike, type ProviderLoaderInput } from "../model/loader.ts";
import type { Model, ModelRequest } from "../model/model.ts";
import { boundedSmokeFetch } from "./transport.ts";

/** Routes the opt-in hosted web search check covers: the Grok subscription login and an xAI API key. */
export const WEB_SEARCH_PROBE_ROUTES = ["grok", "xai-api-key"] as const;

/** One checked route. */
export type WebSearchProbeRoute = (typeof WEB_SEARCH_PROBE_ROUTES)[number];

/** Default output cap; it counts reasoning, so it leaves room for a short answer after reasoning and searches. */
export const DEFAULT_WEB_SEARCH_PROBE_MAX_OUTPUT_TOKENS = 4096;

/** Bounded, secret-free check settings parsed from the command line. */
export interface WebSearchProbeSelection {
  enabled: boolean;
  route: WebSearchProbeRoute;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  revision: string;
}

/** The three calls of one check: a search turn, then the follow-up with and without the first turn's hosted items. */
export type WebSearchProbePhase = "search" | "replay-with-hosted" | "replay-without-hosted";

/** Outcome of one model call; `ok` means the provider accepted the request and the stream completed. */
export type WebSearchProbeCallStatus = "ok" | "incomplete" | "http_error" | "network_error" | "timeout" | "output_limit" | "error";

/** One measured call: status, counts and whole-millisecond times, never content, queries, URLs, keys or headers. */
export interface WebSearchProbeCall {
  phase: WebSearchProbePhase;
  status: WebSearchProbeCallStatus;
  /** Last HTTP status the call received, when it received one. */
  httpStatus?: number;
  /** Hosted items Schway kept from this call's response. */
  hostedItems: number;
  /** Hosted items this call's request replayed. */
  replayedItems: number;
  /** G1 usage: kept hosted searches and the provider's own counter; null when not reported. */
  hostedSearchCalls: number | null;
  reportedHostedSearchCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Time to the first text or thinking delta; null when none arrived. */
  firstDeltaMs: number | null;
  totalMs: number;
}

/** Route verdict: `pass` admits the route to the allowlist; `replay_rejected` admits it with replay turned off. */
export type WebSearchProbeVerdict = "pass" | "replay_rejected" | "unsupported" | "no_search" | "inconclusive";

/** Dated JSON evidence tied to revision, route and model; it holds no token, header, endpoint, prompt, query, URL or response text. */
export interface WebSearchProbeReport {
  testedAt: string;
  revision: string;
  route: WebSearchProbeRoute;
  model: string;
  maxOutputTokens: number;
  status: "complete" | "incomplete" | "skipped" | "pending" | "failed";
  reason?: string;
  calls: WebSearchProbeCall[];
  summary: {
    firstAccepted: boolean;
    hostedItems: number;
    replayWithHostedAccepted: boolean | null;
    replayWithoutHostedAccepted: boolean | null;
    verdict: WebSearchProbeVerdict;
  };
}

/** Test seams; production reads only the OS secure store, `XAI_API_KEY` and the network. */
export interface WebSearchProbeDependencies {
  createStore?: () => CredentialStore;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  createModel?: (input: ProviderLoaderInput, fetch: FetchLike) => Promise<Model>;
  now?: () => number;
  signal?: AbortSignal;
}

const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,100}$/;
const MAX_CALL_BYTES = 2 * 1024 * 1024;
const SYSTEM_PROMPT = "You are a concise assistant. Use web search when a question needs current facts. Answer in one short sentence.";
const SEARCH_QUESTION = "Search the web: what is today's date in UTC, and what is one top news headline today?";
const FOLLOW_UP = "Thanks. Reply with the single word DONE.";

/** Parse arguments without reading the environment or the credential store. */
export function parseWebSearchProbeArgs(argv: readonly string[]): { selection: Omit<WebSearchProbeSelection, "revision"> } | { error: string } {
  const selection: Omit<WebSearchProbeSelection, "revision"> = { enabled: false, route: "grok", model: ROUTE_FALLBACK_MODELS.xai,
    maxOutputTokens: DEFAULT_WEB_SEARCH_PROBE_MAX_OUTPUT_TOKENS, timeoutMs: 120_000 };
  let route: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enable-live") { selection.enabled = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) return { error: "Missing value for web search check option." };
    if (flag === "--route" && WEB_SEARCH_PROBE_ROUTES.includes(value as WebSearchProbeRoute)) route = value;
    else if (flag === "--model" && SAFE_ID.test(value)) selection.model = value;
    else if (flag === "--max-output-tokens" && /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65_536) selection.maxOutputTokens = Number(value);
    else if (flag === "--timeout-ms" && /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 300_000) selection.timeoutMs = Number(value);
    else return { error: "Invalid web search check option or value." };
  }
  if (!route) return { error: "Select --route grok or --route xai-api-key." };
  selection.route = route as WebSearchProbeRoute;
  return { selection };
}

/** Run the search turn, then the follow-up with and without its hosted items, through the production loader and adapter. */
export async function runWebSearchProbe(selection: WebSearchProbeSelection, deps: WebSearchProbeDependencies = {}): Promise<WebSearchProbeReport> {
  const report: WebSearchProbeReport = { testedAt: new Date().toISOString(), revision: SAFE_ID.test(selection.revision) ? selection.revision : "unknown",
    route: selection.route, model: SAFE_ID.test(selection.model) ? selection.model : "invalid-model-id", maxOutputTokens: selection.maxOutputTokens,
    status: "skipped", reason: "live_disabled", calls: [],
    summary: { firstAccepted: false, hostedItems: 0, replayWithHostedAccepted: null, replayWithoutHostedAccepted: null, verdict: "inconclusive" } };
  // No credential is read and no request is made without the explicit opt-in.
  if (!selection.enabled) return report;
  delete report.reason;
  report.status = "incomplete";
  if (!SAFE_ID.test(selection.model)) return { ...report, status: "failed", reason: "invalid_settings" };
  const base = await credentialInput(selection, deps);
  if ("reason" in base) return { ...report, status: base.reason === "missing_credentials" ? "skipped" : "pending", reason: base.reason };
  const now = deps.now ?? (() => performance.now());
  const question: ConversationItem = { type: "user", id: "probe-search", content: [{ type: "text", text: SEARCH_QUESTION }] };
  const followUp: ConversationItem = { type: "user", id: "probe-follow-up", content: [{ type: "text", text: FOLLOW_UP }] };
  const request = (items: ConversationItem[]): ModelRequest => ({ systemPrompt: SYSTEM_PROMPT, context: [], items, hostedTools: ["web_search"] });
  const first = await measure(selection, base, request([question]), "search", 0, now, deps);
  report.calls.push(first.call);
  if (deps.signal?.aborted) return finish({ ...report, status: "pending", reason: "cancelled" });
  if (first.call.status !== "ok" || !first.message) return finish(report);
  const answer = first.message;
  for (const phase of ["replay-with-hosted", "replay-without-hosted"] as const) {
    if (deps.signal?.aborted) return finish({ ...report, status: "pending", reason: "cancelled" });
    const replayed = phase === "replay-with-hosted" ? answer : withoutHostedItems(answer);
    report.calls.push((await measure(selection, base, request([question, replayed, followUp]), phase, hostedItemCount(replayed), now, deps)).call);
  }
  return finish(report);
}

/** Read the route's existing credential source: the saved Grok login, or `XAI_API_KEY` from the environment. */
async function credentialInput(selection: WebSearchProbeSelection, deps: WebSearchProbeDependencies): Promise<ProviderLoaderInput | { reason: string }> {
  const common = { model: selection.model, maxTokens: selection.maxOutputTokens, replayHostedItems: true };
  if (selection.route === "grok") {
    const store = (deps.createStore ?? createNativeCredentialStore)();
    const resolved = await resolveSubscriptionRoute({ provider: "grok", model: selection.model, maxTokens: selection.maxOutputTokens, store, env: {} });
    return "reason" in resolved ? { reason: resolved.reason } : { ...resolved.input, ...common };
  }
  const apiKey = (deps.env ?? process.env).XAI_API_KEY?.trim();
  if (!apiKey) return { reason: "missing_credentials" };
  return { provider: "xai", apiKey, ...common };
}

/** One bounded call with its own deadline and response budget; thinking stays unset so no capability discovery runs. */
async function measure(selection: WebSearchProbeSelection, base: ProviderLoaderInput, request: ModelRequest, phase: WebSearchProbePhase, replayedItems: number,
  now: () => number, deps: WebSearchProbeDependencies): Promise<{ call: WebSearchProbeCall; message?: AssistantMessage }> {
  const call: WebSearchProbeCall = { phase, status: "error", hostedItems: 0, replayedItems, hostedSearchCalls: null, reportedHostedSearchCalls: null,
    inputTokens: null, outputTokens: null, firstDeltaMs: null, totalMs: 0 };
  let message: AssistantMessage | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), selection.timeoutMs);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  let outputLimit = false;
  const fetch = boundedSmokeFetch({ signal, fetch: deps.fetch, maxBytes: MAX_CALL_BYTES, onLimit: () => { outputLimit = true; controller.abort(); },
    onProgress: event => { if (event.type === "response") call.httpStatus = event.status; } });
  const started = now();
  try {
    const model = await (deps.createModel ?? loadProviderModel)({ ...base }, fetch);
    let usage = false;
    try {
      for await (const event of model.stream({ ...request, signal })) {
        if ((event.type === "text_delta" || event.type === "thinking_delta") && call.firstDeltaMs === null) call.firstDeltaMs = Math.max(0, Math.round(now() - started));
        if (event.type === "usage") {
          usage = true;
          call.inputTokens = event.usage.inputTokens;
          call.outputTokens = event.usage.outputTokens;
          call.hostedSearchCalls = event.usage.hostedSearchCalls ?? null;
          call.reportedHostedSearchCalls = event.usage.reportedHostedSearchCalls ?? null;
        }
        if (event.type === "message_complete") {
          call.status = "ok";
          message = event.message;
          call.hostedItems = hostedItemCount(event.message);
        }
      }
    } catch (error) {
      call.status = outputLimit ? "output_limit" : controller.signal.aborted ? "timeout" : usage && /response incomplete$/.test(error instanceof Error ? error.message : "") ? "incomplete"
        : typeof (error as { status?: unknown })?.status === "number" ? "http_error" : call.httpStatus === undefined ? "network_error" : "error";
    }
  } catch {
    // Setup failures (such as building the adapter) carry no provider evidence.
    call.status = controller.signal.aborted ? "timeout" : call.httpStatus !== undefined && call.httpStatus >= 400 ? "http_error" : "error";
  } finally {
    call.totalMs = Math.max(0, Math.round(now() - started));
    clearTimeout(timer);
  }
  return { call, ...(message ? { message } : {}) };
}

/** Hosted items kept in the xAI namespace of one message. */
function hostedItemCount(message: AssistantMessage): number {
  return keptHostedItems(message.providerMetadata?.xai).length;
}

/** The same message with its kept hosted items removed, as the per-route omit switch would send it. */
function withoutHostedItems(message: AssistantMessage): AssistantMessage {
  const xai = message.providerMetadata?.xai;
  if (!xai || typeof xai !== "object" || Array.isArray(xai)) return message;
  const { [HOSTED_ITEMS_KEY]: _omitted, ...rest } = xai as Record<string, unknown>;
  return { ...message, providerMetadata: { ...message.providerMetadata, xai: rest } };
}

/** Summarize acceptance and settle the run status and verdict. */
function finish(report: WebSearchProbeReport): WebSearchProbeReport {
  const byPhase = (phase: WebSearchProbePhase) => report.calls.find(call => call.phase === phase);
  const accepted = (phase: WebSearchProbePhase) => { const call = byPhase(phase); return call ? call.status === "ok" : null; };
  const rejected = (phase: WebSearchProbePhase) => { const status = byPhase(phase)?.httpStatus; return status !== undefined && status >= 400 && status < 500; };
  const first = byPhase("search");
  const hostedItems = first?.hostedItems ?? 0;
  const withHosted = accepted("replay-with-hosted"), withoutHosted = accepted("replay-without-hosted");
  const verdict: WebSearchProbeVerdict = first?.status === "ok"
    ? hostedItems === 0 ? "no_search" : withHosted ? "pass" : withoutHosted && rejected("replay-with-hosted") ? "replay_rejected" : "inconclusive"
    : rejected("search") ? "unsupported" : "inconclusive";
  report.summary = { firstAccepted: first?.status === "ok", hostedItems, replayWithHostedAccepted: withHosted, replayWithoutHostedAccepted: withoutHosted, verdict };
  if (report.status === "skipped" || report.status === "pending") return report;
  const failed = report.calls.some(call => call.status === "http_error" && (call.httpStatus ?? 0) >= 500 || call.status === "network_error" || call.status === "error");
  report.status = report.calls.length === 3 && report.calls.every(call => call.status === "ok") ? "complete" : failed ? "failed" : "incomplete";
  return report;
}

/** Run the explicit opt-in command: 0 when every call completed, 2 when skipped or incomplete, 1 on failure or a usage error. */
export async function runWebSearchProbeCli(argv: readonly string[], io: { revision: string; signal?: AbortSignal; out: (text: string) => void; err: (text: string) => void },
  deps: WebSearchProbeDependencies = {}): Promise<number> {
  const parsed = parseWebSearchProbeArgs(argv);
  if ("error" in parsed) { io.err(`${parsed.error}\nSee docs/live-providers.md.\n`); return 1; }
  const report = await runWebSearchProbe({ ...parsed.selection, revision: io.revision }, { ...deps, signal: io.signal ?? deps.signal });
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
    process.exitCode = await runWebSearchProbeCli(process.argv.slice(2), { revision: await revision(), signal: controller.signal,
      out: text => void process.stdout.write(text), err: text => void process.stderr.write(text) });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
