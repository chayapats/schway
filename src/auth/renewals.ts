/** Subscription route a renewal belongs to. */
export type RenewalRoute = "codex" | "grok";

// Renewals whose token request has left this process, until they and their credential write settle; each resolves
// true when it left a usable sign-in stored.
const sent = new Map<Promise<boolean>, RenewalRoute>();

/** Record a renewal whose token request has left until it settles; `saved` resolves true when a usable sign-in is stored, and never rejects. */
export function trackSentRenewal(route: RenewalRoute, saved: Promise<boolean>): void {
  sent.set(saved, route);
  const forget = () => { sent.delete(saved); };
  void saved.then(forget, forget);
}

/** True while a renewal this process sent has not settled: exiting now could lose a refresh token the provider rotated. */
export function hasSentRenewals(): boolean {
  return sent.size > 0;
}

/** Routes with a renewal still settling, ChatGPT first. */
export function sentRenewalRoutes(): RenewalRoute[] {
  const routes = new Set(sent.values());
  return (["codex", "grok"] as const).filter(route => routes.has(route));
}

/** Resolve once every renewal sent so far, and any sent while waiting, has settled; true when each stored its sign-in. */
export async function sentRenewalsSettled(): Promise<boolean> {
  let saved = true;
  while (sent.size) {
    const outcomes = await Promise.all([...sent.keys()]);
    if (outcomes.some(outcome => !outcome)) saved = false;
  }
  return saved;
}
