import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalCli } from "../src/eval/cli.ts";
import { resolveEvalSettings, type CodingEvalResult } from "../src/eval/coding.ts";
import { withTempDir } from "./helpers.ts";
import type { CredentialStore } from "../src/auth/store.ts";
import type { FetchLike } from "../src/model/loader.ts";
import { encodeSse, TEXT_STREAM_EVENTS, TOOL_USE_STREAM_EVENTS } from "./fixtures/openai.ts";

test("thinking settings preserve omission and explicit off and reject invalid values", () => {
  expect(resolveEvalSettings()).not.toHaveProperty("thinking");
  expect(resolveEvalSettings({ thinking: "off" })).toHaveProperty("thinking", "off");
  expect(() => resolveEvalSettings({ thinking: "bogus" as "off" })).toThrow();
});

test("unsupported thinking records safe skips for every matrix case without inference", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "thinking.json");
    let calls = 0;
    expect(await runEvalCli(["--matrix", "openai:gpt-6-luna,openai:gpt-6-luna", "--allow-paid", "--thinking", "minimal", "--case", "all", "--input-price", "1", "--output-price", "1", "--output", output],
      { OPENAI_API_KEY: "PRIVATE_SECRET" }, { fetch: async () => { calls++; throw Error("PRIVATE_SECRET"); }, model: () => { calls++; throw Error("unexpected model"); } })).toBe(1);
    const text = await readFile(output, "utf8");
    const artifact = JSON.parse(text);
    expect(artifact.settings.thinking).toBe("minimal");
    expect(artifact.results).toHaveLength(14);
    for (const result of artifact.results) expect(result).toMatchObject({ settings: { thinking: "minimal" }, outcome: "skipped_prerequisites", reason: "unsupported_thinking", spendUsd: 0, spendExact: true });
    expect(artifact.spend.casesRun).toBe(0);
    expect(calls).toBe(0);
    expect(text).not.toContain("PRIVATE_SECRET");
  });
});


/** Replay real Responses turns and route-specific catalogs without opening a network connection. */
function protocolFixture(options: { catalog?: "failure" | "missing" | "unsupported"; refresh?: boolean } = {}) {
  const requests: Array<{ url: string; body?: Record<string, unknown> & { model?: string; reasoning?: { effort?: string } }; authorization: string | null }> = [];
  let raw = JSON.stringify({ accessToken: "PRIVATE_TOKEN", refreshToken: "PRIVATE_REFRESH", obtainedAt: 1 });
  const store: CredentialStore = { get: async () => raw, set: async (_identity, value) => { raw = value; }, delete: async () => false };
  let turns = 0, refreshed = false;
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body && String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url, body, authorization });
    if (url.endsWith("/token")) {
      refreshed = true;
      return Response.json({ access_token: "PRIVATE_RENEWED", expires_in: 3600 });
    }
    if (url.includes("/models")) {
      if (options.catalog === "failure") return Response.json({ error: "PRIVATE_CATALOG" }, { status: 503 });
      const levels = options.catalog === "unsupported" ? ["low"] : ["medium", "high"];
      if (url.startsWith("https://chatgpt.com/backend-api/codex/models?")) return Response.json({ models: [{
        slug: options.catalog === "missing" ? "other" : "gpt-6.1-sol", visibility: "list",
        supported_reasoning_levels: levels.map(effort => ({ effort })), default_reasoning_level: "medium",
      }] });
      expect(url).toBe("https://api.x.ai/v1/models");
      return Response.json({ data: [{ id: options.catalog === "missing" ? "grok-other" : "grok-4.7", supported_reasoning_levels: levels }] });
    }
    expect(["https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/codex/responses", "https://api.x.ai/v1/responses"]).toContain(url);
    if (options.refresh && turns === 1 && !refreshed) return Response.json({ error: "expired" }, { status: 401 });
    const events = turns++ % 2 === 0 ? JSON.parse(JSON.stringify(TOOL_USE_STREAM_EVENTS).replaceAll("note.txt", "src/math.ts")) : TEXT_STREAM_EVENTS;
    return new Response(encodeSse(events), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, store, requests };
}

for (const [provider, model, thinking, endpoint] of [
  ["openai", "gpt-6-luna", "high", "https://api.openai.com/v1/responses"],
  ["codex", "gpt-6.1-sol", "medium", "https://chatgpt.com/backend-api/codex/responses"],
  ["xai", "grok-4.7", "medium", "https://api.x.ai/v1/responses"],
  ["grok", "grok-4.7", "medium", "https://api.x.ai/v1/responses"],
]) {
  for (const explicit of [true, false]) test(`${provider} sends ${explicit ? thinking : "omitted defaults"} through both real inference turns`, async () => {
    await withTempDir(async dir => {
      const fixture = protocolFixture();
      const output = join(dir, "wire.json");
      const code = await runEvalCli(["--provider", provider!, "--model", model!, "--allow-paid", "--input-price", "0", "--output-price", "0", "--output", output,
        ...(explicit ? ["--thinking", thinking!] : [])], { OPENAI_API_KEY: "PRIVATE_API", XAI_API_KEY: "PRIVATE_API" },
        { fetch: fixture.fetch, createStore: () => fixture.store });
      expect(code).toBe(1); // The protocol reads the source but deliberately does not solve the coding task.
      const inference = fixture.requests.filter(request => request.body?.model);
      expect(inference).toHaveLength(2);
      for (const request of inference) {
        expect(request.url).toBe(endpoint!);
        expect(request.body!.model).toBe(model!);
        expect(request.body!.reasoning?.effort).toBe(explicit ? thinking : undefined);
        expect(request.authorization).toBe(`Bearer ${provider === "codex" || provider === "grok" ? "PRIVATE_TOKEN" : "PRIVATE_API"}`);
      }
      expect(JSON.stringify(inference[1]!.body)).toContain("function_call_output");
      expect(fixture.requests.filter(request => request.url.includes("/models"))).toHaveLength(explicit && provider !== "openai" ? 1 : 0);
      const text = await readFile(output, "utf8");
      const artifact = JSON.parse(text);
      expect(artifact.outcome).toBe("grader_failure");
      expect(artifact.settings.thinking).toBe(explicit ? thinking : undefined);
      expect(artifact.billing).toBe(provider === "codex" || provider === "grok" ? "subscription" : "usage");
      expect(text).not.toContain("PRIVATE_");
    });
  });
}

for (const catalog of ["failure", "missing", "unsupported"] as const) test(`matrix caches ${catalog} capability evidence per entry and makes zero inference requests`, async () => {
  await withTempDir(async dir => {
    const fixture = protocolFixture({ catalog });
    const output = join(dir, "matrix.json");
    expect(await runEvalCli(["--matrix", "codex:gpt-6.1-sol,grok:grok-4.7,xai:grok-4.7", "--case", "all", "--thinking", "medium", "--allow-paid", "--input-price", "1", "--output-price", "1", "--output", output],
      { XAI_API_KEY: "PRIVATE_API" }, { fetch: fixture.fetch, createStore: () => fixture.store })).toBe(1);
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests.every(request => request.url.includes("/models"))).toBe(true);
    const text = await readFile(output, "utf8");
    const artifact = JSON.parse(text);
    expect(artifact.results).toHaveLength(21);
    for (const result of artifact.results) {
      expect(result).toMatchObject({ settings: { thinking: "medium" }, outcome: "skipped_prerequisites", reason: catalog === "failure" ? "thinking_capability_unavailable" : "unsupported_thinking", spendUsd: 0, spendExact: true });
      expect(result.nextAction).toContain("--thinking");
    }
    expect(artifact.spend).toMatchObject({ casesRun: 0, totalUsd: 0, exact: true, stopReason: null });
    expect(text).not.toContain("PRIVATE_");
  });
});

test("successful capability discovery is cached across cases while subscription adapters still refresh", async () => {
  await withTempDir(async dir => {
    const fixture = protocolFixture({ refresh: true });
    const output = join(dir, "matrix.json");
    expect(await runEvalCli(["--matrix", "grok:grok-4.7", "--case", "all", "--thinking", "medium", "--allow-paid", "--max-turns", "2", "--output", output], {},
      { fetch: fixture.fetch, createStore: () => fixture.store })).toBe(1);
    expect(fixture.requests.filter(request => request.url.includes("/models"))).toHaveLength(1);
    expect(fixture.requests.filter(request => request.url.endsWith("/token"))).toHaveLength(1);
    const inference = fixture.requests.filter(request => request.body?.model);
    expect(inference.length).toBeGreaterThanOrEqual(14);
    expect(inference.every(request => request.body!.reasoning?.effort === "medium")).toBe(true);
    expect(inference.at(-1)!.authorization).toBe("Bearer PRIVATE_RENEWED");
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(artifact.spend.casesRun).toBe(7);
    expect(artifact.results.every((result: CodingEvalResult) => result.settings.thinking === "medium" && result.billing === "subscription")).toBe(true);
  });
});

test("invalid CLI thinking rejects before credentials, discovery or artifact reservation", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "invalid.json");
    expect(await runEvalCli(["--provider", "codex", "--model", "fixture", "--allow-paid", "--thinking", "bogus", "--output", output], {},
      { createStore: () => { throw Error("must not read credentials"); } })).toBe(2);
    expect(await Bun.file(output).exists()).toBe(false);
  });
});

test("missing credentials retain requested thinking and generic compatible endpoints refuse explicit effort", async () => {
  await withTempDir(async dir => {
    for (const key of [undefined, "PRIVATE_API"]) {
      const output = join(dir, key ? "unsupported.json" : "missing.json");
      expect(await runEvalCli(["--provider", "openai-compatible", "--model", "fixture", "--base-url", "https://fixture.invalid/v1", "--thinking", "medium", "--allow-paid", "--input-price", "1", "--output-price", "1", "--output", output],
        { OPENAI_COMPATIBLE_API_KEY: key }, { fetch: async () => { throw Error("must not infer"); } })).toBe(1);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ outcome: "skipped_prerequisites", settings: { thinking: "medium" }, ...(key ? { reason: "unsupported_thinking" } : {}) });
    }
  });
});

test("explicit off reaches the OpenAI wire and remains distinct in artifacts", async () => {
  await withTempDir(async dir => {
    const fixture = protocolFixture();
    const output = join(dir, "off.json");
    expect(await runEvalCli(["--provider", "openai", "--model", "gpt-6-luna", "--thinking", "off", "--allow-paid", "--input-price", "0", "--output-price", "0", "--output", output],
      { OPENAI_API_KEY: "PRIVATE_API" }, { fetch: fixture.fetch })).toBe(1);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every(request => request.body?.reasoning?.effort === "none")).toBe(true);
    expect(JSON.parse(await readFile(output, "utf8")).settings.thinking).toBe("off");
  });
});

test("thinking survives spend-cap skips and artifact reservation precedes discovery", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "spend.json");
    const fixture = protocolFixture();
    expect(await runEvalCli(["--provider", "openai", "--model", "gpt-6-luna", "--thinking", "high", "--case", "all", "--allow-paid", "--input-price", "1", "--output-price", "1", "--output", output],
      { OPENAI_API_KEY: "PRIVATE_API" }, { fetch: fixture.fetch })).toBe(3);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(artifact.summary.skipped_spend_cap).toBe(6);
    expect(artifact.results.every((result: CodingEvalResult) => result.settings.thinking === "high")).toBe(true);
    expect(fixture.requests).toHaveLength(2);
    let calls = 0;
    expect(await runEvalCli(["--provider", "grok", "--model", "grok-4.7", "--thinking", "medium", "--allow-paid", "--output", output], {},
      { createStore: () => { calls++; return fixture.store; }, fetch: async () => { calls++; throw Error("must not discover"); } })).toBe(2);
    expect(calls).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(artifact);
  });
});
