// Renewals whose token request has left this process, until they and their credential write settle.
const sent = new Set<Promise<void>>();

/** Record a renewal whose token request has left, until it and its credential write settle; `settled` never rejects. */
export function trackSentRenewal(settled: Promise<void>): void {
  sent.add(settled);
  const forget = () => { sent.delete(settled); };
  void settled.then(forget, forget);
}

/** True while a renewal this process sent has not settled: exiting now could lose a refresh token the provider rotated. */
export function hasSentRenewals(): boolean {
  return sent.size > 0;
}

/** Resolve once every renewal sent so far, and any sent while waiting, has settled; each is bounded by its refresher. */
export async function sentRenewalsSettled(): Promise<void> {
  while (sent.size) await Promise.all([...sent]);
}
