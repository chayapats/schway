import { expect, test } from "bun:test";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSummaryInputText, pruneForSummary } from "../src/context/compaction.ts";
import type { AssistantMessage, AssistantTelemetry, ConversationItem, ToolResult, ToolTelemetry } from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createCodexSubscriptionModel, CODEX_ACCOUNT_CLAIM } from "../src/model/providers/codex-subscription.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { withTempDir } from "./helpers.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";

const ASSISTANT_TELEMETRY: AssistantTelemetry = { startedAt: "2026-01-15T09:30:00.000Z", firstDeltaMs: 812, attemptMs: 23_800, totalMs: 25_100, attempts: 2, retryWaitMs: 1000,
  usage: { inputTokens: 81_000, outputTokens: 2400, cachedInputTokens: 65_536, reasoningTokens: 2100 } };
const TOOL_TELEMETRY: ToolTelemetry = { startedAt: "2026-01-15T09:30:25.100Z", durationMs: 4800, approvalWaitMs: 3000 };

const user = (id: string, text = id): ConversationItem => ({ type: "user", id, content: [{ type: "text", text }] });
const call = (id: string, callId: string, telemetry?: AssistantTelemetry): AssistantMessage => ({ type: "assistant", id,
  content: [{ type: "text", text: "Reading." }, { type: "tool_call", id: callId, name: "read", arguments: { path: "a.txt" } }], ...(telemetry ? { telemetry } : {}) });
const result = (id: string, callId: string, telemetry?: ToolTelemetry): ToolResult => ({ type: "tool_result", id, toolCallId: callId, content: "alpha", isError: false, ...(telemetry ? { telemetry } : {}) });
const answer = (id: string, telemetry?: AssistantTelemetry): AssistantMessage => ({ type: "assistant", id, content: [{ type: "text", text: "Done." }], ...(telemetry ? { telemetry } : {}) });

test("assistant and tool telemetry survive save, resume, fork and branch select", async () => {
  await withTempDir(async directory => {
    const workspace = { root: directory, launchCwd: directory, extraRoots: [] };
    const session = await createJsonlSession({ directory, workspace });
    session.append(user("u1"), call("a1", "c1", ASSISTANT_TELEMETRY), result("r1", "c1", TOOL_TELEMETRY), answer("a2", { ...ASSISTANT_TELEMETRY, attempts: 1, retryWaitMs: 0 }));
    session.append(user("u2"), answer("a3", ASSISTANT_TELEMETRY));
    const fork = session.forkBranch("a2", "alternate");
    session.append(user("u3"), call("a4", "c2", ASSISTANT_TELEMETRY), result("r2", "c2", { startedAt: TOOL_TELEMETRY.startedAt, durationMs: 120 }));
    session.selectBranch("main");

    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    const byId = (items: readonly ConversationItem[], id: string) => items.find(item => item.id === id) as AssistantMessage & ToolResult;
    expect(byId(resumed.items, "a1").telemetry).toEqual(ASSISTANT_TELEMETRY);
    expect(byId(resumed.items, "r1").telemetry).toEqual(TOOL_TELEMETRY);
    expect(byId(resumed.items, "a3").telemetry).toEqual(ASSISTANT_TELEMETRY);
    resumed.selectBranch(fork);
    expect(byId(resumed.items, "a1").telemetry).toEqual(ASSISTANT_TELEMETRY);
    expect(byId(resumed.items, "a4").telemetry).toEqual(ASSISTANT_TELEMETRY);
    expect(byId(resumed.items, "r2").telemetry).toEqual({ startedAt: TOOL_TELEMETRY.startedAt, durationMs: 120 });
    const forked = await loadJsonlSession({ directory, id: session.header.id, branchId: fork });
    expect(byId(forked.items, "r2").telemetry).toEqual({ startedAt: TOOL_TELEMETRY.startedAt, durationMs: 120 });
  });
});

test("a line with malformed telemetry loads with the field dropped and still resumes", async () => {
  await withTempDir(async directory => {
    const workspace = { root: directory, launchCwd: directory, extraRoots: [] };
    const session = await createJsonlSession({ directory, workspace });
    session.append(user("u1"));
    const path = join(directory, `${session.header.id}.jsonl`);
    const malformed: unknown[] = [
      { ...call("a1", "c1"), telemetry: { startedAt: "not a time", firstDeltaMs: 1, attemptMs: 2, totalMs: 3, attempts: 1, retryWaitMs: 0, usage: { inputTokens: 1, outputTokens: 1 } } },
      { ...result("r1", "c1"), telemetry: { startedAt: TOOL_TELEMETRY.startedAt, durationMs: -5 } },
      { ...answer("a2"), telemetry: "fast" },
      { ...user("u2") },
      { ...answer("a3"), telemetry: { ...ASSISTANT_TELEMETRY, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1.5 } } },
      { ...user("u3") },
      { ...call("a4", "c4") },
      { ...result("r4", "c4"), telemetry: { ...TOOL_TELEMETRY, approvalWaitMs: 99_999 } },
    ];
    let parent = "u1";
    for (const item of malformed) {
      await appendFile(path, `${JSON.stringify({ type: "branch_append", version: 1, branchId: "main", entries: [{ parentId: parent, item }] })}\n`);
      parent = (item as { id: string }).id;
    }
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    expect(resumed.items.map(item => item.id)).toEqual(["u1", "a1", "r1", "a2", "u2", "a3", "u3", "a4", "r4"]);
    expect(resumed.items.every(item => !("telemetry" in item))).toBe(true);
  });
});

const fixtureRoot = join(import.meta.dir, "fixtures/sessions");
for (const release of (await readdir(fixtureRoot)).sort()) {
  test(`published ${release} session still loads every branch with telemetry absent`, async () => {
    const expected = JSON.parse(await readFile(join(fixtureRoot, release, "expect.json"), "utf8")) as { sessionId: string; mainBranchId: string; alternateBranchId: string };
    await withTempDir(async directory => {
      const text = await readFile(join(fixtureRoot, release, `${expected.sessionId}.jsonl`), "utf8");
      await writeFile(join(directory, `${expected.sessionId}.jsonl`), text.replaceAll("__SCHWAY_FIXTURE_WORKSPACE__", directory));
      for (const branchId of [expected.mainBranchId, expected.alternateBranchId]) {
        const loaded = await loadJsonlSession({ directory, id: expected.sessionId, branchId });
        expect(loaded.items.length).toBeGreaterThan(0);
        expect(loaded.items.some(item => "telemetry" in item)).toBe(false);
      }
    });
  });
}

/** Strip harness telemetry, leaving the same conversation. */
const withoutTelemetry = (items: readonly ConversationItem[]): ConversationItem[] => items.map(item => {
  if (item.type === "user") return item;
  const { telemetry: _, ...rest } = item as AssistantMessage | ToolResult;
  return rest as ConversationItem;
});
const ITEMS: ConversationItem[] = [user("u1", "Read a.txt"), call("a1", "call_c1", ASSISTANT_TELEMETRY), result("r1", "call_c1", TOOL_TELEMETRY), answer("a2", ASSISTANT_TELEMETRY), user("u2", "Thanks")];
const request = (items: ConversationItem[]): ModelRequest => ({ systemPrompt: "System.", context: [], items });

/** Capture the exact request body an adapter sends for `items`. */
async function body(send: (fetch: (input: unknown, init?: RequestInit) => Promise<Response>) => AsyncIterable<unknown>): Promise<string> {
  let captured = "";
  for await (const _ of send(async (_input, init) => { captured = String(init?.body ?? ""); return new Response(encodeSse(TEXT_STREAM_EVENTS), { headers: { "Content-Type": "text/event-stream" } }); })) { /* drain */ }
  return captured;
}

test("Responses, ChatGPT subscription and compatible requests are byte-identical with and without telemetry", async () => {
  expect(withoutTelemetry(ITEMS).some(item => "telemetry" in item)).toBe(false);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "none" })}.${encode({ [CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: "acct-wire" } })}.`;
  const adapters: Record<string, (items: ConversationItem[]) => Promise<string>> = {
    openai: items => body(fetch => createOpenAIModel({ model: "gpt-6-astra", apiKey: "fixture", fetch: fetch as never }).stream(request(items))),
    xai: items => body(fetch => createXaiModel({ apiKey: "fixture", model: "grok-fixture", baseUrl: "https://xai.test/v1", fetch: fetch as never }).stream(request(items))),
    codex: items => body(fetch => createCodexSubscriptionModel({ model: "gpt-5.4", tokens: { accessToken, expiresAt: Date.now() + 3_600_000 }, fetch: fetch as never }).stream(request(items))),
    compatible: async items => {
      let captured = "";
      const model = createOpenAICompatibleModel({ model: "gpt-4o", baseUrl: "https://example.test/v1", auth: "none", fetch: async (_input, init) => {
        captured = String(init?.body ?? "");
        return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS), { headers: { "Content-Type": "text/event-stream" } });
      } });
      for await (const _ of model.stream(request(items))) { /* drain */ }
      return captured;
    },
  };
  for (const [name, send] of Object.entries(adapters)) {
    const withTelemetry = await send(ITEMS), without = await send(withoutTelemetry(ITEMS));
    expect(withTelemetry, name).toBe(without);
    expect(withTelemetry, name).not.toContain("telemetry");
    expect(withTelemetry, name).not.toContain(ASSISTANT_TELEMETRY.startedAt);
  }
});

test("compaction summary input never contains telemetry", () => {
  const text = buildSummaryInputText({ compacted: pruneForSummary(ITEMS) });
  expect(text).toBe(buildSummaryInputText({ compacted: pruneForSummary(withoutTelemetry(ITEMS)) }));
  expect(text).not.toContain(ASSISTANT_TELEMETRY.startedAt);
  expect(text).not.toContain("65536");
});
