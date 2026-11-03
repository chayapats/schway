import { AsyncLocalStorage } from "node:async_hooks";

/** Subscription route a renewal belongs to. */
export type RenewalRoute = "codex" | "grok";

/** A renewal whose token request has left; `saved` resolves false only when it leaves no sign-in the user chose, and never rejects. */
export interface SentRenewal {
  readonly route: RenewalRoute;
  readonly saved: Promise<boolean>;
}

// Renewals whose token request has left this process, until they and their credential write settle.
const sent = new Set<SentRenewal>();
// Routes with a renewal that settled without storing a sign-in, that no caller showed and no exit notice named yet.
// A later saved renewal, sign-in or sign-out on the route clears it.
const unreported = new Set<RenewalRoute>();
// Present while work runs whose errors never reach the user, such as a compaction summary.
const unshown = new AsyncLocalStorage<true>();

/** A tracked renewal; `shown()` records that a waiting caller received its failure and shows it, so exit does not repeat it. */
export interface TrackedRenewal {
  shown(): void;
}

/** Record a renewal whose token request has left until it settles, and return its handle; a failure no caller showed is
 * kept for `takeUnsavedRenewals`. `saved` resolves false only when no sign-in the user chose is stored, and never rejects. */
export function trackSentRenewal(route: RenewalRoute, saved: Promise<boolean>): TrackedRenewal {
  const renewal: SentRenewal = { route, saved };
  let shown = false;
  sent.add(renewal);
  // A failure no caller showed outlives its renewal, so a later exit can still warn about it, for example after a
  // stopped TUI turn.
  const settle = (stored: boolean) => {
    sent.delete(renewal);
    if (stored) unreported.delete(route);
    else if (!shown) unreported.add(route);
  };
  void saved.then(stored => settle(stored === true), () => settle(false));
  return {
    shown() {
      if (unshown.getStore()) return;
      shown = true;
      unreported.delete(route);
    },
  };
}

/** Run work whose errors never reach the user; a renewal failure it receives is still named by the exit notice. */
export function withoutShowingRenewalFailures<T>(work: () => T): T {
  return unshown.run(true, work);
}

/** Clear a route's unnamed renewal failure once a sign-in is stored or removed there, since that failure no longer matters. */
export function forgetUnsavedRenewals(route: RenewalRoute): void {
  unreported.delete(route);
}

/** Routes with a renewal failure that no caller showed since the last call; each route is returned once. */
export function takeUnsavedRenewals(): RenewalRoute[] {
  const routes = [...unreported];
  unreported.clear();
  return routes;
}

/** Renewals still settling: exiting now could lose a refresh token the provider already rotated. */
export function pendingRenewals(): SentRenewal[] {
  return [...sent];
}
