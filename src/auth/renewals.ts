/** Subscription route a renewal belongs to. */
export type RenewalRoute = "codex" | "grok";

/** A renewal whose token request has left; `saved` resolves true when it left a usable sign-in stored, and never rejects. */
export interface SentRenewal {
  readonly route: RenewalRoute;
  readonly saved: Promise<boolean>;
}

// Renewals whose token request has left this process, until they and their credential write settle.
const sent = new Set<SentRenewal>();

/** Record a renewal whose token request has left until it settles; `saved` resolves true when a usable sign-in is stored, and never rejects. */
export function trackSentRenewal(route: RenewalRoute, saved: Promise<boolean>): void {
  const renewal: SentRenewal = { route, saved };
  sent.add(renewal);
  const forget = () => { sent.delete(renewal); };
  void saved.then(forget, forget);
}

/** Renewals still settling: exiting now could lose a refresh token the provider already rotated. */
export function pendingRenewals(): SentRenewal[] {
  return [...sent];
}
