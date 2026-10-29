import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { WebFetchAddress } from "./web-address.ts";

/** Connect only to the checked numeric address while retaining the URL's HTTP Host and TLS identity. */
export type WebFetchConnect = (url: string, init: RequestInit, address: WebFetchAddress) => Promise<Response>;

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
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const encoding = headers.get("content-encoding")?.toLowerCase();
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
        const stream = decoder ? incoming.pipe(decoder) : incoming;
        if (decoder) {
          incoming.on("error", error => decoder.destroy(error));
          decoder.on("close", () => incoming.destroy());
          headers.delete("content-encoding"); headers.delete("content-length");
        }
        const noBody = incoming.statusCode === 204 || incoming.statusCode === 205 || incoming.statusCode === 304;
        resolve(new Response(noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode!, statusText: incoming.statusMessage, headers,
        }));
        if (noBody) incoming.resume();
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.on("error", reject);
    request.end();
  });
};
