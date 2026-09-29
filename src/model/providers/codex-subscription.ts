import { assertThinking } from "../thinking.ts";
import type {
  AssistantContent,
  AssistantMessage,
  ConversationItem,
  ProviderMetadata,
} from "../../conversation/types.ts";
import type { ModelCapability } from "../catalog.ts";
import { THINKING_LEVELS, reportedTokens } from "../model.ts";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
  ThinkingLevel,
} from "../model.ts";
import {
  CODEX_SUBSCRIPTION_LABEL,
  codexSubscriptionIdentity,
  credentialStoreError,
  type CredentialStore,
} from "../../auth/store.ts";

/** Public Codex CLI OAuth client shipped in the official Codex CLI binary, shared rather than private. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** OAuth authorization endpoint for the verified browser PKCE login flow. */
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
/** OAuth token endpoint for code exchange and offline_access refresh grants. */
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Localhost callback that receives the authorization code for desktop runs. */
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
/** OAuth scopes requested for the subscription login, including offline_access refresh. */
export const CODEX_SCOPE = "openid profile email offline_access";
/** Device-code request endpoint for the headless beta login flow. */
export const CODEX_DEVICE_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
/** Human verification page where the headless beta user code is entered. */
export const CODEX_DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device";
/** Device-code polling endpoint for the headless beta login flow. */
export const CODEX_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
/** Model-only Responses endpoint owned by the Schway loop; never a delegated agent run. */
export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
/** Codex backend catalog used for account-scoped subscription model choices. */
export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/** Codex CLI protocol version verified against the subscription catalog; not Schway's package version. */
export const CODEX_CATALOG_CLIENT_VERSION = "0.156.1";
/** Account header carrying the verified JWT chatgpt_account_id alongside the Bearer token. */
export const CODEX_ACCOUNT_HEADER = "ChatGPT-Account-Id";
/** JWT claim namespace whose chatgpt_account_id identifies the billed ChatGPT account. */
export const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
/** Refresh skew that renews short-lived access tokens before they expire mid-turn. */
export const CODEX_REFRESH_SKEW_MS = 60_000;
/** Independent timeout for one shared subscription refresh, keeping caller cancellation per-waiter. */
export const CODEX_REFRESH_TIMEOUT_MS = 30_000;
/** Default browser-login ceiling before the attempt fails actionably instead of hanging. */
export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Device-flow polling ceiling matching the verified beta timeout. */
export const CODEX_DEVICE_TIMEOUT_MS = 900_000;
/** Short-lived subscription credential with its offline_access renewal secret. */
export interface CodexTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires; absent means unknown and refreshable-only. */
  expiresAt?: number;
  /** Billed ChatGPT account decoded from the access-token claim, when present. */
  accountId?: string;
  /** Epoch milliseconds when the tokens were obtained. */
  obtainedAt?: number;
}

/** Optional fetch override used by protocol tests to avoid live subscription calls. */
export type CodexFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Progress reporter for explicit interactive login actions. */
export type CodexProgress = (message: string) => void;

/** Injectable login dependencies so deterministic tests never open browsers or sockets. */
export interface CodexLoginDeps {
  fetch?: CodexFetchLike;
  /** Open the authorization URL; failures fall back to the printed manual URL. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Wait for the localhost callback code; omitted when a pasted code is supplied. */
  waitForCallbackCode?: (input: {
    expectedState: string;
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<string>;
  onProgress?: CodexProgress;
  /** Called only after the secure-store write resolves successfully. */
  onSaved?: () => void;
  /** Deterministic random bytes for PKCE/state in tests; defaults to crypto. */
  randomBytes?: (bytes: number) => Uint8Array;
}

/** Injectable device-flow dependencies so tests script the beta polling states. */
export interface CodexDeviceDeps {
  fetch?: CodexFetchLike;
  onProgress?: CodexProgress;
  /** Called only after the secure-store write resolves successfully. */
  onSaved?: () => void;
}

/** Device authorization started by the headless beta request. */
export interface CodexDeviceAuthorization {
  userCode: string;
  verificationUri: string;
  /** Opaque poll token echoed back while polling for the grant. */
  deviceCode: string;
  /** Seconds until the user code expires, when the server reports it. */
  expiresIn?: number;
  /** Suggested poll interval in seconds, when the server reports it. */
  interval?: number;
}

/** Most-recent browser PKCE attempt reused when the user pastes the redirect URL. */
export interface PendingBrowserLoginAttempt {
  verifier: string;
  state: string;
  expiresAt: number;
}

let pendingBrowserAttempt: PendingBrowserLoginAttempt | undefined;

/** Read the most-recent browser PKCE attempt without consuming it. */
export function getPendingBrowserAttempt(): PendingBrowserLoginAttempt | undefined {
  return pendingBrowserAttempt ? { ...pendingBrowserAttempt } : undefined;
}

/** Clear the retained browser PKCE attempt for deterministic tests. */
export function clearPendingBrowserAttempt(): void {
  pendingBrowserAttempt = undefined;
}

/** Generate a PKCE verifier, S256 challenge, and state for one browser login attempt. */
export function createPkceChallenge(randomBytes?: (bytes: number) => Uint8Array): {
  verifier: string;
  challenge: string;
  state: string;
} {
  const random = randomBytes ?? ((bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)));
  const verifier = base64UrlEncode(random(32));
  const state = base64UrlEncode(random(16));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(verifier, "utf8");
  const challenge = base64UrlEncode(hasher.digest() as Uint8Array);
  return { verifier, challenge, state };
}

/** Build the verified browser authorization URL for one PKCE attempt. */
export function buildCodexAuthorizeUrl(input: {
  challenge: string;
  state: string;
}): string {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_SCOPE);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.href;
}

/** Extract the authorization code from a pasted callback URL or bare code, validating state. */
export function extractCodeFromCallbackUrl(
  pasted: string,
  expectedState?: string,
): { code: string } | { error: string } {
  const trimmed = pasted.trim();
  if (!trimmed) {
    return { error: "The pasted code is empty. Paste the callback URL or authorization code." };
  }
  if (!trimmed.includes("://")) {
    return { code: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "The pasted callback URL is malformed. Paste the full redirect URL from the browser." };
  }
  const denied = url.searchParams.get("error");
  if (denied) {
    return { error: codexDeniedError(url.searchParams.get("error_description") ?? denied) };
  }
  const state = url.searchParams.get("state");
  if (expectedState && state !== expectedState) {
    return { error: "The callback state does not match this login attempt. Restart /login codex and paste the newest redirect URL." };
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    return { error: "The callback URL has no authorization code. Approve Schway in the browser, then paste the full redirect URL." };
  }
  return { code };
}

/** Actionable error when the user denies Schway at the provider consent screen. */
export function codexDeniedError(_detail?: string): string {
  return "ChatGPT sign-in was denied at the provider consent screen. Retry sign-in and approve Schway, or stay on API-key billing.";
}

/** Actionable error when an authorization code or device code has expired. */
export function codexExpiredCodeError(): string {
  return "The sign-in code expired before it was exchanged. Restart /login codex for a fresh code; codes are single-use and short-lived.";
}

/** Actionable error when no subscription login is stored for a headless run. */
export function codexMissingLoginError(): string {
  return "No ChatGPT subscription login found. Sign in in interactive mode with /login codex (or /login codex --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache.";
}

/** Actionable error when the access token expired and no refresh token can renew it. */
export function codexExpiredSessionError(): string {
  return "The ChatGPT subscription session expired and has no refresh token. Sign in again in interactive mode with /login codex.";
}

/** Actionable error when the provider rejects renewal, marking revocation distinctly from expiry. */
export function codexRevokedSessionError(): string {
  return "The ChatGPT subscription session was revoked or rejected by the provider. Sign in again in interactive mode with /login codex; stored API keys are never used as a silent fallback.";
}

/** Actionable error when renewal fails transiently, keeping retry ownership with Schway. */
export function codexRefreshFailedError(detail?: string): string {
  const suffix = detail?.trim() ? ` (${detail.trim()})` : "";
  return `Refreshing the ChatGPT subscription session failed${suffix}. Retry the turn; Schway owns retries and never falls back to API-key billing after explicit codex selection.`;
}

/** Load the stored subscription tokens, returning null when this identity was never saved. */
export async function loadSubscriptionTokens(
  store: CredentialStore,
): Promise<CodexTokens | null> {
  const raw = await store.get(codexSubscriptionIdentity());
  if (!raw?.trim()) {
    return null;
  }
  return parseSubscriptionTokens(raw);
}

/** Persist the subscription tokens at exactly the subscription identity. */
export async function saveSubscriptionTokens(
  store: CredentialStore,
  tokens: CodexTokens,
): Promise<void> {
  await store.set(codexSubscriptionIdentity(), JSON.stringify(serializeSubscriptionTokens(tokens)));
}

/** Commit a completed interactive sign-in and report the secure-store commit point. */
async function commitInteractiveLogin(store: CredentialStore, tokens: CodexTokens, deps: { onSaved?: () => void; onProgress?: CodexProgress }): Promise<void> {
  deps.onProgress?.("Approval received. Saving ChatGPT credential in the OS secure store…");
  try { await saveSubscriptionTokens(store, tokens); }
  catch { throw new Error(credentialStoreError("save")); }
  deps.onSaved?.();
  deps.onProgress?.(formatSubscriptionStatus(tokens));
}

/** Remove only the selected subscription identity, reporting whether one existed. */
export async function clearSubscriptionTokens(
  store: CredentialStore,
): Promise<boolean> {
  return store.delete(codexSubscriptionIdentity());
}

/** Parse stored subscription tokens, rejecting malformed or secretless payloads. */
export function parseSubscriptionTokens(raw: string): CodexTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(codexRevokedSessionError());
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(codexRevokedSessionError());
  }
  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  if (!accessToken) {
    throw new Error(codexRevokedSessionError());
  }
  const refreshToken = typeof record.refreshToken === "string" && record.refreshToken.trim()
    ? record.refreshToken.trim()
    : undefined;
  const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : undefined;
  const accountId = typeof record.accountId === "string" && record.accountId.trim()
    ? record.accountId.trim()
    : undefined;
  const obtainedAt = typeof record.obtainedAt === "number" && Number.isFinite(record.obtainedAt)
    ? record.obtainedAt
    : undefined;
  return { accessToken, refreshToken, expiresAt, accountId, obtainedAt };
}

/** Serialize subscription tokens for the identity-based secure store. */
export function serializeSubscriptionTokens(tokens: CodexTokens): Record<string, unknown> {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
    ...(tokens.obtainedAt !== undefined ? { obtainedAt: tokens.obtainedAt } : {}),
  };
}

/** True when the access token is missing, expired, or inside the pre-expiry refresh skew. */
export function subscriptionAccessExpired(tokens: CodexTokens, now: number = Date.now()): boolean {
  if (!tokens.accessToken.trim()) {
    return true;
  }
  if (tokens.expiresAt === undefined) {
    return false;
  }
  return tokens.expiresAt - CODEX_REFRESH_SKEW_MS <= now;
}

/** Decode the billed ChatGPT account id from the access-token JWT claim without verifying it. */
export function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2 || !parts[1]) {
      return undefined;
    }
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const claim = payload[CODEX_ACCOUNT_CLAIM];
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      return undefined;
    }
    const accountId = (claim as Record<string, unknown>)["chatgpt_account_id"];
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Truthful subscription status for notices and logs, never including token material. */
export function formatSubscriptionStatus(tokens: CodexTokens): string {
  const account = tokens.accountId ?? accountIdFromAccessToken(tokens.accessToken) ?? "unknown account";
  const expiry = tokens.expiresAt !== undefined
    ? `expires ${new Date(tokens.expiresAt).toISOString()}`
    : "no reported expiry";
  return `${CODEX_SUBSCRIPTION_LABEL}: credential saved (account ${account}, ${expiry}); model discovery and activation are still pending.`;
}

/** Exchange one authorization code for subscription tokens with a single transport attempt. */
export async function exchangeCodeForTokens(input: {
  code: string;
  verifier: string;
  fetch?: CodexFetchLike;
  signal?: AbortSignal;
}): Promise<CodexTokens> {
  throwIfAborted(input.signal);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code: input.code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: input.verifier,
  });
  const response = await (input.fetch ?? fetch)(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: input.signal,
  });
  throwIfAborted(input.signal);
  const payload = await readTokenPayload(response, input.signal);
  if (!response.ok) {
    throw new Error(mapTokenEndpointError(response.status, payload));
  }
  return toCodexTokens(payload);
}

/** Renew short-lived access with the offline_access refresh token in one transport attempt. */
export async function refreshSubscriptionTokens(input: {
  refreshToken: string;
  fetch?: CodexFetchLike;
  signal?: AbortSignal;
}): Promise<CodexTokens> {
  throwIfAborted(input.signal);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: input.refreshToken,
  });
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: input.signal,
    });
  } catch (error) {
    throwIfAborted(input.signal);
    throw new Error(codexRefreshFailedError(messageOf(error)));
  }
  throwIfAborted(input.signal);
  const payload = await readTokenPayload(response, input.signal);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new Error(codexRevokedSessionError());
    }
    throw new Error(codexRefreshFailedError(`HTTP ${response.status}`));
  }
  return toCodexTokens(payload);
}

/** Create a serialized single-flight refresher so racing turns share one renewal. */
export function createSubscriptionTokenRefresher(input: {
  store: CredentialStore;
  fetch?: CodexFetchLike;
}): {
  /** Return a valid access token, refreshing once before expiry with racing callers sharing the renewal. */
  getValidAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string }>;
} {
  let inFlight: Promise<CodexTokens> | undefined;
  return {
    async getValidAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string }> {
      throwIfAborted(signal);
      let stored: CodexTokens | null;
      try {
        stored = await loadSubscriptionTokens(input.store);
      } catch {
        throw new Error(codexRevokedSessionError());
      }
      throwIfAborted(signal);
      if (!stored) {
        throw new Error(codexMissingLoginError());
      }
      if (!subscriptionAccessExpired(stored)) {
        return { accessToken: stored.accessToken, accountId: stored.accountId ?? accountIdFromAccessToken(stored.accessToken) };
      }
      if (!stored.refreshToken) {
        throw new Error(codexExpiredSessionError());
      }
      if (!inFlight) {
        const refreshToken = stored.refreshToken;
        const refreshSignal = AbortSignal.timeout(CODEX_REFRESH_TIMEOUT_MS);
        inFlight = refreshSubscriptionTokens({ refreshToken, fetch: input.fetch, signal: refreshSignal })
          .catch((error: unknown) => {
            if (refreshSignal.aborted) {
              throw new Error(
                codexRefreshFailedError(`timed out after ${Math.round(CODEX_REFRESH_TIMEOUT_MS / 1000)}s`),
                { cause: refreshSignal.reason ?? error },
              );
            }
            throw error;
          })
          .then(async (renewed) => {
            const merged: CodexTokens = {
              ...renewed,
              refreshToken: renewed.refreshToken ?? refreshToken,
            };
            await saveSubscriptionTokens(input.store, merged);
            return merged;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      const renewed = await raceWithAbort(inFlight, signal);
      return { accessToken: renewed.accessToken, accountId: renewed.accountId ?? accountIdFromAccessToken(renewed.accessToken) };
    },
  };
}

/** Fetch bounded, visible account-scoped model capabilities using only the subscription identity. */
export async function fetchSubscriptionCatalog(input: {
  store: CredentialStore;
  fetch?: CodexFetchLike;
  signal?: AbortSignal;
}): Promise<ModelCapability[]> {
  const credential = await createSubscriptionTokenRefresher({ store: input.store, fetch: input.fetch })
    .getValidAccessToken(input.signal);
  const deadline = AbortSignal.timeout(5_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${CODEX_MODELS_URL}?client_version=${encodeURIComponent(CODEX_CATALOG_CLIENT_VERSION)}`, {
      method: "GET",
      headers: codexRequestHeaders(credential.accessToken, credential.accountId),
      redirect: "error",
      signal,
    });
  } catch {
    if (input.signal?.aborted) throw new Error("Model discovery cancelled.");
    if (signal.aborted) throw new Error("ChatGPT model catalog timed out. Retry /model.");
    throw new Error("Could not reach the ChatGPT subscription model catalog. Retry /model.");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new Error("ChatGPT model catalog rejected this subscription. Retry /login codex; no API key fallback was used.");
    }
    throw new Error(`ChatGPT model catalog returned HTTP ${response.status}. Retry /model.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ChatGPT model catalog returned no data.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new Error("ChatGPT model catalog exceeds the 1 MiB limit.");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (input.signal?.aborted) throw new Error("Model discovery cancelled.");
    if (signal.aborted) throw new Error("ChatGPT model catalog timed out. Retry /model.");
    if (error instanceof Error && error.message === "ChatGPT model catalog exceeds the 1 MiB limit.") throw error;
    throw new Error("Could not read the ChatGPT model catalog. Retry /model.");
  }
  let payload: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("ChatGPT model catalog returned invalid JSON.");
  }
  if (!payload || typeof payload !== "object" || !("models" in payload) || !Array.isArray(payload.models) || payload.models.length > 256) {
    throw new Error("ChatGPT model catalog returned an invalid model list.");
  }
  const models = new Map<string, ModelCapability>();
  for (const item of payload.models) {
    if (!item || typeof item !== "object" || !("slug" in item) || !("visibility" in item)) continue;
    if (item.visibility !== "list" || typeof item.slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.slug)) continue;
    if (models.has(item.slug)) continue;
    const levels: unknown[] = Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
    const supportedThinking = [...new Set<ThinkingLevel>(levels.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("effort" in entry)) return undefined;
      const effort = entry.effort === "none" ? "off" : entry.effort;
      return THINKING_LEVELS.includes(effort as ThinkingLevel) ? effort as ThinkingLevel : undefined;
    }).filter((level): level is ThinkingLevel => level !== undefined))];
    const defaultThinking = item.default_reasoning_level === "none" ? "off" : item.default_reasoning_level;
    models.set(item.slug, {
      id: item.slug,
      ...(item.default === true || item.is_default === true ? { recommended: true } : {}),
      ...(typeof item.context_window === "number" && Number.isSafeInteger(item.context_window) && item.context_window > 0 && item.context_window <= 10_000_000 ? { contextWindow: item.context_window } : {}),
      ...(typeof item.max_output_tokens === "number" && Number.isSafeInteger(item.max_output_tokens) && item.max_output_tokens > 0 && item.max_output_tokens <= 1_000_000 ? { maxOutput: item.max_output_tokens } : {}),
      ...(supportedThinking.includes(defaultThinking as ThinkingLevel) ? { defaultThinking: defaultThinking as ThinkingLevel } : {}),
      supportedThinking,
    });
  }
  if (!models.size) throw new Error("No selectable models were returned for this ChatGPT subscription.");
  return [...models.values()];
}

/** Fetch visible model slugs without exposing account-specific metadata to older callers. */
export async function fetchSubscriptionModels(input: { store: CredentialStore; fetch?: CodexFetchLike; signal?: AbortSignal }): Promise<string[]> {
  return (await fetchSubscriptionCatalog(input)).map(model => model.id);
}

/** Run the explicit browser PKCE login, persisting tokens at the subscription identity. */
export async function loginWithBrowserFlow(input: {
  store: CredentialStore;
  pastedCode?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  deps?: CodexLoginDeps;
}): Promise<CodexTokens> {
  const deps = input.deps ?? {};
  const timeoutMs = input.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  const signal = input.signal;
  throwIfAborted(signal);
  if (input.pastedCode !== undefined) {
    const pending = pendingBrowserAttempt;
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingBrowserAttempt = undefined;
      if (pending) {
        throw new Error(codexExpiredCodeError());
      }
      throw new Error(
        "No active browser sign-in attempt. Start with /login codex to open the browser, then paste the newest redirect with /login codex --code <callback-url>.",
      );
    }
    const extracted = extractCodeFromCallbackUrl(input.pastedCode, pending.state);
    if ("error" in extracted) {
      throw new Error(extracted.error);
    }
    if (pendingBrowserAttempt?.state === pending.state) {
      pendingBrowserAttempt = undefined;
    }
    const code = extracted.code;
    throwIfAborted(signal);
    const tokens = await exchangeCodeForTokens({ code, verifier: pending.verifier, fetch: deps.fetch, signal });
    throwIfAborted(signal);
    const enriched: CodexTokens = {
      ...tokens,
      accountId: tokens.accountId ?? accountIdFromAccessToken(tokens.accessToken),
      obtainedAt: Date.now(),
    };
    await commitInteractiveLogin(input.store, enriched, deps);
    return enriched;
  }
  const { verifier, challenge, state } = createPkceChallenge(deps.randomBytes);
  const authorizeUrl = buildCodexAuthorizeUrl({ challenge, state });
  pendingBrowserAttempt = { verifier, state, expiresAt: Date.now() + timeoutMs };
  deps.onProgress?.(`Open this URL to sign in with ChatGPT: ${authorizeUrl}`);
  if (!deps.waitForCallbackCode) {
    if (deps.openBrowser) {
      try { await deps.openBrowser(authorizeUrl); }
      catch { deps.onProgress?.("The browser could not be opened automatically; use the printed URL instead."); }
    }
    throw new Error(
      "The localhost callback is unavailable in this environment. Retry with /login codex --device, or paste the redirect with /login codex --code <callback-url>.",
    );
  }
  const listenerAbort = new AbortController();
  const abort = AbortSignal.any(signal ? [signal, listenerAbort.signal] : [listenerAbort.signal]);
  let code: string;
  try {
    // Bind before opening the browser: an existing browser session may redirect immediately.
    const callback = deps.waitForCallbackCode({ expectedState: state, signal: abort, timeoutMs });
    const waiting = waitWithTimeout(
      callback,
      timeoutMs,
      "ChatGPT sign-in timed out waiting for the browser callback. If you already approved in the browser, paste the redirect with /login codex --code <callback-url-or-code>; otherwise retry /login codex, or use /login codex --device on headless machines.",
      abort,
    );
    // Some platform launchers stay alive until the browser closes.
    void Promise.resolve().then(() => deps.openBrowser?.(authorizeUrl)).catch(() => {
      if (!abort.aborted) deps.onProgress?.("The browser could not be opened automatically; use the printed URL instead.");
    });
    code = await waiting;
  } finally {
    listenerAbort.abort();
  }
  throwIfAborted(signal);
  if (pendingBrowserAttempt?.state === state) {
    pendingBrowserAttempt = undefined;
  }
  const tokens = await exchangeCodeForTokens({ code, verifier, fetch: deps.fetch, signal });
  throwIfAborted(signal);
  const enriched: CodexTokens = {
    ...tokens,
    accountId: tokens.accountId ?? accountIdFromAccessToken(tokens.accessToken),
    obtainedAt: Date.now(),
  };
  await commitInteractiveLogin(input.store, enriched, deps);
  return enriched;
}

/** Wait for one localhost authorization callback, validating state and cleaning up the listener. */
export function waitForLocalhostCallback(input: {
  expectedState: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Test override that settles the callback without binding a socket. */
  waitForCallbackCode?: (attempt: {
    expectedState: string;
    signal: AbortSignal;
    timeoutMs: number;
  }) => Promise<string>;
}): Promise<string> {
  if (input.waitForCallbackCode) {
    return input.waitForCallbackCode({
      expectedState: input.expectedState,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
  }
  return new Promise<string>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let settled = false;
    let server: ReturnType<typeof Bun.serve>;
    try { server = Bun.serve({
      port: 1455,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("Not found", { status: 404 });
        }
        if (url.searchParams.get("state") !== input.expectedState) {
          return new Response("This callback belongs to another sign-in attempt. Use the newest browser tab; Schway is still waiting.", { status: 400 });
        }
        const error = url.searchParams.get("error");
        if (error) {
          settle(() => reject(new Error(codexDeniedError(url.searchParams.get("error_description") ?? error))));
          return new Response("ChatGPT sign-in was denied. Return to Schway to retry.", { status: 403 });
        }
        const code = url.searchParams.get("code")?.trim();
        if (!code) {
          return new Response("This callback has no authorization code. Complete sign-in in the newest browser tab; Schway is still waiting.", { status: 400 });
        }
        settle(() => resolve(code));
        return new Response(
          "<!doctype html><title>Schway sign-in received</title><p>Schway received the ChatGPT sign-in callback. Return to the terminal to check that sign-in was saved.</p>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
      error: () => {
        settle(() => reject(new Error("The localhost sign-in callback failed. Choose device approval or paste the browser callback to retry.")));
        return new Response("Callback unavailable", { status: 503 });
      },
    }); } catch {
      reject(new Error("The localhost callback port is unavailable. Choose device approval or paste the browser callback to retry."));
      return;
    }
    const timer = setTimeout(() => {
      settle(() => reject(new Error("ChatGPT sign-in timed out waiting for the browser callback. If you already approved in the browser, paste the redirect with /login codex --code <callback-url-or-code>; otherwise retry /login codex, or use /login codex --device on headless machines.")));
    }, input.timeoutMs);
    const onAbort = () => {
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    function settle(run: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      try {
        // Let the callback response finish before closing its socket.
        void server.stop();
      } catch {
        // Listener cleanup is best-effort once the attempt has settled.
      }
      run();
    }
  });
}

/** Start the headless beta device authorization, reporting the user code for verification. */
export async function requestDeviceAuthorization(input: {
  fetch?: CodexFetchLike;
  signal?: AbortSignal;
}): Promise<CodexDeviceAuthorization> {
  throwIfAborted(input.signal);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(CODEX_DEVICE_USERCODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal: input.signal,
    });
  } catch (error) {
    throwIfAborted(input.signal);
    throw new Error(`Starting device sign-in failed (${messageOf(error)}). Retry /login codex --device.`);
  }
  throwIfAborted(input.signal);
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Starting device sign-in returned an unreadable response. Retry /login codex --device.");
  }
  if (!response.ok) {
    throw new Error(`Starting device sign-in failed (HTTP ${response.status}). Retry /login codex --device.`);
  }
  const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
  const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
  if (!userCode || !deviceCode) {
    throw new Error("Starting device sign-in returned an incomplete authorization. Retry /login codex --device.");
  }
  const verificationUri = typeof payload.verification_uri === "string" && payload.verification_uri.trim()
    ? payload.verification_uri.trim()
    : CODEX_DEVICE_VERIFY_URL;
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : undefined;
  const interval = typeof payload.interval === "number" && Number.isFinite(payload.interval)
    ? payload.interval
    : undefined;
  return { userCode, verificationUri, deviceCode, expiresIn, interval };
}

/** Poll the device grant until approval, denial, expiry, timeout, or cancellation. */
export async function pollDeviceAuthorization(input: {
  deviceCode: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: CodexFetchLike;
}): Promise<CodexTokens> {
  const timeoutMs = input.timeoutMs ?? CODEX_DEVICE_TIMEOUT_MS;
  let intervalMs = input.pollIntervalMs ?? 5_000;
  const started = Date.now();
  const runFetch = input.fetch ?? fetch;
  for (;;) {
    throwIfAborted(input.signal);
    if (Date.now() - started >= timeoutMs) {
      throw new Error("Device sign-in timed out after 900s without approval. Restart /login codex --device for a fresh code.");
    }
    let response: Response;
    try {
      response = await runFetch(CODEX_DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID, device_code: input.deviceCode, grant_type: "device_code" }),
        signal: input.signal,
      });
    } catch {
      throwIfAborted(input.signal);
      throw new Error("Device sign-in polling failed. Check the connection and retry device approval.");
    }
    throwIfAborted(input.signal);
    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error("Device sign-in polling returned an unreadable response. Retry /login codex --device.");
    }
    if (response.ok) {
      return toCodexTokens(payload);
    }
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    if (error === "authorization_pending") {
      await sleepCancellable(intervalMs, input.signal);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5_000;
      await sleepCancellable(intervalMs, input.signal);
      continue;
    }
    if (error === "access_denied") {
      throw new Error(codexDeniedError());
    }
    if (error === "expired_token") {
      throw new Error(codexExpiredCodeError());
    }
    throw new Error(`Device sign-in polling failed (${error}). Retry /login codex --device.`);
  }
}

/** Run the explicit headless beta device login, persisting tokens at the subscription identity. */
export async function loginWithDeviceFlow(input: {
  store: CredentialStore;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  deps?: CodexDeviceDeps;
}): Promise<CodexTokens> {
  const deps = input.deps ?? {};
  throwIfAborted(input.signal);
  const authorization = await requestDeviceAuthorization({ fetch: deps.fetch, signal: input.signal });
  deps.onProgress?.(`Enter this code at ${authorization.verificationUri}: ${authorization.userCode}`);
  throwIfAborted(input.signal);
  const tokens = await pollDeviceAuthorization({
    deviceCode: authorization.deviceCode,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    fetch: deps.fetch,
  });
  throwIfAborted(input.signal);
  const enriched: CodexTokens = {
    ...tokens,
    accountId: tokens.accountId ?? accountIdFromAccessToken(tokens.accessToken),
    obtainedAt: Date.now(),
  };
  await commitInteractiveLogin(input.store, enriched, deps);
  return enriched;
}

/** Serialize supported subscription request fields with opaque conversation metadata preserved. */
export function toCodexResponsesBody(
  request: ModelRequest,
  modelId: string,
  capability?: ModelCapability,
): Record<string, unknown> {
  const reasoning = resolveCodexReasoning(request.thinking, modelId, capability);
  // This endpoint rejects output-token caps, unlike the public Responses API.
  return {
    model: modelId,
    store: false,
    stream: true,
    ...(reasoning !== undefined ? { reasoning } : {}),
    instructions: toCodexInstructions(request),
    input: toCodexInput(request.items),
    include: ["reasoning.encrypted_content"],
    ...(request.tools && request.tools.length > 0 ? { tools: toCodexTools(request.tools) } : {}),
  };
}

/** Build the subscription transport headers, carrying the verified account alongside the Bearer token. */
export function codexRequestHeaders(accessToken: string, accountId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(accountId?.trim() ? { [CODEX_ACCOUNT_HEADER]: accountId.trim() } : {}),
  };
}

/** Resolve a provider-independent level to a Responses reasoning param, leaving defaults untouched when unset. */
export function resolveCodexReasoning(
  level: ThinkingLevel | undefined,
  modelId: string,
  capability?: ModelCapability,
):
  | { effort: "none" }
  | { effort: Exclude<ThinkingLevel, "off">; summary: "auto" }
  | undefined {
  assertThinking({ provider: "openai", model: modelId, capability: capability ?? null }, level);
  if (level === undefined) return undefined;
  if (level === "off") return { effort: "none" };
  return { effort: level, summary: "auto" };
}

/** Normalized streaming event accepted from the subscription Responses transport. */
export type CodexStreamEvent = {
  type: string;
  output_index?: number;
  delta?: string;
  item?: CodexOutputItem;
  response?: { id?: string; status?: string; usage?: unknown; error?: { message?: string } };
  message?: string;
};

/** Output item payload carried by subscription stream lifecycle events. */
export type CodexOutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: Array<{ text?: string }>;
};

function requiredModelId(model: string | undefined): string {
  const modelId = model?.trim() ?? "";
  if (!modelId) throw new Error("A model ID is required.");
  return modelId;
}

/**
 * Create the subscription Responses adapter with transport retries disabled and Schway-owned records.
 * Streaming forwards cancellation and provider failures while assembling function-call JSON before exposing a call.
 */
export function createCodexSubscriptionModel(options: {
  model?: string;
  /** Accepted from shared model settings; the subscription endpoint does not support an output cap. */
  maxTokens?: number;
  thinking?: ThinkingLevel;
  /** Verified capabilities for this exact account and model. */
  modelCapability?: ModelCapability;
  tokens?: CodexTokens;
  refresher?: { getValidAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string }> };
  store?: CredentialStore;
  fetch?: CodexFetchLike;
  secrets?: string[];
  onRequest?: (request: {
    model: string;
    instructions: string;
    input: unknown[];
    tools: Array<{ name: string; description: string }>;
  }) => void;
}): Model {
  const modelId = requiredModelId(options.model);
  const secrets = [...(options.secrets ?? [])];
  const refresher = options.refresher ??
    (options.store ? createSubscriptionTokenRefresher({ store: options.store, fetch: options.fetch }) : undefined);
  const runFetch = options.fetch ?? fetch;
  if (options.tokens?.accessToken) {
    rememberSecret(secrets, options.tokens.accessToken);
  }

  return {
    provider: "codex-subscription",
    id: modelId,
    /** Stream normalized subscription deltas and a completed message, forwarding cancellation without retries. */
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const credential = await resolveStreamCredential(
        { tokens: options.tokens, refresher },
        request.signal,
        secrets,
      );
      const body = toCodexResponsesBody(
        { ...request, thinking: request.thinking ?? options.thinking },
        modelId,
        options.modelCapability,
      );
      options.onRequest?.({
        model: modelId,
        instructions: body["instructions"] as string,
        input: body["input"] as unknown[],
        tools: ((body["tools"] as Array<{ name: string; description: string }> | undefined) ?? []),
      });
      let response: Response;
      try {
        response = await runFetch(CODEX_RESPONSES_URL, {
          method: "POST",
          headers: codexRequestHeaders(credential.accessToken, credential.accountId),
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        throwIfAborted(request.signal, secrets);
        throw new Error(redact(`ChatGPT subscription request failed (${messageOf(error)}). Retry the turn; Schway owns retries.`, secrets));
      }
      if (!response.ok) {
        throw new Error(redact(await mapResponsesError(response), secrets));
      }
      const builder = createCodexStreamBuilder();
      for await (const event of readCodexStreamEvents(response, request.signal)) {
        if (["response.completed", "response.incomplete", "response.failed"].includes(event.type) && event.response?.usage && typeof event.response.usage === "object") {
          const usage = event.response.usage as Record<string, unknown>;
          yield { type: "usage", usage: {
            inputTokens: reportedTokens(usage.input_tokens),
            outputTokens: reportedTokens(usage.output_tokens),
          } };
        }
        if (event.type === "response.incomplete") {
          throw new Error("ChatGPT subscription response incomplete");
        }
        if (event.type === "response.failed") {
          throw new Error(redact(event.response?.error?.message || "ChatGPT subscription response failed", secrets));
        }
        if (event.type === "error") {
          throw new Error(redact(event.message || "ChatGPT subscription stream failed", secrets));
        }
        for (const delta of builder.accept(event)) {
          throwIfAborted(request.signal, secrets);
          yield delta;
        }
      }
      throwIfAborted(request.signal, secrets);
      yield { type: "message_complete", message: builder.complete() };
    },
  };
}

/** Stable system prompt plus dynamic context as subscription instructions. */
function toCodexInstructions(request: ModelRequest): string {
  const sections = request.context.map(
    (section) => `<${section.name}>\n${section.content}\n</${section.name}>`,
  );
  return [request.systemPrompt, ...sections].join("\n\n");
}

/** Map Schway tool definitions onto Responses function tools. */
function toCodexTools(tools: readonly ModelTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

/** Convert Schway conversation items to Responses input, preserving opaque codex/openai metadata. */
function toCodexInput(items: readonly ConversationItem[]): unknown[] {
  const input: unknown[] = [];
  for (const item of items) {
    if (item.type === "user") {
      input.push({
        role: "user",
        content: item.content.map((block) => ({ type: "input_text", text: block.text })),
      });
      continue;
    }
    if (item.type === "tool_result") {
      input.push({
        type: "function_call_output",
        call_id: item.toolCallId,
        output: item.content,
      });
      continue;
    }
    for (const block of item.content) {
      if (block.type === "thinking") {
        const reasoning = codexField(block.providerMetadata, "item");
        if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
          input.push(reasoning);
        }
        continue;
      }
      if (block.type === "text") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        });
        continue;
      }
      const itemId = codexField(block.providerMetadata, "item_id");
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: toCodexToolArguments(block.arguments),
        ...(typeof itemId === "string" && itemId.length > 0 ? { id: itemId } : {}),
      });
    }
  }
  return input;
}

/** JSON-stringify tool arguments, sending strings unchanged. */
function toCodexToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** Read an opaque field from codex metadata, accepting prior openai namespacing after auth switches. */
function codexField(metadata: ProviderMetadata | undefined, key: string): unknown {
  for (const namespace of ["codex", "openai"] as const) {
    const scoped = metadata?.[namespace];
    if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
      const value = (scoped as Record<string, unknown>)[key];
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

/** In-progress output item while assembling a subscription stream. */
type CodexStreamBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; item?: unknown }
  | { type: "tool_call"; id: string; name: string; json: string; itemId?: string };

/** Accumulate subscription stream events into Schway deltas and a final message. */
function createCodexStreamBuilder(): {
  accept(event: CodexStreamEvent): ModelStreamEvent[];
  complete(): AssistantMessage;
} {
  const id = crypto.randomUUID();
  let responseId: string | undefined;
  let status: string | undefined;
  let usage: unknown;
  const blocks: CodexStreamBlock[] = [];

  return {
    /** Fold one transport event into blocks and emit Schway deltas. */
    accept(event: CodexStreamEvent): ModelStreamEvent[] {
      switch (event.type) {
        case "response.created":
          responseId = event.response?.id ?? responseId;
          status = event.response?.status ?? status;
          return [];
        case "response.output_item.added":
          if (event.item) {
            startCodexBlock(blocks, event.output_index ?? 0, event.item);
          }
          return [];
        case "response.output_text.delta":
          return appendCodexText(blocks, event.output_index ?? 0, event.delta ?? "");
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          return appendCodexThinking(blocks, event.output_index ?? 0, event.delta ?? "");
        case "response.function_call_arguments.delta":
          appendCodexToolJson(blocks, event.output_index ?? 0, event.delta ?? "");
          return [];
        case "response.output_item.done":
          if (event.item) {
            finishCodexBlock(blocks, event.output_index ?? 0, event.item);
          }
          return [];
        case "response.completed":
        case "response.incomplete":
          responseId = event.response?.id ?? responseId;
          status = event.response?.status ?? status;
          if (event.response?.usage !== undefined) {
            usage = event.response.usage;
          }
          return [];
        default:
          return [];
      }
    },
    /** Build the Schway assistant message after the stream ends. */
    complete(): AssistantMessage {
      const content: AssistantContent[] = [];
      for (const block of blocks) {
        if (!block) {
          continue;
        }
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.text && block.item === undefined) {
            continue;
          }
          content.push({
            type: "thinking",
            text: block.text,
            ...(block.item !== undefined ? { providerMetadata: { codex: { item: block.item } } } : {}),
          });
          continue;
        }
        content.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: parseCodexToolArguments(block.json),
          ...(block.itemId ? { providerMetadata: { codex: { item_id: block.itemId } } } : {}),
        });
      }
      const codex: Record<string, unknown> = {};
      if (responseId) {
        codex.response_id = responseId;
      }
      if (status) {
        codex.status = status;
      }
      if (usage !== undefined) {
        codex.usage = usage;
      }
      return {
        type: "assistant",
        id,
        content,
        ...(Object.keys(codex).length > 0 ? { providerMetadata: { codex } } : {}),
      };
    },
  };
}

/** Open a stream block from an output_item.added payload. */
function startCodexBlock(blocks: CodexStreamBlock[], index: number, item: CodexOutputItem): void {
  if (item.type === "message") {
    blocks[index] = { type: "text", text: "" };
    return;
  }
  if (item.type === "reasoning") {
    blocks[index] = { type: "thinking", text: "" };
    return;
  }
  if (item.type === "function_call") {
    blocks[index] = codexToolCallBlock(item);
  }
}

/** Finalize a block from output_item.done, capturing reasoning metadata. */
function finishCodexBlock(blocks: CodexStreamBlock[], index: number, item: CodexOutputItem): void {
  if (item.type === "reasoning") {
    const summary = (item.summary ?? []).map((part) => part.text ?? "").filter((text) => text.length > 0).join("\n\n");
    const current = blocks[index];
    if (!current || current.type !== "thinking") {
      blocks[index] = { type: "thinking", text: summary, item };
      return;
    }
    if (current.text.length === 0 && summary.length > 0) {
      current.text = summary;
    }
    current.item = item;
    return;
  }
  if (item.type === "function_call") {
    const next = codexToolCallBlock(item);
    const current = blocks[index];
    if (!current || current.type !== "tool_call") {
      blocks[index] = next;
      return;
    }
    if (next.id) {
      current.id = next.id;
    }
    if (next.name) {
      current.name = next.name;
    }
    if (next.json.length > 0) {
      current.json = next.json;
    }
    if (next.itemId) {
      current.itemId = next.itemId;
    }
  }
}

/** Read call_id, name, and argument JSON from a function_call item. */
function codexToolCallBlock(item: CodexOutputItem): Extract<CodexStreamBlock, { type: "tool_call" }> {
  return {
    type: "tool_call",
    id: item.call_id ?? "",
    name: item.name ?? "",
    json: item.arguments ?? "",
    ...(item.id ? { itemId: item.id } : {}),
  };
}

/** Append output_text and emit a text_delta. */
function appendCodexText(blocks: CodexStreamBlock[], index: number, text: string): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "text") {
    blocks[index] = { type: "text", text };
  } else {
    current.text += text;
  }
  return [{ type: "text_delta", text }];
}

/** Append reasoning text and emit a thinking_delta. */
function appendCodexThinking(blocks: CodexStreamBlock[], index: number, text: string): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "thinking") {
    blocks[index] = { type: "thinking", text };
  } else {
    current.text += text;
  }
  return [{ type: "thinking_delta", text }];
}

/** Append streamed function-call argument JSON. */
function appendCodexToolJson(blocks: CodexStreamBlock[], index: number, json: string): void {
  const current = blocks[index];
  if (current && current.type === "tool_call") {
    current.json += json;
  }
}

/** Parse assembled tool JSON, returning malformed input as the raw string. */
function parseCodexToolArguments(json: string): unknown {
  if (json.length === 0) {
    return {};
  }
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Resolve the Bearer credential for one stream, refreshing short-lived tokens before expiry. */
async function resolveStreamCredential(
  input: {
    tokens?: CodexTokens;
    refresher?: { getValidAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string }> };
  },
  signal: AbortSignal | undefined,
  secrets: string[],
): Promise<{ accessToken: string; accountId?: string }> {
  throwIfAborted(signal, secrets);
  if (input.refresher) {
    try {
      return await input.refresher.getValidAccessToken(signal);
    } catch (error) {
      throwIfAborted(signal, secrets);
      throw error instanceof Error ? error : new Error(messageOf(error));
    }
  }
  const tokens = input.tokens;
  if (!tokens?.accessToken.trim()) {
    throw new Error(redact(codexMissingLoginError(), secrets));
  }
  if (subscriptionAccessExpired(tokens)) {
    throw new Error(redact(tokens.refreshToken ? codexRefreshFailedError("no renewal channel in this session; reload with a store-backed refresher") : codexExpiredSessionError(), secrets));
  }
  rememberSecret(secrets, tokens.accessToken);
  return { accessToken: tokens.accessToken, accountId: tokens.accountId ?? accountIdFromAccessToken(tokens.accessToken) };
}

/** Map a failed Responses HTTP status to a distinct actionable subscription error. */
async function mapResponsesError(response: Response): Promise<string> {
  const detail = await readErrorDetail(response);
  if (response.status === 401) {
    return codexRevokedSessionError();
  }
  if (response.status === 402 || response.status === 403) {
    return `The ChatGPT subscription request was refused (HTTP ${response.status}${detail}). Check workspace membership, seat entitlements, and Plus/Pro status, then retry.`;
  }
  if (response.status === 429) {
    return `The ChatGPT subscription is rate-limited (HTTP 429${detail}). Retry the turn; Schway owns retries.`;
  }
  if (response.status >= 500) {
    return `The ChatGPT subscription transport failed transiently (HTTP ${response.status}${detail}). Retry the turn; Schway owns retries.`;
  }
  return `ChatGPT subscription request failed (HTTP ${response.status}${detail}).`;
}

/** Read a bounded provider error detail without leaking transport internals. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim().slice(0, 300);
    return trimmed ? `: ${trimmed}` : "";
  } catch {
    return "";
  }
}

/** Map a failed token endpoint payload to the distinct missing/expired/revoked login errors. */
function mapTokenEndpointError(status: number, payload: Record<string, unknown>): string {
  const error = typeof payload.error === "string" ? payload.error : "";
  if (error === "access_denied") {
    return codexDeniedError();
  }
  if (error === "invalid_grant" || error === "expired_token") {
    return codexExpiredCodeError();
  }
  if (status === 401) {
    return codexRevokedSessionError();
  }
  return `Exchanging the sign-in code failed (HTTP ${status}). Start a fresh sign-in attempt.`;
}

/** Normalize a token endpoint payload into stored subscription tokens. */
function toCodexTokens(payload: Record<string, unknown>): CodexTokens {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("The sign-in response has no access token. Restart /login codex for a fresh attempt.");
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : undefined;
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? payload.expires_in
    : undefined;
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    accountId: accountIdFromAccessToken(accessToken),
  };
}

/** Read a token endpoint JSON payload, rejecting unreadable bodies actionably. */
async function readTokenPayload(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("unreadable");
    }
    return payload as Record<string, unknown>;
  } catch {
    throwIfAborted(signal);
    throw new Error("The sign-in endpoint returned an unreadable response. Retry sign-in.");
  }
}

/** Read SSE transport events from a Responses stream, honoring Schway cancellation. */
async function *readCodexStreamEvents(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncIterable<CodexStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("ChatGPT subscription stream has no readable body. Retry the turn.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) {
        buffer += decoder.decode();
        for (const event of splitCodexSse(buffer, true).events) {
          yield event;
        }
        return;
      }
      const events = splitCodexSse(buffer, false);
      buffer = events.rest;
      for (const event of events.events) {
        throwIfAborted(signal);
        yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader release is best-effort once the stream has settled.
    }
  }
}

/** Split buffered SSE text into complete data events, keeping the partial tail. */
function splitCodexSse(buffer: string, final: boolean): { events: CodexStreamEvent[]; rest: string } {
  const events: CodexStreamEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = final ? "" : (parts.pop() ?? "");
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .map((line) => (line.startsWith("data:") ? line.slice("data:".length).trim() : null))
      .filter((line): line is string => line !== null);
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      events.push(JSON.parse(data) as CodexStreamEvent);
    } catch {
      throw new Error("ChatGPT subscription stream sent an unreadable event. Retry the turn.");
    }
  }
  return { events, rest };
}

/** Sleep until the next device poll, settling early on Schway cancellation. */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race a settling promise against Schway cancellation without leaving dangling handlers. */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Await a login promise with a ceiling, reporting timeouts actionably. */
function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Throw an AbortError when the Schway-owned cancellation signal fires, redacting secrets. */
function throwIfAborted(signal: AbortSignal | undefined, secrets: string[] = []): void {
  if (signal?.aborted) {
    const error = new DOMException("Aborted", "AbortError");
    if (secrets.length === 0) {
      throw error;
    }
    throw new DOMException(redact(error.message, secrets), error.name);
  }
}

/** Remember one secret for error redaction without storing duplicates. */
function rememberSecret(secrets: string[], secret: string): void {
  if (secret.length > 0 && !secrets.includes(secret)) {
    secrets.push(secret);
  }
}

/** Replace secret substrings so subscription failures never leak credentials. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Normalize thrown values into a printable error string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Encode bytes as unpadded base64url for PKCE and state values. */
function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decode an unpadded base64url payload segment. */
function base64UrlDecode(segment: string): string {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(padded, "base64").toString("utf8");
}
