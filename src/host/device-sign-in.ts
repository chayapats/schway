import { DeviceFlowError, sleepDeviceFlow, withinDeviceFlow } from "../auth/device-flow.ts";
import { createNativeCredentialStore, credentialWriteRefusedError, isCleanupUncertain, markCleanupUncertain, type CredentialStore } from "../auth/store.ts";
import { effectiveStore, validateAuthSelection, type HostAuthFetch, type HostAuthRoute, type HostCredentialStore, type HostCredentialWriteGuard } from "./auth-routes.ts";
import { HostError, type HostClock } from "./index.ts";

/** Selected subscription sign-in with an isolated store, optional application fence and deterministic protocol seams. */
export interface HostDeviceSignInOptions {
  route: HostAuthRoute;
  store?: HostCredentialStore;
  fetch?: HostAuthFetch;
  credentialWriteGuard?: HostCredentialWriteGuard;
  signal?: AbortSignal;
  clock?: HostClock;
}

/** Terminal sign-in failures contain categories only; uncertain cleanup requires store recovery before retrying. */
export type HostDeviceSignInFailure =
  | { readonly kind: "expired" | "denied" | "cancelled" | "provider-error"; readonly route: HostAuthRoute; readonly containsNoSecrets: true }
  | { readonly kind: "store-error"; readonly route: HostAuthRoute; readonly containsNoSecrets: true; readonly cleanupUncertain: boolean };

/** Ready means the credential was committed locally, with no inference or model-access claim. */
export type HostDeviceSignInOutcome = HostDeviceSignInFailure
  | { readonly kind: "ready"; readonly route: HostAuthRoute; readonly containsNoSecrets: true };

/** Ephemeral approval handle shares one terminal poll and exposes only the user code and verification address. */
export interface HostDeviceSignIn {
  readonly kind: "pending";
  readonly route: HostAuthRoute;
  readonly containsNoSecrets: true;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  /** Poll once to settlement; repeated calls share the result, and any supplied signal cancels this flow. */
  poll(signal: AbortSignal): Promise<HostDeviceSignInOutcome>;
  /** Cancel this flow, fencing any in-flight write before releasing route ownership. */
  cancel(): void;
}

/** Starting a route returns approval data, a safe failure, or busy while that route is already pending in this process. */
export type HostDeviceSignInStart = HostDeviceSignIn | HostDeviceSignInFailure
  | { readonly kind: "busy"; readonly route: HostAuthRoute; readonly containsNoSecrets: true };

const pendingRoutes = new Set<HostAuthRoute>();
let nativeStore: CredentialStore | undefined;

/** Start the existing selected-provider device protocol without a TTY, tokens in results, or billing fallback. */
export async function beginDeviceSignIn(options: HostDeviceSignInOptions): Promise<HostDeviceSignInStart> {
  try {
    if (!options || Object.keys(options).some(key => !["route", "store", "fetch", "credentialWriteGuard", "signal", "clock"].includes(key))) throw new Error();
    validateAuthSelection({ route: options.route, model: "device-sign-in", store: options.store, fetch: options.fetch, credentialWriteGuard: options.credentialWriteGuard });
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error();
    if (options.clock !== undefined && (typeof options.clock.now !== "function" || typeof options.clock.sleep !== "function")) throw new Error();
  } catch { throw new HostError("invalid-options"); }
  // Capture trusted dependencies so later caller mutations cannot change the selected identity or fence.
  const { route, store: selectedStore, fetch: runFetch, credentialWriteGuard, signal: callerSignal } = options;
  const clock = options.clock ? { now: options.clock.now.bind(options.clock), sleep: options.clock.sleep.bind(options.clock) }
    : { now: Date.now, sleep: sleepDeviceFlow };
  const safe = { route, containsNoSecrets: true as const };
  if (pendingRoutes.has(route)) return { ...safe, kind: "busy" };
  if (callerSignal?.aborted) return { ...safe, kind: "cancelled" };
  pendingRoutes.add(route);
  const controller = new AbortController(), expiryTimer = new AbortController();
  let expiresAt = clock.now() + 30_000;
  let expired = false, writing = false, released = false;
  let result: HostDeviceSignInOutcome | undefined;
  let polling: Promise<HostDeviceSignInOutcome> | undefined;
  const listeners = new Map<AbortSignal, () => void>();
  const release = () => {
    if (released) return;
    released = true;
    pendingRoutes.delete(route);
    expiryTimer.abort();
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.clear();
  };
  const cancel = () => {
    if (result) return;
    controller.abort();
    if (!polling && !writing) { result = { ...safe, kind: expired ? "expired" : "cancelled" }; release(); }
  };
  const attach = (signal: AbortSignal) => {
    if (result || listeners.has(signal)) return;
    const listener = () => cancel();
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) cancel();
  };
  if (callerSignal) attach(callerSignal);
  const classify = (error: unknown): HostDeviceSignInFailure => {
    if (isCleanupUncertain(error)) return { ...safe, kind: "store-error", cleanupUncertain: true };
    if (expired || clock.now() >= expiresAt || error instanceof DeviceFlowError && error.kind === "expired") return { ...safe, kind: "expired" };
    if (controller.signal.aborted) return { ...safe, kind: "cancelled" };
    if (writing) return { ...safe, kind: "store-error", cleanupUncertain: false };
    return { ...safe, kind: error instanceof DeviceFlowError ? error.kind : "provider-error" };
  };
  try {
    // Load only the selected provider; the CLI begins exactly the same authorization.
    const integration = await withinDeviceFlow({ expiresAt, signal: controller.signal, ...clock }, async signal => {
      if (route === "codex") {
        const provider = await import("../model/providers/codex-subscription.ts");
        const authorization = await provider.beginDeviceAuthorization({ fetch: runFetch, signal, ...clock });
        return { authorization, pollAndSave: async (store: CredentialStore, signal: AbortSignal) => {
          const tokens = await authorization.poll(signal);
          signal.throwIfAborted();
          writing = true;
          await provider.saveSubscriptionTokens(store, tokens);
        } };
      }
      const provider = await import("../model/providers/grok-subscription.ts");
      const authorization = await provider.beginDeviceAuthorization({ fetch: runFetch, signal, ...clock });
      return { authorization, pollAndSave: async (store: CredentialStore, signal: AbortSignal) => {
        const tokens = await authorization.poll(signal);
        signal.throwIfAborted();
        writing = true;
        await provider.saveSubscriptionTokens(store, tokens);
      } };
    });
    expiresAt = integration.authorization.expiresAt;
    if (controller.signal.aborted || clock.now() >= expiresAt) throw new DeviceFlowError("expired", "Device sign-in expired.");
    // An abandoned, never-polled handle cannot reserve a route indefinitely.
    void clock.sleep(expiresAt - clock.now(), expiryTimer.signal).then(() => { expired = true; cancel(); }, () => {});
    const base = selectedStore ?? (nativeStore ??= createNativeCredentialStore());
    // A backend may commit then reject. Remove only this attempt's exact value, preserving a newer writer.
    const recoverable: CredentialStore = {
      get: identity => base.get(identity), delete: identity => base.delete(identity),
      ...(base.compareAndDelete ? { compareAndDelete: base.compareAndDelete.bind(base) } : {}),
      set: async (identity, value) => {
        try { await base.set(identity, value); }
        catch (error) {
          try {
            if (base.compareAndDelete) await base.compareAndDelete(identity, value);
            else if (await base.get(identity) === value) await base.delete(identity);
          } catch (cleanup) { throw markCleanupUncertain(error, cleanup); }
          throw error;
        }
      },
    };
    const store = effectiveStore({ route, model: "device-sign-in", store: recoverable, credentialWriteGuard: async identity => {
      const check = () => { if (controller.signal.aborted || clock.now() >= expiresAt) throw credentialWriteRefusedError(); };
      check();
      await credentialWriteGuard?.(identity);
      check();
    } });
    return Object.freeze({ ...safe, kind: "pending" as const, userCode: integration.authorization.userCode,
      verificationUri: integration.authorization.verificationUri, expiresAt, cancel,
      poll(signal: AbortSignal): Promise<HostDeviceSignInOutcome> {
        if (!(signal instanceof AbortSignal)) return Promise.reject(new HostError("invalid-options"));
        attach(signal);
        if (result) return Promise.resolve(result);
        polling ??= (async () => {
          try {
            // Do not race store writes: wait for their post-write fence and cleanup to settle.
            await integration.pollAndSave(store, controller.signal);
            result = { ...safe, kind: "ready" };
          } catch (error) { result = classify(error); }
          finally { release(); }
          return result;
        })();
        return polling;
      },
    });
  } catch (error) {
    result = classify(error);
    release();
    return result;
  }
}
