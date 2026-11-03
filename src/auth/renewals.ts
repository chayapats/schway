/** Subscription route a renewal belongs to. */
export type RenewalRoute = "codex" | "grok";

/** A renewal whose token request has left; `saved` resolves true when it left a usable sign-in stored, and never rejects. */
export interface SentRenewal {
  readonly route: RenewalRoute;
  readonly saved: Promise<boolean>;
}

// Renewals whose token request has left this process, until they and their credential write settle.
const sent = new Set<SentRenewal>();
// Renewals that settled without storing a sign-in and that no exit notice has reported yet.
const unreported = new Set<SentRenewal>();

/** A tracked renewal; `shown()` records that a waiting caller received its failure and reports it, so exit does not repeat it. */
export interface TrackedRenewal {
  shown(): void;
}

/** Record a renewal whose token request has left until it settles; `saved` resolves true when a usable sign-in is stored, and never rejects. */
export function trackSentRenewal(route: RenewalRoute, saved: Promise<boolean>): TrackedRenewal {
  const renewal: SentRenewal = { route, saved };
  let shown = false;
  sent.add(renewal);
  // A failed save no caller received outlives its renewal, so a later exit can still warn about it, for example after
  // a stopped TUI turn.
  const settle = (stored: boolean) => { sent.delete(renewal); if (!stored && !shown) unreported.add(renewal); };
  void saved.then(stored => settle(stored === true), () => settle(false));
  return { shown() { shown = true; unreported.delete(renewal); } };
}

/** Routes whose sent renewal settled without storing a sign-in since the last call; each failure is returned once. */
export function takeUnsavedRenewals(): RenewalRoute[] {
  const routes = [...unreported].map(renewal => renewal.route);
  unreported.clear();
  return routes;
}

/** Renewals still settling: exiting now could lose a refresh token the provider already rotated. */
export function pendingRenewals(): SentRenewal[] {
  return [...sent];
}
