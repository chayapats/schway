import { expect, test } from "bun:test";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import type { AssistantMessage, UserMessage } from "../src/conversation/types.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const workspace = {
  root: "/tmp/project",
  launchCwd: "/tmp/project",
  extraRoots: [],
};

function user(text: string): UserMessage {
  return { type: "user", id: "u1", content: [{ type: "text", text }] };
}

test("scripted model streams text through the real agent loop", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({ chunks: ["Hel", "lo"] }),
      contextManager: createContextManager(workspace),
    }),
  );

  expect(events.map((event) => event.type)).toEqual([
    "agent.started",
    "model.started",
    "model.delta",
    "model.delta",
    "model.finished",
    "agent.finished",
  ]);
  expect(events).toContainEqual({
    type: "model.started",
    provider: "scripted",
    model: "scripted",
  });
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "text", text: "Hel" },
  });
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "text", text: "lo" },
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });

  const assistant = session.items[1] as AssistantMessage;
  expect(assistant.type).toBe("assistant");
  expect(assistant.content).toEqual([{ type: "text", text: "Hello" }]);
});

test("stream failure emits an error and does not complete successfully", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({ error: "connection reset" }),
      contextManager: createContextManager(workspace),
    }),
  );

  expect(events).toContainEqual({ type: "error", message: "connection reset" });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  expect(session.items).toHaveLength(1);
});

test("runtime events do not use provider wire types", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        thinkingChunks: ["hmm"],
        text: "done",
      }),
      contextManager: createContextManager(workspace),
    }),
  );
  const serialized = JSON.stringify(events);
  expect(serialized.includes("content_block_delta")).toBe(false);
  expect(serialized.includes("message_start")).toBe(false);
  expect(serialized.includes("text_delta")).toBe(false);
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "thinking", text: "hmm" },
  });
});
