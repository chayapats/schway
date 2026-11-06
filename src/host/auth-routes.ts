import type { Model } from "../model/model.ts";
import { credentialLifecycleStore, lifecycleModel, validateCredentialLifecycle, type CredentialLifecycleLease, type HostCredentialLifecycle } from "./credential-lifecycle.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, createNativeCredentialStore, credentialWriteRefusedError, findCredentialLockError, isCleanupUncertain, isCredentialWriteRefused, markCleanupUncertain, replaceCredential, type CredentialIdentity, type CredentialStore } from "../auth/store.ts";
import { dispatchRouteModel, routeModelOptions, type HostRouteModelOptions, type RouteControls } from "./dispatch.ts";
import { catalogCapability, effortSupport, exactEffort, outputCapSupport, routeOutputCap, type HostEffortSupport, type HostOutputCapSupport } from "./route-capabilities.ts";
import { hasDispatchRefusal, hasRedirectRefusal, routeControlRefusal } from "../model/dispatch.ts";
import { HostError } from "./index.ts";

export { isCleanupUncertain, isCredentialWriteRefused };

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
  /**
   * Atomically delete exactly the expected value, reporting whether anything
   * was removed. Returns false only on a proven value mismatch; backend
   * failures reject so the guarded wrapper never mistakes an uncertain
   * cleanup for a clean one. Optional: the guarded wrapper prefers it and
   * falls back to a serialized read-then-delete otherwise.
   */
  compareAndDelete?(identity: HostCredentialReference, expectedValue: string): Promise<boolean>;
  // Optional: without it, a renewal reads, compares and then sets, and another writer can overtake it in between.
  /** Atomically replace exactly the expected value, returning false without writing when the stored value differs. */
  compareAndSet?(identity: HostCredentialReference, expectedValue: string, value: string): Promise<boolean>;
}

/** Fetch override used by deterministic protocol fixtures; production uses global fetch. */
export type HostAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Embedding-application fence for credential-store mutations; throwing refuses the write.
 * Applies to host route writes resolved through the effective store; interactive
 * management flows use raw stores outside any embedding attempt. The guard runs
 * before every write and is rechecked after the backend write completes: a
 * refusal after the write removes exactly the value just written (compare and
 * delete) unless a shared lifecycle's valid sibling still authorizes it. With a
 * lifecycle, guards can run during readiness before the caller's stream starts;
 * refusal fences that caller even when a sibling retains the renewed value. */
export type HostCredentialWriteGuard = (identity: HostCredentialReference) => Promise<void> | void;

/** Explicit route/model binding without raw tokens or API-key material. */
export interface HostAuthSelection {
  route: HostAuthRoute;
  model: string;
  store?: HostCredentialStore;
  /** Shared opaque credential owner; mutually exclusive with store. */
  lifecycle?: HostCredentialLifecycle;
  env?: Record<string, string | undefined>;
  fetch?: HostAuthFetch;
  /** Optional fence invoked before every credential-store write; reads stay unfenced. */
  credentialWriteGuard?: HostCredentialWriteGuard;
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
  | "integration-unavailable"
  | "dispatch-refused";

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
  /** Effort the adapter accepts without account evidence: none for subscription routes; list models for the real support. */
  readonly effort: HostEffortSupport;
  /** Whether this route sends a provider-enforced output cap, with its default and maximum. */
  readonly outputCap: HostOutputCapSupport;
}

/** Terminal observation for a route-bound run with safe auth detail on failures. */
export type HostAuthRunResult =
  | import("./image-input.ts").HostImagesRejected
  | { outcome: "completed"; input: import("./index.ts").HostEntryReference; result: import("./index.ts").HostEntryReference;
      message: import("../conversation/types.ts").AssistantMessage; observedInference: "observed"; usage: import("./index.ts").HostRunUsage; steering: import("./steering.ts").HostSteeringReport }
  | { outcome: "error" | "cancelled" | "max_turns" | "limit_exceeded"; input: import("./index.ts").HostEntryReference; auth: HostAuthReadiness; usage: import("./index.ts").HostRunUsage; steering: import("./steering.ts").HostSteeringReport };

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Return the opaque credential address for the selected route without reading secrets. */
export function credentialReferenceForRoute(route: HostAuthRoute): HostCredentialReference {
  const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
  return { account: identity.account, label: identity.label };
}

/** Validate an explicit route/model binding; raw tokens and API keys are never accepted.
 * @internal Host composition only; external callers use createHost validation instead.
 */
export function validateAuthSelection(input: unknown): HostAuthSelection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid");
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => !["route", "model", "store", "lifecycle", "env", "fetch", "credentialWriteGuard"].includes(key))) throw new Error("invalid");
  const route = record["route"];
  if (route !== "codex" && route !== "grok") throw new Error("unsupported");
  const model = record["model"];
  if (typeof model !== "string" || !MODEL_PATTERN.test(model.trim())) throw new Error("invalid");
  const store = record["store"];
  const lifecycle = record["lifecycle"] as HostCredentialLifecycle | undefined;
  if (lifecycle !== undefined) {
    if (store !== undefined) throw new Error("invalid");
    validateCredentialLifecycle(lifecycle);
  }
  if (store !== undefined) {
    if (typeof store !== "object" || store === null || typeof (store as HostCredentialStore).get !== "function" ||
        typeof (store as HostCredentialStore).set !== "function" || typeof (store as HostCredentialStore).delete !== "function") throw new Error("invalid");
  }
  const env = record["env"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) throw new Error("invalid");
    if (Object.keys(env).length > 64) throw new Error("invalid");
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || (value !== undefined && typeof value !== "string")) throw new Error("invalid");
    }
  }
  const fetch = record["fetch"];
  if (fetch !== undefined && typeof fetch !== "function") throw new Error("invalid");
  const credentialWriteGuard = record["credentialWriteGuard"];
  if (credentialWriteGuard !== undefined && typeof credentialWriteGuard !== "function") throw new Error("invalid");
  return { route, model: (model as string).trim(), ...(store !== undefined ? { store: store as HostCredentialStore } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
    ...(env !== undefined ? { env: env as Record<string, string | undefined> } : {}),
    ...(fetch !== undefined ? { fetch: fetch as HostAuthFetch } : {}),
    ...(credentialWriteGuard !== undefined ? { credentialWriteGuard: credentialWriteGuard as HostCredentialWriteGuard } : {}) };
}

/** Describe the selected route statically without store, network, or provider loading. */
export function describeAuthRoute(selection: HostAuthSelection): HostAuthDescription {
  const valid = validateAuthSelection(selection);
  return { route: valid.route, model: valid.model, credential: credentialReferenceForRoute(valid.route), supported: true as const,
    effort: effortSupport(valid.route, valid.model, null), outputCap: outputCapSupport(valid.route, valid.model) };
}

// The process's OS secure store is one owner for every selection that names no store or lifecycle.
const NATIVE_OWNER: object = Object.freeze({});

/** Identity of the credentials a selection reads: a lifecycle's current route store (replaced on logout), the explicit store, or the OS store. @internal */
export function credentialOwner(selection: HostAuthSelection): object {
  if (selection.lifecycle) return credentialLifecycleStore(selection.lifecycle, selection.route);
  return selection.store ?? NATIVE_OWNER;
}

const defaultNativeStores = new WeakMap<object, CredentialStore>();
const guardedStores = new WeakMap<object, { guard: HostCredentialWriteGuard; store: CredentialStore }>();

/** Resolve the effective store without exposing native errors or creating plaintext fallback.
 * @internal Host composition only; keyed by caller selection identity so concurrent
 * route runs on one runtime share one renewal lifecycle for the default native store.
 */
export function effectiveStore(selection: HostAuthSelection): CredentialStore {
  if (selection.lifecycle) return credentialLifecycleStore(selection.lifecycle, selection.route);
  const base = (() => {
    if (selection.store) return selection.store as CredentialStore;
    let cached = defaultNativeStores.get(selection);
    if (!cached) {
      cached = createNativeCredentialStore();
      defaultNativeStores.set(selection, cached);
    }
    return cached;
  })();
  const guard = selection.credentialWriteGuard;
  if (!guard) return base;
  // Reads stay unfenced; every mutation invokes the guard first and a refusal
  // throws before the backend is touched. Any guard throw normalizes to the
  // refusal marker so providers and classifiers see one stable identity.
  // The wrapper is memoized per selection and guard so concurrent runs keep
  // one shared renewal lifecycle.
  const cached = guardedStores.get(selection);
  if (cached && cached.guard === guard) return cached.store;
  const runGuard = async (identity: CredentialIdentity): Promise<void> => {
    try {
      await guard({ account: identity.account, label: identity.label });
    } catch (error) {
      if (isCredentialWriteRefused(error)) throw error;
      throw credentialWriteRefusedError(error);
    }
  };
  // The fence runs before every write and again after it; a refusal after the write removes exactly that value.
  const fenced = async (identity: CredentialIdentity, value: string, write: () => Promise<boolean>): Promise<boolean> => {
    await runGuard(identity);
    if (!await write()) return false;
    // Final visibility is generation-fenced: a stop that lands while the
    // backend write is in flight makes the post-write guard fail, and
    // exactly the late value is removed. Prefers the store's atomic
    // compare-and-delete; without it, falls back to a serialized
    // read-then-delete inside the caller's lifecycle chain (same
    // guarantee against fenced writers, best effort against unfenced
    // cross-process writers). A concurrent legitimate write is never
    // touched. Reads stay unfenced; only persisted writes are fenced.
    // Cleanup backend failures propagate distinctly: the refusal still
    // terminalizes, but marked uncertain instead of claiming the value
    // is gone.
    try {
      await runGuard(identity);
    } catch (refusal) {
      try {
        if (typeof base.compareAndDelete === "function") {
          await base.compareAndDelete(identity, value);
        } else {
          const current = await base.get(identity);
          if (current === value) await base.delete(identity);
        }
      } catch (cleanupError) {
        throw markCleanupUncertain(refusal, cleanupError);
      }
      throw refusal;
    }
    return true;
  };
  const store: CredentialStore = {
    get: identity => base.get(identity),
    set: async (identity, value) => { await fenced(identity, value, async () => { await base.set(identity, value); return true; }); },
    // The guard runs before the compare and the write, which then share the base store's critical section.
    compareAndSet: (identity, expectedValue, value) => fenced(identity, value, () => replaceCredential(base, identity, expectedValue, value)),
    delete: async identity => {
      await runGuard(identity);
      return base.delete(identity);
    },
  };
  guardedStores.set(selection, { guard, store });
  return store;
}

function needsLoginAction(route: HostAuthRoute): string {
  return route === "codex"
    ? "No ChatGPT subscription login found. Sign in in interactive mode with /login chatgpt (or /login chatgpt --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache."
    : "No Grok subscription login found. Sign in in interactive mode with /login grok (or /login grok --device on headless machines). Headless runs never start a browser automatically and never read another CLI's credential cache.";
}

function storeUnavailableAction(): string {
  return "Cannot read credential in the OS secure store. Unlock or allow access to your OS credential store; on Linux install libsecret and start a Secret Service. Retry after restoring access. No plaintext fallback is used.";
}

function invalidStoreAction(route: HostAuthRoute): string {
  return route === "codex"
    ? "Stored ChatGPT subscription login is invalid. Sign in again with /login chatgpt."
    : "Stored Grok subscription login is invalid. Sign in again with /login grok.";
}

/** Safe status for a route run stopped before its secure-store read answered; no credential verdict exists. @internal */
export function readinessInterrupted(selection: HostAuthSelection): HostAuthReadiness {
  const valid = validateAuthSelection(selection);
  return { route: valid.route, model: valid.model, credential: credentialReferenceForRoute(valid.route), observedInference: "not-checked",
    status: "store-unavailable",
    nextAction: "The run stopped before the OS secure store returned the credential. Retry the turn; if the store keeps waiting, unlock or allow access to your OS credential store." };
}

/** Bounds for one local readiness check; omission keeps the unbounded local read. */
export interface HostReadinessOptions {
  /** Abort the check: it rejects with an `AbortError` and ignores the store read when it finally settles. */
  readonly signal?: AbortSignal;
  /** Bound the check in whole milliseconds (1–86,400,000): expiry rejects with a `TimeoutError`. */
  readonly deadlineMs?: number;
}

const MAX_READINESS_DEADLINE_MS = 86_400_000;

/** Validate a `{ signal, deadlineMs }` bound, rejecting `invalid-input` for any other shape. @internal */
export function readinessBounds(input: unknown): HostReadinessOptions {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      Object.keys(input).some(key => key !== "signal" && key !== "deadlineMs")) throw new HostError("invalid-input");
  const { signal, deadlineMs } = input as { signal?: unknown; deadlineMs?: unknown };
  // Structural so a signal from another realm is accepted.
  if (signal !== undefined && (typeof signal !== "object" || signal === null || typeof (signal as AbortSignal).aborted !== "boolean" ||
      typeof (signal as AbortSignal).addEventListener !== "function" || typeof (signal as AbortSignal).removeEventListener !== "function")) throw new HostError("invalid-input");
  if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_READINESS_DEADLINE_MS)) throw new HostError("invalid-input");
  return { ...(signal !== undefined ? { signal: signal as AbortSignal } : {}), ...(deadlineMs !== undefined ? { deadlineMs: deadlineMs as number } : {}) };
}

/** Check local store readiness without network or inference; only the selected route identity is read.
 * With a signal or deadline, the check settles promptly on abort (`AbortError`) or expiry (`TimeoutError`);
 * a store read that cannot be cancelled is ignored once it settles, and readiness never writes. */
export async function checkAuthReadiness(selection: HostAuthSelection, options?: HostReadinessOptions): Promise<HostAuthReadiness> {
  validateAuthSelection(selection);
  const { signal, deadlineMs } = readinessBounds(options);
  if (!signal && deadlineMs === undefined) return readiness(selection, () => false);
  return new Promise<HostAuthReadiness>((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => reject(new DOMException("The readiness check was aborted.", "AbortError")));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (deadlineMs !== undefined) timer = setTimeout(() => finish(() => reject(new DOMException("The readiness check timed out.", "TimeoutError"))), deadlineMs);
    readiness(selection, () => settled).then(value => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

/** Read and parse the selected identity, stopping after the read once the caller has settled. */
async function readiness(selection: HostAuthSelection, abandoned: () => boolean): Promise<HostAuthReadiness> {
  return (await routeCredentialState(selection, abandoned)).readiness;
}

/** Readiness of the selected identity and whether its access is expired or inside the refresh skew with a refresh token to renew it.
 * Reads through `store` (the selection's effective store by default); after an abandoned read it throws `AbortError`
 * without parsing or loading an adapter. @internal */
export async function routeCredentialState(selection: HostAuthSelection, abandoned: () => boolean, store?: CredentialStore): Promise<{ readiness: HostAuthReadiness; renewalDue: boolean }> {
  const valid = validateAuthSelection(selection);
  const credential = credentialReferenceForRoute(valid.route);
  const base = { route: valid.route, model: valid.model, credential, observedInference: "not-checked" as const };
  const settled = (readiness: HostAuthReadiness, renewalDue = false) => ({ readiness, renewalDue });
  // Memoize on the caller selection identity, not the validated copy, so one
  // runtime shares one default native store across readiness and model runs.
  const source = store ?? effectiveStore(selection);
  const identity = valid.route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
  let raw: string | null;
  try {
    raw = await source.get(identity);
  } catch {
    return settled({ ...base, status: "store-unavailable", nextAction: storeUnavailableAction() });
  }
  // An abandoned check never parses, loads an adapter or acts on the late value; its caller already settled.
  if (abandoned()) throw new DOMException("The readiness check was aborted.", "AbortError");
  if (!raw?.trim()) return settled({ ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) });
  let expired: boolean;
  try {
    let refreshToken: string | undefined;
    if (valid.route === "codex") {
      const { parseSubscriptionTokens, subscriptionAccessExpired } = await import("../model/providers/codex-subscription.ts");
      const tokens = parseSubscriptionTokens(raw);
      ({ refreshToken } = tokens); expired = subscriptionAccessExpired(tokens);
    } else {
      const { parseSubscriptionTokens, subscriptionAccessExpired } = await import("../model/providers/grok-subscription.ts");
      const tokens = parseSubscriptionTokens(raw);
      ({ refreshToken } = tokens); expired = subscriptionAccessExpired(tokens);
    }
    if (expired && !refreshToken) return settled({ ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) });
  } catch {
    return settled({ ...base, status: "invalid-store", nextAction: invalidStoreAction(valid.route) });
  }
  return settled({ ...base, status: "configured-unverified", nextAction: "Run a route-bound request to observe inference; static configuration alone does not prove live access." }, expired);
}

/** Create only the selected subscription adapter; the unselected route and TUI never load.
 * `authorizeDispatch` runs before every physical inference send the model makes; omission keeps request bytes unchanged. */
export async function createAuthRouteModel(selection: HostAuthSelection, options?: HostRouteModelOptions): Promise<Model> {
  const valid = routeModelOptions(options);
  return createAuthRouteModelForRun(selection, undefined, valid);
}

/** Bind an admitted run to its original route epoch and readiness participation. @internal */
export async function createAuthRouteModelForRun(selection: HostAuthSelection, admitted?: CredentialLifecycleLease, options: HostRouteModelOptions = {}): Promise<Model> {
  const valid = validateAuthSelection(selection);
  // Route evidence and pins are settled before any store, adapter or network access; mismatches reject invalid-input.
  const capability = options.catalogModel !== undefined ? catalogCapability(options.catalogModel, valid.route, valid.model, credentialOwner(valid)) : undefined;
  const outputCap = routeOutputCap(valid.route, valid.model, options.maxOutputTokens, options.requireOutputCap === true);
  const controls: RouteControls = { ...(options.effort ? { effort: exactEffort(valid.route, valid.model, capability ?? null, options.effort) } : {}),
    ...(outputCap ? { outputCap } : {}) };
  const store = admitted?.store ?? effectiveStore(selection);
  const { loadProviderModel } = await import("../model/loader.ts");
  // Only Grok sends a cap; an unset cap keeps the adapter's default, so bytes stay unchanged.
  const evidence = { ...(capability ? { modelCapability: capability } : {}), ...(options.maxOutputTokens !== undefined ? { maxTokens: options.maxOutputTokens } : {}) };
  const model = valid.route === "codex"
    ? await loadProviderModel({ provider: "openai", openaiAuth: "codex", model: valid.model, codexStore: store, ...evidence }, valid.fetch)
    : await loadProviderModel({ provider: "xai", xaiAuth: "grok", model: valid.model, grokStore: store, ...evidence }, valid.fetch);
  const bound = valid.lifecycle ? lifecycleModel(valid.lifecycle, valid.route, store, model, valid.credentialWriteGuard, admitted) : model;
  // Outermost, so a run's accounting attaches even when an inner layer refuses before sending.
  return dispatchRouteModel(bound, valid.route, options.authorizeDispatch, controls);
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

/** Map a route-bound failure to a stable safe category without leaking secrets or switching routes.
 * Classification is message- and category-based: provider adapters throw sanitized
 * plain messages (and the loop drops transport status), so status-less bodies must
 * still hit their documented category through these patterns. A dispatch refusal is
 * recognized only by identity, directly or as a `cause`, so echoed refusal wording never reads as `dispatch-refused`;
 * Schway's own refused-redirect failures are recognized the same way. */
export function classifyAuthError(error: unknown, selection: HostAuthSelection): HostAuthReadiness {
  return classifyRouteFailure(error, selection, "turn");
}

/** Classify like `classifyAuthError`, wording retry guidance for a `turn` or an explicit `renewal`, which has no turn and never retries. @internal */
export function classifyRouteFailure(error: unknown, selection: HostAuthSelection, retry: "turn" | "renewal"): HostAuthReadiness {
  const renewal = retry === "renewal";
  const valid = validateAuthSelection(selection);
  const credential = credentialReferenceForRoute(valid.route);
  const base = { route: valid.route, model: valid.model, credential, observedInference: "not-checked" as const };
  const text = errorText(error);
  const status = httpStatusOf(error);
  if (hasDispatchRefusal(error)) {
    return { ...base, status: "dispatch-refused",
      nextAction: "The embedding application refused a provider request. The refused request was not sent. Retry the turn after the application allows it." };
  }
  // Pinned effort or a required cap could not be sent exactly for this model; its stable message names the next step.
  const controlRefusal = routeControlRefusal(error);
  if (controlRefusal) return { ...base, status: "model-unavailable", nextAction: controlRefusal.message };
  if (isCredentialWriteRefused(error)) {
    // An uncertain cleanup never claims a clean fence: the late value may
    // still be visible, so the guidance says verify instead of retrying.
    if (isCleanupUncertain(error)) {
      return { ...base, status: "store-unavailable",
        nextAction: renewal
          ? "A renewed credential was refused after it may have landed, and its removal could not be verified. A late credential may still be visible: verify the OS credential store before retrying the renewal."
          : "A credential write was refused after it may have landed, and its removal could not be verified. A late credential may still be visible: verify the OS credential store before retrying the turn." };
    }
    return { ...base, status: "store-unavailable",
      nextAction: renewal
        ? "The embedding application's credential fence refused the renewal. No credential was changed. Retry the renewal after the fence allows writes; if that renewal is rejected, sign in again."
        : "The embedding application's credential fence refused a credential write. No credential was changed. Retry the turn after the fence allows writes." };
  }
  // A lock refusal already names its cause and next step; the generic store
  // guidance (unlock the keychain, install libsecret) would point elsewhere.
  // Recognized by brand only, so provider text that copies its wording never
  // becomes guidance. An uncertain cleanup may hide a lock failure in its cause
  // while its own write may have landed, so it never says nothing changed.
  const lock = isCleanupUncertain(error) ? undefined : findCredentialLockError(error);
  if (lock) return { ...base, status: "store-unavailable", nextAction: lock.message };
  if (/Cannot (read|save|delete) credential|secure store|Secret Service|libsecret/i.test(text)) {
    return { ...base, status: "store-unavailable", nextAction: storeUnavailableAction() };
  }
  if (/No ChatGPT subscription login|No Grok subscription login|expired.*no refresh token|no refresh token/i.test(text)) {
    return { ...base, status: "needs-login", nextAction: needsLoginAction(valid.route) };
  }
  if (valid.route === "grok" && /Grok usage limit reached/.test(text)) {
    return { ...base, status: "quota-exceeded", nextAction: "Check https://grok.com/?_s=usage and wait before retrying this Grok subscription. API-key billing is never used as a fallback." };
  }
  if (valid.route === "grok" && /Grok access temporarily unavailable/.test(text)) {
    return { ...base, status: "integration-unavailable", nextAction: "Grok access is temporarily unavailable. Retry later; API-key billing is never used as a fallback." };
  }
  if (/Stored .* subscription login is invalid|revoked|rejected by the provider|rejected by xAI|denied|Plus\/Pro|membership|seat|entitlement|Your Grok plan doesn't include API access|HTTP 40[123]\b/i.test(text) ||
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
      nextAction: renewal
        ? valid.route === "codex"
          ? "The ChatGPT subscription is rate-limited (HTTP 429). Wait, then retry the renewal; renewal never retries on its own."
          : "The Grok subscription is rate-limited. Wait, then retry the renewal; renewal never retries on its own."
        : valid.route === "codex"
          ? "The ChatGPT subscription is rate-limited (HTTP 429). Retry the turn; Schway owns retries."
          : "The Grok subscription is rate-limited. Retry the turn; Schway owns retries." };
  }
  // Renewal names no model, so model wording in its transport text is incidental and stays a reach failure.
  if (!renewal && (/unknown.*model|model.*(not found|unavailable|does not exist|invalid)|not supported|subscription catalog|No selectable models/i.test(text) ||
      ((status === 400 || status === 404 || status === 422) && /model/i.test(text)))) {
    return { ...base, status: "model-unavailable",
      nextAction: `Model ${valid.model} is not available on this subscription. Choose a listed model for this route.` };
  }
  // The endpoint answered, so this is not "could not reach". Identity only: echoed provider text never matches.
  if (hasRedirectRefusal(error)) {
    return { ...base, status: "integration-unavailable",
      nextAction: valid.route === "codex"
        ? "The ChatGPT subscription answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing."
        : "The Grok subscription answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing." };
  }
  return { ...base, status: "integration-unavailable",
    nextAction: renewal
      ? valid.route === "codex"
        ? "Could not reach the ChatGPT subscription to renew its credential. Retry the renewal later; Schway never falls back to API-key billing."
        : "Could not reach the Grok subscription to renew its credential. Retry the renewal later; Schway never falls back to API-key billing."
      : valid.route === "codex"
        ? "Could not reach the ChatGPT subscription. Retry the turn; Schway owns retries and never falls back to API-key billing."
        : "Could not reach the Grok subscription. Retry the turn; Schway owns retries and never falls back to API-key billing." };
}

/** True when a value contains none of the supplied secret sentinels. */
export function containsNoSecrets(value: unknown, sentinels: readonly string[]): boolean {
  if (sentinels.length === 0) return true;
  if (typeof value === "string") {
    return sentinels.every(sentinel => sentinel.length === 0 || !value.includes(sentinel));
  }
  // Unserializable input cannot prove it holds no secrets.
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return false;
  }
  return sentinels.every(sentinel => sentinel.length === 0 || !text.includes(sentinel));
}
