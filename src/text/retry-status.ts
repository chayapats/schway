import type { ModelRetryCause } from "../agent/events.ts";

/** Name a retry's cause in two words; only `offline` mentions the connection, and a missing cause stays neutral. */
export function retryCauseLabel(cause: ModelRetryCause | undefined): string {
  switch (cause) {
    case "rate-limit": return "Rate limited";
    case "provider": return "Provider unavailable";
    case "offline": return "Connection lost";
    default: return "Retrying request";
  }
}

/** Number the upcoming attempt after `failedAttempt` out of the total, as `Attempt 2/3`. */
export function retryAttemptLabel(failedAttempt: number, maxAttempts: number): string {
  return `Attempt ${failedAttempt + 1}/${maxAttempts}`;
}

/** Describe time until the next attempt in whole seconds rounded up (`in 2s`), or `now` once none remains. */
export function formatRetryWait(remainingMs: number): string {
  if (!(remainingMs > 0)) return "now";
  const seconds = Math.ceil(remainingMs / 1000);
  return seconds < 60 ? `in ${seconds}s` : `in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
