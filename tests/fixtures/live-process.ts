import { writeSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import type { FetchLike } from "../../src/model/loader.ts";
import type { CredentialStore } from "../../src/auth/store.ts";
import { runWorker } from "../../src/live/worker.ts";
import { encodeSse, TEXT_STREAM_EVENTS, TOOL_USE_STREAM_EVENTS } from "./openai.ts";

/** Replay selected-route model catalogs and the real sentinel tool round trip without remote requests. */
export function smokeProtocolFixture(options: { catalogMode?: string } = {}): {
  fetch: FetchLike; store: CredentialStore; requests: Array<{ url: string; body?: Record<string, unknown> }>;
} {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const store: CredentialStore = { get: async () => JSON.stringify({ accessToken: "PRIVATE_FIXTURE_TOKEN", obtainedAt: Date.now() }),
    set: async () => {}, delete: async () => false };
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, ...(body ? { body } : {}) });
    const catalog = url.includes("/models");
    if (catalog) {
      if (options.catalogMode === "failure") return Response.json({ error: "PRIVATE_CATALOG_BODY" }, { status: 503 });
      if (options.catalogMode === "oversized") return new Response("x".repeat(256 * 1024 + 1));
      if (options.catalogMode === "hang") return new Promise(() => {});
      const levels = options.catalogMode === "unsupported" ? ["low"] : ["medium"];
      if (url.startsWith("https://chatgpt.com/backend-api/codex/models?")) return Response.json({ models: [{
        slug: options.catalogMode === "missing" ? "other" : "gpt-6-sol", visibility: "list",
        supported_reasoning_levels: levels.map(effort => ({ effort })), default_reasoning_level: "medium",
      }] });
      if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: [{
        id: options.catalogMode === "missing" ? "other" : "meta/muse-spark-1.3-contributor",
        reasoning: { mandatory: true, supported_efforts: options.catalogMode === "unsupported" ? levels : ["max", "xhigh", "high", "medium", "low", "minimal"], default_effort: "medium" },
      }] });
      if (url === "https://api.x.ai/v1/models") return Response.json({ data: [{
        id: options.catalogMode === "missing" ? "grok-other" : "grok-4.7", supported_reasoning_levels: options.catalogMode === "unsupported" ? levels : ["low", "medium", "high", "xhigh"],
      }] });
      throw Error("unexpected catalog route");
    }
    if (!body || !["https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/codex/responses",
      "https://api.x.ai/v1/responses", "https://openrouter.ai/api/v1/chat/completions"].includes(url)) throw Error("unexpected inference route");
    // The marker comes only from the actual read result in round two.
    const marker = JSON.stringify(body.input ?? body.messages).match(/1\|([a-f0-9]{40})/)?.[1];
    if (url.endsWith("/chat/completions")) {
      const delta = marker ? { content: marker } : { tool_calls: [{ index: 0, id: "read1", type: "function", function: {
        name: "read", arguments: '{"path":"smoke-sentinel.txt"}' } }] };
      const chunk = (delta: object, finish_reason: string | null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] });
      return new Response([chunk(delta, null), chunk({}, marker ? "stop" : "tool_calls")]
        .map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    const events = marker
      ? TEXT_STREAM_EVENTS.map(event => ({ ...event, ...("delta" in event ? { delta: event.sequence_number === 2 ? marker : "" } : {}),
        ...("item" in event ? { item: { ...event.item, content: [{ type: "output_text", text: marker, annotations: [] }] } } : {}) }))
      : JSON.parse(JSON.stringify(TOOL_USE_STREAM_EVENTS).replaceAll("note.txt", "smoke-sentinel.txt")) as object[];
    return new Response(encodeSse(events), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, store, requests };
}

// A real OS process that deliberately ignores abort, and optionally leaves a child in its process group.
if (import.meta.main) {
  const path = process.env.SCHWAY_FIXTURE_PID_FILE;
  if (process.argv.includes("grandchild")) {
    if (path) await writeFile(`${path}.descendant`, String(process.pid));
    setInterval(() => {}, 10_000);
  } else {
    let raw = "";
    for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
    const instruction = JSON.parse(raw) as { provider: string; model: string; workspaceRoot: string; thinking?: string };
    if (path) await writeFile(path, String(process.pid));
    const mode = process.env.SCHWAY_FIXTURE_MODE;
    if (mode === "protocol") {
      const fixture = smokeProtocolFixture({ catalogMode: process.env.SCHWAY_FIXTURE_CATALOG_MODE });
      const output = await runWorker(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(raw)); controller.close();
      } }), process.env, { createStore: () => fixture.store, fetch: fixture.fetch });
      if (process.env.SCHWAY_FIXTURE_REQUEST_FILE) await writeFile(process.env.SCHWAY_FIXTURE_REQUEST_FILE, JSON.stringify(fixture.requests));
      process.stdout.write(`${output}\n`);
    } else if (mode === "hang-with-descendant") {
      Bun.spawn([process.execPath, import.meta.path, "grandchild"], { stdout: "ignore", stderr: "ignore" });
      setInterval(() => {}, 10_000);
    } else if (mode === "hang" || mode === "hang-stream") {
      if (mode === "hang-stream") await writeFile(`${instruction.workspaceRoot}/.model-started`, "");
      setInterval(() => {}, 10_000);
    } else if (mode === "deferred-output") {
      Bun.spawn([process.execPath, import.meta.path, "grandchild"], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 100; i++) {
        try { await access(`${path}.descendant`); break; } catch { await Bun.sleep(5); }
      }
      writeSync(1, `${JSON.stringify({ provider: instruction.provider, model: instruction.model, thinking: instruction.thinking, authSource: "env",
        status: "failed_provider", reason: "output_limit", durationMs: 1, toolRoundTrip: false, cleanup: "deferred" })}\n`);
      setInterval(() => {}, 10_000);
    } else if (mode === "oversized") {
      process.stdout.write("PRIVATE_SECRET".repeat(1000));
    } else if (mode === "orphan") {
      Bun.spawn([process.execPath, import.meta.path, "grandchild"], { stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 100; i++) {
        try { await access(`${path}.descendant`); break; } catch { await Bun.sleep(5); }
      }
      writeSync(1, JSON.stringify({ provider: instruction.provider, model: instruction.model, thinking: instruction.thinking,
        authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
      process.exit(0);
    } else if (mode === "fake-timeout") {
      process.stdout.write("timeout\n");
    } else if (mode === "forged") {
      process.stdout.write(JSON.stringify({ provider: instruction.provider, model: "PRIVATE_SECRET", thinking: instruction.thinking,
        authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
    } else {
      process.stdout.write(JSON.stringify({ provider: instruction.provider, model: instruction.model, thinking: instruction.thinking,
        authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
    }
  }
}
