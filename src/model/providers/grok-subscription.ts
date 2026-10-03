import { grokSubscriptionIdentity, credentialStoreError, type CredentialStore } from "../../auth/store.ts";
import { MISSING_GROK_SUBSCRIPTION } from "../../auth/credentials.ts";
import { boundedCatalogFetch, fetchProviderModelListResult, fetchProviderModelList, requireXaiModels, type ListedModel, type ModelListResult } from "../model-list.ts";
import { createHash, randomBytes } from "node:crypto";

/** Public OAuth client shared with Grok Build, attributed to Schway by referrer. */
export const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** Fixed public browser authorization endpoint; discovery is not performed at runtime. */
export const GROK_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
/** Fixed public endpoint for authorization, refresh and device token grants. */
export const GROK_TOKEN_URL = "https://auth.x.ai/oauth2/token";
/** Fixed public endpoint for requesting device approval. */
export const GROK_DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
/** Minimum identity, offline and public API scopes needed by this transport. */
export const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access";
/** Attribute every sign-in attempt to Schway rather than another OAuth client. */
export const GROK_REFERRER = "schway";
/** Renew subscription access two minutes before its recorded expiry. */
export const GROK_REFRESH_SKEW_MS = 120_000;
/** Protocol fetch injection keeps deterministic fixtures off the network. */
export type GrokFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** Subscription secrets and timestamps persisted at the dedicated secure-store identity. */
export interface GrokTokens { accessToken: string; refreshToken?: string; expiresAt?: number; obtainedAt: number }
/** Structured ephemeral approval data; device codes must never enter notices or history. */
export type GrokApproval = { kind: "browser" } | { kind: "device"; verificationUri: string; userCode: string };
/** Device grant metadata needed for bounded polling. */
export interface GrokDeviceAuthorization { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
/** Actionable revoked-session guidance that forbids billing fallback. */
export function grokRevokedSessionError(): string {
  return "The Grok subscription session was revoked or rejected by xAI. Sign in again in interactive mode with /login grok; stored API keys are never used as a silent fallback.";
}
/** Safe transient renewal guidance without provider response bodies or credential data. */
export function grokRefreshFailedError(detail: string): string {
  return `Refreshing the Grok subscription session failed (${detail}). Retry the turn; Schway owns retries and never falls back to xAI API-key billing.`;
}
/** Plan rejection text shared with headless output; the TUI adds its own shortcut hint. */
export const GROK_PLAN_ERROR = "Your Grok plan doesn't include API access. Use an xAI API key instead.";
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); }
function positive(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback; }
function jwtExpiry(token: string): number | undefined {
  try { const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()); return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined; }
  catch { return undefined; }
}
function tokensFromPayload(payload: Record<string, unknown>, now: number): GrokTokens {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) throw new Error("The Grok sign-in response has no access token. Retry /login grok.");
  const expiresAt = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in >= 0 ? now + payload.expires_in * 1000 : jwtExpiry(accessToken);
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim() ? payload.refresh_token.trim() : undefined;
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), obtainedAt: now };
}
/** Parse stored tokens without exposing malformed values in thrown errors. */
export function parseSubscriptionTokens(raw: string): GrokTokens {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("Stored Grok subscription login is invalid. Sign in again with /login grok."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stored Grok subscription login is invalid. Sign in again with /login grok.");
  const value = data as Record<string, unknown>;
  if (typeof value.accessToken !== "string" || !value.accessToken.trim() || (value.refreshToken !== undefined && (typeof value.refreshToken !== "string" || !value.refreshToken.trim())) || (value.expiresAt !== undefined && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))) || typeof value.obtainedAt !== "number" || !Number.isFinite(value.obtainedAt)) throw new Error("Stored Grok subscription login is invalid. Sign in again with /login grok.");
  return { accessToken: value.accessToken.trim(), ...(value.refreshToken !== undefined ? { refreshToken: value.refreshToken as string } : {}), ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt as number } : {}), obtainedAt: value.obtainedAt };
}
/** True when a stored expiry falls within the Grok renewal window. */
export function subscriptionAccessExpired(tokens: GrokTokens, now = Date.now()): boolean { return tokens.expiresAt !== undefined && tokens.expiresAt <= now + GROK_REFRESH_SKEW_MS; }
async function formRequest(url: string, fields: Record<string, string>, options: { fetch?: GrokFetch; signal?: AbortSignal }): Promise<Response> {
  aborted(options.signal);
  try {
    const response = await (options.fetch ?? fetch)(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: GROK_CLIENT_ID, ...fields }).toString(), redirect: "error", signal: options.signal });
    aborted(options.signal); return response;
  } catch { aborted(options.signal); throw new Error("The Grok sign-in endpoint could not be reached. Retry /login grok."); }
}
async function payload(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); aborted(signal); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch { aborted(signal); }
  throw new Error("The Grok sign-in endpoint returned an unreadable response. Retry /login grok.");
}
/** Exchange one PKCE code with a form POST and no automatic retry. */
export async function exchangeCodeForTokens(input: { code: string; verifier: string; redirectUri: string; fetch?: GrokFetch; signal?: AbortSignal; now?: () => number }): Promise<GrokTokens> {
  const response = await formRequest(GROK_TOKEN_URL, { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, referrer: GROK_REFERRER }, input);
  if (!response.ok) throw new Error(`Exchanging the Grok sign-in code failed (HTTP ${response.status}). Retry /login grok.`);
  return tokensFromPayload(await payload(response, input.signal), (input.now ?? Date.now)());
}
/** Renew access once, mapping rejected refresh grants to safe revoked-session guidance. */
export async function refreshSubscriptionTokens(input: { refreshToken: string; fetch?: GrokFetch; signal?: AbortSignal; now?: () => number }): Promise<GrokTokens> {
  let response: Response;
  try { response = await formRequest(GROK_TOKEN_URL, { grant_type: "refresh_token", refresh_token: input.refreshToken, referrer: GROK_REFERRER }, input); }
  catch { aborted(input.signal); throw new Error(grokRefreshFailedError("connection failed")); }
  if ([400, 401, 403].includes(response.status)) throw new Error(grokRevokedSessionError());
  if (!response.ok) throw new Error(grokRefreshFailedError(`HTTP ${response.status}`));
  try { return tokensFromPayload(await payload(response, input.signal), (input.now ?? Date.now)()); }
  catch { aborted(input.signal); throw new Error(grokRefreshFailedError("invalid token response")); }
}
/** Generate a fresh PKCE verifier and unpredictable browser state and nonce. */
export function createBrowserAttempt(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(32).toString("base64url"), nonce: randomBytes(32).toString("base64url") };
}
/** Build the public authorization URL using the already-bound loopback redirect. */
export function createAuthorizeUrl(attempt: { challenge: string; state: string; nonce: string }, redirectUri: string): string {
  const url = new URL(GROK_AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: "code", client_id: GROK_CLIENT_ID, redirect_uri: redirectUri, scope: GROK_SCOPE, code_challenge: attempt.challenge, code_challenge_method: "S256", state: attempt.state, nonce: attempt.nonce, referrer: GROK_REFERRER }).toString();
  return url.toString();
}
/** Bind a random loopback port before authorization and close it on every terminal outcome. */
export function startLoopbackCallback(input: { expectedState: string; signal: AbortSignal; timeoutMs?: number }): { redirectUri: string; code: Promise<string>; close(): void } {
  aborted(input.signal);
  let resolve!: (code: string) => void, reject!: (error: Error) => void;
  const code = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // A browser launcher can fail before the caller begins awaiting the code.
  void code.catch(() => {});
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  const finish = (value?: string, error?: Error) => {
    if (done) return; done = true; clearTimeout(timer); input.signal.removeEventListener("abort", cancel);
    void server.stop();
    if (error) reject(error); else resolve(value!);
  };
  const cancel = () => finish(undefined, new DOMException("Aborted", "AbortError"));
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const headers = new Headers();
      if (request.headers.get("Origin") === "https://accounts.x.ai") {
        headers.set("Access-Control-Allow-Origin", "https://accounts.x.ai"); headers.set("Vary", "Origin");
        if (request.method === "OPTIONS") { headers.set("Access-Control-Allow-Methods", "GET"); headers.set("Access-Control-Allow-Private-Network", "true"); }
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
      if (url.searchParams.get("state") !== input.expectedState) return new Response("Wrong state; Schway is still waiting for this sign-in attempt.", { status: 400, headers });
      if (url.searchParams.has("error")) { finish(undefined, new Error("Grok sign-in was denied. Retry /login grok.")); return new Response("Grok sign-in was denied.", { status: 403, headers }); }
      const value = url.searchParams.get("code")?.trim();
      if (!value) return new Response("Missing authorization code.", { status: 400, headers });
      finish(value); return new Response("Grok sign-in received. Return to Schway.", { headers });
    } });
  } catch { throw new Error("The Grok localhost callback could not start. Use /login grok --device."); }
  input.signal.addEventListener("abort", cancel, { once: true });
  timer = setTimeout(() => finish(undefined, new Error("Grok sign-in timed out waiting for browser approval. Retry /login grok.")), input.timeoutMs ?? 600_000);
  if (input.signal.aborted) cancel();
  return { redirectUri: `http://127.0.0.1:${server.port}/callback`, code, close: cancel };
}
/** Ask for a device grant while rejecting non-HTTPS verification addresses. */
export async function requestDeviceAuthorization(input: { fetch?: GrokFetch; signal?: AbortSignal }): Promise<GrokDeviceAuthorization> {
  const response = await formRequest(GROK_DEVICE_AUTHORIZATION_URL, { scope: GROK_SCOPE, referrer: GROK_REFERRER }, input);
  if (!response.ok) throw new Error(`Starting Grok device sign-in failed (HTTP ${response.status}).`);
  const data = await payload(response, input.signal);
  if (typeof data.verification_uri !== "string" || typeof data.device_code !== "string" || !data.device_code.trim() || typeof data.user_code !== "string" || !data.user_code.trim()) throw new Error("Grok device sign-in returned an incomplete authorization.");
  try { if (new URL(data.verification_uri).protocol !== "https:") throw new Error(); }
  catch { throw new Error("Grok device sign-in requires an HTTPS verification address."); }
  return { verificationUri: data.verification_uri, deviceCode: data.device_code, userCode: data.user_code, expiresIn: positive(data.expires_in, 900), interval: positive(data.interval, 5) };
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
/** Poll with RFC device intervals, a strict deadline and cancellable waits. */
export async function pollDeviceAuthorization(input: GrokDeviceAuthorization & { fetch?: GrokFetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }): Promise<GrokTokens> {
  const now = input.now ?? Date.now, wait = input.sleep ?? sleep;
  const deadline = now() + input.expiresIn * 1000;
  let interval = input.interval * 1000;
  const expired = () => new Error("Grok device sign-in timed out waiting for approval. Restart /login grok --device.");
  for (;;) {
    aborted(input.signal);
    const remaining = deadline - now(); if (remaining <= 0) throw expired();
    await wait(Math.min(interval, remaining), input.signal); aborted(input.signal);
    if (now() >= deadline) throw expired();
    const timeout = AbortSignal.timeout(Math.max(1, deadline - now()));
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try { response = await formRequest(GROK_TOKEN_URL, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: input.deviceCode, referrer: GROK_REFERRER }, { fetch: input.fetch, signal }); }
    catch (error) { aborted(input.signal); if (timeout.aborted || now() >= deadline) throw expired(); throw error; }
    const data = await payload(response, signal);
    if (now() >= deadline) throw expired();
    if (response.ok) return tokensFromPayload(data, now());
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { interval += 5000; continue; }
    if (data.error === "access_denied") throw new Error("Grok device sign-in was denied. Restart /login grok --device.");
    if (data.error === "expired_token") throw new Error("The Grok device code expired. Restart /login grok --device.");
    throw new Error(`Grok device sign-in failed (HTTP ${response.status}). Restart /login grok --device.`);
  }
}
/** Injectable login side effects keep browser opening, panels and storage under the caller's control. */
export interface GrokLoginDependencies { fetch?: GrokFetch; saveTokens(tokens: GrokTokens): Promise<void>; onSaved?: () => void; onApproval?: (approval: GrokApproval) => void; onProgress?: (message: string) => void }
/** Complete explicit browser approval and save only after a final cancellation check. */
export async function loginWithBrowserFlow(input: { signal: AbortSignal; deps: GrokLoginDependencies & { openBrowser(url: string): Promise<void> | void }; timeoutMs?: number }): Promise<GrokTokens> {
  const attempt = createBrowserAttempt();
  const listener = startLoopbackCallback({ expectedState: attempt.state, signal: input.signal, timeoutMs: input.timeoutMs });
  try {
    const authorize = createAuthorizeUrl(attempt, listener.redirectUri);
    input.deps.onApproval?.({ kind: "browser" });
    try { await input.deps.openBrowser(authorize); }
    catch { aborted(input.signal); input.deps.onProgress?.(`The browser could not be opened automatically. Open ${authorize}`); }
    const code = await listener.code;
    const tokens = await exchangeCodeForTokens({ code, verifier: attempt.verifier, redirectUri: listener.redirectUri, fetch: input.deps.fetch, signal: input.signal });
    aborted(input.signal); await input.deps.saveTokens(tokens); input.deps.onSaved?.(); return tokens;
  } finally { listener.close(); }
}
/** Complete explicit device approval without putting its user code in notices. */
export async function loginWithDeviceFlow(input: { signal: AbortSignal; deps: GrokLoginDependencies & { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } }): Promise<GrokTokens> {
  const grant = await requestDeviceAuthorization({ fetch: input.deps.fetch, signal: input.signal });
  input.deps.onApproval?.({ kind: "device", verificationUri: grant.verificationUri, userCode: grant.userCode });
  const tokens = await pollDeviceAuthorization({ ...grant, fetch: input.deps.fetch, signal: input.signal, now: input.deps.now, sleep: input.deps.sleep });
  aborted(input.signal); await input.deps.saveTokens(tokens); input.deps.onSaved?.(); return tokens;
}

/** Read only Schway's dedicated Grok subscription identity, preserving secure-store failures. */
export async function loadSubscriptionTokens(store: CredentialStore, onCredential?: (raw: string) => void): Promise<GrokTokens | null> {
  let raw: string | null;
  try { raw = await store.get(grokSubscriptionIdentity()); } catch { throw new Error(credentialStoreError("read")); }
  if (raw) onCredential?.(raw);
  return raw?.trim() ? parseSubscriptionTokens(raw) : null;
}
type RefreshCaller = { onCredential?: (raw: string) => void };
type CredentialLifecycle = {
  generation: number; writes: Promise<void>; callers: Set<RefreshCaller>;
  refresh?: { generation: number; promise: Promise<GrokTokens>; controller: AbortController };
};
const credentialLifecycles = new WeakMap<CredentialStore, CredentialLifecycle>();
function credentialLifecycle(store: CredentialStore): CredentialLifecycle {
  let state = credentialLifecycles.get(store);
  if (!state) { state = { generation: 0, writes: Promise.resolve(), callers: new Set() }; credentialLifecycles.set(store, state); }
  return state;
}
function serializeCredentialWrite<T>(state: CredentialLifecycle, operation: () => Promise<T>): Promise<T> {
  const next = state.writes.then(operation);
  state.writes = next.then(() => {}, () => {});
  return next;
}
async function writeTokens(store: CredentialStore, tokens: GrokTokens): Promise<void> {
  try { await store.set(grokSubscriptionIdentity(), JSON.stringify(tokens)); } catch { throw new Error(credentialStoreError("save")); }
}
/** Replace the dedicated login and invalidate older refreshes before serializing its secure-store write. */
export async function saveSubscriptionTokens(store: CredentialStore, tokens: GrokTokens): Promise<void> {
  const state = credentialLifecycle(store); state.generation++;
  await serializeCredentialWrite(state, () => writeTokens(store, tokens));
}
/** Invalidate pending refreshes and delete the login after earlier credential writes finish. */
export async function deleteSubscriptionTokens(store: CredentialStore): Promise<boolean> {
  const state = credentialLifecycle(store); state.generation++;
  return serializeCredentialWrite(state, async () => {
    try { return await store.delete(grokSubscriptionIdentity()); } catch { throw new Error(credentialStoreError("delete")); }
  });
}
/** Inputs retain the original lifecycle identity when discovery memoizes its first credential read. */
interface SubscriptionTokenInput {
  store: CredentialStore; fetch?: GrokFetch; now?: () => number;
  lifecycleStore?: CredentialStore; onCredential?: (raw: string) => void;
}

/** Share renewal per original store and generation; cancellation detaches only this caller. */
async function resolveSubscriptionToken(input: SubscriptionTokenInput, signal?: AbortSignal, rejectedToken?: string): Promise<string> {
  aborted(signal);
  const owner = input.lifecycleStore ?? input.store, state = credentialLifecycle(owner);
  const caller: RefreshCaller = { onCredential: input.onCredential };
  // Register before any asynchronous read so an arriving caller can keep a shared renewal alive.
  state.callers.add(caller);
  const detach = () => {
    state.callers.delete(caller);
    if (!state.callers.size && state.refresh) {
      const refresh = state.refresh;
      state.refresh = undefined;
      refresh.controller.abort();
    }
  };
  signal?.addEventListener("abort", detach, { once: true });
  const getToken = async (): Promise<string> => {
    aborted(signal);
    const pendingWrites = state.writes;
    await raceAbort(pendingWrites, signal);
    if (pendingWrites !== state.writes) return getToken();
    const generation = state.generation;
    // Memoized route selection is reusable only before an in-process mutation or renewal.
    const currentStore = input.lifecycleStore && (generation !== 0 || state.refresh) ? owner : input.store;
    const tokens = await raceAbort(loadSubscriptionTokens(currentStore, input.onCredential), signal);
    if (generation !== state.generation) return getToken();
    if (!tokens) throw new Error(MISSING_GROK_SUBSCRIPTION);
    let refresh = state.refresh;
    if (refresh?.generation !== generation) {
      if (rejectedToken !== undefined ? tokens.accessToken !== rejectedToken : !subscriptionAccessExpired(tokens, (input.now ?? Date.now)())) return tokens.accessToken;
      if (!tokens.refreshToken) throw new Error("The Grok subscription session expired and has no refresh token. Sign in again in interactive mode with /login grok.");
      const refreshToken = tokens.refreshToken, controller = new AbortController();
      // Ordinary execution retains its safety ceiling; discovery's earlier deadline detaches its interest.
      const timer = setTimeout(() => controller.abort(new DOMException("Refresh timed out", "TimeoutError")), 30_000);
      const promise = (async () => {
        let renewed: GrokTokens;
        try {
          renewed = await refreshSubscriptionTokens({ refreshToken, now: input.now, signal: controller.signal,
            fetch: boundedCatalogFetch({ fetch: input.fetch, signal: controller.signal, label: "Grok subscription" }) });
        } catch (error) {
          if (controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError") throw new Error(grokRefreshFailedError("timed out"));
          throw error;
        }
        const merged = { ...renewed, refreshToken: renewed.refreshToken ?? refreshToken };
        for (const interested of state.callers) interested.onCredential?.(JSON.stringify(merged));
        await serializeCredentialWrite(state, async () => {
          controller.signal.throwIfAborted();
          if (state.generation !== generation) throw new Error(grokRevokedSessionError());
          // A discovery wrapper belongs to one deadline; only the original store can serve all callers.
          await writeTokens(owner, merged);
          if (state.generation !== generation) throw new Error(grokRevokedSessionError());
          state.generation++;
        });
        return merged;
      })().finally(() => {
        clearTimeout(timer);
        if (state.refresh?.promise === promise) state.refresh = undefined;
      });
      // Cancellation can happen before a caller begins awaiting this shared promise.
      void promise.catch(() => {});
      refresh = { generation, promise, controller };
      state.refresh = refresh;
    }
    const renewed = await raceAbort(refresh.promise, signal);
    input.onCredential?.(JSON.stringify(renewed));
    return renewed.accessToken;
  };
  try { return await getToken(); }
  finally { signal?.removeEventListener("abort", detach); detach(); }
}

/** Share renewal per store while fencing refresh writes against logout and replacement sign-ins. */
export function createSubscriptionTokenRefresher(input: { store: CredentialStore; fetch?: GrokFetch; now?: () => number }) {
  return { getValidAccessToken: (signal?: AbortSignal, rejectedToken?: string) => resolveSubscriptionToken(input, signal, rejectedToken) };
}
async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  aborted(signal); if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", stop, { once: true });
    promise.then(value => { signal.removeEventListener("abort", stop); resolve(value); }, error => { signal.removeEventListener("abort", stop); reject(error); });
  });
}
/** Discover under the caller's total deadline while sharing selected-account renewal with execution. */
export async function fetchDiscoveryCatalog(input: {
  store: CredentialStore; fetch?: GrokFetch; signal: AbortSignal;
  /** Original identity owner when reads are memoized for route selection. */
  lifecycleStore?: CredentialStore;
  /** Register every selected credential read, including fresh reads after concurrent replacement. */
  onCredential?: (raw: string) => void;
}): Promise<ModelListResult> {
  const getToken = (rejectedToken?: string) => resolveSubscriptionToken(input, input.signal, rejectedToken);
  let accessToken = await getToken();
  let authError: unknown;
  const authorizedFetch: GrokFetch = async (url, init) => {
    const send = () => (input.fetch ?? fetch)(url, { ...init, signal: input.signal, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${accessToken}` } });
    let response = await send();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      try { accessToken = await getToken(accessToken); }
      catch (error) { authError = error; throw error; }
      input.signal.throwIfAborted();
      response = await send();
    }
    return response;
  };
  try {
    const result = await fetchProviderModelListResult({ url: "https://api.x.ai/v1/models", signal: input.signal, label: "Grok subscription", fetch: authorizedFetch, parseOptions: { chatOnly: "xai" } });
    return { ...result, models: requireXaiModels(result.models) };
  } catch (error) { input.signal.throwIfAborted(); throw authError ?? error; }
}

/** List chat-capable Grok account models with one auth refresh, never an API-key fallback. */
export async function fetchSubscriptionModels(input: { store: CredentialStore; fetch?: GrokFetch; signal?: AbortSignal; refresher?: ReturnType<typeof createSubscriptionTokenRefresher> }): Promise<ListedModel[]> {
  const refresher = input.refresher ?? createSubscriptionTokenRefresher(input);
  let accessToken = await refresher.getValidAccessToken(input.signal);
  // Only token resolution and our own authorization statuses cross the generic transport sanitizer.
  let authError: Error | undefined;
  const authorizedFetch: GrokFetch = async (url, init) => {
    const send = () => (input.fetch ?? fetch)(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${accessToken}` } });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      try { accessToken = await refresher.getValidAccessToken(input.signal, accessToken); }
      catch (error) { aborted(input.signal); if (error instanceof Error) authError = error; throw error; }
      response = await send();
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      authError = new Error(response.status === 401 ? grokRevokedSessionError() : GROK_PLAN_ERROR);
      throw authError;
    }
    return response;
  };
  try { return requireXaiModels(await fetchProviderModelList({ url: "https://api.x.ai/v1/models", signal: input.signal, label: "Grok", fetch: authorizedFetch })); }
  catch (error) { aborted(input.signal); throw authError ?? error; }
}
