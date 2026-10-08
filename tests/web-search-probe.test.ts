import { expect, test } from "bun:test";
import { grokSubscriptionIdentity } from "../src/auth/store.ts";
import { parseWebSearchProbeArgs, runWebSearchProbeCli, type WebSearchProbeReport } from "../src/live/web-search-probe.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { webSearchEvents } from "./fixtures/xai-web-search.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const TOKEN = "fixture-grok-secret-token";
const API_KEY = "xai-fixture-secret-key";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const USAGE = { input_tokens: 40, output_tokens: 12, server_side_tool_usage_details: { web_search_calls: 1 } };

interface Seen { tools: Array<{ type: string }>; input: Array<{ type?: string }>; maxOutput?: number; authorization: string | null }

/** Protocol fixture: the first call searches; later calls answer, or reject a replayed hosted item when `rejectReplay` is set. */
function server(options: { rejectReplay?: boolean; rejectSearch?: boolean } = {}) {
  const seen: Seen[] = [];
  let clock = 0;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools: Seen["tools"]; input: Seen["input"]; max_output_tokens?: number };
    seen.push({ tools: body.tools, input: body.input, maxOutput: body.max_output_tokens, authorization: new Headers(init?.headers).get("authorization") });
    clock += 700;
    if (options.rejectSearch) return Response.json({ error: { message: "web_search is not available" } }, { status: 400 });
    if (options.rejectReplay && body.input.some(item => item.type === "web_search_call")) return Response.json({ error: { message: "unknown input item" } }, { status: 400 });
    return new Response(encodeXaiSse(seen.length === 1 ? webSearchEvents({ usage: USAGE }) : XAI_TEXT_EVENTS), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, seen, now: () => clock };
}

async function run(argv: string[], fixture: ReturnType<typeof server>, deps: { store?: ReturnType<typeof fakeCredentialStore>; env?: Record<string, string | undefined> } = {}) {
  let out = "", err = "";
  const code = await runWebSearchProbeCli(argv, { revision: REVISION, out: text => { out += text; }, err: text => { err += text; } },
    { createStore: () => deps.store ?? fakeCredentialStore(), env: deps.env ?? {}, fetch: fixture.fetch, now: fixture.now });
  return { code, out, err, report: out ? JSON.parse(out) as WebSearchProbeReport : undefined };
}

async function grokStore() {
  const store = fakeCredentialStore();
  await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: TOKEN, obtainedAt: Date.now() }));
  return store;
}

/** The report must never carry credentials, prompts, queries, source URLs or answers. */
function expectPrivate(out: string) {
  for (const forbidden of [TOKEN, API_KEY, "Bearer", "bangkok weather today", "weather.example.test", "Search the web", "Rain after", "DONE", "api.x.ai"]) expect(out).not.toContain(forbidden);
}

test("argument parsing requires a route and bounds the output cap and deadline", () => {
  expect(parseWebSearchProbeArgs([])).toEqual({ error: "Select --route grok or --route xai-api-key." });
  expect(parseWebSearchProbeArgs(["--route", "grok"])).toMatchObject({ selection: { enabled: false, route: "grok", model: "grok-4.7", maxOutputTokens: 4096 } });
  expect(parseWebSearchProbeArgs(["--route", "codex"])).toHaveProperty("error");
  expect(parseWebSearchProbeArgs(["--route", "grok", "--max-output-tokens", "100000"])).toHaveProperty("error");
  expect(parseWebSearchProbeArgs(["--route", "grok", "--api-key", API_KEY])).toHaveProperty("error");
  expect(parseWebSearchProbeArgs(["--enable-live", "--route", "xai-api-key", "--model", "grok-4.7"])).toMatchObject({ selection: { enabled: true, route: "xai-api-key", model: "grok-4.7" } });
});

test("without --enable-live nothing is read or sent and the report says it was skipped", async () => {
  const fixture = server();
  let opened = false;
  let out = "";
  const env = new Proxy({}, { get: () => { throw new Error("environment read"); } }) as Record<string, string | undefined>;
  const code = await runWebSearchProbeCli(["--route", "grok"], { revision: "unknown", out: text => { out += text; }, err: () => {} },
    { createStore: () => { opened = true; return fakeCredentialStore(); }, env, fetch: fixture.fetch });
  expect(code).toBe(2);
  expect(opened).toBe(false);
  expect(fixture.seen).toEqual([]);
  expect(JSON.parse(out)).toMatchObject({ status: "skipped", reason: "live_disabled", route: "grok", calls: [] });
});

test("a Grok subscription pass reports acceptance, hosted items, replay both ways, timing and usage without private text", async () => {
  const fixture = server();
  const { code, out, report } = await run(["--enable-live", "--route", "grok", "--max-output-tokens", "2048"], fixture, { store: await grokStore() });
  expect(code).toBe(0);
  expect(report).toMatchObject({ revision: REVISION, route: "grok", model: "grok-4.7", maxOutputTokens: 2048, status: "complete",
    summary: { firstAccepted: true, hostedItems: 1, replayWithHostedAccepted: true, replayWithoutHostedAccepted: true, verdict: "pass" } });
  expect(report!.calls.map(call => [call.phase, call.status, call.hostedItems, call.replayedItems])).toEqual([
    ["search", "ok", 1, 0], ["replay-with-hosted", "ok", 0, 1], ["replay-without-hosted", "ok", 0, 0]]);
  expect(report!.calls[0]).toMatchObject({ hostedSearchCalls: 1, reportedHostedSearchCalls: 1, inputTokens: 40, outputTokens: 12, totalMs: 700, httpStatus: 200 });
  expect(typeof report!.calls[0]!.firstDeltaMs).toBe("number");
  expect(Number.isFinite(Date.parse(report!.testedAt))).toBe(true);
  expect(fixture.seen.every(request => request.tools.at(-1)?.type === "web_search" && request.maxOutput === 2048)).toBe(true);
  expect(fixture.seen.map(request => request.input.filter(item => item.type === "web_search_call").length)).toEqual([0, 1, 0]);
  expect(fixture.seen.every(request => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  expectPrivate(out);
});

test("the API-key lane reads only XAI_API_KEY and records a rejected replay as a route that needs the omit switch", async () => {
  const fixture = server({ rejectReplay: true });
  const store = fakeCredentialStore();
  const { code, out, report } = await run(["--enable-live", "--route", "xai-api-key"], fixture, { store, env: { XAI_API_KEY: API_KEY } });
  expect(code).toBe(2);
  expect(report).toMatchObject({ route: "xai-api-key", status: "incomplete",
    summary: { firstAccepted: true, hostedItems: 1, replayWithHostedAccepted: false, replayWithoutHostedAccepted: true, verdict: "replay_rejected" } });
  expect(report!.calls[1]).toMatchObject({ phase: "replay-with-hosted", status: "http_error", httpStatus: 400 });
  expect(fixture.seen[0]!.authorization).toBe(`Bearer ${API_KEY}`);
  expectPrivate(out);
  const missing = server();
  const skipped = await run(["--enable-live", "--route", "xai-api-key"], missing, { env: {} });
  expect(skipped.code).toBe(2);
  expect(skipped.report).toMatchObject({ status: "skipped", reason: "missing_credentials", calls: [] });
  expect(missing.seen).toEqual([]);
});

test("a rejected search request records the route as unsupported and sends no follow-up", async () => {
  const fixture = server({ rejectSearch: true });
  const { report, out } = await run(["--enable-live", "--route", "grok"], fixture, { store: await grokStore() });
  expect(report).toMatchObject({ summary: { firstAccepted: false, verdict: "unsupported", replayWithHostedAccepted: null }, calls: [{ phase: "search", status: "http_error", httpStatus: 400 }] });
  expect(fixture.seen).toHaveLength(1);
  expectPrivate(out);
});
