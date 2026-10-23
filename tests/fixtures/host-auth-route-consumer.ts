import { createHost, hostCapabilities } from "schway/host";

function fakeStore() {
  const values = new Map<string, string>();
  return {
    async get(identity: { account: string }) { return values.get(identity.account) ?? null; },
    async set(identity: { account: string; label?: string }, value: string) { values.set(identity.account, value); },
    async delete(identity: { account: string }) { return values.delete(identity.account); },
  };
}

const XAI_EVENTS = [
  { type: "response.created", response: { id: "resp_text", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_text", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 0, delta: " world" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_text", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello world" }] } },
  { type: "response.completed", response: { id: "resp_text", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
];
function encodeXai(events: readonly object[]): string {
  return events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const input = await Bun.stdin.json() as { action: "capabilities" | "codex-route" | "grok-route"; workspaceRoot: string; homeDirectory: string; sessionDirectory: string };
if (input.action === "capabilities") {
  console.log(JSON.stringify(hostCapabilities()));
} else if (input.action === "codex-route") {
  const store = fakeStore();
  await store.set({ account: "codex-subscription:chatgpt", label: "ChatGPT subscription (Codex OAuth)" },
    JSON.stringify({ accessToken: "codex-fixture", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
  const host = await createHost({
    workspaceRoot: input.workspaceRoot, homeDirectory: input.homeDirectory, sessionDirectory: input.sessionDirectory,
    context: { policy: "strict", systemPrompt: "probe", sections: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 1024, maxInputChars: 64 },
    auth: { route: "codex", model: "gpt-5.4", store, fetch: (async () => {
      const body = `data: ${JSON.stringify({ type: "response.created", response: { id: "r", status: "in_progress" } })}\n\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "ok" })}\n\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed" } })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as never },
  } as never);
  const session = await host.createSession();
  const run = await session.submitWithRoute({ text: "probe" });
  await session.close(); await host.close();
  console.log(JSON.stringify({ outcome: run.outcome }));
} else {
  const store = fakeStore();
  await store.set({ account: "grok-subscription:xai", label: "Grok subscription (xAI OAuth)" },
    JSON.stringify({ accessToken: "grok-fixture", refreshToken: "r", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
  const host = await createHost({
    workspaceRoot: input.workspaceRoot, homeDirectory: input.homeDirectory, sessionDirectory: input.sessionDirectory,
    context: { policy: "strict", systemPrompt: "probe", sections: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 1024, maxInputChars: 64 },
    auth: { route: "grok", model: "grok-4.7", store, fetch: (async () => new Response(encodeXai(XAI_EVENTS), { headers: { "Content-Type": "text/event-stream" } })) as never },
  } as never);
  const session = await host.createSession();
  const run = await session.submitWithRoute({ text: "probe" });
  await session.close(); await host.close();
  console.log(JSON.stringify({ outcome: run.outcome }));
}
