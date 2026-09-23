import { expect, test } from "bun:test";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import type { ModelRequest } from "../src/model/model.ts";
import {
  CODEX_FEASIBILITY_MODEL,
  createCodexFeasibilityModel,
  type CodexFeasibilityTurn,
  type CodexFeasibilityWireRequest,
} from "../src/model/providers/codex-feasibility.ts";

type FixtureTurn = {
  turn: CodexFeasibilityTurn;
};

/** Load one sanitized offline replay fixture without touching any credential cache. */
async function loadTurn(name: string): Promise<CodexFeasibilityTurn> {
  const file = Bun.file(
    new URL(`./fixtures/codex-subscription/${name}`, import.meta.url),
  );
  const parsed = (await file.json()) as FixtureTurn;
  return parsed.turn;
}

/** Drain a model stream into an array for assertions. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/** Build a minimal Schway request carrying system context, one user item, and one tool. */
function sampleRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemPrompt: STABLE_SYSTEM_PROMPT,
    context: [
      {
        name: "environment",
        content: "Workspace root: /tmp/project\nLaunch directory: /tmp/project",
      },
    ],
    items: [
      {
        type: "user",
        id: "user-1",
        content: [{ type: "text", text: "read note.txt" }],
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
    ...overrides,
  };
}

test("streams replayed text without delegating tool execution", async () => {
  const turn = await loadTurn("turn-text.json");
  const seen: CodexFeasibilityWireRequest[] = [];
  const model = createCodexFeasibilityModel({
    turns: [turn],
    onRequest: (request) => seen.push(request),
  });

  const events = await collect(model.stream(sampleRequest()));

  expect(model.provider).toBe("codex-feasibility");
  expect(model.id).toBe(CODEX_FEASIBILITY_MODEL);
  expect(events.filter((event) => event.type !== "message_complete")).toEqual([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
  const complete = events.at(-1);
  expect(complete?.type).toBe("message_complete");
  if (complete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(complete.message.content).toEqual([
    { type: "text", text: "Hello world" },
  ]);
  expect(model.requestCount).toBe(1);
  expect(model.executedTools).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.instructions).toContain(STABLE_SYSTEM_PROMPT);
  expect(seen[0]?.tools).toEqual([
    { name: "read", description: "Read a file" },
  ]);
});

test("Schway executes the requested tool itself and submits its own result", async () => {
  const first = await loadTurn("turn-tool-call.json");
  const second = await loadTurn("turn-tool-result.json");
  const seen: CodexFeasibilityWireRequest[] = [];
  const model = createCodexFeasibilityModel({
    turns: [first, second],
    onRequest: (request) => seen.push(request),
  });

  // Turn 1: model requests a tool; the transport must not execute anything.
  const firstEvents = await collect(model.stream(sampleRequest()));
  const firstComplete = firstEvents.at(-1);
  expect(firstComplete?.type).toBe("message_complete");
  if (firstComplete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  const toolCall = firstComplete.message.content.find(
    (block) => block.type === "tool_call",
  );
  expect(toolCall).toMatchObject({ id: "call_read1", name: "read" });
  expect(model.executedTools).toBe(0);

  // Schway-owned execution: this fake read stands in for src/tools/read.ts.
  if (toolCall?.type !== "tool_call") {
    throw new Error("expected tool_call");
  }
  const args = toolCall.arguments as { path: string };
  expect(args).toEqual({ path: "note.txt" });
  const toolOutput = "note.txt says hello";

  // Turn 2: Schway submits its own tool result and receives final text.
  const followup: ModelRequest = {
    ...sampleRequest(),
    items: [
      ...sampleRequest().items,
      firstComplete.message,
      {
        type: "tool_result",
        id: "result-1",
        toolCallId: "call_read1",
        content: toolOutput,
        isError: false,
      },
    ],
  };
  const secondEvents = await collect(model.stream(followup));
  const secondComplete = secondEvents.at(-1);
  expect(secondComplete?.type).toBe("message_complete");
  if (secondComplete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(secondComplete.message.content).toEqual([
    { type: "text", text: "note.txt says hello" },
  ]);
  expect(model.requestCount).toBe(2);
  expect(model.executedTools).toBe(0);
  expect(seen).toHaveLength(2);
  const secondInput = seen[1]?.input as Array<Record<string, unknown>>;
  expect(
    secondInput.some(
      (entry) =>
        entry["role"] === "tool" &&
        entry["toolCallId"] === "call_read1" &&
        entry["content"] === toolOutput,
    ),
  ).toBe(true);
});

test("cancellation at the Schway boundary aborts without delegating the run", async () => {
  const model = createCodexFeasibilityModel({
    turns: [{ waitForAbort: true, chunks: ["partial"] }],
  });
  const controller = new AbortController();
  const pending = collect(
    model.stream(sampleRequest({ signal: controller.signal })),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(model.executedTools).toBe(0);
});

test("already-aborted requests fail fast with a single attempt", async () => {
  const model = createCodexFeasibilityModel({
    turns: [{ chunks: ["never"] }],
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    collect(model.stream(sampleRequest({ signal: controller.signal }))),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(model.requestCount).toBe(1);
});

test("transport failures surface once without Schway-owned retries inside the adapter", async () => {
  const model = createCodexFeasibilityModel({
    turns: [{ error: "codex-feasibility upstream unavailable" }],
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    "codex-feasibility upstream unavailable",
  );
  expect(model.requestCount).toBe(1);
  expect(model.executedTools).toBe(0);
});

test("feasibility prototype never scrapes CLI caches or reuses private OAuth identity", async () => {
  const source = await Bun.file(
    new URL(
      "../src/model/providers/codex-feasibility.ts",
      import.meta.url,
    ),
  ).text();
  for (const forbidden of [
    ".codex/auth.json",
    "CODEX_HOME",
    "client_secret",
    "clientSecret",
    "turn/start",
    "thread/start",
    "app-server",
    "codex login",
    "requires_openai_auth",
  ]) {
    expect(source.includes(forbidden)).toBe(false);
  }
  const model = createCodexFeasibilityModel({ turns: [] });
  expect(Object.keys(model).sort()).toEqual(
    ["executedTools", "id", "provider", "requestCount", "stream"].sort(),
  );
});
