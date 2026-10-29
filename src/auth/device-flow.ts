/** Ephemeral provider authorization keeps its private grant inside one shared polling closure. */
export interface DeviceFlowAuthorization<T> {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  /** Complete the captured grant under its original deadline without persisting credentials. */
  poll(signal?: AbortSignal): Promise<T>;
}

/** Stable protocol failures carry only fixed guidance, never provider payloads. */
export class DeviceFlowError extends Error {
  constructor(readonly kind: "expired" | "denied" | "provider-error", message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/** Wait without retaining an abort listener after either settlement. */
export function sleepDeviceFlow(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

/** Cap a device grant at fifteen minutes from issuance, including deferred polling. */
export function deviceFlowExpiresAt(expiresIn: number | undefined, now: number): number {
  const seconds = expiresIn !== undefined && Number.isFinite(expiresIn) ? Math.max(0, Math.min(expiresIn, 900)) : 900;
  return now + seconds * 1000;
}

/** Bound even an uncooperative transport or body reader and discard its late result. */
export async function withinDeviceFlow<T>(input: {
  expiresAt: number; signal?: AbortSignal; now?: () => number; expiredMessage?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const timer = new AbortController(), controller = new AbortController();
  const expired = () => new DeviceFlowError("expired", input.expiredMessage ?? "Sign-in timed out · /login retry device approval");
  let rejectStop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const cancel = () => { controller.abort(); rejectStop(new DOMException("Aborted", "AbortError")); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  const remaining = input.expiresAt - now();
  if (input.signal?.aborted) cancel();
  else if (remaining <= 0) { controller.abort(); rejectStop(expired()); }
  else void (input.sleep ?? sleepDeviceFlow)(remaining, timer.signal).then(() => {
    controller.abort(); rejectStop(expired());
  }, () => {});
  try {
    return await Promise.race([stopped, (async () => {
      controller.signal.throwIfAborted();
      const result = await operation(controller.signal);
      input.signal?.throwIfAborted();
      if (now() >= input.expiresAt) throw expired();
      return result;
    })()]);
  } finally {
    timer.abort();
    input.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

/** Admit only an HTTPS approval address without embedded credentials. */
export function validateDeviceVerificationUri(value: string): string {
  try {
    const uri = new URL(value);
    if (uri.protocol === "https:" && !uri.username && !uri.password && value.length <= 2048) return value;
  } catch {}
  throw new DeviceFlowError("provider-error", "HTTPS approval link required · /login retry sign-in");
}
