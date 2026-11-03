import { credentialWriteRefusedError, isCleanupUncertain } from "../auth/store.ts";
import { classifyAuthError, credentialReferenceForRoute, effectiveStore, readinessBounds, routeCredentialState, validateAuthSelection,
  type HostAuthReadiness, type HostAuthSelection } from "./auth-routes.ts";
import { acquireCredentialLifecycle } from "./credential-lifecycle.ts";

/** Bounds for one explicit renewal; omission keeps only the refresher's own 30-second ceiling. */
export interface HostRouteRenewalOptions {
  /** Stop the renewal: it settles `cancelled` at once, and a token response that arrives later is never stored for it. */
  readonly signal?: AbortSignal;
  /** Bound the renewal in whole milliseconds (1–86,400,000): expiry settles `limit_exceeded` the same way. */
  readonly deadlineMs?: number;
}

/** Route credential status after a renewal: readiness without a model, because renewal belongs to the route credential. */
export type HostRouteRenewalStatus = Omit<HostAuthReadiness, "model">;

/** Credential-free result of one explicit renewal; renewal never sends inference or switches route, model or billing. */
export interface HostRouteRenewal {
  /**
   * `fresh`: the stored access was valid, so nothing was sent. `renewed`: it was expired or inside the refresh skew and
   * fresh access is now stored. `failed`: `auth` carries the route-run classification. `cancelled` and `limit_exceeded`:
   * the signal or deadline stopped it, and nothing that arrives later is stored for it.
   */
  readonly outcome: "fresh" | "renewed" | "failed" | "cancelled" | "limit_exceeded";
  /** Token requests this call started: 1 only when it sent the request itself; joining another caller's renewal counts 0. */
  readonly renewalRequests: 0 | 1;
  /** `configured-unverified` when fresh or renewed; otherwise the latest verdict with its next action. */
  readonly auth: HostRouteRenewalStatus;
}

/** Placeholder satisfying selection validation for a model-free renewal; renewal results never carry a model. */
const RENEWAL_MODEL = "route-renewal";

const INTERRUPTED = "The renewal stopped before the OS secure store returned the credential. Retry the renewal; if the store keeps waiting, unlock or allow access to your OS credential store.";

function withoutModel({ model: _model, ...status }: HostAuthReadiness): HostRouteRenewalStatus {
  return status;
}

/**
 * Renew the selected route's credential at most once, through its existing refresher, without inference.
 * Use the same `lifecycle` as your hosts to share their single-flight renewal and write fencing.
 * Invalid selections reject like `listRouteModels`; malformed bounds reject `invalid-input`.
 */
export async function renewAuthRoute(selection: Omit<HostAuthSelection, "model">, options?: HostRouteRenewalOptions): Promise<HostRouteRenewal> {
  if (typeof selection !== "object" || selection === null || Array.isArray(selection) || "model" in selection) throw new Error("invalid");
  const valid = validateAuthSelection({ ...selection, model: RENEWAL_MODEL });
  // The caller's own object keys the effective store, so repeated calls with one selection share renewal.
  return renewSelectedRoute(selection as HostAuthSelection, valid, options);
}

/**
 * Renew through `memo`'s effective store and `valid`'s lifecycle, guard and fetch. @internal
 * `memo` is the selection object the effective store is memoized on, so a runtime passes the selection its runs use.
 */
export async function renewSelectedRoute(memo: HostAuthSelection, valid: HostAuthSelection, input: unknown): Promise<HostRouteRenewal> {
  const { signal, deadlineMs } = readinessBounds(input);
  const credential = credentialReferenceForRoute(valid.route);
  const interrupted: HostRouteRenewalStatus = { route: valid.route, credential, status: "store-unavailable", nextAction: INTERRUPTED, observedInference: "not-checked" };
  // An already-stopped renewal never reads the store.
  if (signal?.aborted) return { outcome: "cancelled", renewalRequests: 0, auth: interrupted };
  const classify = (error: unknown): HostAuthReadiness => {
    const auth = classifyAuthError(error, valid);
    // Renewal names no model, so a model verdict could only come from incidental transport text.
    return auth.status === "model-unavailable" ? classifyAuthError(new Error("Renewal failed."), valid) : auth;
  };
  const stop = new AbortController();
  // Join the route's participants before the read, as runs do, so a shared renewal may persist for this call.
  const lease = valid.lifecycle ? acquireCredentialLifecycle(valid.lifecycle, valid.route, valid.credentialWriteGuard, stop.signal) : undefined;
  const store = lease?.store ?? effectiveStore(memo);
  const fenced = (): HostAuthReadiness => classify(credentialWriteRefusedError());
  let requests: 0 | 1 = 0;
  let observed: HostAuthReadiness | undefined;

  const renew = async (): Promise<[HostRouteRenewal["outcome"], HostAuthReadiness]> => {
    const state = await routeCredentialState(valid, () => stop.signal.aborted, store);
    // A logout during the read fences this participant; its old route store refuses the read, so report the fence.
    if (lease?.interest.refused) return ["failed", fenced()];
    observed = state.readiness;
    if (state.readiness.status !== "configured-unverified") return ["failed", state.readiness];
    if (!state.renewalDue) return ["fresh", state.readiness];
    // Consult the fence before sending: a refused caller never spends the refresh token.
    try { await valid.credentialWriteGuard?.(credential); }
    catch {
      if (lease) lease.interest.refused = true;
      return ["failed", fenced()];
    }
    stop.signal.throwIfAborted();
    // With a lifecycle, logout aborts this participant too.
    const waiting = lease?.interest.controller.signal ?? stop.signal;
    const started = () => { requests = 1; };
    try {
      if (valid.route === "codex") {
        const { createSubscriptionTokenRefresher } = await import("../model/providers/codex-subscription.ts");
        await createSubscriptionTokenRefresher({ store, ...(valid.fetch ? { fetch: valid.fetch } : {}) }).getValidAccessToken(waiting, started, true);
      } else {
        const { createSubscriptionTokenRefresher } = await import("../model/providers/grok-subscription.ts");
        await createSubscriptionTokenRefresher({ store, ...(valid.fetch ? { fetch: valid.fetch } : {}) }).getValidAccessToken(waiting, undefined, started);
      }
    } catch (error) {
      // A fenced participant reports its own refusal, unless cleanup is uncertain and the late value may still be visible.
      return ["failed", lease?.interest.refused && !isCleanupUncertain(error) ? fenced() : classify(error)];
    }
    // A sibling may keep the renewed value, but a fenced caller still reports its refusal.
    if (lease?.interest.refused) return ["failed", fenced()];
    return ["renewed", state.readiness];
  };

  return new Promise<HostRouteRenewal>(resolve => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: HostRouteRenewal["outcome"], auth: HostRouteRenewalStatus): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (outcome === "cancelled" || outcome === "limit_exceeded") stop.abort();
      // Released at settlement: work still blocked in the store or guard no longer authorizes any write.
      lease?.release();
      resolve({ outcome, renewalRequests: requests, auth });
    };
    // Stopped before the store answered, there is no verdict; afterwards, the verdict read is the latest one.
    const stopped = (outcome: "cancelled" | "limit_exceeded") => finish(outcome, observed ? withoutModel(observed) : interrupted);
    const onAbort = (): void => stopped("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (deadlineMs !== undefined) timer = setTimeout(() => stopped("limit_exceeded"), deadlineMs);
    renew().then(([outcome, auth]) => finish(outcome, withoutModel(auth)), (error: unknown) => finish("failed", withoutModel(classify(error))));
  });
}
