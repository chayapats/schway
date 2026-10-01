import { expect, test } from "bun:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import type { ModelRequest } from "../src/model/model.ts";
import {
  selectOpenAITransport,
  type OpenAIAuthPreference,
} from "../src/auth/credentials.ts";
import {
  codexSubscriptionIdentity,
  credentialIdentity,
  type CredentialStore,
} from "../src/auth/store.ts";
import {
  CODEX_ACCOUNT_CLAIM,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_DEVICE_TIMEOUT_MS,
  CODEX_REDIRECT_URI,
  CODEX_REFRESH_TIMEOUT_MS,
  CODEX_RESPONSES_URL,
  CODEX_SCOPE,
  accountIdFromAccessToken,
  buildCodexAuthorizeUrl,
  clearPendingBrowserAttempt,
  clearSubscriptionTokens,
  codexRequestHeaders,
  createCodexSubscriptionModel,
  createPkceChallenge,
  createSubscriptionTokenRefresher,
  exchangeCodeForTokens,
  extractCodeFromCallbackUrl,
  formatSubscriptionStatus,
  getPendingBrowserAttempt,
  loadSubscriptionTokens,
  loginWithBrowserFlow,
  loginWithDeviceFlow,
  parseSubscriptionTokens,
  pollDeviceAuthorization,
  refreshSubscriptionTokens,
  requestDeviceAuthorization,
  resolveCodexReasoning,
  saveSubscriptionTokens,
  subscriptionAccessExpired,
  toCodexResponsesBody,
  type CodexFetchLike,
} from "../src/model/providers/codex-subscription.ts";
import { createCodexLoginRunner, loadInteractiveModel, subscriptionAuthorizeLauncher } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { parseLoginTarget } from "../src/tui/commands.ts";
import { createSession } from "../src/session/session.ts";
import { createContextManager } from "../src/context/manager.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { executeToolCall } from "../src/tools/executor.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import {
  cliOverridesFromArgs,
  parseArgs,
} from "../src/cli/args.ts";
import {
  parseConfigObject,
  resolveSettings,
} from "../src/config/config.ts";
import { runCli } from "../src/cli/main.ts";

/** Drain a model stream into an array for assertions. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/** Build a minimal Schway request carrying system context, one user item, and tools. */
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
      { name: "read", description: "Read a file", inputSchema: { type: "object" } },
    ],
    ...overrides,
  };
}

/** Mint an unsigned JWT carrying the verified ChatGPT account claim. */
function jwtWithAccount(accountId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ [CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } })}.`;
}

/** Stub the OAuth token endpoint with one JSON payload. */
function tokenEndpoint(
  payload: Record<string, unknown>,
  status = 200,
  seen?: Array<{ url: string; body: string }>,
): CodexFetchLike {
  return async (input, init) => {
    seen?.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Build a streaming Responses body from transport event objects. */
function sseResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const TEXT_EVENTS = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 0, delta: " world" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
  {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  },
];

const TOOL_CALL_EVENTS = [
  { type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "item_1", call_id: "call_read1", name: "read", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '"note.txt"}' },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "item_1", call_id: "call_read1", name: "read", arguments: '{"path":"note.txt"}' },
  },
  { type: "response.completed", response: { id: "resp_tool", status: "completed" } },
];

/** Mixed thinking, tool-call, and text blocks on distinct output indexes. */
const MIXED_EVENTS = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "checking " },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "the file" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", summary: [{ text: "checking the file" }] },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "item_1", call_id: "call_read1", name: "read", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: '"note.txt"}' },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: { type: "function_call", id: "item_1", call_id: "call_read1", name: "read", arguments: '{"path":"note.txt"}' },
  },
  { type: "response.output_item.added", output_index: 2, item: { type: "message" } },
  { type: "response.output_text.delta", output_index: 2, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 2, delta: " world" },
  { type: "response.output_item.done", output_index: 2, item: { type: "message" } },
  {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
  },
];

test("browser authorization URL uses the verified public client, callback, scope, and S256 challenge", () => {
  const fixed = new Uint8Array(48).fill(7);
  const { verifier, challenge, state } = createPkceChallenge(() => fixed.slice(0, 32));
  expect(verifier.length).toBeGreaterThan(0);
  const url = new URL(buildCodexAuthorizeUrl({ challenge, state }));
  expect(`${url.origin}${url.pathname}`).toBe(CODEX_AUTHORIZE_URL);
  expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(CODEX_REDIRECT_URI);
  expect(url.searchParams.get("scope")).toBe(CODEX_SCOPE);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(challenge);
  expect(url.searchParams.get("state")).toBe(state);
});

test("callback code extraction accepts bare codes and full URLs while rejecting mismatched state", () => {
  expect(extractCodeFromCallbackUrl("authcode-123", "s")).toEqual({ code: "authcode-123" });
  const full = `${CODEX_REDIRECT_URI}?code=authcode-123&state=s`;
  expect(extractCodeFromCallbackUrl(full, "s")).toEqual({ code: "authcode-123" });
  expect(extractCodeFromCallbackUrl(full, "other")).toMatchObject({ error: expect.stringContaining("state") });
  expect(extractCodeFromCallbackUrl(`${CODEX_REDIRECT_URI}?error=access_denied`, "s")).toMatchObject({
    error: expect.stringContaining("denied"),
  });
  expect(extractCodeFromCallbackUrl(`${CODEX_REDIRECT_URI}?state=s`, "s")).toMatchObject({
    error: expect.stringContaining("no authorization code"),
  });
  expect(extractCodeFromCallbackUrl("   ", "s")).toMatchObject({ error: expect.any(String) });
});

test("code exchange mints tokens with the billed account decoded from the JWT claim", async () => {
  const accessToken = jwtWithAccount("acct-123");
  const tokens = await exchangeCodeForTokens({
    code: "code-1",
    verifier: "verifier-1",
    fetch: tokenEndpoint({ access_token: accessToken, refresh_token: "refresh-1", expires_in: 3600 }),
  });
  expect(tokens.accessToken).toBe(accessToken);
  expect(tokens.refreshToken).toBe("refresh-1");
  expect(tokens.accountId).toBe("acct-123");
  expect(tokens.expiresAt).toBeGreaterThan(Date.now());
});

test("code exchange maps denial and expiry to distinct actionable errors", async () => {
  await expect(
    exchangeCodeForTokens({
      code: "code-1",
      verifier: "verifier-1",
      fetch: tokenEndpoint({ error: "access_denied" }, 400),
    }),
  ).rejects.toThrow(/denied/i);
  await expect(
    exchangeCodeForTokens({
      code: "code-1",
      verifier: "verifier-1",
      fetch: tokenEndpoint({ error: "invalid_grant" }, 400),
    }),
  ).rejects.toThrow(/expired/i);
});

test("pasted-code browser login persists only the subscription identity with a token-free status", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai" }), "api-key-sentinel");
  const progress: string[] = [];
  const seen: Array<{ url: string; body: string }> = [];
  await expect(
    loginWithBrowserFlow({
      store,
      deps: { openBrowser: () => {}, },
    }),
  ).rejects.toThrow(/callback is unavailable/);
  const pending = getPendingBrowserAttempt();
  expect(pending?.verifier.length).toBeGreaterThan(0);
  expect(pending?.state.length).toBeGreaterThan(0);
  const callbackUrl = `${CODEX_REDIRECT_URI}?code=pasted-code-1&state=${pending?.state}`;
  let openerCalled = false;
  const tokens = await loginWithBrowserFlow({
    store,
    pastedCode: callbackUrl,
    deps: {
      fetch: tokenEndpoint({
        access_token: jwtWithAccount("acct-paste"),
        refresh_token: "refresh-paste",
        expires_in: 3600,
      }, 200, seen),
      openBrowser: () => {
        openerCalled = true;
      },
      waitForCallbackCode: () => {
        throw new Error("must not bind a callback server for pasted codes");
      },
      onProgress: (message) => progress.push(message),
    },
  });
  expect(openerCalled).toBe(false);
  expect(tokens.accountId).toBe("acct-paste");
  expect(seen).toHaveLength(1);
  const body = new URLSearchParams(seen[0]?.body ?? "");
  expect(body.get("code")).toBe("pasted-code-1");
  expect(body.get("code_verifier")).toBe(pending?.verifier ?? "");
  expect(getPendingBrowserAttempt()).toBeUndefined();
  const stored = await loadSubscriptionTokens(store);
  expect(stored?.accessToken).toBe(tokens.accessToken);
  expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("api-key-sentinel");
  expect(JSON.stringify(progress)).not.toContain(tokens.accessToken);
  expect(formatSubscriptionStatus(tokens)).toContain("acct-paste");
  expect(formatSubscriptionStatus(tokens)).not.toContain(tokens.accessToken);
  clearPendingBrowserAttempt();
});

test("browser login denial saves nothing and stays actionable", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  await expect(
    loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } }),
  ).rejects.toThrow(/callback is unavailable/);
  const pending = getPendingBrowserAttempt();
  expect(pending?.state.length).toBeGreaterThan(0);
  const callbackUrl = `${CODEX_REDIRECT_URI}?code=denied-code&state=${pending?.state}`;
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: callbackUrl,
      deps: { fetch: tokenEndpoint({ error: "access_denied" }, 400) },
    }),
  ).rejects.toThrow(/denied/i);
  expect(await loadSubscriptionTokens(store)).toBeNull();
  clearPendingBrowserAttempt();
});

test("browser login cancellation settles without persisting tokens", async () => {
  const store = fakeCredentialStore();
  const controller = new AbortController();
  controller.abort();
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: "late-code",
      signal: controller.signal,
      deps: { fetch: tokenEndpoint({ access_token: "never-used" }) },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await loadSubscriptionTokens(store)).toBeNull();
});

test("browser login times out actionably when the callback never settles", async () => {
  const store = fakeCredentialStore();
  await expect(
    loginWithBrowserFlow({
      store,
      timeoutMs: 20,
      deps: {
        openBrowser: () => {},
        waitForCallbackCode: ({ signal }) =>
          new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
      },
    }),
  ).rejects.toThrow(/timed out/i);
  expect(await loadSubscriptionTokens(store)).toBeNull();
});

test("device flow reports the user code then persists approved tokens", async () => {
  const store = fakeCredentialStore();
  const progress: string[] = [];
  let polls = 0;
  const tokens = await loginWithDeviceFlow({
    store,
    pollIntervalMs: 1,
    deps: {
      fetch: (async (input, _init) => {
        if (String(input).includes("usercode")) {
          return new Response(
            JSON.stringify({
              user_code: "ABCD-1234",
              verification_uri: "https://auth.openai.com/codex/device",
              device_code: "device-1",
              expires_in: 900,
              interval: 1,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        polls += 1;
        if (polls === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: jwtWithAccount("acct-device"),
            refresh_token: "refresh-device",
            expires_in: 3600,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) satisfies CodexFetchLike,
      onProgress: (message) => progress.push(message),
    },
  });
  expect(tokens.accountId).toBe("acct-device");
  expect(progress.some((message) => message.includes("ABCD-1234"))).toBe(true);
  expect(JSON.stringify(progress)).not.toContain(tokens.accessToken);
  expect((await loadSubscriptionTokens(store))?.accessToken).toBe(tokens.accessToken);
});

test("device polling maps denial, expiry, and cancellation distinctly", async () => {
  const denied: CodexFetchLike = async () =>
    new Response(JSON.stringify({ error: "access_denied" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  await expect(pollDeviceAuthorization({ deviceCode: "d", pollIntervalMs: 1, fetch: denied })).rejects.toThrow(
    /denied/i,
  );
  const expired: CodexFetchLike = async () =>
    new Response(JSON.stringify({ error: "expired_token" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  await expect(pollDeviceAuthorization({ deviceCode: "d", pollIntervalMs: 1, fetch: expired })).rejects.toThrow(
    /expired/i,
  );
  const slow: CodexFetchLike = async () =>
    new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  const controller = new AbortController();
  const pending = pollDeviceAuthorization({
    deviceCode: "d",
    pollIntervalMs: 50,
    fetch: slow,
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const immediate: CodexFetchLike = async () =>
    new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  await expect(
    pollDeviceAuthorization({ deviceCode: "d", timeoutMs: 0, pollIntervalMs: 1, fetch: immediate }),
  ).rejects.toThrow(/timed out|900s/);
  expect(CODEX_DEVICE_TIMEOUT_MS).toBe(900_000);
});

test("device authorization request failures stay actionable without leaking transport internals", async () => {
  await expect(
    requestDeviceAuthorization({
      fetch: (async () => {
        throw new Error("socket-sentinel");
      }) satisfies CodexFetchLike,
    }),
  ).rejects.toThrow(/device sign-in failed/);
});

test("stored tokens distinguish missing, expired, revoked, and transient refresh failures", async () => {
  const empty = fakeCredentialStore();
  const refresher = createSubscriptionTokenRefresher({ store: empty });
  await expect(refresher.getValidAccessToken()).rejects.toThrow(/No ChatGPT subscription login/);

  const noRefresh = fakeCredentialStore();
  await saveSubscriptionTokens(noRefresh, { accessToken: "old-token", expiresAt: Date.now() - 1_000 });
  await expect(
    createSubscriptionTokenRefresher({ store: noRefresh }).getValidAccessToken(),
  ).rejects.toThrow(/expired.*no refresh token/i);

  const revokedStore = fakeCredentialStore();
  await saveSubscriptionTokens(revokedStore, {
    accessToken: "old-token",
    refreshToken: "revoked-refresh",
    expiresAt: Date.now() - 1_000,
  });
  await expect(
    createSubscriptionTokenRefresher({
      store: revokedStore,
      fetch: tokenEndpoint({ error: "invalid_grant" }, 400),
    }).getValidAccessToken(),
  ).rejects.toThrow(/revoked/i);

  const flakyStore = fakeCredentialStore();
  await saveSubscriptionTokens(flakyStore, {
    accessToken: "old-token",
    refreshToken: "flaky-refresh",
    expiresAt: Date.now() - 1_000,
  });
  await expect(
    createSubscriptionTokenRefresher({
      store: flakyStore,
      fetch: (async () => {
        throw new Error("socket-down");
      }) satisfies CodexFetchLike,
    }).getValidAccessToken(),
  ).rejects.toThrow(/Refreshing.*failed/i);
});

test("direct refresh maps revocation distinctly from transient failure", async () => {
  await expect(
    refreshSubscriptionTokens({
      refreshToken: "revoked",
      fetch: tokenEndpoint({ error: "invalid_grant" }, 401),
    }),
  ).rejects.toThrow(/revoked/i);
  await expect(
    refreshSubscriptionTokens({
      refreshToken: "flaky",
      fetch: (async () => {
        throw new Error("socket-down");
      }) satisfies CodexFetchLike,
    }),
  ).rejects.toThrow(/Refreshing.*failed/i);
});

test("racing turns share one serialized refresh before expiry", async () => {
  const store = fakeCredentialStore();
  await saveSubscriptionTokens(store, {
    accessToken: "stale-token",
    refreshToken: "shared-refresh",
    expiresAt: Date.now() - 1_000,
  });
  let calls = 0;
  const refresher = createSubscriptionTokenRefresher({
    store,
    fetch: (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({ access_token: "fresh-token", refresh_token: "shared-refresh", expires_in: 3600 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) satisfies CodexFetchLike,
  });
  const [first, second] = await Promise.all([
    refresher.getValidAccessToken(),
    refresher.getValidAccessToken(),
  ]);
  expect(calls).toBe(1);
  expect(first.accessToken).toBe("fresh-token");
  expect(second.accessToken).toBe("fresh-token");
  expect((await loadSubscriptionTokens(store))?.accessToken).toBe("fresh-token");
});

test("valid access tokens skip renewal without touching the transport", async () => {
  const store = fakeCredentialStore();
  await saveSubscriptionTokens(store, {
    accessToken: jwtWithAccount("acct-valid"),
    refreshToken: "refresh-valid",
    expiresAt: Date.now() + 3_600_000,
  });
  let calls = 0;
  const refresher = createSubscriptionTokenRefresher({
    store,
    fetch: (async () => {
      calls += 1;
      throw new Error("must not refresh a valid token");
    }) satisfies CodexFetchLike,
  });
  const credential = await refresher.getValidAccessToken();
  expect(calls).toBe(0);
  expect(credential.accountId).toBe("acct-valid");
});

test("malformed stored payloads fail as revoked rather than crashing", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), "not-json{{{");
  await expect(loadSubscriptionTokens(store)).rejects.toThrow(/revoked/i);
  expect(() => parseSubscriptionTokens(JSON.stringify({}))).toThrow(/revoked/i);
});

test("subscription expiry honors the pre-expiry refresh skew", () => {
  expect(subscriptionAccessExpired({ accessToken: "t", expiresAt: Date.now() + 30_000 })).toBe(true);
  expect(subscriptionAccessExpired({ accessToken: "t", expiresAt: Date.now() + 3_600_000 })).toBe(false);
  expect(subscriptionAccessExpired({ accessToken: "t" })).toBe(false);
  expect(accountIdFromAccessToken("not-a-jwt")).toBeUndefined();
  expect(accountIdFromAccessToken(jwtWithAccount("acct-x"))).toBe("acct-x");
});

test("auto prefers runtime and environment keys while explicit codex never falls back to billing", async () => {
  const subscribed = fakeCredentialStore();
  await saveSubscriptionTokens(subscribed, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  const empty = fakeCredentialStore();

  expect(
    await selectOpenAITransport({ runtimeApiKey: "runtime-key", env: {}, store: subscribed }),
  ).toEqual({ transport: "api-key" });
  expect(
    await selectOpenAITransport({ env: { OPENAI_API_KEY: "env-key" }, store: subscribed }),
  ).toEqual({ transport: "api-key" });
  expect(await selectOpenAITransport({ env: {}, store: subscribed })).toEqual({ transport: "codex" });
  const apiKeyOnly = fakeCredentialStore();
  await apiKeyOnly.set(credentialIdentity({ provider: "openai" }), "stored-api-key");
  expect(await selectOpenAITransport({ env: {}, store: apiKeyOnly })).toEqual({ transport: "api-key" });
  expect(await selectOpenAITransport({ env: {}, store: empty })).toMatchObject({
    error: expect.stringContaining("OPENAI_API_KEY"),
  });
  expect(
    await selectOpenAITransport({ openaiAuth: "codex", env: { OPENAI_API_KEY: "env-key" }, store: subscribed }),
  ).toMatchObject({ transport: "codex", notice: expect.stringContaining("ignores") });
  expect(await selectOpenAITransport({ openaiAuth: "codex", env: {}, store: empty })).toMatchObject({
    error: expect.stringContaining("/login codex"),
  });
  expect(
    await selectOpenAITransport({ openaiAuth: "api-key", env: {}, store: subscribed }),
  ).toEqual({ transport: "api-key" });
  expect(await selectOpenAITransport({ runtimeApiKey: "  ", env: {}, store: empty })).toMatchObject({
    error: expect.stringContaining("empty"),
  });
  expect(
    await selectOpenAITransport({
      openaiAuth: "bogus" as OpenAIAuthPreference,
      env: {},
      store: empty,
    }),
  ).toMatchObject({ error: expect.stringContaining("Unknown OpenAI auth") });
});

test("locked subscription storage fails actionably instead of starting a browser", async () => {
  const locked = {
    async get(): Promise<string | null> {
      throw new Error("native locked");
    },
    async set(): Promise<void> {
      throw new Error("native locked");
    },
    async delete(): Promise<boolean> {
      throw new Error("native locked");
    },
  };
  const resolved = await selectOpenAITransport({ openaiAuth: "codex", env: {}, store: locked });
  expect(JSON.stringify(resolved)).not.toContain("native locked");
  expect(resolved).toMatchObject({ error: expect.stringContaining("secure store") });
});

test("createCodexSubscriptionModel rejects a missing or blank model ID", () => {
  expect(() => createCodexSubscriptionModel({})).toThrow("A model ID is required.");
  expect(() => createCodexSubscriptionModel({ model: " " })).toThrow("A model ID is required.");
});

test("subscription transport explicitly enables streaming to avoid the endpoint's HTTP 400", async () => {
  let requests = 0;
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: jwtWithAccount("acct-stream-required"), expiresAt: Date.now() + 3_600_000 },
    fetch: async (_input, init) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.stream !== true) {
        return Response.json({ detail: "Stream must be set to true" }, { status: 400 });
      }
      return sseResponse(TEXT_EVENTS);
    },
  });
  const events = await collect(model.stream(sampleRequest()));
  expect(requests).toBe(1);
  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
  expect(events.at(-1)?.type).toBe("message_complete");
});

test.each([undefined, 128, 16_384])("subscription requests omit unsupported output limits (configured: %s)", async maxTokens => {
  let requests = 0;
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    maxTokens,
    tokens: { accessToken: jwtWithAccount("acct-output-limit"), expiresAt: Date.now() + 3_600_000 },
    fetch: async (_input, init) => {
      requests++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (Object.hasOwn(body, "max_output_tokens")) {
        return Response.json({ detail: "Unsupported parameter: max_output_tokens" }, { status: 400 });
      }
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("max_completion_tokens");
      return sseResponse(TEXT_EVENTS);
    },
  });
  const events = await collect(model.stream(sampleRequest()));
  expect(requests).toBe(1);
  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
  expect(events.at(-1)?.type).toBe("message_complete");
});

test("subscription transport normalizes text, thinking, tool calls, usage, and opaque metadata", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchStub: CodexFetchLike = async (input, init) => {
    seen.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return sseResponse(MIXED_EVENTS);
  };
  const model = createCodexSubscriptionModel({
    model: "gpt-5.4",
    tokens: { accessToken: jwtWithAccount("acct-stream"), expiresAt: Date.now() + 3_600_000 },
    fetch: fetchStub,
  });
  expect(model.provider).toBe("codex-subscription");
  const events = await collect(model.stream(sampleRequest()));
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe(CODEX_RESPONSES_URL);
  expect(seen[0]?.headers["Authorization"]).toBe(`Bearer ${jwtWithAccount("acct-stream")}`);
  expect(seen[0]?.headers["ChatGPT-Account-Id"]).toBe("acct-stream");
  expect(seen[0]?.body["model"]).toBe("gpt-5.4");
  expect(String(seen[0]?.body["instructions"])).toContain(STABLE_SYSTEM_PROMPT);
  expect(events.filter((event) => event.type === "usage")).toEqual([
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  const deltas = events.filter((event) => event.type !== "message_complete" && event.type !== "usage");
  expect(deltas).toEqual([
    { type: "thinking_delta", text: "checking " },
    { type: "thinking_delta", text: "the file" },
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
  const complete = events.at(-1);
  expect(complete?.type).toBe("message_complete");
  if (complete?.type !== "message_complete") throw new Error("expected message_complete");
  expect(complete.message.content).toEqual([
    { type: "thinking", text: "checking the file", providerMetadata: { codex: { item: expect.anything() } } },
    { type: "tool_call", id: "call_read1", name: "read", arguments: { path: "note.txt" }, providerMetadata: { codex: { item_id: "item_1" } } },
    { type: "text", text: "Hello world" },
  ]);
  const metadata = complete.message.providerMetadata?.["codex"] as Record<string, unknown>;
  expect(metadata["response_id"]).toBe("resp_1");
  expect(metadata["usage"]).toEqual({ input_tokens: 10, output_tokens: 5 });
});

test("subscription transport makes exactly one attempt and maps revocation distinctly", async () => {
  const token = "revoked-token-sentinel";
  let calls = 0;
  const revoked: CodexFetchLike = async () => {
    calls += 1;
    return new Response("revoked detail", { status: 401 });
  };
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: token, expiresAt: Date.now() + 3_600_000 },
    fetch: revoked,
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(/revoked/i);
  expect(calls).toBe(1);

  let transientCalls = 0;
  const transient: CodexFetchLike = async () => {
    transientCalls += 1;
    return new Response("busy", { status: 500 });
  };
  const transientModel = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: token, expiresAt: Date.now() + 3_600_000 },
    fetch: transient,
  });
  await expect(collect(transientModel.stream(sampleRequest()))).rejects.toThrow(/transiently/i);
  expect(transientCalls).toBe(1);
});

test("subscription failures redact token material from thrown errors", async () => {
  const token = "top-secret-subscription-token";
  const leaking: CodexFetchLike = async () => new Response(`boom ${token}`, { status: 500 });
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: token, expiresAt: Date.now() + 3_600_000 },
    fetch: leaking,
  });
  const failure = await collect(model.stream(sampleRequest())).then(
    () => {
      throw new Error("expected stream failure");
    },
    (error: unknown) => error,
  );
  expect(String(failure instanceof Error ? failure.message : failure)).not.toContain(token);
});

test("subscription cancellation aborts the transport without accepting a message", async () => {
  const gate = fakeCredentialStore();
  await saveSubscriptionTokens(gate, {
    accessToken: "cancel-token",
    expiresAt: Date.now() + 3_600_000,
  });
  const hanging: CodexFetchLike = () => new Promise<Response>(() => {});
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra", store: gate, fetch: hanging,
  });
  const controller = new AbortController();
  const iterator = model.stream(sampleRequest({ signal: controller.signal }))[Symbol.asyncIterator]();
  const pending = iterator.next();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("Schway executes the subscription tool call itself and submits its own result", async () => {
  const bodies: unknown[] = [];
  const scripted: CodexFetchLike = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return sseResponse(TOOL_CALL_EVENTS);
    return sseResponse(TEXT_EVENTS);
  }) satisfies CodexFetchLike;
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: "loop-token", expiresAt: Date.now() + 3_600_000 },
    fetch: scripted,
    onRequest: () => {},
  });
  const firstEvents = await collect(model.stream(sampleRequest()));
  const firstComplete = firstEvents.at(-1);
  expect(firstComplete?.type).toBe("message_complete");
  if (firstComplete?.type !== "message_complete") throw new Error("expected message_complete");
  const toolCall = firstComplete.message.content.find((block) => block.type === "tool_call");
  expect(toolCall).toMatchObject({ id: "call_read1", name: "read" });
  if (toolCall?.type !== "tool_call") throw new Error("expected tool_call");

  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "note.txt says hello\n");
    const registry = createToolRegistry([readTool]);
    const executed = await executeToolCall({
      registry,
      workspace: { root: dir, launchCwd: dir, extraRoots: [] },
      call: toolCall,
    });
    expect(executed.status).toBe("success");
    const toolOutput = executed.result.content;
    const followup = await collect(
      model.stream({
        ...sampleRequest(),
        items: [
          ...sampleRequest().items,
          firstComplete.message,
          { type: "tool_result", id: "result-1", toolCallId: "call_read1", content: toolOutput, isError: false },
        ],
      }),
    );
    const secondComplete = followup.at(-1);
    expect(secondComplete?.type).toBe("message_complete");
    if (secondComplete?.type !== "message_complete") throw new Error("expected message_complete");
    expect(secondComplete.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    const secondInput = (bodies[1] as Record<string, unknown>)["input"] as Array<Record<string, unknown>>;
    expect(
      secondInput.some((entry) => entry["type"] === "function_call_output" && entry["call_id"] === "call_read1"),
    ).toBe(true);
  });
});

test("resume across auth switches preserves prior openai metadata and codex round trips", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchStub: CodexFetchLike = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse(TEXT_EVENTS);
  }) satisfies CodexFetchLike;
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: "resume-token", expiresAt: Date.now() + 3_600_000 },
    fetch: fetchStub,
  });
  await collect(
    model.stream(
      sampleRequest({
        items: [
          ...sampleRequest().items,
          {
            type: "assistant",
            id: "asst-prior",
            content: [
              { type: "thinking", text: "prior reasoning", providerMetadata: { openai: { item: { type: "reasoning" } } } },
              {
                type: "tool_call",
                id: "call_old",
                name: "read",
                arguments: { path: "old.txt" },
                providerMetadata: { codex: { item_id: "item_old" } },
              },
            ],
          },
          { type: "tool_result", id: "r-old", toolCallId: "call_old", content: "old output", isError: false },
        ],
      }),
    ),
  );
  const input = bodies[0]?.["input"] as unknown[];
  expect(input).toContainEqual({ type: "reasoning" });
  expect(input).toContainEqual({
    type: "function_call",
    call_id: "call_old",
    name: "read",
    arguments: '{"path":"old.txt"}',
    id: "item_old",
  });
  expect(input).toContainEqual({ type: "function_call_output", call_id: "call_old", output: "old output" });
});

test("logout removes only the subscription identity and keeps API-key storage", async () => {
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai" }), "api-key-sentinel");
  await saveSubscriptionTokens(store, { accessToken: "sub-token", expiresAt: Date.now() + 3_600_000 });
  expect(await clearSubscriptionTokens(store)).toBe(true);
  expect(await loadSubscriptionTokens(store)).toBeNull();
  expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("api-key-sentinel");
  expect(await clearSubscriptionTokens(store)).toBe(false);
});

test("openaiAuth is a validated config preference defaulting to auto", () => {
  const parsed = parseConfigObject({ openaiAuth: "codex" }, "test");
  expect(parsed).toEqual({ openaiAuth: "codex" });
  expect(parseConfigObject({ openaiAuth: "bogus" }, "test")).toMatchObject({ error: expect.any(String) });
  const resolved = resolveSettings({ cli: { provider: "openai" } });
  expect(resolved).toMatchObject({ provider: "openai", openaiAuth: "auto" });
  const explicit = resolveSettings({ cli: { provider: "openai", openaiAuth: "codex" } });
  expect(explicit).toMatchObject({ openaiAuth: "codex" });
});

test("CLI exposes --openai-auth separately from compatible --auth", () => {
  expect(cliOverridesFromArgs({ json: false, help: false, openaiAuth: "codex" })).toEqual({ openaiAuth: "codex" });
  expect(parseArgs(["--openai-auth", "codex"])).toMatchObject({ args: { openaiAuth: "codex" } });
  expect(parseArgs(["--openai-auth=bogus"])).toMatchObject({ error: expect.stringContaining("Unknown OpenAI auth") });
  expect(parseArgs(["--provider", "openai-compatible", "--openai-auth", "codex"])).toMatchObject({
    error: expect.stringContaining("--provider openai"),
  });
});

test("a saved but unverified Codex effort never sends an inference request", async () => {
  let requests = 0;
  const model = createCodexSubscriptionModel({
    model: "gpt-5.4", thinking: "high",
    tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 },
    fetch: async () => { requests++; return sseResponse(TEXT_EVENTS); },
  });
  await expect(async () => {
    for await (const _event of model.stream(sampleRequest())) { /* no request permitted */ }
  }).toThrow(/subscription catalog/);
  expect(requests).toBe(0);
});

test("subscription reasoning requires account-verified levels while leaving defaults untouched when unset", () => {
  const capability = { id: "gpt-5.4", supportedThinking: ["off", "medium"] as const };
  expect(resolveCodexReasoning(undefined, "gpt-5.4")).toBeUndefined();
  expect(() => resolveCodexReasoning("medium", "gpt-5.4")).toThrow(/subscription catalog/);
  expect(() => resolveCodexReasoning("off", "gpt-5.4")).toThrow(/subscription catalog/);
  expect(resolveCodexReasoning("medium", "gpt-5.4", capability)).toEqual({ effort: "medium", summary: "auto" });
  expect(resolveCodexReasoning("off", "gpt-5.4", capability)).toEqual({ effort: "none" });
  expect(() => resolveCodexReasoning("high", "gpt-5.4", capability)).toThrow(/subscription catalog/);
  const body = toCodexResponsesBody(sampleRequest(), "gpt-5.4");
  expect(body["model"]).toBe("gpt-5.4");
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(body["store"]).toBe(false);
  expect(codexRequestHeaders("token-1", "acct-9")).toEqual({
    Authorization: "Bearer token-1",
    "Content-Type": "application/json",
    "ChatGPT-Account-Id": "acct-9",
  });
  expect(codexRequestHeaders("token-1")).toEqual({
    Authorization: "Bearer token-1",
    "Content-Type": "application/json",
  });
});

test("login target parsing routes subscription flags separately from API-key providers", () => {
  expect(parseLoginTarget("openai")).toEqual({ kind: "api-key", provider: "openai" });
  expect(parseLoginTarget("codex")).toEqual({ kind: "codex", device: false });
  expect(parseLoginTarget("codex --device")).toEqual({ kind: "codex", device: true });
  expect(parseLoginTarget("codex --code pasted-123")).toEqual({ kind: "codex", device: false, code: "pasted-123" });
  expect(parseLoginTarget("codex --device --code x")).toMatchObject({ error: expect.any(String) });
  expect(parseLoginTarget("codex --bogus")).toMatchObject({ error: expect.any(String) });
  expect(parseLoginTarget("unknown")).toMatchObject({ error: expect.any(String) });
});

test("interactive subscription login succeeds, denies, and cancels through the controller", async () => {
  await withTempDir(async (root) => {
    clearPendingBrowserAttempt();
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const secrets: string[] = [];
    const seen: Array<{ url: string; body: string }> = [];
    const runner = createCodexLoginRunner({
      store,
      secrets,
      fetch: tokenEndpoint({
        access_token: jwtWithAccount("acct-tui"),
        refresh_token: "refresh-tui",
        expires_in: 3600,
      }, 200, seen),
      openBrowser: () => {
        throw new Error("headless test must use the pasted-code path");
      },
    });
    const scripted = async () => ({ model: createScriptedModel({ text: "ok" }) });
    const session = createSession();
    const controller = new TuiController({
      session,
      sessionId: "codex-login",
      workspace,
      secrets,
      provider: "openai",
      modelId: "gpt-5.4",
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: scripted, codexLogin: runner },
    });
    await expect(
      loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } }),
    ).rejects.toThrow(/callback is unavailable/);
    const pending = getPendingBrowserAttempt();
    expect(pending?.verifier.length).toBeGreaterThan(0);
    const callbackUrl = `${CODEX_REDIRECT_URI}?code=pasted-tui-code&state=${pending?.state}`;
    expect(await controller.login(`codex --code ${callbackUrl}`)).toBe(true);
    expect((await loadSubscriptionTokens(store))?.accountId).toBe("acct-tui");
    expect(seen).toHaveLength(1);
    expect(new URLSearchParams(seen[0]?.body ?? "").get("code_verifier")).toBe(pending?.verifier ?? "");
    const snapshot = JSON.stringify(controller.snapshot());
    expect(snapshot).not.toContain("acct-tui");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("acct-tui");
    expect(snapshot).not.toContain("pasted-tui-code");
    controller.dispose();
    clearPendingBrowserAttempt();
  });

  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const denying = new TuiController({
      session: createSession(),
      sessionId: "codex-denied",
      workspace,
      secrets: [],
      provider: "openai",
      modelId: "gpt-5.4",
      contextManager: createContextManager(workspace),
      credentials: {
        store,
        env: {},
        reload: async () => ({ model: createScriptedModel() }),
        codexLogin: async () => ({ ok: false as const, message: "ChatGPT sign-in was denied." }),
      },
    });
    expect(await denying.login("codex --device")).toBe(false);
    expect(await loadSubscriptionTokens(store)).toBeNull();
    expect(JSON.stringify(denying.snapshot())).toContain("denied");
    denying.dispose();
  });

  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const cancelling = new TuiController({
      session: createSession(),
      sessionId: "codex-cancel",
      workspace,
      secrets: [],
      provider: "openai",
      modelId: "gpt-5.4",
      contextManager: createContextManager(workspace),
      credentials: {
        store,
        env: {},
        reload: async () => ({ model: createScriptedModel() }),
        codexLogin: async ({ signal }) => {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
          throw new Error("unreachable");
        },
      },
    });
    const attempt = cancelling.login("codex");
    cancelling.cancel();
    expect(await attempt).toBe(false);
    expect(await loadSubscriptionTokens(store)).toBeNull();
    expect(JSON.stringify(cancelling.snapshot())).toContain("cancelled");
    cancelling.dispose();
  });
});

test("interactive sign-in chooser offers browser, device, callback and API-key actions", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const methods: string[] = [];
    const controller = new TuiController({
      session: createSession(), sessionId: "login-chooser", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, reload: async () => ({ model: createScriptedModel() }),
        codexLogin: async ({ device }) => {
          methods.push(device ? "device" : "browser");
          return { ok: false, message: "Authorization was denied. Try another method." };
        },
      },
    });
    expect(await controller.login("")).toBe(true);
    expect(controller.snapshot().loginChooser?.rows.filter(row => row.kind === "choice").map(row => row.label)).toEqual(["ChatGPT", "Grok", "OpenAI", "xAI", "OpenAI-compatible"]);
    controller.openLoginMoreOptions();
    expect(controller.snapshot().loginChooser?.rows.map(row => row.label)).toEqual(["Device approval", "Paste browser callback"]);
    expect(await controller.selectLoginChoice()).toBe(false);
    expect(methods).toEqual(["device"]);
    controller.dispose();
  });
});

test("browser opener failure can switch directly to device approval without command syntax", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const calls: string[] = [];
    const controller = new TuiController({
      session: createSession(), sessionId: "opener-fallback", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: async ({ device, signal, onProgress }) => {
          calls.push(device ? "device" : "browser");
          if (device) return { ok: false as const, message: "Device approval denied." };
          onProgress("The browser could not be opened automatically; use the printed URL instead.");
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
          throw new Error("unreachable");
        } },
    });
    try {
      const browser = controller.login("codex");
      await Bun.sleep(0);
      expect(controller.snapshot().loginChooser).toMatchObject({ level: "chatgpt", selectedId: "chatgpt-device" });
      expect(await controller.selectLoginChoice()).toBe(false);
      expect(await browser).toBe(false);
      expect(calls).toEqual(["browser", "device"]);
    } finally { controller.dispose(); }
  });
});

test("controller browser callback saves a credential, discovers account models and activates without inference", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } });
    const values = new Map<string, string>();
    const openStore = (): CredentialStore => ({
      async get(identity) { return values.get(identity.account) ?? null; },
      async set(identity, value) { values.set(identity.account, value); },
      async delete(identity) { return values.delete(identity.account); },
    });
    const store = openStore();
    const secrets: string[] = [];
    let callbackStatus = 0;
    const browserDone = Promise.withResolvers<void>();
    let inferences = 0;
    const runner = createCodexLoginRunner({
      store, secrets,
      fetch: tokenEndpoint({ access_token: jwtWithAccount("acct-browser-journey"), refresh_token: "refresh-journey-secret", expires_in: 3600 }),
      openBrowser: async authorizeUrl => {
        try {
          const state = new URL(authorizeUrl).searchParams.get("state");
          const response = await fetch(`${CODEX_REDIRECT_URI}?code=browser-journey-secret&state=${state}`);
          callbackStatus = response.status;
          await response.text();
        } finally { browserDone.resolve(); }
      },
    });
    const controller = new TuiController({
      session: createSession(), sessionId: "browser-journey", workspace, configEditor: editor,
      provider: "openai", modelId: editor.settings.model,
      model: createScriptedModel({ provider: "openai" }), contextManager: createContextManager(workspace), secrets,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), codexLogin: runner,
        listSubscriptionCatalog: async () => [{ id: "account-model", contextWindow: 100000, supportedThinking: ["low"] }] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model,
        responses: [() => { inferences++; return { text: "unused" }; }] }), contextManager: createContextManager(workspace) }),
    });
    const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, {
      controller, home: join(root, "home"), workspaceRoot: root, env: {}, secrets,
      submit: async () => {}, quit: () => {},
    });
    try {
      const composer = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
      await terminal.mockInput.pasteBracketedText("finish the prepared task\nsecond line");
      composer.cursorOffset = 7;
      expect(controller.openLoginChooser()).toBe(true);
      view.refresh();
      await terminal.flush();
      expect(await controller.selectLoginChoice()).toBe(true);
      await browserDone.promise;
      view.refresh();
      await terminal.flush();
      expect(callbackStatus).toBe(200);
      expect((await loadSubscriptionTokens(openStore()))?.accountId).toBe("acct-browser-journey");
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "account-model" });
      expect(composer.plainText).toBe("finish the prepared task\nsecond line");
      expect(composer.cursorOffset).toBe(7);
      expect(controller.snapshot().transcript.filter(entry => entry.kind === "user")).toHaveLength(0);
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("Approval received");
      expect(text).toContain("Sign-in saved · /model choose model · Ctrl+I details");
      expect(text).not.toContain("acct-browser-journey");
      expect(controller.inspectNoticeDetails()).toBe(true);
      expect(controller.snapshot().transcript.at(-1)?.text).toContain("acct-browser-journey");
      expect(text).toContain("Found 1 model · Activating account-model · Esc cancel");
      expect(text).toContain("ChatGPT model active · Enter send · account-model");
      expect(text).not.toContain("browser-journey-secret");
      expect(text).not.toContain("refresh-journey-secret");
      expect(inferences).toBe(0);
    } finally { view.destroy(); terminal.renderer.destroy(); controller.dispose(); clearPendingBrowserAttempt(); }
  });
});

test("controller reports locked secure-store save after approval without claiming activation or leaking native errors", async () => {
  await withTempDir(async root => {
    clearPendingBrowserAttempt();
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const denied = { ...store, async set() { throw new Error("native-save-secret-sentinel"); } };
    await expect(loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } })).rejects.toThrow(/callback is unavailable/);
    const state = getPendingBrowserAttempt()?.state;
    const controller = new TuiController({
      session: createSession(), sessionId: "locked-save", workspace, provider: "openai", modelId: "gpt-5.4",
      contextManager: createContextManager(workspace), secrets: [],
      credentials: { store: denied, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: createCodexLoginRunner({ store: denied, secrets: [],
          fetch: tokenEndpoint({ access_token: "access-secret-sentinel", refresh_token: "refresh-secret-sentinel" }) }) },
    });
    try {
      expect(await controller.login(`codex --code ${CODEX_REDIRECT_URI}?code=approval-secret-sentinel&state=${state}`)).toBe(false);
      expect(await loadSubscriptionTokens(store)).toBeNull();
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("Cannot save credential");
      expect(text).not.toContain("active for this session");
      expect(text).not.toContain("secret-sentinel");
    } finally { controller.dispose(); clearPendingBrowserAttempt(); }
  });
});

test("controller device approval keeps the user code ephemeral and saves only after polling succeeds", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const presented = Promise.withResolvers<void>();
    const grant = Promise.withResolvers<void>();
    const controller = new TuiController({
      session: createSession(), sessionId: "device-journey", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace), secrets: [],
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }),
        codexLogin: createCodexLoginRunner({ store, secrets: [],
          fetch: async input => {
            if (String(input).includes("usercode")) {
              presented.resolve();
              return Response.json({ user_code: "DEVICE-SECRET-CODE", verification_uri: "https://auth.openai.com/codex/device", device_code: "device-private", interval: 0 });
            }
            await grant.promise;
            return Response.json({ access_token: jwtWithAccount("acct-device-controller"), refresh_token: "refresh-device-private", expires_in: 3600 });
          } }) },
    });
    try {
      const pending = controller.login("codex --device");
      await presented.promise;
      await Bun.sleep(0);
      expect(controller.snapshot().loginApproval).toContain("DEVICE-SECRET-CODE");
      expect(JSON.stringify(controller.snapshot().transcript)).not.toContain("DEVICE-SECRET-CODE");
      expect(await loadSubscriptionTokens(store)).toBeNull();
      grant.resolve();
      expect(await pending).toBe(true);
      expect((await loadSubscriptionTokens(store))?.accountId).toBe("acct-device-controller");
      expect(JSON.stringify(controller.snapshot())).not.toContain("DEVICE-SECRET-CODE");
    } finally { grant.resolve(); controller.dispose(); }
  });
});

test("controller cancels a live device poll before saving and clears the approval code", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const polling = Promise.withResolvers<void>();
    const controller = new TuiController({
      session: createSession(), sessionId: "cancel-device-poll", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: createCodexLoginRunner({ store, secrets: [],
          fetch: async (input, init) => {
            if (String(input).includes("usercode")) {
              return Response.json({ user_code: "CANCEL-CODE", verification_uri: "https://auth.openai.com/codex/device", device_code: "device-private" });
            }
            polling.resolve();
            return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
          } }) },
    });
    try {
      const pending = controller.login("codex --device");
      await polling.promise;
      expect(controller.snapshot().loginApproval).toContain("CANCEL-CODE");
      controller.cancel();
      expect(await pending).toBe(false);
      expect(await loadSubscriptionTokens(store)).toBeNull();
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("Sign-in cancelled; nothing saved · Alt+L retry");
      expect(text).not.toContain("CANCEL-CODE");
    } finally { controller.dispose(); }
  });
});

test("controller replaces native token-exchange exceptions with a redacted recovery action", async () => {
  await withTempDir(async root => {
    clearPendingBrowserAttempt();
    const store = fakeCredentialStore();
    await expect(loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } })).rejects.toThrow(/callback is unavailable/);
    const state = getPendingBrowserAttempt()?.state;
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const controller = new TuiController({
      session: createSession(), sessionId: "native-exception", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: createCodexLoginRunner({ store, secrets: [],
          fetch: async () => { throw new Error("native-network-secret-sentinel"); } }) },
    });
    try {
      expect(await controller.login(`codex --code ${CODEX_REDIRECT_URI}?code=callback-secret-sentinel&state=${state}`)).toBe(false);
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("Check the connection");
      expect(text).not.toContain("secret-sentinel");
      expect(await loadSubscriptionTokens(store)).toBeNull();
    } finally { controller.dispose(); clearPendingBrowserAttempt(); }
  });
});

test("interactive subscription logout removes only the subscription identity", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "openai" }), "api-key-sentinel");
    await saveSubscriptionTokens(store, { accessToken: "sub-token", expiresAt: Date.now() + 3_600_000 });
    const controller = new TuiController({
      session: createSession(),
      sessionId: "codex-logout",
      workspace,
      secrets: [],
      provider: "openai",
      modelId: "gpt-5.4",
      contextManager: createContextManager(workspace),
      credentials: {
        store,
        env: {},
        reload: async () => ({ error: "No ChatGPT subscription login found. Sign in again." }),
      },
    });
    expect(await controller.logout("codex")).toBe(false);
    expect(await loadSubscriptionTokens(store)).toBeNull();
    expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("api-key-sentinel");
    controller.dispose();
  });
});

test("logout blocks an active ChatGPT account while reporting untouched API-key overrides", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await saveSubscriptionTokens(store, { accessToken: "old-account-secret", expiresAt: Date.now() + 3600000 });
    await store.set(credentialIdentity({ provider: "openai" }), "stored-api-key-secret");
    let oldCalls = 0;
    let reloads = 0;
    const controller = new TuiController({
      session: createSession(), sessionId: "logout-active", workspace,
      provider: "openai", modelId: "old-model", openaiAuth: "auto",
      model: createScriptedModel({ provider: "codex-subscription",
        responses: [() => { oldCalls++; return { text: "old response" }; }] }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: { OPENAI_API_KEY: "env-api-key-secret" },
        reload: async () => { reloads++; return { model: createScriptedModel({ provider: "openai" }) }; } },
    });
    try {
      expect(await controller.logout("codex")).toBe(true);
      expect(await loadSubscriptionTokens(store)).toBeNull();
      expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("stored-api-key-secret");
      await controller.submit("do not switch billing");
      expect(oldCalls).toBe(0);
      expect(reloads).toBe(0);
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("OPENAI_API_KEY");
      expect(text).toContain("ChatGPT disconnected · Alt+L reconnect this account");
      expect(text).not.toContain("env-api-key-secret");
    } finally { controller.dispose(); }
  });
});

test("revoked account is repaired through controller login then logout without API-key fallback", async () => {
  await withTempDir(async root => {
    clearPendingBrowserAttempt();
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const repairedAccess = jwtWithAccount("acct-repaired");
    await saveSubscriptionTokens(store, { accessToken: "revoked-access", refreshToken: "revoked-refresh", expiresAt: Date.now() - 1000 });
    let refreshCalls = 0;
    let inferenceCalls = 0;
    const responseFetch: CodexFetchLike = async (input, init) => {
      if (String(input).includes("/oauth/token")) {
        refreshCalls++;
        return Response.json({ error: "invalid_grant" }, { status: 401 });
      }
      inferenceCalls++;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${repairedAccess}`);
      return sseResponse(TEXT_EVENTS);
    };
    const secrets: string[] = [];
    let reloads = 0;
    const controller = new TuiController({
      session: createSession(), sessionId: "repair-revoked", workspace,
      provider: "openai", modelId: "gpt-5.4", openaiAuth: "codex",
      model: createCodexSubscriptionModel({
        model: "gpt-6-astra", store, fetch: responseFetch,
      }),
      contextManager: createContextManager(workspace), secrets,
      credentials: { store, env: { OPENAI_API_KEY: "explicit-env-secret" },
        reload: async () => {
          reloads++;
          return { model: createCodexSubscriptionModel({
            model: "gpt-6-astra", store, fetch: responseFetch,
          }) };
        },
        codexLogin: createCodexLoginRunner({ store, secrets,
          fetch: tokenEndpoint({ access_token: repairedAccess, refresh_token: "new-refresh-secret", expires_in: 3600 }) }) },
    });
    try {
      await controller.submit("before repair");
      expect(refreshCalls).toBe(1);
      expect(inferenceCalls).toBe(0);
      expect(JSON.stringify(controller.snapshot())).toContain("revoked");
      await expect(loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } })).rejects.toThrow(/callback is unavailable/);
      const state = getPendingBrowserAttempt()?.state;
      expect(await controller.login(`codex --code ${CODEX_REDIRECT_URI}?code=repair-secret&state=${state}`)).toBe(true);
      expect((await loadSubscriptionTokens(store))?.accountId).toBe("acct-repaired");
      await controller.submit("after repair");
      expect(inferenceCalls).toBe(1);
      expect(reloads).toBe(1);
      expect(await controller.logout("codex")).toBe(true);
      await controller.submit("after logout");
      expect(inferenceCalls).toBe(1);
      expect(reloads).toBe(1);
      expect(JSON.stringify(controller.snapshot())).toContain("OPENAI_API_KEY");
      expect(JSON.stringify(controller.snapshot())).not.toContain("explicit-env-secret");
    } finally { controller.dispose(); clearPendingBrowserAttempt(); }
  });
});

test("interactive model loading proves the selected transport without starting a browser", async () => {
  const subscribed = fakeCredentialStore();
  await saveSubscriptionTokens(subscribed, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  const captured: unknown[] = [];
  const stub = async (input: {
    apiKey?: string;
    provider: string;
    openaiAuth?: string;
  }) => {
    captured.push(input);
    return createScriptedModel({ text: "ok" });
  };

  await loadInteractiveModel("openai", "gpt-5.4", {
    runtimeApiKey: undefined,
    env: {},
    credentialStore: subscribed,
    secrets: [],
    createModel: stub,
  });
  expect(captured.at(-1)).toMatchObject({ provider: "openai", openaiAuth: "codex" });

  await loadInteractiveModel("openai", "gpt-5.4", {
    runtimeApiKey: "runtime-key",
    env: {},
    credentialStore: subscribed,
    secrets: [],
    createModel: stub,
  });
  expect(captured.at(-1)).toMatchObject({ provider: "openai", apiKey: "runtime-key" });
  expect(captured.at(-1)).not.toMatchObject({ openaiAuth: "codex" });

  await loadInteractiveModel("openai", "gpt-5.4", {
    runtimeApiKey: undefined,
    env: {},
    openaiAuth: "api-key",
    credentialStore: subscribed,
    secrets: [],
    createModel: stub,
  });
  expect(captured.at(-1)).not.toMatchObject({ openaiAuth: "codex" });

  const missing = await loadInteractiveModel("openai", "gpt-5.4", {
    runtimeApiKey: undefined,
    env: {},
    openaiAuth: "codex",
    credentialStore: fakeCredentialStore(),
    secrets: [],
    createModel: stub,
  });
  expect(missing).toMatchObject({ error: expect.stringContaining("/login codex") });
});

test("headless codex selection reaches the loop without a browser and fails actionably when missing", async () => {
  await withTempDir(async (root) => {
    const home = join(root, "home");
    const captured: unknown[] = [];
    const subscribed = fakeCredentialStore();
    await saveSubscriptionTokens(subscribed, {
      accessToken: "headless-token",
      refreshToken: "headless-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["--provider", "openai", "--openai-auth", "codex", "-p", "hi"], {
      stdout: { write: (chunk) => void stdout.push(chunk) },
      stderr: { write: (chunk) => void stderr.push(chunk) },
      env: { HOME: home },
      cwd: root,
      credentialStore: subscribed,
      createModel: (async (input) => {
        captured.push(input);
        return createScriptedModel({ text: "subscription hello" });
      }) as Parameters<typeof runCli>[1]["createModel"],
    });
    expect(exitCode).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ provider: "openai", openaiAuth: "codex" });
    expect(stdout.join("")).toContain("subscription hello");
  });

  await withTempDir(async (root) => {
    const home = join(root, "home");
    const stderr: string[] = [];
    const exitCode = await runCli(["--provider", "openai", "--openai-auth", "codex", "-p", "hi"], {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => void stderr.push(chunk) },
      env: { HOME: home },
      cwd: root,
      credentialStore: fakeCredentialStore(),
      createModel: (async () => createScriptedModel()) as Parameters<typeof runCli>[1]["createModel"],
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("/login codex");
  });
});

test("aborted refresh waiter does not cancel the shared renewal or drop the rotated token", async () => {
  expect(CODEX_REFRESH_TIMEOUT_MS).toBe(30_000);
  const store = fakeCredentialStore();
  await saveSubscriptionTokens(store, {
    accessToken: "stale-token",
    refreshToken: "shared-refresh",
    expiresAt: Date.now() - 1_000,
  });
  const refresher = createSubscriptionTokenRefresher({
    store,
    fetch: (async (_input, init) => {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      return new Response(
        JSON.stringify({ access_token: "fresh-token", refresh_token: "rotated-refresh", expires_in: 3600 }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) satisfies CodexFetchLike,
  });
  const firstController = new AbortController();
  const first = refresher.getValidAccessToken(firstController.signal);
  const second = refresher.getValidAccessToken();
  firstController.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  const renewed = await second;
  expect(renewed.accessToken).toBe("fresh-token");
  expect((await loadSubscriptionTokens(store))?.accessToken).toBe("fresh-token");
  expect((await loadSubscriptionTokens(store))?.refreshToken).toBe("rotated-refresh");
});

test("pasted browser code requires the active attempt and rejects expired or missing attempts", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: `${CODEX_REDIRECT_URI}?code=orphan&state=orphan-state`,
      deps: { fetch: tokenEndpoint({ access_token: "never" }) },
    }),
  ).rejects.toThrow(/No active browser sign-in attempt/);
  expect(await loadSubscriptionTokens(store)).toBeNull();

  await expect(
    loginWithBrowserFlow({ store, timeoutMs: 5, deps: { openBrowser: () => {} } }),
  ).rejects.toThrow(/callback is unavailable/);
  const pending = getPendingBrowserAttempt();
  expect(pending?.state.length).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: `${CODEX_REDIRECT_URI}?code=stale&state=${pending?.state}`,
      deps: { fetch: tokenEndpoint({ access_token: "never" }) },
    }),
  ).rejects.toThrow(/expired/);
  expect(getPendingBrowserAttempt()).toBeUndefined();
  expect(await loadSubscriptionTokens(store)).toBeNull();
  clearPendingBrowserAttempt();
});

test("pasted callback with a stale state fails instead of exchanging with the wrong verifier", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  await expect(
    loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } }),
  ).rejects.toThrow(/callback is unavailable/);
  const pending = getPendingBrowserAttempt();
  expect(pending?.state.length).toBeGreaterThan(0);
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: `${CODEX_REDIRECT_URI}?code=code-1&state=wrong-state`,
      deps: { fetch: tokenEndpoint({ access_token: "never" }) },
    }),
  ).rejects.toThrow(/state/);
  expect(await loadSubscriptionTokens(store)).toBeNull();
  clearPendingBrowserAttempt();
});

test("subscription URL launcher keeps OAuth query intact per platform", () => {
  const url = `${CODEX_AUTHORIZE_URL}?client_id=${CODEX_CLIENT_ID}&scope=a%20b&state=x&code_challenge=y`;
  expect(subscriptionAuthorizeLauncher("darwin", url)).toEqual({ command: "open", args: [url] });
  expect(subscriptionAuthorizeLauncher("win32", url)).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", url],
  });
  expect(subscriptionAuthorizeLauncher("linux", url)).toEqual({ command: "xdg-open", args: [url] });
  const windows = subscriptionAuthorizeLauncher("win32", url);
  expect(JSON.stringify(windows)).not.toContain("cmd");
  expect(windows.args.at(-1)).toBe(url);
});

test("explicit codex notice survives interactive model loading and the TUI reload path", async () => {
  const subscribed = fakeCredentialStore();
  await saveSubscriptionTokens(subscribed, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
  const stub = async () => createScriptedModel({ text: "ok" });
  const loaded = await loadInteractiveModel("openai", "gpt-5.4", {
    runtimeApiKey: "runtime-key",
    openaiAuth: "codex",
    env: {},
    credentialStore: subscribed,
    secrets: [],
    createModel: stub,
  });
  expect(loaded).toMatchObject({ notice: expect.stringContaining("ignores") });
  if ("error" in loaded) throw new Error("expected codex model with notice");
  expect(loaded.model).toBeDefined();

  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const reloadStore = fakeCredentialStore();
    await saveSubscriptionTokens(reloadStore, {
      accessToken: "sub-token",
      refreshToken: "sub-refresh",
      expiresAt: Date.now() + 3_600_000,
    });
    const controller = new TuiController({
      session: createSession(),
      sessionId: "codex-notice",
      workspace,
      secrets: [],
      provider: "openai",
      modelId: "gpt-5.4",
      contextManager: createContextManager(workspace),
      credentials: {
        store: reloadStore,
        env: {},
        reload: async () => ({ model: createScriptedModel({ text: "ok" }), notice: "Explicit codex selection ignores the runtime/environment API key; subscription billing applies." }),
      },
    });
    expect(await controller.logout("codex")).toBe(true);
    expect(JSON.stringify(controller.snapshot())).toContain("ignores");
    controller.dispose();
  });
});

test("shared refresh timeout fails actionably with cause while per-caller abort still cancels only that waiter", async () => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (() => originalTimeout(15)) as unknown as typeof AbortSignal.timeout;
  try {
    const store = fakeCredentialStore();
    await saveSubscriptionTokens(store, {
      accessToken: "stale-token",
      refreshToken: "shared-refresh",
      expiresAt: Date.now() - 1_000,
    });
    const refresher = createSubscriptionTokenRefresher({
      store,
      fetch: (async (_input, init) => {
        await new Promise<void>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error("unreachable: refresh fetch must hang until the shared timeout aborts it");
      }) satisfies CodexFetchLike,
    });
    const firstController = new AbortController();
    const first = refresher.getValidAccessToken(firstController.signal);
    const second = refresher.getValidAccessToken();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const failure = await second.then(
      () => {
        throw new Error("expected shared refresh timeout");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected Error");
    expect(failure.name).not.toBe("AbortError");
    expect(failure.message).toMatch(/Refreshing.*timed out after/);
    expect(failure.message).toContain(`${Math.round(CODEX_REFRESH_TIMEOUT_MS / 1000)}s`);
    expect(failure.cause).toBeDefined();
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("cancelled browser wait preserves the pending attempt for --code paste recovery", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  const controller = new AbortController();
  const attempt = loginWithBrowserFlow({
    store,
    signal: controller.signal,
    deps: {
      openBrowser: () => {},
      fetch: tokenEndpoint({ access_token: "never" }),
      waitForCallbackCode: ({ signal }) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    },
  });
  controller.abort();
  await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
  const preserved = getPendingBrowserAttempt();
  expect(preserved?.state.length).toBeGreaterThan(0);
  const callbackUrl = `${CODEX_REDIRECT_URI}?code=recovered-code&state=${preserved?.state}`;
  const tokens = await loginWithBrowserFlow({
    store,
    pastedCode: callbackUrl,
    deps: {
      fetch: tokenEndpoint({ access_token: jwtWithAccount("acct-recovered"), refresh_token: "refresh-recovered", expires_in: 3600 }),
    },
  });
  expect(tokens.accountId).toBe("acct-recovered");
  expect(getPendingBrowserAttempt()).toBeUndefined();
  expect((await loadSubscriptionTokens(store))?.accessToken).toBe(tokens.accessToken);
  clearPendingBrowserAttempt();
});

test("timed-out browser wait preserves the pending attempt and reports the --code recovery path", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  const failure = await loginWithBrowserFlow({
    store,
    timeoutMs: 20,
    deps: {
      openBrowser: () => {},
      waitForCallbackCode: ({ signal }) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    },
  }).then(
    () => {
      throw new Error("expected browser callback timeout");
    },
    (error: unknown) => error,
  );
  expect(String(failure instanceof Error ? failure.message : failure)).toContain("--code");
  expect(getPendingBrowserAttempt()?.state.length).toBeGreaterThan(0);
  expect(await loadSubscriptionTokens(store)).toBeNull();
  clearPendingBrowserAttempt();
});

test("mismatched pasted state preserves the attempt while matching state clears it", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  await expect(loginWithBrowserFlow({ store, deps: { openBrowser: () => {} } })).rejects.toThrow(/callback is unavailable/);
  const pending = getPendingBrowserAttempt();
  expect(pending?.state.length).toBeGreaterThan(0);
  await expect(
    loginWithBrowserFlow({
      store,
      pastedCode: `${CODEX_REDIRECT_URI}?code=code-1&state=wrong-state`,
      deps: { fetch: tokenEndpoint({ access_token: "never" }) },
    }),
  ).rejects.toThrow(/state/);
  expect(getPendingBrowserAttempt()?.state).toBe(pending?.state);
  expect(await loadSubscriptionTokens(store)).toBeNull();
  const tokens = await loginWithBrowserFlow({
    store,
    pastedCode: `${CODEX_REDIRECT_URI}?code=code-1&state=${pending?.state}`,
    deps: {
      fetch: tokenEndpoint({ access_token: jwtWithAccount("acct-match"), refresh_token: "refresh-match", expires_in: 3600 }),
    },
  });
  expect(tokens.accountId).toBe("acct-match");
  expect(getPendingBrowserAttempt()).toBeUndefined();
  clearPendingBrowserAttempt();
});

test("successful browser callback clears only the owning attempt", async () => {
  clearPendingBrowserAttempt();
  const store = fakeCredentialStore();
  const tokens = await loginWithBrowserFlow({
    store,
    deps: {
      openBrowser: () => {},
      waitForCallbackCode: async () => "callback-code-1",
      fetch: tokenEndpoint({ access_token: jwtWithAccount("acct-callback"), refresh_token: "refresh-callback", expires_in: 3600 }),
    },
  });
  expect(tokens.accountId).toBe("acct-callback");
  expect(getPendingBrowserAttempt()).toBeUndefined();
  clearPendingBrowserAttempt();
});
