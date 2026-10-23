import type { Model } from "../model/model.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, createNativeCredentialStore, type CredentialStore } from "../auth/store.ts";

/** Selected subscription route; billing and endpoint identity stay with this choice. */
export type HostAuthRoute = "codex" | "grok";

/** Opaque credential address; never carries token material. */
export interface HostCredentialReference {
  readonly account: string;
  readonly label: string;
}

/** Secure-store boundary for a selected route; missing reads return null and deletions report presence. */
export interface HostCredentialStore {
  /** Read one credential, returning null when its identity is absent. */
  get(identity: HostCredentialReference): Promise<string | null>;
  /** Save or replace the credential at exactly one identity. */
  set(identity: HostCredentialReference, value: string): Promise<void>;
  /** Delete one identity, returning whether a credential existed. */
  delete(identity: HostCredentialReference): Promise<boolean>;
}

/** Fetch override used by deterministic protocol fixtures; production uses global fetch. */
export type HostAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Explicit route/model binding without raw tokens or API-key material. */
export interface HostAuthSelection {
  route: HostAuthRoute;
  model: string;
  store?: HostCredentialStore;
  env?: Record<string, string | undefined>;
  fetch?: HostAuthFetch;
}

/** Stable safe categories for selected-route readiness and inference failures. */
export type HostAuthStatusCode =
  | "configured-unverified"
  | "needs-login"
  | "store-unavailable"
  | "invalid-store"
  | "rejected"
  | "quota-exceeded"
  | "model-unavailable"
  | "integration-unavailable";

/** Selected-route readiness with safe next-action guidance and no secret payloads. */
export interface HostAuthReadiness {
  readonly route: HostAuthRoute;
  readonly model: string;
  readonly credential: HostCredentialReference;
  readonly status: HostAuthStatusCode;
  readonly nextAction: string;
  readonly observedInference: "not-checked" | "observed";
}

/** Static route description without store access, network, or adapter loading. */
export interface HostAuthDescription {
  readonly route: HostAuthRoute;
  readonly model: string;
  readonly credential: HostCredentialReference;
  readonly supported: true;
}

/** Terminal observation for a route-bound run with safe auth detail on failures. */
export type HostAuthRunResult =
  | { outcome: "completed"; input: import("./index.ts").HostEntryReference; result: import("./index.ts").HostEntryReference;
      message: import("../conversation/types.ts").AssistantMessage; observedInference: "observed" }
  | { outcome: "error" | "cancelled" | "max_turns"; input: import("./index.ts").HostEntryReference; auth: HostAuthReadiness };

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Return the opaque credential address for the selected route without reading secrets. */
export function credentialReferenceForRoute(route: HostAuthRoute): HostCredentialReference {
  const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
  return { account: identity.account, label: identity.label };
}

/** Validate an explicit route/model binding; raw tokens and API keys are never accepted. */
export function validateAuthSelection(input: unknown): HostAuthSelection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => !["route", "model", "store", "env", "fetch"].includes(key))) throw new Error("invalid");
  const route = record["route"];
  if (route !== "codex" && route !== "grok") throw new Error("unsupported");
  const model = record["model"];
  if (typeof model !== "string" || !MODEL_PATTERN.test(model.trim())) throw new Error("invalid");
  const store = record["store"];
  if (store !== undefined) {
    if (typeof store !== "object" || store === null || typeof (store as HostCredentialStore).get !== "function" ||
        typeof (store as HostCredentialStore).set !== "function" || typeof (store as HostCredentialStore).delete !== "function") throw new Error("invalid");
  }
  const env = record["env"];
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) throw new Error("invalid");
  const fetch = record["fetch"];
  if (fetch !== undefined && typeof fetch !== "function") throw new Error("invalid");
  return { route, model: (model as string).trim(), ...(store !== undefined ? { store: store as HostCredentialStore } : {}),
    ...(env !== undefined ? { env: env as Record<string, string | undefined> } : {}),
    ...(fetch !== undefined ? { fetch: fetch as HostAuthFetch } : {}) };
}

/** Describe the selected route statically without store, network, or provider loading. */
export function describeAuthRoute(selection: HostAuthSelection): HostAuthDescription {
  const valid = validateAuthSelection(selection);
  return { route: valid.route, model: valid.model, credential: credentialReferenceForRoute(valid.route), supported: true as const };
}

/** Resolve the effective store without exposing native errors or creating plaintext fallback. */
function effectiveStore(selection: HostAuthSelection): CredentialStore {
  return (selection.store ?? createNativeCredentialStore()) as CredentialStore;
}

function needsLoginAction(route: HostAuthRoute): string {
  return route === "codex"
    ? "No ChatGPT subscription login found. Sign in in interactive mode with /login chatgpt (or /login chatgpt --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache."
    : "No Grok subscription login found. Sign in in interactive mode with /login grok (or /login grok --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache.";
}

function storeUnavailableAction(): string {
  return "Cannot read credential in the OS secure store. Unlock or allow access to your OS credential store; on Linux install libsecret and start a Secret Service. Retry after restoring access. For reads, --api-key or the provider API-key environment variable bypasses the store. No plaintext fallback is used.";
}

function invalidStoreAction(route: HostAuthRoute): string {
  return route === "codex"
    ? "Stored ChatGPT subscription login is invalid. Sign in again with /login chatgpt."
    : "Stored Grok subscription login is invalid. Sign in again with /login grok.";
}

/** Check local store readiness without network or inference; only the selected route identity is read. */
export async function checkAuthReadiness(selection: HostAuthSelection): Promise<HostAuthReadiness> {
  const valid = validateAuthSelection(selection);
  const credential = credentialReferenceForRoute(valid.route);
  const base = { route: valid.route, model: valid.model, credential, observedInference: "not-checked" as const };
  const store = effectiveStore(valid);
  const identity = valid.route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
  let raw: string | null;
  try {
    raw = await store.get(identity);
  } catch {
    return { ...base, status: "store-unavailable", nextAction: storeUnavailableAction() };
  }
  if (!raw?.trim()) return { ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) };
  try {
    if (valid.route === "codex") {
      const { parseSubscriptionTokens, subscriptionAccessExpired } = await import("../model/providers/codex-subscription.ts");
      const tokens = parseSubscriptionTokens(raw);
      if (subscriptionAccessExpired(tokens) && !tokens.refreshToken) return { ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) };
    } else {
      const { parseSubscriptionTokens, subscriptionAccessExpired } = await import("../model/providers/grok-subscription.ts");
      const tokens = parseSubscriptionTokens(raw);
      if (subscriptionAccessExpired(tokens) && !tokens.refreshToken) return { ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) };
    }
  } catch {
    return { ...base, status: "invalid-store", nextAction: invalidStoreAction(valid.route) };
  }
  return { ...base, status: "configured-unverified", nextAction: "Run a route-bound request to observe inference; static configuration alone does not prove live access." };
}

/** Create only the selected subscription adapter; the unselected route and TUI never load. */
export async function createAuthRouteModel(selection: HostAuthSelection): Promise<Model> {
  const valid = validateAuthSelection(selection);
  const store = effectiveStore(valid);
  const { loadProviderModel } = await import("../model/loader.ts");
  if (valid.route === "codex") {
    return loadProviderModel({ provider: "openai", openaiAuth: "codex", model: valid.model, codexStore: store }, valid.fetch);
  }
  return loadProviderModel({ provider: "xai", xaiAuth: "grok", model: valid.model, grokStore: store }, valid.fetch);
}

function httpStatusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    if (typeof current === "object") {
      const record = current as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
      if (typeof record.status === "number" && Number.isFinite(record.status)) return record.status;
      if (typeof record.statusCode === "number" && Number.isFinite(record.statusCode)) return record.statusCode;
      if (typeof record.response?.status === "number" && Number.isFinite(record.response.status)) return record.response.status;
      if (!("cause" in record)) break;
      current = (record as { cause?: unknown }).cause;
    } else break;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** Map a route-bound failure to a stable safe category without leaking secrets or switching routes. */
export function classifyAuthError(error: unknown, selection: HostAuthSelection): HostAuthReadiness {
  const valid = validateAuthSelection(selection);
  const credential = credentialReferenceForRoute(valid.route);
  const base = { route: valid.route, model: valid.model, credential, observedInference: "not-checked" as const };
  const text = errorText(error);
  const status = httpStatusOf(error);
  if (/Cannot (read|save|delete) credential|secure store|Secret Service|libsecret/i.test(text)) {
    return { ...base, status: "store-unavailable", nextAction: storeUnavailableAction() };
  }
  if (/No ChatGPT subscription login|No Grok subscription login|expired.*no refresh token|no refresh token/i.test(text)) {
    return { ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) };
  }
  if (/Stored .* subscription login is invalid|revoked|rejected by the provider|rejected by xAI|denied|Plus\/Pro|membership|seat|entitlement|Your Grok plan doesn't include API access/i.test(text) ||
      status === 401 || status === 402 || status === 403) {
    const nextAction = valid.route === "codex"
      ? "The ChatGPT subscription session was rejected. Sign in again in interactive mode with /login chatgpt; stored API keys are never used as a silent fallback."
      : "The Grok subscription session was rejected. Sign in again in interactive mode with /login grok; stored API keys are never used as a silent fallback.";
    if (/Your Grok plan doesn't include API access/.test(text) && valid.route === "grok") {
      return { ...base, status: "rejected", nextAction: "Your Grok plan doesn't include API access. Use an xAI API key instead." };
    }
    return { ...base, status: "rejected", nextAction };
  }
  if (/rate-limited|rate limit|HTTP 429/i.test(text) || status === 429) {
    return { ...base, status: "quota-exceeded",
      nextAction: valid.route === "codex"
        ? "The ChatGPT subscription is rate-limited (HTTP 429). Retry the turn; Schway owns retries."
        : "The Grok subscription is rate-limited. Retry the turn; Schway owns retries." };
  }
  if (/unknown.*model|model.*(not found|unavailable|does not exist|invalid)|not supported|subscription catalog|No selectable models/i.test(text) ||
      ((status === 400 || status === 404 || status === 422) && /model/i.test(text))) {
    return { ...base, status: "model-unavailable",
      nextAction: `Model ${valid.model} is not available on this subscription. Choose a listed model for this route.` };
  }
  return { ...base, status: "integration-unavailable",
    nextAction: valid.route === "codex"
      ? "Could not reach the ChatGPT subscription. Retry the turn; Schway owns retries and never falls back to API-key billing."
      : "Could not reach the Grok subscription. Retry the turn; Schway owns retries and never falls back to API-key billing." };
}

/** True when a value contains none of the supplied secret sentinels. */
export function containsNoSecrets(value: unknown, sentinels: readonly string[]): boolean {
  if (sentinels.length === 0) return true;
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return sentinels.every(sentinel => sentinel.length === 0 || !text.includes(sentinel));
}
