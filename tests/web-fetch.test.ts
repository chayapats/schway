import { afterEach, expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json";
import { executeToolCall } from "../src/tools/executor.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import {
  createWebFetchTool as createGuardedWebFetchTool,
  WEB_FETCH_ERROR_EXCERPT_BYTES,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_RAW_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_RESPONSE_DEADLINE_MS,
  WEB_FETCH_TOTAL_DEADLINE_MS,
  WEB_FETCH_USER_AGENT,
  webFetchTool as defaultWebFetchTool,
  type WebFetchDetails,
  type WebFetchOptions,
} from "../src/tools/web-fetch.ts";
import type { ToolExecutionResult } from "../src/tools/types.ts";
import { decodeHtmlEntities, htmlToText } from "../src/tools/html-text.ts";

// Body/format fixtures explicitly opt into their loopback HTTP servers; security tests use defaults.
const createWebFetchTool = (options: WebFetchOptions = {}) => createGuardedWebFetchTool({
  dangerouslyAllowPrivateAddressesForDevelopment: true,
  ...(options.connect ? { resolve: async () => [{ address: "93.184.216.34", family: 4 as const }] } : {}), ...options,
});
const webFetchTool = createWebFetchTool();
const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
const fixtures = join(import.meta.dir, "fixtures/web-fetch");
const encoder = new TextEncoder();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Serve a handler on an ephemeral loopback port for one test. */
function serve(handler: (request: Request, url: URL) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch: request => handler(request, new URL(request.url)) });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** Run web_fetch directly with optional injections. */
async function fetchUrl(url: string, options: WebFetchOptions = {}, signal?: AbortSignal): Promise<ToolExecutionResult & { details: WebFetchDetails }> {
  const result = await createWebFetchTool(options).execute({ url }, { workspace, signal });
  const details = result.details as WebFetchDetails;
  if (details.outputPath) cleanups.push(() => rm(details.outputPath!, { force: true }));
  return result as ToolExecutionResult & { details: WebFetchDetails };
}

const bytes = (text: string) => encoder.encode(text).length;
const firstLine = (content: string) => content.split("\n")[0]!;
/** Promise plus its resolver, for fixture handshakes. */
function latch<T = void>() { return Promise.withResolvers<T>(); }
/** Reject when a fixture handshake does not arrive quickly, so failures never hang. */
const within = <T>(promise: Promise<T>, ms = 2_000) => Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`Timed out after ${ms} ms`); })]);

test("exported limits match the documented contract", () => {
  expect(WEB_FETCH_RESPONSE_DEADLINE_MS).toBe(5_000);
  expect(WEB_FETCH_TOTAL_DEADLINE_MS).toBe(15_000);
  expect(WEB_FETCH_MAX_RAW_BYTES).toBe(2 * 1024 * 1024);
  expect(WEB_FETCH_MAX_OUTPUT_BYTES).toBe(32 * 1024);
  expect(WEB_FETCH_MAX_REDIRECTS).toBe(5);
  expect(WEB_FETCH_ERROR_EXCERPT_BYTES).toBe(2 * 1024);
  expect(defaultWebFetchTool).toMatchObject({ name: "web_fetch", effect: "read-only", execution: "parallel" });
});

test("the schema requires one url and rejects unknown keys", () => {
  const registered = createToolRegistry([webFetchTool]).get("web_fetch")!;
  expect(registered.validate({ url: "https://example.test/" }).ok).toBe(true);
  expect(registered.validate({}).ok).toBe(false);
  expect(registered.validate({ url: "https://example.test/", method: "POST" }).ok).toBe(false);
  expect(registered.validate({ url: "" }).ok).toBe(false);
  expect(registered.definition.description).toContain("JavaScript does not run");
});

test("an HTML page with script, style and navigation noise converts to the golden text", async () => {
  const html = await readFile(join(fixtures, "page.html"));
  const golden = (await readFile(join(fixtures, "page.golden.txt"), "utf8")).trimEnd();
  const base = serve(() => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  const result = await fetchUrl(`${base}/page`);
  expect(result.isError).toBeUndefined();
  expect(result.content).toBe(`HTTP 200 OK · text/html · ${html.length.toLocaleString("en-US")} bytes · ${base}/page\n\n${golden}`);
  expect(result.details).toMatchObject({ url: `${base}/page`, finalUrl: `${base}/page`, status: 200, contentType: "text/html",
    rawBytes: html.length, textBytes: bytes(golden), truncated: false });
  expect(result.details.errorKind).toBeUndefined();
  expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
});

test("HTML conversion handles quoted brackets, unclosed scripts, XHTML and entity edge cases", () => {
  expect(htmlToText('<P CLASS="a">Go <A TITLE="x > y" HREF="/n">next</A><BR/>line</P>')).toBe("Go next\nline");
  expect(htmlToText("<p>Before</p><script>never()")).toBe("Before");
  expect(htmlToText("<div>a</div><!-- unclosed comment <p>hidden</p>")).toBe("a");
  expect(htmlToText("<p>1 < 2 and 3 > 2</p>")).toBe("1 < 2 and 3 > 2");
  expect(htmlToText("<textarea>keep <b>this</b></textarea>")).toBe("keep <b>this</b>");
  expect(htmlToText("<ul><li>one</li><li></li></ul><p>after</p>")).toBe("- one\n\nafter");
  expect(htmlToText("<ol><li><p>step</p></li></ol>")).toBe("1. step");
  expect(decodeHtmlEntities("&#x1F600; &#128512; &bogus; &amp &ampx &copy &#0; &#xD800; &#150;")).toBe("😀 😀 &bogus; & &ampx © \ufffd \ufffd –");
});

test("indented tables keep single spaces around cell separators", () => {
  expect(htmlToText("<table>\n  <tr>\n    <td>Sukhumvit</td>\n    <td>05:15</td>\n  </tr>\n  <tr><td>a </td><td> b</td><td>\n c </td></tr>\n</table>"))
    .toBe("Sukhumvit | 05:15\na | b | c");
});

test("preformatted blocks keep blank-line runs, trailing spaces and tabs", () => {
  expect(htmlToText("<p>Before</p><pre>a\n\n\n\nb  \n\tc &lt;d&gt;</pre><p>after   it</p>")).toBe("Before\n\na\n\n\n\nb  \n\tc <d>\n\nafter it");
  // Noncharacters in the page, literal or as references, cannot impersonate preformatted whitespace.
  expect(htmlToText("<p>x\ufdd0\ufdd1y</p>")).toBe("x\ufffd\ufffdy");
  expect(htmlToText("<p>a&#xFDD0;&#64976;b&#xFDD1;&#xFDD2;</p><ul><li>x&#xFDD0;- injected item</li></ul>"))
    .toBe("a\ufffd\ufffdb\ufffd\ufffd\n\n- x\ufffd- injected item");
  expect(htmlToText("<pre>a&#xFDD0;&#xFDD1;b</pre>")).toBe("a\ufffd\ufffdb");
});

test("a 2 MiB run of preformatted or entity newlines converts in linear time", () => {
  const newlines = 2 * 1024 * 1024;
  for (const html of [`<pre>a${"\n".repeat(newlines)}b</pre>`, `<pre>a${"\n".repeat(newlines)}</pre>`, `<p>a${"&#xFDD0;".repeat(newlines / 8)}b</p>`]) {
    const started = performance.now();
    const text = htmlToText(html);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(text.startsWith("a")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(newlines + 2);
  }
  expect(htmlToText(`<pre>a${"\n".repeat(newlines)}b</pre>`)).toHaveLength(newlines + 2);
});

test("deeply nested lists near the raw cap convert quickly with bounded output", () => {
  const depth = 230_000;
  const html = "<ul>".repeat(depth) + "<li>x".repeat(depth);
  expect(html.length).toBeGreaterThan(2_000_000);
  const started = performance.now();
  const text = htmlToText(html);
  expect(performance.now() - started).toBeLessThan(2_000);
  // Each item is at most a 12-space indent, a marker, the text and a newline.
  expect(text.length).toBeLessThanOrEqual(depth * 16);
  expect(text.split("\n").at(-1)).toBe(`${" ".repeat(12)}- x`);
});

test("declared non-UTF-8 charsets decode from the header and from a meta declaration", async () => {
  // "ภาษาไทย" in windows-874 (a TIS-620 superset) and "café" in ISO-8859-1.
  const thai = Uint8Array.from([0xc0, 0xd2, 0xc9, 0xd2, 0xe4, 0xb7, 0xc2]);
  const base = serve((_request, url) => {
    if (url.pathname === "/header") return new Response(Uint8Array.from([...thai, 0x20, 0x31, 0x32]), { headers: { "Content-Type": "text/plain; charset=windows-874" } });
    if (url.pathname === "/meta") return new Response(Uint8Array.from([...encoder.encode("<html><head><meta charset=\"iso-8859-1\"></head><body><p>caf"), 0xe9, ...encoder.encode("</p></body></html>")]), { headers: { "Content-Type": "text/html" } });
    return new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), { headers: { "Content-Type": "text/plain" } });
  });
  expect((await fetchUrl(`${base}/header`)).content.split("\n\n")[1]).toBe("ภาษาไทย 12");
  expect((await fetchUrl(`${base}/meta`)).content.split("\n\n")[1]).toBe("café");
  // Undeclared invalid UTF-8 falls back to replacement characters.
  expect((await fetchUrl(`${base}/plain`)).content.split("\n\n")[1]).toBe("caf�");
});

test("text, JSON and XML pass through unchanged", async () => {
  const base = serve((_request, url) => url.pathname === "/json"
    ? Response.json({ temp: 31, city: "กรุงเทพ" })
    : url.pathname === "/xml" ? new Response("<rss><item>one &amp; two</item></rss>", { headers: { "Content-Type": "application/rss+xml" } })
      : new Response("plain\r\ntext", { headers: { "Content-Type": "text/plain" } }));
  expect((await fetchUrl(`${base}/json`)).content).toEndWith('\n\n{"temp":31,"city":"กรุงเทพ"}');
  expect((await fetchUrl(`${base}/xml`)).content).toEndWith("\n\n<rss><item>one &amp; two</item></rss>");
  expect((await fetchUrl(`${base}/text`)).content).toEndWith("\n\nplain\ntext");
});

test("204 and an empty 200 say the body is empty instead of returning empty content", async () => {
  const base = serve((_request, url) => url.pathname === "/204" ? new Response(null, { status: 204 }) : new Response("", { headers: { "Content-Type": "text/html" } }));
  const noContent = await fetchUrl(`${base}/204`);
  expect(noContent.isError).toBeUndefined();
  expect(noContent.content).toBe(`HTTP 204 No Content · no content type · 0 bytes · ${base}/204\n\nThe response body is empty.`);
  const empty = await fetchUrl(`${base}/empty`);
  expect(empty.isError).toBeUndefined();
  expect(empty.content).toBe(`HTTP 200 OK · text/html · 0 bytes · ${base}/empty\n\nThe response body is empty.`);
});

test("an HTML page without readable text says so", async () => {
  const base = serve(() => new Response("<html><body><script>render()</script></body></html>", { headers: { "Content-Type": "text/html" } }));
  const result = await fetchUrl(`${base}/app`);
  expect(result.isError).toBeUndefined();
  expect(result.content).toEndWith("\n\nThe page has no readable text. It may need JavaScript.");
});

test("a 301 → 302 → 200 chain reports the final URL", async () => {
  const hits: string[] = [];
  const base = serve((_request, url) => {
    hits.push(url.pathname);
    if (url.pathname === "/start") return new Response(null, { status: 301, headers: { Location: "/middle" } });
    if (url.pathname === "/middle") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${url.port}/final?x=1` } });
    return new Response("arrived", { headers: { "Content-Type": "text/plain" } });
  });
  const result = await fetchUrl(`${base}/start`);
  expect(hits).toEqual(["/start", "/middle", "/final"]);
  expect(result.isError).toBeUndefined();
  expect(firstLine(result.content)).toBe(`HTTP 200 OK · text/plain · 7 bytes · ${base}/final?x=1 · after 2 redirects`);
  expect(result.details).toMatchObject({ url: `${base}/start`, finalUrl: `${base}/final?x=…`, status: 200 });
});

test("a redirect loop stops at the redirect limit", async () => {
  let hits = 0;
  const base = serve(() => { hits++; return new Response(null, { status: 302, headers: { Location: "/loop" } }); });
  const result = await fetchUrl(`${base}/loop`);
  expect(hits).toBe(WEB_FETCH_MAX_REDIRECTS + 1);
  expect(result.isError).toBe(true);
  expect(result.content).toBe(`HTTP 302 Found · no content type · 0 bytes · ${base}/loop\n\nStopped after 5 redirects. The redirect chain may loop.`);
  expect(result.details).toMatchObject({ errorKind: "redirect-limit", status: 302 });
});

test("a redirect to another scheme is not followed", async () => {
  const base = serve(() => new Response(null, { status: 302, headers: { Location: "file:///etc/passwd" } }));
  const result = await fetchUrl(`${base}/escape`);
  expect(result.isError).toBe(true);
  expect(result.details.errorKind).toBe("unsupported-scheme");
  expect(result.content).toContain("Only http and https URLs are supported, not file:");
});

test("404 and 500 are errors with the code, reason and a bounded body excerpt", async () => {
  const long = `<html><body><h1>Server error</h1><p>${"ข้อผิดพลาด 🧪 ".repeat(800)}</p></body></html>`;
  const base = serve((_request, url) => url.pathname === "/missing"
    ? new Response("<h1>Not here</h1><p>Try the index.</p>", { status: 404, headers: { "Content-Type": "text/html" } })
    : new Response(long, { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }));
  const missing = await fetchUrl(`${base}/missing`);
  expect(missing.isError).toBe(true);
  expect(missing.content).toBe(`HTTP 404 Not Found · text/html · 38 bytes · ${base}/missing\n\nThe server returned HTTP 404 Not Found.\n\n# Not here\n\nTry the index.`);
  expect(missing.details).toMatchObject({ status: 404, errorKind: "http-status" });
  const failed = await fetchUrl(`${base}/broken`);
  expect(failed.isError).toBe(true);
  expect(failed.content).toStartWith(`HTTP 500 Internal Server Error · text/html · ${bytes(long).toLocaleString("en-US")} bytes · ${base}/broken\n\nThe server returned HTTP 500 Internal Server Error.\n\n# Server error`);
  const excerpt = failed.content.split("\n\n").slice(2).join("\n\n");
  expect(bytes(excerpt)).toBeLessThanOrEqual(WEB_FETCH_ERROR_EXCERPT_BYTES + bytes("…"));
  expect(excerpt).toEndWith("…");
  expect(excerpt).not.toContain("�");
});

test("a closed port fails as connection refused", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  const result = await fetchUrl(`http://127.0.0.1:${port}/`);
  expect(result.isError).toBe(true);
  expect(result.content).toBe(`No response · http://127.0.0.1:${port}/\n\n127.0.0.1:${port} refused the connection.`);
  expect(result.details).toMatchObject({ errorKind: "connection-refused", rawBytes: 0 });
  expect(result.details.status).toBeUndefined();
});

test("DNS, TLS and reset failures from injected fetch errors each have their own message", async () => {
  const failing = (error: Error) => ({ connect: async () => { throw error; } });
  const coded = (message: string, code: string) => Object.assign(new TypeError(message), { code });
  const dns = await fetchUrl("https://unknown.example.test/", failing(coded("getaddrinfo ENOTFOUND unknown.example.test", "ENOTFOUND")));
  expect(dns).toMatchObject({ isError: true, details: { errorKind: "dns" } });
  expect(dns.content).toBe("No response · https://unknown.example.test/\n\nDNS lookup failed for unknown.example.test. Check the host name.");
  const bunDns = await fetchUrl("https://typo.example.test/", failing(coded("Was there a typo in the url or port?", "FailedToOpenSocket")));
  expect(bunDns.details.errorKind).toBe("dns");
  const tls = await fetchUrl("https://self-signed.example.test/", failing(coded("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT")));
  expect(tls).toMatchObject({ isError: true, details: { errorKind: "tls" } });
  expect(tls.content).toBe("No response · https://self-signed.example.test/\n\nThe secure connection to self-signed.example.test failed. Its certificate or TLS setup was rejected.");
  const reset = await fetchUrl("https://flaky.example.test/", failing(coded("The socket connection was closed unexpectedly.", "ECONNRESET")));
  expect(reset.details.errorKind).toBe("connection-reset");
  expect(reset.content).toEndWith("The connection to flaky.example.test closed before the response finished.");
  const other = await fetchUrl("https://odd.example.test/", failing(new Error("Something else")));
  expect(other).toMatchObject({ isError: true, details: { errorKind: "network" } });
  expect(other.content).toEndWith("The request to odd.example.test failed.");
  expect(new Set([dns.content, tls.content, reset.content, other.content].map(content => content.split("\n\n")[1])).size).toBe(4);
});

test("a TLS handshake against a plain HTTP loopback server fails as TLS", async () => {
  const base = serve(() => new Response("plain"));
  const result = await fetchUrl(base.replace("http:", "https:") + "/");
  expect(result.isError).toBe(true);
  expect(result.details.errorKind).toBe("tls");
});

test("file:, ftp:, relative and userinfo URLs are rejected before any request", async () => {
  const requests: string[] = [];
  const options: WebFetchOptions = { connect: async input => { requests.push(input); return new Response("unexpected"); } };
  const file = await fetchUrl("file:///etc/hosts", options);
  expect(file.content).toBe("No request sent · file:///etc/hosts\n\nOnly http and https URLs are supported, not file:");
  expect(file.details.errorKind).toBe("unsupported-scheme");
  const ftp = await fetchUrl("ftp://files.example.test/readme.txt", options);
  expect(ftp.details.errorKind).toBe("unsupported-scheme");
  expect(ftp.content).toEndWith("not ftp:");
  const data = await fetchUrl("data:text/plain,hello", options);
  expect(data.details.errorKind).toBe("unsupported-scheme");
  const relative = await fetchUrl("/docs/page", options);
  expect(relative.content).toBe("No request sent · /docs/page\n\nUse an absolute http or https URL.");
  expect(relative.details.errorKind).toBe("invalid-url");
  const userinfo = await fetchUrl("https://admin:hunter2@example.test/private", options);
  expect(userinfo.details.errorKind).toBe("userinfo");
  expect(userinfo.content).toBe("No request sent · https://***@example.test/private\n\nURLs with a user name or password are not supported. Remove the credentials from the URL.");
  expect(JSON.stringify(userinfo)).not.toContain("hunter2");
  const atPassword = await fetchUrl("https://user:p@ss@example.test/private", options);
  expect(atPassword.content).toStartWith("No request sent · https://***@example.test/private\n\n");
  const unparsable = await fetchUrl("http://user:p@ss@[bad/x", options);
  expect(unparsable.content).toStartWith("No request sent · http://***@[bad/x\n\n");
  const backslashes = await fetchUrl("https:\\\\u:p@ss@[bad/x", options);
  expect(backslashes.content).toStartWith("No request sent · https:\\\\***@[bad/x\n\n");
  const tolerated = await fetchUrl("https:user:p@ss@example.test/x", options);
  expect(tolerated.content).toStartWith("No request sent · https://***@example.test/x\n\n");
  expect(JSON.stringify([atPassword, unparsable, backslashes, tolerated])).not.toContain("ss@");
  for (const result of [file, ftp, data, relative, userinfo]) expect(result.isError).toBe(true);
  expect(requests).toEqual([]);
});

test("binary content types are errors naming the type and size without returning bytes", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const base = serve((_request, url) => url.pathname === "/image"
    ? new Response(png, { headers: { "Content-Type": "image/png" } })
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([0, 1, 2, 3, 0xff])); controller.close(); } }),
      { headers: { "Content-Type": "application/octet-stream" } }));
  const image = await fetchUrl(`${base}/image`);
  expect(image.isError).toBe(true);
  expect(image.content).toBe(`HTTP 200 OK · image/png · 12 bytes · ${base}/image\n\nUnsupported content type image/png (12 bytes). web_fetch returns text only.`);
  expect(image.details).toMatchObject({ errorKind: "unsupported-content-type", contentType: "image/png" });
  const stream = await fetchUrl(`${base}/stream`);
  expect(stream.isError).toBe(true);
  expect(stream.content).toEndWith("Unsupported content type application/octet-stream (5 bytes). web_fetch returns text only.");
});

test("an endless binary stream without Content-Length fails at once as unsupported, without reading the body", async () => {
  const cancelled = latch();
  let pulls = 0;
  const base = serve(() => new Response(new ReadableStream({
    async pull(controller) { pulls++; await Bun.sleep(5); controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled.resolve(); },
  }), { headers: { "Content-Type": "audio/mpeg" } }));
  const started = performance.now();
  const result = await fetchUrl(`${base}/live`, { totalDeadlineMs: 5_000 });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(result).toMatchObject({ isError: true, details: { errorKind: "unsupported-content-type", rawBytes: 0 } });
  expect(result.content).toBe(`HTTP 200 OK · audio/mpeg · size unknown · ${base}/live\n\nUnsupported content type audio/mpeg (size unknown). web_fetch returns text only.`);
  await within(cancelled.promise);
  expect(pulls).toBeLessThan(20);
});

test("a redirect to an unsupported target reports type and size in its status line", async () => {
  const base = serve(() => new Response("moved", { status: 301, headers: { Location: "ftp://files.example.test/a", "Content-Type": "text/plain" } }));
  const result = await fetchUrl(`${base}/old`);
  expect(result.content).toBe(`HTTP 301 Moved Permanently · text/plain · 5 bytes · ${base}/old\n\nThe server redirected to a URL that web_fetch does not follow. Only http and https URLs are supported, not ftp:`);
});

test("an endpoint that never sends headers fails at the injected response deadline", async () => {
  const closed = latch();
  const base = serve(request => new Promise<Response>(resolve => request.signal.addEventListener("abort", () => { closed.resolve(); resolve(new Response("late")); })));
  const started = performance.now();
  const result = await fetchUrl(`${base}/silent`, { responseDeadlineMs: 50, totalDeadlineMs: 5_000 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(result.isError).toBe(true);
  expect(result.content).toBe(`No response · ${base}/silent\n\nThe server sent no response within 50 ms.`);
  expect(result.details.errorKind).toBe("response-deadline");
  await within(closed.promise);
});

test("an endpoint that trickles its body forever fails at the injected total deadline", async () => {
  const base = serve(() => new Response(new ReadableStream({
    async pull(controller) { await Bun.sleep(10); controller.enqueue(encoder.encode("x")); },
  }), { headers: { "Content-Type": "text/plain" } }));
  const started = performance.now();
  const result = await fetchUrl(`${base}/trickle`, { responseDeadlineMs: 1_000, totalDeadlineMs: 150 });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(new RegExp(`^HTTP 200 OK · text/plain · \\d+ bytes? read · ${base}/trickle\n\nThe response did not finish within 150 ms\\.$`));
  expect(result.details).toMatchObject({ errorKind: "total-deadline", status: 200 });
  expect(result.details.rawBytes).toBeGreaterThan(0);
});

test("cancelling mid-body settles the call as cancelled and closes the connection", async () => {
  const sent = latch();
  const closed = latch();
  const base = serve(request => {
    request.signal.addEventListener("abort", () => closed.resolve());
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode("first chunk\n")); sent.resolve(); },
      cancel() { closed.resolve(); },
    }), { headers: { "Content-Type": "text/plain" } });
  });
  const abort = new AbortController();
  const running = executeToolCall({
    registry: createToolRegistry([webFetchTool]), workspace, signal: abort.signal,
    call: { type: "tool_call", id: "fetch-1", name: "web_fetch", arguments: { url: `${base}/stream` } },
  });
  await within(sent.promise);
  await Bun.sleep(30);
  abort.abort();
  const result = await within(running);
  expect(result.status).toBe("cancelled");
  expect(result.result).toMatchObject({ content: "Tool call cancelled", isError: true });
  await within(closed.promise);
});

test("a multibyte page larger than the output cap stays within the UTF-8 byte cap and spills the full text", async () => {
  const line = "อากาศวันนี้ฝนตก 🌧️ ไปสยามด้วย BTS 🚆 ใช้เวลา 12 นาที\n";
  const text = line.repeat(1_500);
  expect(bytes(text)).toBeGreaterThan(WEB_FETCH_MAX_OUTPUT_BYTES * 2);
  const base = serve(() => new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  const result = await fetchUrl(`${base}/thai`);
  expect(result.isError).toBeUndefined();
  expect(bytes(result.content)).toBeLessThanOrEqual(WEB_FETCH_MAX_OUTPUT_BYTES);
  expect(result.content).not.toContain("�");
  expect(new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(result.content))).toBe(result.content);
  const path = result.details.outputPath!;
  expect(path).toBeString();
  expect(result.details).toMatchObject({ truncated: true, rawBytes: bytes(text), textBytes: bytes(text) });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).toBe(text);
  const notice = /\n\n\[Showing the first (\d+) of (\d+) bytes of text\. Full text: (.+)\. Use read with offset (\d+) to continue\.\]$/.exec(result.content)!;
  expect(notice).not.toBeNull();
  expect(notice[3]).toBe(path);
  expect(Number(notice[2])).toBe(bytes(text));
  const shown = result.content.slice(result.content.indexOf("\n\n") + 2, notice.index);
  expect(bytes(shown)).toBe(Number(notice[1]));
  expect(text.startsWith(shown)).toBe(true);
  // The continuation offset re-reads the partly shown line.
  expect(Number(notice[4])).toBe(shown.split("\n").length);
});

test("the raw-body cap stops reading an endless body", async () => {
  const cancelled = latch();
  const base = serve(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(encoder.encode("ข้อมูล".repeat(1_000))); },
    cancel() { cancelled.resolve(); },
  }), { headers: { "Content-Type": "text/plain" } }));
  const result = await fetchUrl(`${base}/endless`, { maxRawBytes: 64 * 1024, totalDeadlineMs: 5_000 });
  expect(result.isError).toBeUndefined();
  expect(result.details).toMatchObject({ rawBytes: 64 * 1024, truncated: true });
  expect(firstLine(result.content)).toBe(`HTTP 200 OK · text/plain · 65,536 bytes (read limit) · ${base}/endless`);
  expect(result.content).toContain("[Stopped reading at the read limit (65,536 bytes); the rest was not fetched.]");
  expect(result.content).not.toContain("�");
  await within(cancelled.promise);
});

test("hitting the raw-body cap before any readable text is an error", async () => {
  const base = serve(() => new Response(`<html><script>${"x".repeat(200_000)}</script></html>`, { headers: { "Content-Type": "text/html" } }));
  const result = await fetchUrl(`${base}/scripts`, { maxRawBytes: 1024 * 1024 / 8 });
  expect(result.isError).toBe(true);
  expect(result.details.errorKind).toBe("body-cap");
  expect(result.content).toEndWith("The body reached the read limit (131,072 bytes) before any readable text appeared.");
});

test("requests are GET with the Schway User-Agent and no cookies or credentials", async () => {
  const seen: Array<{ method: string; headers: Record<string, string>; body: string }> = [];
  const base = serve(async request => {
    seen.push({ method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    return new Response("ok", { headers: { "Content-Type": "text/plain", "Set-Cookie": "session=abc" } });
  });
  await fetchUrl(`${base}/one`);
  await fetchUrl(`${base}/two`);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    expect(request.method).toBe("GET");
    expect(request.body).toBe("");
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["proxy-authorization"]).toBeUndefined();
    expect(request.headers["user-agent"]).toBe(WEB_FETCH_USER_AGENT);
  }
  expect(WEB_FETCH_USER_AGENT).toBe(`Schway/${version} (web_fetch)`);
});
