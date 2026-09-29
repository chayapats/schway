import type { FetchLike } from "../model/loader.ts";

/** Cumulative response-body byte ceiling for one live smoke lane, including retries and subscription refresh. */
export const MAX_SMOKE_WIRE_BYTES = 256 * 1024;

/** Forward selected-provider HTTP requests while bounding response bytes before adapters parse SSE frames. */
export function boundedSmokeFetch(options: {
  signal: AbortSignal;
  onLimit: () => void;
  /** Observe only request start and numeric response status, including retries/refresh. */
  onProgress?: (event: { type: "request" } | { type: "response"; status: number }) => void;
  fetch?: FetchLike;
}): FetchLike {
  let bytes = 0;
  let exceeded = false;
  return async (input, init) => {
    if (exceeded) throw new Error("Live smoke response byte budget exceeded");
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = originalSignal ? AbortSignal.any([options.signal, originalSignal]) : options.signal;
    // Preserve request bodies/headers but never let an SDK or Request follow a redirect:
    // an HTTPS endpoint must not forward Bearer credentials to a plaintext target.
    options.onProgress?.({ type: "request" });
    const response = await (options.fetch ?? fetch)(input, { ...init, signal, redirect: "error" });
    options.onProgress?.({ type: "response", status: response.status });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_SMOKE_WIRE_BYTES) {
            exceeded = true;
            controller.error(new Error("Live smoke response byte budget exceeded"));
            // Neither reader cancellation nor provider abort is assumed to settle.
            void reader.cancel().catch(() => {});
            options.onLimit();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { void reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
