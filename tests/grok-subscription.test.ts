import { beforeAll, afterAll, expect, test } from "bun:test";
import { GROK_CLIENT_ID, GROK_SCOPE, GROK_REFERRER, GROK_TOKEN_URL, GROK_DEVICE_AUTHORIZATION_URL, createBrowserAttempt, createAuthorizeUrl, exchangeCodeForTokens, refreshSubscriptionTokens, parseSubscriptionTokens, subscriptionAccessExpired, requestDeviceAuthorization, pollDeviceAuthorization, loginWithDeviceFlow, type GrokFetch } from "../src/model/providers/grok-subscription.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const grant = { deviceCode: "private-device", userCode: "ABCD-EFGH", verificationUri: "https://x.ai/device", expiresIn: 900, interval: 5 };
test("Grok authorize parameters contain only exact scopes and fresh PKCE state and nonce", () => {
  const attempt = createBrowserAttempt(), other = createBrowserAttempt();
  const url = new URL(createAuthorizeUrl(attempt, "http://127.0.0.1:1234/callback"));
  expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: "code", client_id: GROK_CLIENT_ID, redirect_uri: "http://127.0.0.1:1234/callback", scope: GROK_SCOPE, code_challenge: attempt.challenge, code_challenge_method: "S256", state: attempt.state, nonce: attempt.nonce, referrer: GROK_REFERRER });
  expect(attempt.state).not.toBe(other.state); expect(attempt.nonce).not.toBe(other.nonce); expect(attempt.verifier.length).toBeGreaterThanOrEqual(43);
});
test("code exchange and refresh use form bodies and token expiry falls back through JWT and unknown", async () => {
  const captured: { url: string; body: Record<string, string> }[] = [];
  const fetch: GrokFetch = async (url, init) => {
    expect(init!.method).toBe("POST"); expect(new Headers(init!.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    captured.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init!.body))) });
    return json({ access_token: "fixture", refresh_token: "rotated", expires_in: 3600 });
  };
  expect((await exchangeCodeForTokens({ code: "code", verifier: "verifier", redirectUri: "http://127.0.0.1:4321/callback", fetch, now: () => 1000 })).expiresAt).toBe(3_601_000);
  await refreshSubscriptionTokens({ refreshToken: "old", fetch });
  expect(captured).toEqual([{ url: GROK_TOKEN_URL, body: { client_id: GROK_CLIENT_ID, grant_type: "authorization_code", code: "code", code_verifier: "verifier", redirect_uri: "http://127.0.0.1:4321/callback", referrer: "schway" } }, { url: GROK_TOKEN_URL, body: { client_id: GROK_CLIENT_ID, grant_type: "refresh_token", refresh_token: "old", referrer: "schway" } }]);
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 1234 })).toString("base64url")}.sig`;
  const exchange = (access: string) => exchangeCodeForTokens({ code: "code", verifier: "v", redirectUri: "http://127.0.0.1/callback", fetch: async () => json({ access_token: access }) });
  expect((await exchange(token)).expiresAt).toBe(1_234_000); expect((await exchange("opaque")).expiresAt).toBeUndefined();
});
test("stored parsing and 120-second skew never echo malformed secrets", () => {
  const tokens = parseSubscriptionTokens(JSON.stringify({ accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 130_000, obtainedAt: 1 }));
  expect(subscriptionAccessExpired(tokens, 9999)).toBe(false); expect(subscriptionAccessExpired(tokens, 10_000)).toBe(true);
  for (const bad of ["private-access", JSON.stringify({ accessToken: "private-access", obtainedAt: "invalid" })]) {
    try { parseSubscriptionTokens(bad); throw Error("expected rejection"); } catch (error) { expect(String(error)).not.toContain("private-access"); }
  }
});
test("refresh revoked statuses and transient failures redact response and thrown secrets", async () => {
  for (const status of [400, 401, 403, 500]) {
    try { await refreshSubscriptionTokens({ refreshToken: "private-refresh", fetch: async () => json({ error: "private-refresh private-access" }, status) }); throw Error("expected rejection"); }
    catch (error) { expect(String(error)).toContain(status === 500 ? "Refreshing the Grok subscription session failed (HTTP 500)" : "session was revoked"); expect(String(error)).not.toContain("private-refresh"); expect(String(error)).not.toContain("private-access"); }
  }
  await expect(refreshSubscriptionTokens({ refreshToken: "private-refresh", fetch: async () => { throw Error("private-refresh"); } })).rejects.toThrow("connection failed");
});
test("device authorization posts restricted scopes and rejects insecure verification URI", async () => {
  const fetch: GrokFetch = async (url, init) => {
    expect(String(url)).toBe(GROK_DEVICE_AUTHORIZATION_URL);
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ client_id: GROK_CLIENT_ID, scope: GROK_SCOPE, referrer: "schway" });
    return json({ device_code: grant.deviceCode, user_code: grant.userCode, verification_uri: grant.verificationUri });
  };
  expect(await requestDeviceAuthorization({ fetch })).toEqual(grant);
  await expect(requestDeviceAuthorization({ fetch: async () => json({ device_code: "d", user_code: "u", verification_uri: "http://x.ai/device" }) })).rejects.toThrow("HTTPS");
});
test("device polling waits intervals, adds slow-down, and uses the standard form grant", async () => {
  let now = 0, calls = 0; const waits: number[] = [];
  const tokens = await pollDeviceAuthorization({ ...grant, now: () => now, sleep: async ms => { waits.push(ms); now += ms; }, fetch: async (url, init) => {
    expect(String(url)).toBe(GROK_TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ client_id: GROK_CLIENT_ID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.deviceCode, referrer: "schway" });
    calls++; return calls === 1 ? json({ error: "authorization_pending" }, 400) : calls === 2 ? json({ error: "slow_down" }, 400) : json({ access_token: "approved" });
  } });
  expect(waits).toEqual([5000, 5000, 10_000]); expect(tokens.accessToken).toBe("approved");
});
test("device denial, expiry, deadline and Esc have distinct outcomes without saving", async () => {
  for (const reason of ["access_denied", "expired_token", "deadline", "abort"]) {
    let now = 0; const abort = new AbortController();
    const task = pollDeviceAuthorization({ ...grant, expiresIn: 8, signal: abort.signal, now: () => now, sleep: async ms => { now += ms; if (reason === "abort") abort.abort(); }, fetch: async () => json({ error: reason === "deadline" ? "authorization_pending" : reason }, 400) });
    await expect(task).rejects.toThrow(reason === "access_denied" ? "denied" : reason === "expired_token" ? "code expired" : reason === "deadline" ? "timed out" : "Aborted");
  }
  let saved = 0, now = 0; const abort = new AbortController(), notices: string[] = [], panels: unknown[] = [];
  await expect(loginWithDeviceFlow({ signal: abort.signal, deps: { now: () => now, sleep: async ms => { now += ms; abort.abort(); }, fetch: async () => json({ device_code: grant.deviceCode, user_code: grant.userCode, verification_uri: grant.verificationUri }), saveTokens: async () => { saved++; }, onProgress: message => notices.push(message), onApproval: approval => panels.push(approval) } })).rejects.toThrow("Aborted");
  expect(saved).toBe(0); expect(notices).toEqual([]); expect(panels).toEqual([{ kind: "device", verificationUri: grant.verificationUri, userCode: grant.userCode }]);
});

test("single-flight refresh persists rotated tokens and missing rotation retains the old token", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens, loadSubscriptionTokens, createSubscriptionTokenRefresher } = await import("../src/model/providers/grok-subscription.ts");
  const store = fakeCredentialStore(); let calls = 0;
  await saveSubscriptionTokens(store, { accessToken: "old", refreshToken: "refresh-old", expiresAt: 1000, obtainedAt: 0 });
  const refresher = createSubscriptionTokenRefresher({ store, now: () => 1000, fetch: async () => { calls++; await Bun.sleep(5); return json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }); } });
  expect(await Promise.all([refresher.getValidAccessToken(), refresher.getValidAccessToken()])).toEqual(["new", "new"]);
  expect(calls).toBe(1); expect((await loadSubscriptionTokens(store))!.refreshToken).toBe("rotated");
  const noRotation = createSubscriptionTokenRefresher({ store, fetch: async () => json({ access_token: "newer" }) });
  await noRotation.getValidAccessToken(undefined, "new"); expect((await loadSubscriptionTokens(store))!.refreshToken).toBe("rotated");
});
test("Grok models refresh once on 401, filter chat models, and map plan or revoked errors", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens, fetchSubscriptionModels } = await import("../src/model/providers/grok-subscription.ts");
  for (const finalStatus of [200, 401, 403]) {
    const store = fakeCredentialStore(); await saveSubscriptionTokens(store, { accessToken: "old", refreshToken: "refresh", obtainedAt: 0 });
    const seen: string[] = []; let refreshes = 0;
    const task = fetchSubscriptionModels({ store, fetch: async (url, init) => {
      if (String(url) === GROK_TOKEN_URL) { refreshes++; return json({ access_token: "renewed" }); }
      expect(String(url)).toBe("https://api.x.ai/v1/models"); seen.push(new Headers(init!.headers).get("Authorization")!);
      return seen.length === 1 ? json({}, 401) : json({ data: [{ id: "grok-4.7" }, { id: "grok-imagine-image" }] }, finalStatus);
    } });
    if (finalStatus === 200) expect((await task).map(model => model.id)).toEqual(["grok-4.7"]);
    else await expect(task).rejects.toThrow(finalStatus === 401 ? "session was revoked" : "Your Grok plan doesn't include API access");
    expect(refreshes).toBe(1); expect(seen).toEqual(["Bearer old", "Bearer renewed"]);
  }
});
test("Grok Responses resends the identical body once with refreshed OAuth credentials and never billing keys", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens } = await import("../src/model/providers/grok-subscription.ts");
  const { credentialIdentity } = await import("../src/auth/store.ts");
  const { selectXaiTransport } = await import("../src/auth/credentials.ts");
  const { loadProviderModel } = await import("../src/model/loader.ts");
  const { sampleRequest } = await import("./fixtures/openai.ts");
  const { collect } = await import("./helpers/scripted-model.ts");
  const { encodeXaiSse, XAI_TEXT_EVENTS } = await import("./fixtures/xai.ts");
  for (const finalStatus of [200, 401, 403]) {
    const store = fakeCredentialStore(); await saveSubscriptionTokens(store, { accessToken: "old", refreshToken: "refresh", obtainedAt: 0 }); await store.set(credentialIdentity({ provider: "xai" }), "stored-billing-key");
    expect(await selectXaiTransport({ xaiAuth: "grok", runtimeApiKey: "runtime-billing-key", env: { XAI_API_KEY: "env-billing-key" }, store })).toEqual({ transport: "grok" });
    const bodies: string[] = [], auth: string[] = []; let refreshes = 0;
    const model = await loadProviderModel({ provider: "xai", model: "grok-4.7", xaiAuth: "grok", grokStore: store, apiKey: "runtime-billing-key" }, async (url, init) => {
      if (String(url) === GROK_TOKEN_URL) { refreshes++; return json({ access_token: "renewed" }); }
      expect(String(url)).toBe("https://api.x.ai/v1/responses"); bodies.push(String(init!.body)); auth.push(new Headers(init!.headers).get("Authorization")!);
      return bodies.length === 1 ? json({}, 401) : finalStatus === 200 ? new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } }) : json({}, finalStatus);
    });
    const task = collect(model.stream(sampleRequest()));
    if (finalStatus === 200) expect((await task).some(event => event.type === "message_complete")).toBe(true);
    else await expect(task).rejects.toThrow(finalStatus === 401 ? "session was revoked" : "Your Grok plan doesn't include API access");
    expect(refreshes).toBe(1); expect(bodies.length).toBe(2); expect(bodies[0]).toBe(bodies[1]); expect(auth).toEqual(["Bearer old", "Bearer renewed"]);
  }
});
test("subscription storage writes one identity and hides secure-store failures", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { grokSubscriptionIdentity, credentialStoreError } = await import("../src/auth/store.ts");
  const { saveSubscriptionTokens } = await import("../src/model/providers/grok-subscription.ts");
  const store = fakeCredentialStore(); const identities: string[] = [];
  await saveSubscriptionTokens({ ...store, set: async (id, value) => { identities.push(id.account); await store.set(id, value); } }, { accessToken: "approved", obtainedAt: 1000 });
  expect(identities).toEqual(["grok-subscription:xai"]); expect(grokSubscriptionIdentity().label).toBe("Grok subscription (xAI OAuth)");
  await expect(saveSubscriptionTokens({ ...store, set: async () => { throw Error("private-secret"); } }, { accessToken: "approved", obtainedAt: 1000 })).rejects.toThrow(credentialStoreError("save"));
});

const unguardedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Grok fixtures must not use external network");
    return unguardedFetch(input, init);
  }, { preconnect: unguardedFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedFetch; });

test("browser, device, headless, doctor and smoke never consume or alter another CLI's cache", async () => {
  const { withTempDir } = await import("./helpers.ts"), { mkdir, writeFile, readFile, stat } = await import("node:fs/promises"), { join } = await import("node:path");
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts"), { runCli } = await import("../src/cli/main.ts"), { diagnose } = await import("../src/doctor/doctor.ts"), { runLiveSmoke } = await import("../src/live/smoke.ts");
  const { loginWithBrowserFlow } = await import("../src/model/providers/grok-subscription.ts");
  await withTempDir(async home => {
    const cache = join(home, ".grok", "auth.json"), sentinel = "OTHER_CLI_SENTINEL_SECRET";
    await mkdir(join(home, ".grok")); await writeFile(cache, JSON.stringify({ access_token: sentinel })); const before = await stat(cache), bytes = await readFile(cache);
    const oldHome = process.env.HOME; process.env.HOME = home;
    const requests: string[] = [];
    const transport: GrokFetch = async (url, init) => { requests.push(String(url) + " " + String(init?.body)); return String(url) === GROK_DEVICE_AUTHORIZATION_URL ? json({ device_code: "fixture-device", user_code: "ABCD-EFGH", verification_uri: "https://x.ai/device" }) : json({ access_token: "fixture-access", refresh_token: "fixture-refresh" }); };
    try {
      await loginWithBrowserFlow({ signal: new AbortController().signal, deps: { fetch: transport, saveTokens: async () => {}, openBrowser: async value => { const url = new URL(value); await (await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=fixture-code`)).text(); } } });
      let now = 0;
      await loginWithDeviceFlow({ signal: new AbortController().signal, deps: { fetch: transport, saveTokens: async () => {}, now: () => now, sleep: async ms => { now += ms; } } });
      let stderr = "";
      expect(await runCli(["--provider", "xai", "--xai-auth", "grok", "--model", "grok-4.7", "-p", "Hello"], { cwd: home, env: { HOME: home }, credentialStore: fakeCredentialStore(), fetch: transport, stdout: { write() {} }, stderr: { write(value) { stderr += value; } } })).toBe(1);
      expect(stderr).toContain("No Grok subscription login found.");
      const report = await diagnose({ cwd: home, env: { HOME: home }, args: { provider: "xai", xaiAuth: "grok", help: false, json: false }, store: fakeCredentialStore() });
      expect(report.checks.find(check => check.id === "auth")?.status).toBe("error");
      const smoke = await runLiveSmoke({ enabled: true, providers: ["grok"], timeoutMs: 1000, revision: "fixture", env: { HOME: home } }, { createStore: fakeCredentialStore, createModel: async () => { throw Error("must not load"); } });
      expect(smoke.scenarios[0]?.reason).toBe("missing_subscription");
      expect(await readFile(cache)).toEqual(bytes); expect((await stat(cache)).mtimeMs).toBe(before.mtimeMs); expect(requests.join("\n")).not.toContain(sentinel);
      expect(requests.every(request => request.startsWith("https://auth.x.ai/"))).toBe(true);
    } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  });
});
test("approved browser store failure returns the standard secure-store error", async () => {
  const { createGrokLoginRunner } = await import("../src/tui/app.ts"), { fakeCredentialStore } = await import("./helpers/credential-store.ts"), { credentialStoreError } = await import("../src/auth/store.ts");
  let saves = 0;
  const runner = createGrokLoginRunner({ store: { ...fakeCredentialStore(), set: async () => { saves++; throw Error("private-token"); } }, secrets: [], openBrowser: async value => { const url = new URL(value); await (await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=approved`)).text(); }, fetch: async () => json({ access_token: "private-token" }) });
  const result = await runner({ device: false, signal: new AbortController().signal, onProgress() {}, onApproval() {} });
  expect(result).toEqual({ ok: false, message: credentialStoreError("save") }); expect(saves).toBe(1);
});

test("aborting a Grok turn stops waiting for shared refresh while another turn completes it", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens } = await import("../src/model/providers/grok-subscription.ts");
  const { loadProviderModel } = await import("../src/model/loader.ts");
  const { sampleRequest } = await import("./fixtures/openai.ts");
  const { collect } = await import("./helpers/scripted-model.ts");
  const { encodeXaiSse, XAI_TEXT_EVENTS } = await import("./fixtures/xai.ts");
  const saved = fakeCredentialStore();
  await saveSubscriptionTokens(saved, { accessToken: "expired", refreshToken: "refresh", obtainedAt: 0, expiresAt: 0 });
  let reads = 0, refreshes = 0, sends = 0;
  const store = { ...saved, get: async (...args: Parameters<typeof saved.get>) => { reads++; return saved.get(...args); } };
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const model = await loadProviderModel({ provider: "xai", model: "grok-4.7", xaiAuth: "grok", grokStore: store }, async (url, init) => {
    if (String(url) === GROK_TOKEN_URL) { refreshes++; started.resolve(); await release.promise; return json({ access_token: "renewed", expires_in: 3600 }); }
    sends++; expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer renewed");
    return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  });
  const abort = new AbortController();
  const cancelled = collect(model.stream({ ...sampleRequest(), signal: abort.signal })).then(() => "completed", error => error instanceof Error ? error.name : "unknown");
  await started.promise;
  const continuing = collect(model.stream(sampleRequest()));
  try {
    abort.abort();
    expect(await Promise.race([cancelled, Bun.sleep(100).then(() => "still waiting")])).toBe("AbortError");
    expect(refreshes).toBe(1); expect(sends).toBe(0);
  } finally { release.resolve(); await cancelled; await continuing; }
  expect(refreshes).toBe(1); expect(sends).toBe(1);
  expect(reads).toBe(2); // Each turn resolves credentials once; the SDK never asks again.
});

test("late Grok refresh cannot recreate a logged-out login or overwrite a replacement account", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens, loadSubscriptionTokens, deleteSubscriptionTokens, createSubscriptionTokenRefresher } = await import("../src/model/providers/grok-subscription.ts");
  for (const mutation of ["logout", "replacement"] as const) {
    const store = fakeCredentialStore();
    await saveSubscriptionTokens(store, { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0, obtainedAt: 0 });
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let refreshes = 0;
    const transport: GrokFetch = async () => { refreshes++; started.resolve(); await release.promise; return json({ access_token: "stale-renewal", refresh_token: "stale-rotation", expires_in: 3600 }); };
    const one = createSubscriptionTokenRefresher({ store, fetch: transport });
    const two = createSubscriptionTokenRefresher({ store, fetch: transport });
    const abort = new AbortController();
    const cancelled = one.getValidAccessToken(abort.signal).catch(error => error.name);
    await started.promise;
    const outstanding = two.getValidAccessToken().catch(error => error.message);
    await Bun.sleep(0); abort.abort(); expect(await cancelled).toBe("AbortError");
    if (mutation === "logout") expect(await deleteSubscriptionTokens(store)).toBe(true);
    else await saveSubscriptionTokens(store, { accessToken: "new-account", obtainedAt: 123 });
    release.resolve(); expect(await outstanding).toContain("session was revoked");
    const tokens = await loadSubscriptionTokens(store);
    expect(tokens?.accessToken ?? null).toBe(mutation === "logout" ? null : "new-account");
    expect(refreshes).toBe(1);
  }
});

test("Grok logout and account replacement serialize behind an already-started refresh store write", async () => {
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { saveSubscriptionTokens, loadSubscriptionTokens, deleteSubscriptionTokens, createSubscriptionTokenRefresher } = await import("../src/model/providers/grok-subscription.ts");
  for (const mutation of ["logout", "replacement"] as const) {
    const saved = fakeCredentialStore();
    const writing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const store = { ...saved, set: async (identity: Parameters<typeof saved.set>[0], value: string) => {
      if (JSON.parse(value).accessToken === "stale-renewal") { writing.resolve(); await release.promise; }
      await saved.set(identity, value);
    } };
    await saveSubscriptionTokens(store, { accessToken: "old", refreshToken: "refresh", expiresAt: 0, obtainedAt: 0 });
    const refresher = createSubscriptionTokenRefresher({ store, fetch: async () => json({ access_token: "stale-renewal", expires_in: 3600 }) });
    const refresh = refresher.getValidAccessToken().catch(error => error.message);
    await writing.promise;
    let mutated = false;
    const change = (mutation === "logout" ? deleteSubscriptionTokens(store) : saveSubscriptionTokens(store, { accessToken: "new-account", obtainedAt: 123 })).then(() => { mutated = true; });
    try { await Bun.sleep(0); expect(mutated).toBe(false); }
    finally { release.resolve(); await change; }
    expect(await refresh).toContain("session was revoked");
    expect((await loadSubscriptionTokens(store))?.accessToken ?? null).toBe(mutation === "logout" ? null : "new-account");
  }
});
