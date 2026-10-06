import { expect, test } from "bun:test";
import { credentialIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { estimateTextTokens } from "../src/context/tokens.ts";
import { parsePromptCacheProbeArgs, probePrefix, runPromptCacheProbeCli, type PromptCacheProbeReport } from "../src/live/prompt-cache-probe.ts";
import { PROMPT_CACHE_KEY_PATTERN } from "../src/model/prompt-cache-key.ts";
import { encodeXaiSse } from "./fixtures/xai.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const TOKEN = "fixture-grok-secret-token";
const REVISION = "0123456789abcdef0123456789abcdef01234567";

/** One Responses stream reporting `cached` of `input` tokens as served from cache. */
const stream = (input: number, cached: number) => encodeXaiSse([
  { type: "response.created", response: { id: "resp_probe", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_probe", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "READY" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_probe", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "READY" }] } },
  { type: "response.completed", response: { id: "resp_probe", status: "completed", usage: { input_tokens: input, output_tokens: 5, input_tokens_details: { cached_tokens: cached } } } },
]);

interface Seen { key?: string; convId: string | null; instructions: string; input: unknown[]; maxOutput?: number; authorization: string | null }

/** Protocol fixture whose cache serves a prefix only to a request that repeats the previous request's prompt_cache_key. */
function server(options: { rejectKey?: boolean } = {}) {
  const seen: Seen[] = [];
  let clock = 0;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { prompt_cache_key?: string; instructions: string; input: unknown[]; max_output_tokens?: number };
    const previous = seen.at(-1);
    seen.push({ key: body.prompt_cache_key, convId: headers.get("x-grok-conv-id"), instructions: body.instructions, input: body.input, maxOutput: body.max_output_tokens, authorization: headers.get("authorization") });
    if (options.rejectKey && body.prompt_cache_key) return Response.json({ error: { message: `unknown field ${TOKEN}` } }, { status: 400 });
    const hit = body.prompt_cache_key !== undefined && previous?.key === body.prompt_cache_key;
    clock += hit ? 300 : 900;
    return new Response(stream(20_000, hit ? 18_432 : 0), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, seen, now: () => clock };
}

async function run(argv: string[], fixture: ReturnType<typeof server>, store = fakeCredentialStore()) {
  let out = "", err = "";
  const code = await runPromptCacheProbeCli(argv, { revision: REVISION, out: text => { out += text; }, err: text => { err += text; } },
    { createStore: () => store, fetch: fixture.fetch, now: fixture.now });
  return { code, out, err, report: out ? JSON.parse(out) as PromptCacheProbeReport : undefined };
}

async function grokStore() {
  const store = fakeCredentialStore();
  await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: TOKEN, obtainedAt: Date.now() }));
  return store;
}

test("argument parsing requires a route and bounds runs and the output cap", () => {
  expect(parsePromptCacheProbeArgs([])).toEqual({ error: "Select --route grok or --route xai-api-key." });
  expect(parsePromptCacheProbeArgs(["--route", "grok"])).toMatchObject({ selection: { enabled: false, route: "grok", model: "grok-4.7", runs: 1, maxOutputTokens: 4096 } });
  expect(parsePromptCacheProbeArgs(["--route", "codex"])).toHaveProperty("error");
  expect(parsePromptCacheProbeArgs(["--route", "grok", "--runs", "6"])).toHaveProperty("error");
  expect(parsePromptCacheProbeArgs(["--route", "grok", "--max-output-tokens", "100000"])).toHaveProperty("error");
  expect(parsePromptCacheProbeArgs(["--route", "grok", "--no-key"])).toHaveProperty("error");
  expect(parsePromptCacheProbeArgs(["--enable-live", "--route", "xai-api-key", "--runs", "2"])).toMatchObject({ selection: { enabled: true, route: "xai-api-key", runs: 2 } });
});

test("the shared prefix is fixed and about 20k tokens", () => {
  expect(probePrefix()).toBe(probePrefix());
  const tokens = estimateTextTokens(probePrefix());
  expect(tokens).toBeGreaterThan(15_000);
  expect(tokens).toBeLessThan(30_000);
});

test("without --enable-live nothing is read or sent and the report says it was skipped", async () => {
  const fixture = server();
  let opened = false;
  let out = "";
  const code = await runPromptCacheProbeCli(["--route", "grok"], { revision: "unknown", out: text => { out += text; }, err: () => {} },
    { createStore: () => { opened = true; return fakeCredentialStore(); }, fetch: fixture.fetch });
  expect(code).toBe(2);
  expect(opened).toBe(false);
  expect(fixture.seen).toEqual([]);
  expect(JSON.parse(out)).toMatchObject({ status: "skipped", reason: "live_disabled", route: "grok", calls: [] });
});

test("a recorded run sends one key across both keyed turns, none on the other arm, and reports turn-2 cache hits without secrets", async () => {
  const fixture = server();
  const { code, out, report } = await run(["--enable-live", "--route", "grok", "--runs", "2"], fixture, await grokStore());
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: "complete", route: "grok", model: "grok-4.7", runs: 2, maxOutputTokens: 4096, revision: REVISION });
  // Run 1 is keyed first and run 2 unkeyed first; each arm is two turns.
  expect(report!.calls.map(call => [call.run, call.arm, call.turn])).toEqual([
    [1, "key", 1], [1, "key", 2], [1, "no-key", 1], [1, "no-key", 2],
    [2, "no-key", 1], [2, "no-key", 2], [2, "key", 1], [2, "key", 2],
  ]);
  const keyed = fixture.seen.filter(entry => entry.key !== undefined);
  expect(keyed).toHaveLength(4);
  expect(keyed.every(entry => PROMPT_CACHE_KEY_PATTERN.test(entry.key!))).toBe(true);
  expect(fixture.seen[0]!.key).toBe(fixture.seen[1]!.key!);
  expect(fixture.seen[6]!.key).toBe(fixture.seen[7]!.key!);
  expect(fixture.seen[0]!.key).not.toBe(fixture.seen[6]!.key!);
  expect([2, 3, 4, 5].every(index => fixture.seen[index]!.key === undefined)).toBe(true);
  expect(fixture.seen.every(entry => entry.convId === null && entry.maxOutput === 4096 && entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
  // Turn 2 strictly extends turn 1, and every arm-run starts from its own prefix.
  for (let index = 0; index < fixture.seen.length; index += 2) {
    const [first, second] = [fixture.seen[index]!, fixture.seen[index + 1]!];
    expect(second.instructions).toBe(first.instructions);
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(second.input.length).toBe(first.input.length + 2);
  }
  expect(new Set(fixture.seen.map(entry => entry.instructions)).size).toBe(4);
  expect(report!.calls[1]).toEqual({ arm: "key", run: 1, turn: 2, status: "ok", httpStatus: 200, inputTokens: 20_000, cachedInputTokens: 18_432, outputTokens: 5, firstDeltaMs: 300, totalMs: 300 });
  expect(report!.calls[3]).toMatchObject({ arm: "no-key", turn: 2, cachedInputTokens: 0, totalMs: 900 });
  expect(report!.summary).toEqual({ keyTurn2Hits: 2, noKeyTurn2Hits: 0, cacheHit: true });
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain("schway-v1-");
  expect(out).not.toContain("Record 0001");
  expect(out).not.toContain("READY");
  expect(out).not.toMatch(/https?:|authorization|Bearer|Probe [0-9a-f-]{36}/i);
});

test("a route that rejects the key is reported per call and never counts as a hit", async () => {
  const fixture = server({ rejectKey: true });
  const { code, out, report } = await run(["--enable-live", "--route", "grok"], fixture, await grokStore());
  expect(code).toBe(2);
  expect(report!.status).toBe("incomplete");
  expect(report!.calls.map(call => [call.arm, call.turn, call.status, call.httpStatus])).toEqual([
    ["key", 1, "http_error", 400], ["key", 2, "http_error", 400], ["no-key", 1, "ok", 200], ["no-key", 2, "ok", 200],
  ]);
  expect(report!.summary.cacheHit).toBe(false);
  expect(out).not.toContain(TOKEN);
});

test("missing stored credentials are reported without any request, and environment keys are ignored", async () => {
  const fixture = server();
  expect((await run(["--enable-live", "--route", "grok"], fixture)).report).toMatchObject({ status: "pending", reason: "missing_subscription" });
  expect((await run(["--enable-live", "--route", "xai-api-key"], fixture)).report).toMatchObject({ status: "skipped", reason: "missing_credentials" });
  expect(fixture.seen).toEqual([]);
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "xai" }), "stored-xai-key");
  const stored = await run(["--enable-live", "--route", "xai-api-key"], fixture, store);
  expect(stored.report!.status).toBe("complete");
  expect(fixture.seen.every(entry => entry.authorization === "Bearer stored-xai-key")).toBe(true);
  expect(stored.out).not.toContain("stored-xai-key");
});
