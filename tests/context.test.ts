import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import { createSession } from "../src/session/session.ts";
import type {
  AssistantMessage,
  ConversationItem,
  UserMessage,
} from "../src/conversation/types.ts";

test("session stores user, assistant, thinking, and tool-call content", () => {
  const session = createSession();
  const user: UserMessage = {
    type: "user",
    id: "u1",
    content: [{ type: "text", text: "look at src/foo.ts" }],
  };
  const assistant: AssistantMessage = {
    type: "assistant",
    id: "a1",
    content: [
      {
        type: "thinking",
        text: "I should read the file",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      { type: "text", text: "Reading it now." },
      {
        type: "tool_call",
        id: "call-1",
        name: "read",
        arguments: { path: "src/foo.ts" },
      },
    ],
    providerMetadata: { anthropic: { stop_reason: "tool_use" } },
  };

  session.append(user);
  session.append(assistant);

  expect(session.items).toEqual([user, assistant]);
  const stored = session.items[1] as AssistantMessage;
  expect(stored.content[0]).toEqual(assistant.content[0]);
  expect(stored.content[2]).toEqual(assistant.content[2]);
});

test("stable system prompt is assembled separately from environment context", async () => {
  const workspace = {
    root: "/tmp/project",
    launchCwd: "/tmp/project/pkg",
    extraRoots: [],
  };
  const session = createSession([
    {
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "hello" }],
    },
  ]);
  const prepared = await createContextManager(workspace).prepare(session);

  expect(prepared.systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
  expect(prepared.systemPrompt.includes("/tmp/project")).toBe(false);
  expect(prepared.context).toEqual([
    {
      name: "environment",
      content: [
        "Workspace root: /tmp/project",
        "Launch directory: /tmp/project/pkg",
      ].join("\n"),
    },
  ]);
  expect(prepared.items).toEqual(session.items as ConversationItem[]);
});
