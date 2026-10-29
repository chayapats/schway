import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { PassThrough, Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { WebFetchAddress } from "./web-address.ts";

/** Connect only to the checked numeric address while retaining the URL's HTTP Host and TLS identity. */
export type WebFetchConnect = (url: string, init: RequestInit, address: WebFetchAddress) => Promise<Response>;

/** Refuse an encoded response that cannot be decoded into readable body bytes. */
export class UnsupportedWebContentEncoding extends Error {
  constructor() { super("Unsupported content encoding. Use a page with gzip, deflate, Brotli or plain text."); }
}

/** Forward body failures to the reader and fence pending reads after cancellation. */
function responseBody(stream: Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (cancelled) return;
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel() {
      cancelled = true;
      stream.destroy();
      try { await iterator.return?.(); } catch { /* the cancelled reader owns no further errors */ }
    },
  });
}

/** Make one direct GET with no proxy, cookie jar, credentials, redirects, connection reuse or second DNS lookup. */
export const connectWebAddress: WebFetchConnect = async (input, init, address) => {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: address.address, family: address.family,
      port: url.port || undefined, path: `${url.pathname}${url.search}`, method: "GET", agent: false,
      headers: { ...Object.fromEntries(new Headers(init.headers)), Host: url.host },
      ...(url.protocol === "https:" ? { servername: isIP(host) ? "" : host, rejectUnauthorized: true } : {}),
      signal: init.signal ?? undefined,
    }, incoming => {
      // Also cover failures before a pipeline exists, including bodyless responses and setup errors.
      incoming.on("error", reject);
      const streams: Readable[] = [incoming];
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const noBody = incoming.statusCode === 204 || incoming.statusCode === 205 || incoming.statusCode === 304;
        const responseInit = {
          status: incoming.statusCode!, statusText: incoming.statusMessage, headers,
        };
        if (noBody) {
          const response = new Response(null, responseInit);
          incoming.once("end", () => resolve(response));
          incoming.resume();
          return;
        }
        const encodings = headers.get("content-encoding")?.toLowerCase().split(",").map(value => value.trim()).filter(Boolean) ?? [];
        if (encodings.some(encoding => !["gzip", "x-gzip", "deflate", "br", "identity"].includes(encoding))) {
          throw new UnsupportedWebContentEncoding();
        }
        for (const encoding of encodings.reverse()) {
          if (encoding !== "identity") streams.push(
            encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : createGunzip(),
          );
        }
        if (encodings.length) {
          headers.delete("content-encoding"); headers.delete("content-length");
        }
        // Pipeline owns errors and teardown for the source, every decoder and the web-stream bridge.
        const body = new PassThrough();
        streams.push(body);
        pipeline(streams, error => { if (error) reject(error); });
        resolve(new Response(responseBody(body), responseInit));
      } catch (error) {
        for (const stream of streams) stream.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end();
  });
};
