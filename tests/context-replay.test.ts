import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgentLoop } from "../src/agent/loop.ts";
import { pruneForSummary } from "../src/context/compaction.ts";
import { createContextManager } from "../src/context/manager.ts";
import {
  REPLAY_TOOL_RESULT_BYTES,
  shortenEarlierTurnToolResults,
  shortenToolResultForReplay,
} from "../src/context/replay.ts";
import type { ConversationItem, ToolResult, UserMessage } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { Model, ModelRequest } from "../src/model/model.ts";
import { buildResponsesRequest } from "../src/model/providers/responses-stream.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

// About 21,000 UTF-16 units but 57,000 UTF-8 bytes, well over the replay budget.
const BIG = "ข้อมูล data ".repeat(3_000);

function user(id: string, text: string): UserMessage {
  return { type: "user", id, content: [{ type: "text", text }] };
}

function result(id: string, content: string): ToolResult {
  return { type: "tool_result", id, toolCallId: `call-${id}`, content, isError: false };
}

const EMIT_TOOL: ToolDefinition = {
  name: "emit",
  description: "Return a fixed result.",
  inputSchema: { type: "object", properties: { size: { type: "string" } } },
  execution: "parallel",
  effect: "read-only",
  async execute(input) { return { content: (input as { size: string }).size === "big" ? BIG : "small result" }; },
};

test("shortening keeps the first bytes on a code-point boundary and appends a fixed notice", () => {
  const big = result("r", `a${"🙂".repeat(5_000)}`);
  const shortened = shortenToolResultForReplay(big);
  expect(shortened).not.toBe(big);
  expect(shortened.content).toBe(`a${"🙂".repeat(1_999)}\n\n[Earlier output shortened from 20001 bytes. Run the call again if you need the full text.]`);
  expect(shortened.content.isWellFormed()).toBe(true);
  expect({ ...shortened, content: big.content }).toEqual(big);
  // Pure: the same item always shortens to the same bytes.
  expect(shortenToolResultForReplay(big)).toEqual(shortened);

  const fits = result("f", "x".repeat(REPLAY_TOOL_RESULT_BYTES));
  expect(shortenToolResultForReplay(fits)).toBe(fits);
  // Just over the budget, the notice would make the result longer, so it stays whole.
  const barely = result("b", "x".repeat(REPLAY_TOOL_RESULT_BYTES + 10));
  expect(shortenToolResultForReplay(barely)).toBe(barely);
});

test("only tool results before the latest user message are shortened, and the input is not mutated", () => {
  const items: ConversationItem[] = [
    user("u1", "first"),
    result("r1", BIG),
    user("u2", "second"),
    result("r2", BIG),
  ];
  const snapshot = structuredClone(items);
  const shortened = shortenEarlierTurnToolResults(items);
  expect(items).toEqual(snapshot);
  expect(shortened[0]).toBe(items[0]);
  expect((shortened[1] as ToolResult).content).toContain("[Earlier output shortened from");
  expect(shortened[2]).toBe(items[2]);
  expect(shortened[3]).toBe(items[3]);
  expect(shortenEarlierTurnToolResults([user("u", "only"), result("r", BIG)])[1]!).toEqual(result("r", BIG));
});

test("a large earlier-turn result is sent in full during its turn and shortened, byte-stable, from the next turn", async () => {
  await withTempDir(async dir => {
    const extensionPath = join(dir, "observer.ts");
    await Bun.write(extensionPath, `export const seen = [];
      export default ctx => {
        ctx.beforeModel(request => {
          seen.push(request.items.filter(item => item.type === 'tool_result').map(item => item.content));
          return request;
        });
      };`);
    const workspace = await resolveWorkspace(dir);
    const home = join(dir, "home");
    const tools = createToolRegistry([EMIT_TOOL]);
    const loaded = await loadExtensions({ modules: [await realpath(extensionPath)], workspace, home, secrets: [], tools });
    const observer = await import(pathToFileURL(await realpath(extensionPath)).href) as { seen: string[][] };
    try {
      const directory = join(dir, "sessions");
      const session = await createJsonlSession({ directory, workspace });
      const contextManager = createContextManager(workspace, { home, keepTurns: 1 });
      const requests: ModelRequest[] = [];
      const turnOf: number[] = [];
      let turn = 0;
      const inner = createScriptedModel({ responses: [
        { toolCalls: [{ id: "big", name: "emit", arguments: { size: "big" } }] },
        { toolCalls: [{ id: "small-1", name: "emit", arguments: { size: "small" } }] },
        { text: "turn 1 done" },
        { toolCalls: [{ id: "small-2", name: "emit", arguments: { size: "small" } }] },
        { text: "turn 2 done" },
        { text: "turn 3 done" },
      ] });
      const model: Model = { provider: inner.provider, id: inner.id, stream(request) { requests.push(request); turnOf.push(turn); return inner.stream(request); } };
      for (turn = 0; turn < 3; turn++) {
        session.append(user(`u${turn}`, `question ${turn}`));
        const events = await collect(runAgentLoop({ session, model, contextManager, workspace, tools, extensions: loaded.runtime }));
        expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      }
      expect(turnOf).toEqual([0, 0, 0, 1, 1, 2]);

      const bigOf = (request: ModelRequest) =>
        request.items.find((item): item is ToolResult => item.type === "tool_result" && item.toolCallId === "big")?.content;
      expect(bigOf(requests[0]!)).toBeUndefined();
      expect(bigOf(requests[1]!)).toBe(BIG);
      expect(bigOf(requests[2]!)).toBe(BIG);
      const shortened = bigOf(requests[3]!)!;
      expect(utf8ByteLength(shortened)).toBeLessThan(REPLAY_TOOL_RESULT_BYTES + 200);
      expect(shortened).toEndWith(`[Earlier output shortened from ${utf8ByteLength(BIG)} bytes. Run the call again if you need the full text.]`);
      for (const request of requests.slice(4)) expect(bigOf(request)).toBe(shortened);
      // Results of the turn in progress go out in full.
      expect(requests[4]!.items.find(item => item.type === "tool_result" && item.toolCallId === "small-2")).toMatchObject({ content: "small result" });

      // The adapter sends the same bytes: one change at the first request of turn 2, then stable, and each input extends the last within a turn.
      const bodies = requests.map(request => buildResponsesRequest({ model: "grok-4.7", maxOutputTokens: 8192, request, namespace: "xai" }));
      const output = (index: number) => JSON.stringify(bodies[index]!.input.find(item => "call_id" in item && item.call_id === "big" && item.type === "function_call_output"));
      expect(output(1)).toBe(output(2));
      expect(output(3)).not.toBe(output(2));
      expect(output(4)).toBe(output(3));
      expect(output(5)).toBe(output(3));
      for (let index = 1; index < bodies.length; index++) {
        if (turnOf[index] !== turnOf[index - 1]) continue;
        const previous = bodies[index - 1]!.input;
        const next = bodies[index]!.input;
        expect(next.length).toBeGreaterThan(previous.length);
        expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
      }

      // beforeModel hooks receive the shortened items.
      expect(observer.seen).toHaveLength(6);
      expect(observer.seen[2]![0]).toBe(BIG);
      expect(observer.seen[3]![0]).toBe(shortened);
      expect(observer.seen[5]![0]).toBe(shortened);

      // The live and saved session keep the full result.
      const stored = (items: readonly unknown[]) => items.find((item): item is ToolResult => (item as ToolResult).type === "tool_result" && (item as ToolResult).toolCallId === "big")!.content;
      expect(stored(session.items)).toBe(BIG);
      const resumed = await loadJsonlSession({ directory, id: session.header.id });
      expect(stored(resumed.items)).toBe(BIG);

      // Compaction summaries prune the full items, not the replay copy.
      let summaryInput = "";
      const summarizer = createScriptedModel({ responses: [request => {
        const first = request.items[0];
        summaryInput = first?.type === "user" ? first.content[0]!.text : "";
        return { text: "summary" };
      }] });
      const record = await contextManager.compact(session, summarizer, { reason: "manual" });
      expect(record).not.toBeNull();
      const pruned = pruneForSummary([{ type: "tool_result", id: "x", toolCallId: "big", content: BIG, isError: false }])[0] as ToolResult;
      expect(summaryInput).toContain(pruned.content);
      expect(summaryInput).not.toContain("Earlier output shortened");
    } finally { loaded.runtime.dispose(); }
  });
});
