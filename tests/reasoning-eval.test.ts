import { expect, test } from "bun:test";
import { grokSubscriptionIdentity } from "../src/auth/store.ts";
import { parseReasoningEvalArgs, REASONING_EVAL_PROBE, runReasoningEvalCli, type ReasoningEvalReport } from "../src/live/reasoning-eval.ts";
import { encodeXaiSse } from "./fixtures/xai.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const TOKEN = "fixture-grok-secret-token";
/** One Responses stream whose usage reports `reasoning` of `output` tokens; `incomplete` ends at the output cap. */
const stream = (reasoning: number, output: number, incomplete = false) => encodeXaiSse([
  { type: "response.created", response: { id: "resp_eval", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_eval", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "Rail is faster." },
  ...(incomplete ? [{ type: "response.incomplete", response: { id: "resp_eval", status: "incomplete", usage: { input_tokens: 40, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning } } } }]
    : [{ type: "response.output_item.done", output_index: 0, item: { id: "msg_eval", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Rail is faster." }] } },
      { type: "response.completed", response: { id: "resp_eval", status: "completed", usage: { input_tokens: 40, output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning } } } }]),
]);

/** Protocol fixture: the Grok model list plus a response per call whose reasoning depends on the requested effort. */
function server(options: { reject?: string; incompleteUnset?: boolean } = {}) {
  const seen: Array<{ effort?: string; maxOutput?: number; authorization: string | null }> = [];
  const lists: string[] = [];
  let clock = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/models")) { lists.push(url); return Response.json({ data: [{ id: "grok-4.7", capabilities: { reasoning_effort: ["low", "medium", "high"] }, default_reasoning_effort: "high" }] }); }
    const body = JSON.parse(String(init?.body)) as { reasoning?: { effort: string }; max_output_tokens?: number };
    seen.push({ effort: body.reasoning?.effort, maxOutput: body.max_output_tokens, authorization: headers.get("authorization") });
    if (options.reject && body.reasoning?.effort === options.reject) return Response.json({ error: { message: `unsupported ${TOKEN}` } }, { status: 400 });
    const reasoning = { undefined: 4000, low: 900, medium: 2200 }[String(body.reasoning?.effort)] ?? 3000;
    // Model time follows reasoning output in this fixture: 10 ms per reasoning token.
    clock += reasoning * 10;
    const incomplete = options.incompleteUnset && body.reasoning === undefined && seen.filter(entry => entry.effort === undefined).length === 2;
    return new Response(stream(reasoning, reasoning + 120, incomplete), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, seen, lists, now: () => clock };
}

async function run(argv: string[], fixture: ReturnType<typeof server>, store = fakeCredentialStore()) {
  let out = "", err = "";
  const code = await runReasoningEvalCli(argv, { revision: "0123456789abcdef0123456789abcdef01234567", out: text => { out += text; }, err: text => { err += text; } },
    { createStore: () => store, fetch: fixture.fetch, now: fixture.now });
  return { code, out, err, report: out ? JSON.parse(out) as ReasoningEvalReport : undefined };
}

async function grokStore() {
  const store = fakeCredentialStore();
  await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: TOKEN, obtainedAt: Date.now() }));
  return store;
}

test("argument parsing requires a route, keeps at least three runs and bounds the output cap", () => {
  expect(parseReasoningEvalArgs([])).toEqual({ error: "Select --route grok or --route xai-api-key." });
  expect(parseReasoningEvalArgs(["--route", "grok"])).toMatchObject({ selection: { enabled: false, route: "grok", model: "grok-4.7", levels: ["low", "medium"], runs: 3, maxOutputTokens: 16_384 } });
  expect(parseReasoningEvalArgs(["--route", "grok", "--runs", "2"])).toHaveProperty("error");
  expect(parseReasoningEvalArgs(["--route", "grok", "--max-output-tokens", "256"])).toHaveProperty("error");
  expect(parseReasoningEvalArgs(["--route", "grok", "--levels", "low,extreme"])).toHaveProperty("error");
  expect(parseReasoningEvalArgs(["--route", "codex"])).toHaveProperty("error");
  expect(parseReasoningEvalArgs(["--enable-live", "--route", "xai-api-key", "--levels", "low", "--runs", "5"])).toMatchObject({ selection: { enabled: true, route: "xai-api-key", levels: ["low"], runs: 5 } });
});

test("without --enable-live nothing is read or sent and the report says it was skipped", async () => {
  const fixture = server();
  let opened = false;
  let out = "";
  const code = await runReasoningEvalCli(["--route", "grok"], { revision: "unknown", out: text => { out += text; }, err: () => {} },
    { createStore: () => { opened = true; return fakeCredentialStore(); }, fetch: fixture.fetch });
  expect(code).toBe(2);
  expect(opened).toBe(false);
  expect(fixture.seen).toEqual([]);
  expect(JSON.parse(out)).toMatchObject({ status: "skipped", reason: "live_disabled", route: "grok" });
});

test("a recorded run compares interleaved arms by median reasoning tokens and model time, and never prints secrets", async () => {
  const fixture = server();
  const { code, out, report } = await run(["--enable-live", "--route", "grok"], fixture, await grokStore());
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: "complete", route: "grok", model: "grok-4.7", runs: 3, maxOutputTokens: 16_384, revision: "0123456789abcdef0123456789abcdef01234567" });
  // Interleaved: unset, low, medium per run; unset sends no reasoning field, and every call keeps the output cap.
  expect(fixture.seen.map(entry => entry.effort)).toEqual([undefined, "low", "medium", undefined, "low", "medium", undefined, "low", "medium"]);
  expect(fixture.seen.every(entry => entry.maxOutput === 16_384 && entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
  // Capability is discovered once per explicit level, as production requires before sending a level.
  expect(fixture.lists).toHaveLength(2);
  expect(report!.arms.map(arm => [arm.arm, arm.evidenceCalls, arm.medians?.reasoningTokens, arm.medians?.totalMs])).toEqual([["unset", 3, 4000, 40_000], ["low", 3, 900, 9000], ["medium", 3, 2200, 22_000]]);
  expect(report!.arms[0]!.calls[0]).toEqual({ arm: "unset", run: 1, status: "ok", httpStatus: 200, reasoningTokens: 4000, outputTokens: 4120, firstDeltaMs: 40_000, totalMs: 40_000 });
  expect(report!.verdicts).toEqual([
    { level: "low", accepted: true, fewerReasoningTokens: true, lessModelTime: true, meetsDefaultBar: true },
    { level: "medium", accepted: true, fewerReasoningTokens: true, lessModelTime: true, meetsDefaultBar: true },
  ]);
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain("Rail is faster");
  expect(out).not.toContain(REASONING_EVAL_PROBE);
  expect(out).not.toMatch(/https?:|authorization|Bearer/i);
});

test("a 4xx for a level and a response cut at the output cap are reported but never count as evidence", async () => {
  const fixture = server({ reject: "medium", incompleteUnset: true });
  const { code, out, report } = await run(["--enable-live", "--route", "grok"], fixture, await grokStore());
  expect(code).toBe(2);
  expect(report!.status).toBe("incomplete");
  const unset = report!.arms.find(arm => arm.arm === "unset")!, medium = report!.arms.find(arm => arm.arm === "medium")!;
  expect(unset.calls.map(call => call.status)).toEqual(["ok", "incomplete", "ok"]);
  expect(unset.calls[1]).toMatchObject({ reasoningTokens: 4000, outputTokens: 4120 });
  expect(unset.evidenceCalls).toBe(2);
  expect(medium.calls.map(call => [call.status, call.httpStatus])).toEqual([["http_error", 400], ["http_error", 400], ["http_error", 400]]);
  // Neither level meets the bar: medium was rejected, and unset has fewer than three usable calls.
  expect(report!.verdicts.map(verdict => [verdict.level, verdict.accepted, verdict.meetsDefaultBar])).toEqual([["low", true, false], ["medium", false, false]]);
  expect(out).not.toContain(TOKEN);
});

test("a missing login is reported without any request, and an unlisted level is refused before inference", async () => {
  const fixture = server();
  const missing = await run(["--enable-live", "--route", "grok"], fixture);
  expect(missing.report).toMatchObject({ status: "pending", reason: "missing_subscription" });
  const apiKey = await run(["--enable-live", "--route", "xai-api-key"], fixture);
  expect(apiKey.report).toMatchObject({ status: "skipped", reason: "missing_credentials" });
  expect(fixture.seen).toEqual([]);
  const unlisted = await run(["--enable-live", "--route", "grok", "--levels", "xhigh"], fixture, await grokStore());
  expect(unlisted.report!.arms[1]!.calls.map(call => call.status)).toEqual(["unsupported_thinking", "unsupported_thinking", "unsupported_thinking"]);
  expect(fixture.seen.every(entry => entry.effort === undefined)).toBe(true);
  expect(unlisted.report!.verdicts).toEqual([{ level: "xhigh", accepted: false, fewerReasoningTokens: false, lessModelTime: false, meetsDefaultBar: false }]);
});
