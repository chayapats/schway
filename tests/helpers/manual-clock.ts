/** Advance simultaneous cancellable waits in deadline order without using wall-clock timers. */
export function manualClock() {
  let time = 1_800_000_000_000;
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const timers = new Set<{ at: number; finish(): void }>();
  return {
    now: () => time,
    sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      const cleanup = () => { timers.delete(entry); signal?.removeEventListener("abort", stop); };
      const stop = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const entry = { at: time + ms, finish() { cleanup(); resolve(); } };
      timers.add(entry); signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    }),
    advance: async (ms: number) => {
      await flush();
      const target = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > target) break;
        time = next.at; next.finish(); await flush();
      }
      time = target; await flush();
    },
    pending: () => timers.size,
  };
}
