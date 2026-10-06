import { Type, type Static } from "@sinclair/typebox";
import { chmod, writeFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../../package.json";
import { abortError } from "./fs.ts";
import { htmlToText } from "./html-text.ts";
import { displayUrl } from "./web-fetch-display.ts";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.ts";

/** Deadline in milliseconds for DNS, connect, TLS and response headers on each request hop. */
export const WEB_FETCH_RESPONSE_DEADLINE_MS = 5_000;
/** Deadline in milliseconds for the whole call, including redirects and reading the body. */
export const WEB_FETCH_TOTAL_DEADLINE_MS = 15_000;
/** Raw (decompressed) body bytes read before reading stops. */
export const WEB_FETCH_MAX_RAW_BYTES = 2 * 1024 * 1024;
/** UTF-8 byte cap on the whole model-facing result, status line and notices included. */
export const WEB_FETCH_MAX_OUTPUT_BYTES = 32 * 1024;
/** Redirects followed before the call fails. */
export const WEB_FETCH_MAX_REDIRECTS = 5;
/** UTF-8 byte cap on the body excerpt shown for a non-2xx status. */
export const WEB_FETCH_ERROR_EXCERPT_BYTES = 2 * 1024;
/** Fixed User-Agent naming Schway and its version; no other identifying or credential headers are sent. */
export const WEB_FETCH_USER_AGENT = `Schway/${version} (web_fetch)`;

const ACCEPT = "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.5";
/** Longest URL echoed in a model-facing status line; long enough for presigned final URLs whose values the TUI masks. */
const MAX_URL_DISPLAY_CHARS = 8_192;
/** Longest server-supplied reason phrase kept in a status line. */
const MAX_REASON_CHARS = 64;
/** Longest server-supplied media type kept in a status line. */
const MAX_TYPE_CHARS = 100;
const encoder = new TextEncoder();

/** Accept one required absolute http(s) URL and reject unknown keys; compiled once at registration. */
export const webFetchInputSchema = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      description: "Absolute http or https URL to fetch.",
    }),
  },
  { additionalProperties: false },
);

/** Absolute http(s) URL accepted by the web_fetch schema. */
export type WebFetchInput = Static<typeof webFetchInputSchema>;

/** Failure class recorded on an unsuccessful web_fetch call. */
export type WebFetchErrorKind =
  | "invalid-url"
  | "unsupported-scheme"
  | "userinfo"
  | "dns"
  | "connection-refused"
  | "connection-reset"
  | "tls"
  | "network"
  | "response-deadline"
  | "total-deadline"
  | "redirect-limit"
  | "http-status"
  | "unsupported-content-type"
  | "body-cap";

/** Structured outcome of one web_fetch call: URLs, HTTP status, byte counts, truncation, spill path, timing and failure class. */
export interface WebFetchDetails {
  /** Display-safe form of the requested URL from `displayUrl`: no userinfo and no query or fragment value, ever. */
  url: string;
  /** Display-safe form of the last response's URL, or of the requested URL when no response arrived. */
  finalUrl: string;
  /** Display-safe copy of the result's first line, with its URL in display form; interfaces show this instead. */
  statusLine: string;
  /** HTTP status of the last response; absent when none arrived. */
  status?: number;
  /** Media type of the last response without parameters; absent when not declared. */
  contentType?: string;
  /** Decompressed body bytes read. */
  rawBytes: number;
  /** UTF-8 bytes of the full extracted text. */
  textBytes: number;
  /** True when model-facing text was cut or the body stopped at the raw-byte cap. */
  truncated: boolean;
  /** Private temporary file holding the full extracted text when output was cut. */
  outputPath?: string;
  /** Wall time of the call in milliseconds. */
  durationMs: number;
  /** Failure class; absent on success. */
  errorKind?: WebFetchErrorKind;
}

/** Injection points for deterministic tests; production uses the exported defaults. */
export interface WebFetchOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  responseDeadlineMs?: number;
  totalDeadlineMs?: number;
  maxRawBytes?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

const DESCRIPTION =
  "Fetch one http or https URL with a GET request and return its readable text. HTML becomes plain text; " +
  "JavaScript does not run. Text, JSON and XML pass through; other content types are errors. The URL is sent to " +
  "the remote host. Output is bounded; oversized text is saved to a temporary file you can read. Calls are " +
  "read-only and run in parallel, so make several in one turn when you need several pages.";

/** Build the read-only, parallel web_fetch definition with optional test injections. */
export function createWebFetchTool(options: WebFetchOptions = {}): ToolDefinition<WebFetchInput> {
  return {
    name: "web_fetch",
    description: DESCRIPTION,
    inputSchema: webFetchInputSchema,
    effect: "read-only",
    execution: "parallel",
    execute: (input, ctx) => executeWebFetch(input, ctx, options),
  };
}

/** Built-in read-only, parallel tool that GETs one http(s) URL and returns bounded readable text. */
export const webFetchTool: ToolDefinition<WebFetchInput> = createWebFetchTool();

type Outcome = { kind: WebFetchErrorKind; message: string };
/** A result's first line: model-facing text with the real URL, and a display-safe copy. */
type Status = { text: string; display: string };

/**
 * GET one http(s) URL and return its status line plus bounded readable text.
 * Rejects other schemes and userinfo before any request; follows at most five redirects; every failure is a tool error.
 * Cancellation aborts the request, releases the connection and rejects with an AbortError.
 */
async function executeWebFetch(input: WebFetchInput, ctx: ToolContext, options: WebFetchOptions): Promise<ToolExecutionResult> {
  const now = options.now ?? (() => performance.now());
  const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const responseDeadlineMs = options.responseDeadlineMs ?? WEB_FETCH_RESPONSE_DEADLINE_MS;
  const totalDeadlineMs = options.totalDeadlineMs ?? WEB_FETCH_TOTAL_DEADLINE_MS;
  const maxRawBytes = options.maxRawBytes ?? WEB_FETCH_MAX_RAW_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? WEB_FETCH_MAX_OUTPUT_BYTES;
  const started = now();
  if (ctx.signal?.aborted) throw abortError();

  const requested = maskedUrl(input.url);
  const requestedDisplay = displayUrl(input.url);
  // Parsing normalizes away input details that the display rules use (a `\\` in the path becomes `/`), so the
  // requested URL's own hop is displayed from the input; redirect targets are displayed from their href.
  let requestedHref = "";
  const display = (href: string) => href === requestedHref ? requestedDisplay : displayUrl(href);
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const status = (prefix: string, url: string, shown = url, suffix = ""): Status =>
    ({ text: `${prefix} · ${clip(shown)}${suffix}`, display: `${prefix} · ${display(url)}${suffix}` });
  const fail = (outcome: Outcome, line: Status, extra: Partial<WebFetchDetails> = {}): ToolExecutionResult => ({
    content: boundOutput(`${line.text}\n\n${outcome.message}`, maxOutputBytes),
    isError: true,
    details: { url: requestedDisplay, finalUrl: requestedDisplay, rawBytes: 0, textBytes: 0, truncated: false, ...extra,
      statusLine: line.display, durationMs: elapsed(), errorKind: outcome.kind },
  });

  const target = checkUrl(input.url);
  // The echo stays on one line: control characters are percent-encoded, as a URL serializer would.
  if ("kind" in target) return fail(target, status("No request sent", input.url, requested.replace(/[\u0000-\u001f\u007f]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)));
  requestedHref = target.href;

  const controller = new AbortController();
  let cause: "cancelled" | "response-deadline" | "total-deadline" | undefined;
  const abortWith = (reason: NonNullable<typeof cause>) => {
    if (cause) return;
    cause = reason;
    controller.abort();
  };
  const onCancel = () => abortWith("cancelled");
  ctx.signal?.addEventListener("abort", onCancel, { once: true });
  const totalTimer = setTimeout(() => abortWith("total-deadline"), totalDeadlineMs);
  const deadlineOutcome = (): Outcome | undefined => cause === "response-deadline"
    ? { kind: "response-deadline", message: `The server sent no response within ${formatDeadline(responseDeadlineMs)}.` }
    : cause === "total-deadline"
      ? { kind: "total-deadline", message: `The response did not finish within ${formatDeadline(totalDeadlineMs)}.` }
      : undefined;

  try {
    let current = target;
    let redirects = 0;
    let response: Response;
    for (;;) {
      const responseTimer = setTimeout(() => abortWith("response-deadline"), responseDeadlineMs);
      try {
        response = await raceAbort(fetchImpl(current.href, {
          method: "GET",
          headers: { "User-Agent": WEB_FETCH_USER_AGENT, Accept: ACCEPT },
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        }), controller.signal);
      } catch (error) {
        if (cause === "cancelled") throw abortError();
        const outcome = deadlineOutcome() ?? networkOutcome(error, current);
        return fail(outcome, status("No response", current.href), { finalUrl: display(current.href) });
      } finally {
        clearTimeout(responseTimer);
      }
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) break;
      void discard(response);
      const statusLine = status(`${httpStatus(response)} · ${typeLabel(mediaType(response.headers.get("content-type")))} · ${declaredSize(response)}`, current.href);
      const hop = { finalUrl: display(current.href), status: response.status };
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
        return fail({ kind: "redirect-limit", message: `Stopped after ${WEB_FETCH_MAX_REDIRECTS} redirects. The redirect chain may loop.` },
          statusLine, hop);
      }
      let next: URL;
      try { next = new URL(location, current); }
      catch { return fail({ kind: "invalid-url", message: "The server redirected to an invalid URL." }, statusLine, hop); }
      const checked = checkUrl(next.href);
      if ("kind" in checked) {
        return fail({ kind: checked.kind, message: `The server redirected to a URL that web_fetch does not follow. ${checked.message}` },
          statusLine, hop);
      }
      current = checked;
      redirects++;
    }

    const finalUrl = current.href;
    const contentTypeHeader = response.headers.get("content-type");
    const contentType = mediaType(contentTypeHeader);
    const ok = response.status >= 200 && response.status < 300;
    let body: { bytes: Uint8Array; capped: boolean };
    const progress = { bytes: 0 };
    const kind = contentKind(contentType);
    if (kind === "unsupported") {
      // A declared binary type is never read; its size comes from Content-Length when present.
      void discard(response);
      body = { bytes: new Uint8Array(), capped: false };
    } else {
      try {
        body = await readBody(response, maxRawBytes, controller.signal, progress);
      } catch (error) {
        if (cause === "cancelled") throw abortError();
        const outcome = deadlineOutcome() ?? networkOutcome(error, current);
        return fail(outcome, status(`${httpStatus(response)} · ${typeLabel(contentType)} · ${formatBytes(progress.bytes)} read`, finalUrl),
          { finalUrl: display(finalUrl), status: response.status, ...(contentType ? { contentType } : {}), rawBytes: progress.bytes });
      }
    }
    const rawBytes = body.bytes.length;
    const redirectNote = redirects > 0 ? ` · after ${redirects === 1 ? "1 redirect" : `${redirects} redirects`}` : "";
    const sizeLabel = kind === "unsupported" ? declaredSize(response) : `${formatBytes(rawBytes)}${body.capped ? " (read limit)" : ""}`;
    const statusLine = status(`${httpStatus(response)} · ${typeLabel(contentType)} · ${sizeLabel}`, finalUrl, finalUrl, redirectNote);
    const base: Omit<WebFetchDetails, "durationMs" | "textBytes" | "truncated"> = {
      url: requestedDisplay, finalUrl: display(finalUrl), statusLine: statusLine.display, status: response.status,
      ...(contentType ? { contentType } : {}), rawBytes,
    };
    const effectiveKind = kind === "sniff" ? sniffKind(body.bytes) : kind;

    if (!ok) {
      const reason = `The server returned ${httpStatus(response)}.`;
      let excerpt = "";
      if (effectiveKind === "unsupported") excerpt = `The body is ${typeLabel(contentType)} (${sizeLabel}).`;
      else if (rawBytes === 0) excerpt = "The response body is empty.";
      else {
        const text = extractText(body.bytes, contentTypeHeader, effectiveKind, body.capped);
        const cut = utf8Prefix(text, WEB_FETCH_ERROR_EXCERPT_BYTES);
        excerpt = text.trim() ? `${cut}${cut.length < text.length ? "…" : ""}` : "The body has no readable text.";
      }
      return {
        content: boundOutput(`${statusLine.text}\n\n${reason}\n\n${excerpt}`, maxOutputBytes),
        isError: true,
        details: { ...base, textBytes: 0, truncated: false, durationMs: elapsed(), errorKind: "http-status" },
      };
    }

    if (rawBytes === 0 && kind !== "unsupported") {
      return { content: `${statusLine.text}\n\nThe response body is empty.`, details: { ...base, textBytes: 0, truncated: false, durationMs: elapsed() } };
    }
    if (effectiveKind === "unsupported") {
      return fail({ kind: "unsupported-content-type", message: `Unsupported content type ${typeLabel(contentType)} (${sizeLabel}). web_fetch returns text only.` },
        statusLine, base);
    }

    const text = extractText(body.bytes, contentTypeHeader, effectiveKind, body.capped);
    if (!text.trim()) {
      if (body.capped) {
        return fail({ kind: "body-cap", message: `The body reached the read limit (${formatBytes(maxRawBytes)}) before any readable text appeared.` },
          statusLine, { ...base, truncated: true });
      }
      const message = effectiveKind === "html" ? "The page has no readable text. It may need JavaScript." : "The response has no readable text.";
      return { content: `${statusLine.text}\n\n${message}`, details: { ...base, textBytes: 0, truncated: false, durationMs: elapsed() } };
    }

    const textBytes = encoder.encode(text).length;
    const capNote = body.capped ? `\n\n[Stopped reading at the read limit (${formatBytes(maxRawBytes)}); the rest was not fetched.]` : "";
    const head = `${statusLine.text}\n\n`;
    if (utf8Length(head) + textBytes + utf8Length(capNote) <= maxOutputBytes) {
      return { content: `${head}${text}${capNote}`, details: { ...base, textBytes, truncated: body.capped, durationMs: elapsed() } };
    }

    const outputPath = join(tmpdir(), `schway-web-fetch-${crypto.randomUUID()}.txt`);
    await writeFile(outputPath, text, { mode: 0o600 });
    await chmod(outputPath, 0o600);
    const notice = (shown: number, line: number) =>
      `\n\n[Showing the first ${shown} of ${textBytes} bytes of text. Full text: ${outputPath}. Use read with offset ${line} to continue.]`;
    const budget = maxOutputBytes - utf8Length(head) - utf8Length(capNote) - utf8Length(notice(textBytes, textBytes + 1));
    const shown = utf8Prefix(text, Math.max(0, budget));
    const shownBytes = utf8Length(shown);
    const nextLine = shown.split("\n").length;
    return {
      content: `${head}${shown}${notice(shownBytes, nextLine)}${capNote}`,
      details: { ...base, textBytes, truncated: true, outputPath, durationMs: elapsed() },
    };
  } finally {
    clearTimeout(totalTimer);
    ctx.signal?.removeEventListener("abort", onCancel);
    // Release any connection still open after the result is settled.
    if (!controller.signal.aborted) controller.abort();
  }
}

/** Parse an absolute http(s) URL without userinfo, or describe why it is refused. */
function checkUrl(value: string): URL | Outcome {
  let url: URL;
  try { url = new URL(value); }
  catch { return { kind: "invalid-url", message: "Use an absolute http or https URL." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Name the scheme only when it plainly is one (`scheme://`); in `user:pass@host` it would be a user name.
    const named = /^[\s\u0000-\u001f]*[a-z][a-z0-9+.-]*:\/\//i.test(value);
    return { kind: "unsupported-scheme", message: `Only http and https URLs are supported${named ? `, not ${url.protocol}` : "."}` };
  }
  if (url.username || url.password) {
    return { kind: "userinfo", message: "URLs with a user name or password are not supported. Remove the credentials from the URL." };
  }
  return url;
}

/** Mask any userinfo so credentials in a refused URL are not echoed back. */
function maskedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "***";
    url.password = "";
    return url.href;
  } catch {
    // Unparsable input: mask up to the last '@' before the path, accepting tolerated forms such as `https:\\u:p@`.
    const prefix = /^\s*[a-z][a-z0-9+.-]*:[/\\]*/i.exec(value);
    if (!prefix) return value;
    const begin = prefix[0].length;
    let end = begin;
    while (end < value.length && !"/?#\\".includes(value[end]!)) end++;
    const at = value.lastIndexOf("@", end - 1);
    return at < begin ? value : `${value.slice(0, begin)}***${value.slice(at)}`;
  }
}

/** Map a fetch rejection to a plain failure class and message. */
function networkOutcome(error: unknown, url: URL): Outcome {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown; cause?: unknown } : {};
  const nested = typeof record.cause === "object" && record.cause !== null ? record.cause as { code?: unknown; message?: unknown } : {};
  const code = `${String(record.code ?? "")} ${String(nested.code ?? "")}`;
  const message = `${String(record.message ?? error)} ${String(nested.message ?? "")}`;
  const host = url.hostname;
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HANDSHAKE/i.test(code) || /certificate|\btls\b|\bssl\b|handshake/i.test(message)) {
    return { kind: "tls", message: `The secure connection to ${host} failed. Its certificate or TLS setup was rejected.` };
  }
  if (/\b(ENOTFOUND|EAI_[A-Z]+|DNS[A-Za-z_]*|FailedToOpenSocket)\b/.test(code) || /getaddrinfo|\bdns\b|resolve host|typo in the url/i.test(message)) {
    return { kind: "dns", message: `DNS lookup failed for ${host}. Check the host name.` };
  }
  if (/\b(ECONNREFUSED|ConnectionRefused)\b/.test(code)) {
    return { kind: "connection-refused", message: `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")} refused the connection.` };
  }
  if (/\b(ECONNRESET|ConnectionClosed|ConnectionReset|EPIPE|ECONNABORTED)\b/.test(code) || /connection (was )?(reset|closed)|socket (hang up|closed)/i.test(message)) {
    return { kind: "connection-reset", message: `The connection to ${host} closed before the response finished.` };
  }
  const detail = String(record.message ?? "").trim();
  return { kind: "network", message: `The request to ${host} failed${detail ? `: ${detail}` : "."}` };
}

/** Settle with the promise or reject when the signal aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Read the body until it ends or reaches `maxBytes`, cancelling the stream on the cap or an abort. */
async function readBody(response: Response, maxBytes: number, signal: AbortSignal, progress: { bytes: number }): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), capped: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        progress.bytes = total;
        capped = true;
        break;
      }
      chunks.push(value);
      total += value.length;
      progress.bytes = total;
      if (total === maxBytes) {
        capped = !(await peekDone(reader, signal));
        break;
      }
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  if (capped) reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, capped };
}

/** After an exact-cap chunk, report whether the stream has ended. */
async function peekDone(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    const { done, value } = await raceAbort(reader.read(), signal);
    if (done) return true;
    if (value && value.length > 0) return false;
  }
}

/** Drop an unread body so its connection can close or be reused. */
async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already closed */ }
}

/** Lowercased media type without parameters, or undefined when absent. */
function mediaType(header: string | null): string | undefined {
  const essence = header?.split(";")[0]?.trim().toLowerCase();
  return essence ? essence : undefined;
}

/** Classify a media type as HTML, pass-through text, unknown (sniffed) or unsupported. */
function contentKind(type: string | undefined): "html" | "text" | "sniff" | "unsupported" {
  if (!type) return "sniff";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/x-ndjson"
    || type === "application/xml" || type.endsWith("+xml")) return "text";
  return "unsupported";
}

/** Treat an undeclared body as HTML or text unless it contains NUL bytes. */
function sniffKind(bytes: Uint8Array): "html" | "text" | "unsupported" {
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) return "unsupported";
  return /^\s*<(!doctype\s+html|html|head|body)\b/i.test(new TextDecoder("latin1").decode(head)) ? "html" : "text";
}

/** Decode with the declared or BOM charset, falling back to UTF-8 with replacement, then convert HTML. */
function extractText(bytes: Uint8Array, header: string | null, kind: "html" | "text", capped: boolean): string {
  const text = decode(bytes, charsetOf(bytes, header, kind), capped);
  return kind === "html" ? htmlToText(text) : text.replace(/\r\n?/g, "\n");
}

/** Charset from a BOM, the Content-Type parameter or an HTML meta declaration, in that order. */
function charsetOf(bytes: Uint8Array, header: string | null, kind: "html" | "text"): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  const declared = /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(header ?? "")?.[1];
  if (declared) return declared;
  if (kind === "html") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    const meta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
    if (meta?.[1]) return meta[1];
  }
  return "utf-8";
}

/** Decode bytes with a charset label, using UTF-8 for unknown labels and omitting a cut trailing sequence. */
function decode(bytes: Uint8Array, label: string, capped: boolean): string {
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]); }
  catch { decoder = new TextDecoder("utf-8"); }
  return decoder.decode(bytes, { stream: capped });
}

/** HTTP status code and reason phrase, such as `HTTP 404 Not Found`. */
function httpStatus(response: Response): string {
  // The reason phrase comes from the server; bound it so the status line stays bounded.
  const reason = clipText((response.statusText || STATUS_CODES[response.status] || "").replace(/[\u0000-\u001f\u007f]/g, " "), MAX_REASON_CHARS);
  return `HTTP ${response.status}${reason ? ` ${reason}` : ""}`;
}

/** Declared Content-Length for a body that is not read, or `size unknown`. */
function declaredSize(response: Response): string {
  const header = response.headers.get("content-length");
  const length = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? formatBytes(length) : "size unknown";
}

/** Media type label for status lines. */
function typeLabel(type: string | undefined): string {
  return type === undefined ? "no content type" : clipText(type, MAX_TYPE_CHARS);
}

/** Exact byte count with thousands separators. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
}

/** Deadline as milliseconds below one second, otherwise seconds. */
function formatDeadline(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

/** Clip long URLs in status lines. */
function clip(url: string): string {
  return clipText(url, MAX_URL_DISPLAY_CHARS);
}

/** Clip text to `max` UTF-16 units with an ellipsis, never splitting a surrogate pair. */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  const end = high >= 0xd800 && high <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** UTF-8 byte length. */
function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Longest prefix whose UTF-8 encoding fits `maxBytes`, cut on a code-point boundary. */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Bound a whole result by UTF-8 bytes, marking a cut with an ellipsis. */
function boundOutput(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  return `${utf8Prefix(text, maxBytes - 3)}…`;
}
