import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import type { ModelRequest } from "../../src/model/model.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./openai.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./xai.ts";
import { TEXT_STREAM_CHUNKS } from "./openai-compatible.ts";

// Test-only process preload. Every transport is intercepted; unknown requests,
// TUI imports, credential mutation and the wrong billing route fail closed.
const mode = process.env.SCHWAY_DOCS_MODE ?? "protocol";
const route = process.env.SCHWAY_DOCS_ROUTE ?? "openai-api";
const tracePath = process.env.SCHWAY_DOCS_TRACE;
const key = route === "codex" ? "fixture-codex-access" : route === "grok" ? "fixture-grok-access"
  : route === "xai-api" ? "fixture-xai-key" : route === "compatible" ? "fixture-compatible-key" : "fixture-openai-key";
const selectedId = route === "xai-api" || route === "grok" ? "grok-4.7" : route === "compatible" ? "fixture-selected" : "gpt-4.1";
function record(value: object): void { if (tracePath) appendFileSync(tracePath, `${JSON.stringify(value)}\n`); }
function forbid(reason: string): never { throw new Error(`Headless fixture rejected ${reason}`); }

await Bun.plugin({ name: "headless-docs-no-tui", setup(builder) {
  builder.onLoad({ filter: /(?:[/\\]tui[/\\]|@opentui|[/\\]interactive-memory\.ts$)/ }, () => forbid("TUI or interactive memory import"));
} });
const auth = await import("../../src/auth/store.ts");
mock.module("../../src/auth/store.ts", () => ({ ...auth, createNativeCredentialStore: () => ({
  async get(identity: { account: string }) {
    record({ kind: "credential", account: identity.account });
    if (process.argv.includes("doctor") && identity.account === "api-key:anthropic") return null;
    const expected = route === "codex" ? auth.codexSubscriptionIdentity().account
      : route === "grok" ? auth.grokSubscriptionIdentity().account
        : auth.credentialIdentity({ provider: route === "xai-api" ? "xai" : route === "compatible" ? "openai-compatible" : "openai",
          baseUrl: "http://127.0.0.1:11434/v1" }).account;
    if (identity.account !== expected) return forbid("unselected credential read");
    return route === "codex" || route === "grok"
      ? JSON.stringify({ accessToken: key, accountId: "fixture-account", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }) : key;
  }, async set() { return forbid("credential write"); }, async delete() { return forbid("credential deletion"); },
}) }));

if (process.env.SCHWAY_DOCS_FIXED_IDS) {
  let id = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
}

if (mode !== "protocol") {
  if (["unpersisted", "create-failure", "append-failure"].includes(mode)) {
    const sessions = await import("../../src/session/jsonl.ts");
    const createSession = sessions.createJsonlSession;
    mock.module("../../src/session/jsonl.ts", () => ({ ...sessions, createJsonlSession: async (options: Parameters<typeof sessions.createJsonlSession>[0]) => {
      if (mode === "create-failure") throw new Error("Fixture persistence unavailable");
      const session = await createSession({ ...options, ...(mode === "unpersisted" ? { deferred: true } : {}) });
      if (mode === "append-failure") session.append = () => { throw new Error("Fixture append failed"); };
      return session;
    } }));
  }
  mock.module("../../src/model/loader.ts", () => ({ bindGrokModel: (model: unknown) => model, isGrokModel: () => false,
    loadProviderModel: async () => ({ provider: "openai", id: "fixture", async *stream(request: ModelRequest) {
      if (mode === "failure") throw Object.assign(new Error("Fixture authentication failure"), { status: 401 });
      if (mode === "cancel") {
        if (!request.signal) throw new Error("Missing cancellation signal");
        await new Promise<void>(resolve => {
          if (request.signal!.aborted) resolve();
          else request.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("Aborted", "AbortError");
      }
      if ((mode === "tool-failure" || mode === "ask") && !request.items.some(item => item.type === "tool_result")) {
        yield { type: "message_complete" as const, message: { type: "assistant" as const, id: "fixture-tool", content: [{
          type: "tool_call" as const, id: "fixture-call", name: mode === "ask" ? "write" : "read",
          arguments: mode === "ask" ? { path: "must-not-exist", content: "changed" } : { path: "missing-fixture" },
        }] } };
        return;
      }
      yield { type: "text_delta" as const, text: "Fixture answer" };
      yield { type: "message_complete" as const, message: { type: "assistant" as const, id: `fixture-answer-${crypto.randomUUID()}`, content: [{ type: "text" as const, text: "Fixture answer" }] } };
    } }),
  }));
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (mode !== "protocol") return forbid("network in scripted mode");
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.get("authorization") !== `Bearer ${key}`) return forbid("wrong billing credential");
  const endpoint = route === "codex" ? "https://chatgpt.com/backend-api/codex"
    : route === "xai-api" || route === "grok" ? "https://api.x.ai/v1"
      : route === "compatible" ? "http://127.0.0.1:11434/v1" : "https://api.openai.com/v1";
  if (url === endpoint + "/models" || route === "codex" && url.startsWith(endpoint + "/models?")) {
    record({ kind: "catalog", route, url });
    const ids = [route === "xai-api" || route === "grok" ? "grok-3" : route === "compatible" ? "fixture-other" : "gpt-4.0", selectedId];
    return Response.json(route === "codex" ? { models: ids.map(slug => ({ slug, visibility: "list", supported_reasoning_levels: [] })) }
      : { data: ids.map(id => ({ id })) });
  }
  if (url !== endpoint + (route === "compatible" ? "/chat/completions" : "/responses")) return forbid("unknown network endpoint");
  const body = JSON.parse(init?.body ? String(init.body) : input instanceof Request ? await input.clone().text() : "null");
  if (body?.model !== selectedId) return forbid("unadvertised or unchosen model ID");
  record({ kind: "inference", route, url, model: body.model, input: body.input ?? body.messages });
  const data = route === "compatible"
    ? TEXT_STREAM_CHUNKS.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
    : route === "xai-api" || route === "grok" ? encodeXaiSse(XAI_TEXT_EVENTS) : encodeSse(TEXT_STREAM_EVENTS);
  return new Response(data.replaceAll("resp_text", `resp-${crypto.randomUUID()}`).replaceAll("msg_text", `msg-${crypto.randomUUID()}`)
    .replaceAll("chatcmpl-text", `chat-${crypto.randomUUID()}`), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;
