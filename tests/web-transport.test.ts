import { afterEach, expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createWebFetchTool, type WebFetchOptions } from "../src/tools/web-fetch.ts";
import { connectWebAddress } from "../src/tools/web-transport.ts";

const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const text = "Readable compressed page: ภาษาไทย 🧪";

/** Serve exact encoded bytes through the production numeric-address transport. */
function fixture(encoding: string, body: Uint8Array = new Uint8Array(), status = 200, contentType = "text/plain") {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    [204, 205, 304].includes(status) ? null : body,
    { status, headers: { "Content-Encoding": encoding, "Content-Type": contentType } },
  ) });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/`;
}

/** Execute the real transport with explicit fixture-only loopback access and no spill file. */
const run = (url: string, options: WebFetchOptions = {}, signal?: AbortSignal) => createWebFetchTool({
  dangerouslyAllowPrivateAddressesForDevelopment: true, ...options,
}, false).execute({ url }, { workspace, signal });

for (const status of [204, 205, 304]) for (const encoding of ["gzip", "deflate", "br", "gzip, br"]) {
  test(`production transport ignores ${encoding} on bodyless HTTP ${status}`, async () => {
    const result = await run(fixture(encoding, undefined, status));
    expect(result.details).toMatchObject({ status, rawBytes: 0 });
    expect(result.isError).toBe(status === 304 ? true : undefined);
    expect(result.content).toContain("The response body is empty.");
    // Let decoder finalization errors surface inside this test on the unfixed transport.
    await new Promise(resolve => setImmediate(resolve));
  });
}

for (const [encoding, body] of [
  ["gzip", gzipSync(text)],
  ["deflate", deflateSync(text)],
  ["br", brotliCompressSync(text)],
  ["x-gzip", gzipSync(text)],
  ["identity", Buffer.from(text)],
  ["gzip, br", brotliCompressSync(gzipSync(text))],
  ["br, gzip", gzipSync(brotliCompressSync(text))],
  [" GZip , identity, BR ", brotliCompressSync(gzipSync(text))],
] as const) test(`production transport decodes ${encoding} into readable text`, async () => {
  const url = fixture(encoding, body);
  const result = await run(url);
  expect(result.isError).toBeUndefined();
  expect(result.content).toEndWith(`\n\n${text}`);
  expect(result.details).toMatchObject({ rawBytes: Buffer.byteLength(text), truncated: false });
  const response = await connectWebAddress(url, {}, { address: "127.0.0.1", family: 4 });
  expect(await response.text()).toBe(text);
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.has("content-length")).toBe(false);
});

for (const encoding of ["unknown-secret", "gzip, unknown-secret", "unknown-secret, br"]) {
  test(`production transport refuses unsupported encoding ${encoding}`, async () => {
    const result = await run(fixture(encoding, gzipSync(text)));
    expect(result).toMatchObject({ isError: true, details: { errorKind: "unsupported-content-encoding", rawBytes: 0 } });
    expect(result.content).not.toContain("unknown-secret");
    expect(result.content).not.toContain(text);
  });
}

for (const [name, encoding, body] of [
  ["corrupt gzip", "gzip", Buffer.from("not gzip")],
  ["truncated gzip", "gzip", gzipSync(text).subarray(0, -4)],
  ["corrupt Brotli", "br", Buffer.from([0xff, 0xff, 0xff, 0xff])],
  ["truncated Brotli", "br", brotliCompressSync(text).subarray(0, -4)],
  ["corrupt outer decoder", "gzip, br", Buffer.from([0xff, 0xff, 0xff, 0xff])],
  ["corrupt inner decoder", "gzip, br", brotliCompressSync("not gzip")],
] as const) test(`production transport turns ${name} into a tool error`, async () => {
  const result = await run(fixture(encoding, body));
  expect(result).toMatchObject({ isError: true, details: { errorKind: "network", status: 200 } });
  expect(result.content).not.toContain("not gzip");
});

test("stacked compression retains the decoded byte cap and cancels the whole pipeline", async () => {
  const cap = 1024;
  const body = "z".repeat(256 * 1024);
  const result = await run(fixture("gzip, br", brotliCompressSync(gzipSync(body))), { maxRawBytes: cap });
  expect(result.isError).toBeUndefined();
  expect(result.details).toMatchObject({ rawBytes: cap, truncated: true });
  expect(result.content).toContain("z".repeat(cap));
  expect(result.content).not.toContain("z".repeat(cap + 1));
});

test("discarding a corrupt compressed binary body handles every decoder error", async () => {
  const result = await run(fixture("gzip, br", brotliCompressSync("not gzip"), 200, "image/png"));
  expect(result).toMatchObject({ isError: true, details: { errorKind: "unsupported-content-type", rawBytes: 0 } });
  await new Promise(resolve => setImmediate(resolve));
});

/** Serve a partial response whose socket is controlled after headers arrive. */
async function partialResponse(encoding?: string) {
  const sent = Promise.withResolvers<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain", ...(encoding ? { "Content-Encoding": encoding } : {}) });
    response.flushHeaders();
    response.write(encoding ? gzipSync(text).subarray(0, 10) : "partial");
    sent.resolve(response);
  });
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture did not bind a port");
  return { url: `http://127.0.0.1:${address.port}/`, sent: sent.promise };
}

for (const encoding of [undefined, "gzip, identity"]) test(`socket errors propagate through ${encoding ?? "plain"} bodies`, async () => {
  const fixture = await partialResponse(encoding);
  const result = run(fixture.url);
  const response = await fixture.sent;
  // The client must have received headers before the fixture cuts the body short.
  await new Promise(resolve => setImmediate(resolve));
  response.destroy();
  expect(await result).toMatchObject({ isError: true, details: { errorKind: "connection-reset" } });
});

test("cancelling an unfinished compressed body closes its socket without decoder errors", async () => {
  const fixture = await partialResponse("gzip");
  const controller = new AbortController();
  const result = run(fixture.url, {}, controller.signal);
  const response = await fixture.sent;
  const closed = new Promise<void>(resolve => response.on("close", resolve));
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  await closed;
});
