import { credentialWriteRefusedError, isCleanupUncertain } from "../auth/store.ts";
import { classifyRouteFailure, credentialReferenceForRoute, effectiveStore, readinessBounds, routeCredentialState, validateAuthSelection,
  type HostAuthReadiness, type HostAuthSelection } from "./auth-routes.ts";
import { acquireCredentialLifecycle, holdRenewal } from "./credential-lifecycle.ts";

/** Bounds for one explicit renewal; omission keeps only the refresher's own 30-second ceiling. */
export interface HostRouteRenewalOptions {
  /** Stop waiting: the renewal settles `cancelled` at once; a token request that already left still completes. */
  readonly signal?: AbortSignal;
  /** Bound the wait in whole milliseconds (1–86,400,000): expiry settles `limit_exceeded` the same way. */
  readonly deadlineMs?: number;
}

/** Route credential status after a renewal: readiness without a model, because renewal belongs to the route credential. */
export type HostRouteRenewalStatus = Omit<HostAuthReadiness, "model">;

/** Credential-free result of one explicit renewal; renewal never sends inference or switches route, model or billing. */
export interface HostRouteRenewal {
  /** `fresh` sent nothing, `renewed` stored fresh access, `failed` is classified in `auth`; `cancelled` and `limit_exceeded` stopped waiting. */
  readonly outcome: "fresh" | "renewed" | "failed" | "cancelled" | "limit_exceeded";
  /** Token requests this call started: 1 only when it sent the request itself; joining another caller's renewal counts 0. */
  readonly renewalRequests: 0 | 1;
  /** `configured-unverified` when fresh or renewed; otherwise the latest verdict with its next action. Decide on `outcome` first. */
  readonly auth: HostRouteRenewalStatus;
}

/** Placeholder satisfying selection validation for a model-free renewal; renewal results never carry a model. */
const RENEWAL_MODEL = "route-renewal";

const INTERRUPTED = "The renewal stopped before the OS secure store returned the credential. Retry the renewal; if the store keeps waiting, unlock or allow access to your OS credential store.";

function withoutModel({ model: _model, ...status }: HostAuthReadiness): HostRouteRenewalStatus {
  return status;
}

/** Renew the selected route's credential at most once without inference; pass your hosts' `lifecycle` to share their renewal. */
export async function renewAuthRoute(selection: Omit<HostAuthSelection, "model">, options?: HostRouteRenewalOptions): Promise<HostRouteRenewal> {
  // Invalid selections reject like `listRouteModels`, a model included; malformed bounds reject `invalid-input`.
  if (typeof selection !== "object" || selection === null || Array.isArray(selection) || "model" in selection) throw new Error("invalid");
  const valid = validateAuthSelection({ ...selection, model: RENEWAL_MODEL });
  // The caller's own object keys the effective store, so repeated calls with one selection share renewal.
  return renewSelectedRoute(selection as HostAuthSelection, valid, options);
}

/** Renew through the effective store memoized on `memo`, with `valid`'s lifecycle, guard and fetch. @internal */
export async function renewSelectedRoute(memo: HostAuthSelection, valid: HostAuthSelection, input: unknown): Promise<HostRouteRenewal> {
  const { signal, deadlineMs } = readinessBounds(input);
  const interrupted: HostRouteRenewalStatus = { route: valid.route, credential: credentialReferenceForRoute(valid.route),
    status: "store-unavailable", nextAction: INTERRUPTED, observedInference: "not-checked" };
  // An already-stopped renewal never reads the store.
  if (signal?.aborted) return { outcome: "cancelled", renewalRequests: 0, auth: interrupted };
  const classify = (error: unknown): HostAuthReadiness => classifyRouteFailure(error, valid, "renewal");
  const fenced = (): HostAuthReadiness => classify(credentialWriteRefusedError());
  // Stops this call's wait. Before its token request leaves, nothing is sent afterwards; once it has left, the
  // renewal completes and stores its response unless a logout or a fence refuses it, because the provider may
  // already have rotated the refresh token.
  const stop = new AbortController();
  // Join the route's participants before the read, as runs do, so a shared renewal may persist for this call.
  const lease = valid.lifecycle ? acquireCredentialLifecycle(valid.lifecycle, valid.route, valid.credentialWriteGuard, stop.signal) : undefined;
  const store = lease?.store ?? effectiveStore(memo);
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
    try { await valid.credentialWriteGuard?.(Object.freeze(credentialReferenceForRoute(valid.route))); }
    catch {
      if (lease) lease.interest.refused = true;
      return ["failed", fenced()];
    }
    stop.signal.throwIfAborted();
    // With a lifecycle, logout aborts this participant too.
    const waiting = lease?.interest.controller.signal ?? stop.signal;
    // A renewal this call sent keeps its participation until it settles, even after this call stops waiting.
    const started = (settled: Promise<void>) => { requests = 1; if (lease) holdRenewal(lease, settled); };
    try {
      if (valid.route === "codex") {
        const { createSubscriptionTokenRefresher } = await import("../model/providers/codex-subscription.ts");
        await createSubscriptionTokenRefresher({ store, ...(valid.fetch ? { fetch: valid.fetch } : {}) }).getValidAccessToken(waiting, started);
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
      resolve({ outcome, renewalRequests: requests, auth });
    };
    const stopped = (outcome: "cancelled" | "limit_exceeded"): void => {
      stop.abort();
      // A renewal already sent defers this release until it settles.
      lease?.release();
      // Stopped before the store answered, there is no verdict; afterwards, the verdict read is the latest one.
      finish(outcome, observed ? withoutModel(observed) : interrupted);
    };
    const onAbort = (): void => stopped("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (deadlineMs !== undefined) timer = setTimeout(() => stopped("limit_exceeded"), deadlineMs);
    renew().then(
      ([outcome, auth]) => { lease?.release(); finish(outcome, withoutModel(auth)); },
      (error: unknown) => { lease?.release(); finish("failed", withoutModel(classify(error))); });
  });
}
