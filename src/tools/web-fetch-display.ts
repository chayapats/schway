/** Placeholder shown when not even a scheme can be shown safely for a URL. */
export const UNDISPLAYABLE_URL = "the requested URL";

/** Longest display URL before it is clipped with an ellipsis. */
const MAX_DISPLAY_CHARS = 1_000;

/** Schemes WHATWG parses with an authority, whose structure the display form can rebuild. */
const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

/**
 * Parameter names whose values are treated as credentials: a case-insensitive match anywhere in the decoded name,
 * deliberately broad (`key` covers `api_key`, `accessKey` and `private_key`; `sig` covers `signature`).
 */
const CREDENTIAL_NAME = /key|token|secret|pass|pwd|auth|sig|jwt|session|credential|appid|code/i;

/** True when a raw (possibly percent-encoded) name, or any decoding of it, contains a credential word. */
export function isCredentialName(name: string): boolean {
  return decodeLayers(name).some(layer => CREDENTIAL_NAME.test(layer) || CREDENTIAL_NAME.test(layer.replace(/\+/g, " ")));
}

/**
 * Display-safe URL that structurally never shows a query or fragment value or userinfo:
 * `scheme://host[:port]/path?name=…&…#…`, where a name shows only if it matches `[A-Za-z0-9_.-]{1,32}` after one
 * decoding (otherwise the pair is `…`) and a path segment holding `= ; @ % : \ ? #` or non-ASCII in any of up to
 * three decodings is `…` (the whole path when the input holds `\`). The host shows only when it is a plain DNS name or
 * bracketed IP literal with an all-digit port, both as parsed and as written. Input without a special scheme and such
 * a host, or with `@` in any decoding, shows `<scheme>://…`, `<scheme>:…` or `the requested URL`.
 */
export function displayUrl(raw: string): string {
  const cleaned = whatwgClean(raw);
  let url: URL | undefined;
  try { url = new URL(cleaned); } catch { url = undefined; }
  // An `@` anywhere means the host itself may be the tail of a password, so only the scheme shows.
  if (!url || !SPECIAL_SCHEMES.has(url.protocol) || !url.host || decodeLayers(cleaned).some(layer => layer.includes("@"))) return schemeOnly(cleaned);
  // The host shows only when it is plainly a DNS name or IP literal, both as parsed and as written.
  const authority = cleaned.replace(/^[a-z][a-z0-9+.-]*:[/\\]*/i, "").split(/[/?#\\]/, 1)[0]!;
  if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/.test(url.hostname) || !/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d*)?$/.test(authority)) return schemeOnly(cleaned);
  // WHATWG turns `\` into `/` in special-scheme paths, so a backslash in the input hides the whole path.
  const path = cleaned.includes("\\") ? "/…" : url.pathname.split("/").map(segment => decodeLayers(segment).some(layer => /[=;@%:\\?#]|[^\x20-\x7e]/.test(layer)) ? "…" : segment).join("/");
  const query = url.search ? `?${url.search.slice(1).split("&").map(pair => {
    if (!pair) return "";
    const equals = pair.indexOf("=");
    const name = equals < 0 ? "" : decodeLenient(pair.slice(0, equals));
    return /^[A-Za-z0-9_.-]{1,32}$/.test(name) ? `${name}=…` : "…";
  }).join("&")}` : "";
  const shown = `${url.protocol}//${url.host}${path}${query}${url.hash.length > 1 ? "#…" : ""}`;
  return shown.length <= MAX_DISPLAY_CHARS ? shown : `${shown.slice(0, MAX_DISPLAY_CHARS)}…`;
}

/** `<scheme>://…` for a plain `scheme://` or special scheme, `<scheme>:…` for another scheme without `@`, else the placeholder. */
function schemeOnly(cleaned: string): string {
  const match = /^([a-z][a-z0-9+.-]*):([/\\]{2})?/i.exec(cleaned);
  if (!match) return UNDISPLAYABLE_URL;
  const scheme = match[1]!.toLowerCase();
  if (match[2] || SPECIAL_SCHEMES.has(`${scheme}:`)) return `${scheme}://…`;
  // Without `//`, a "scheme" before `@` may be a user name.
  return decodeLayers(cleaned).some(layer => layer.includes("@")) ? UNDISPLAYABLE_URL : `${scheme}:…`;
}

/** Remove leading and trailing C0 controls and spaces, and tabs and newlines anywhere, as WHATWG parsing does. */
export function whatwgClean(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 32) start++;
  while (end > start && url.charCodeAt(end - 1) <= 32) end--;
  return url.slice(start, end).replace(/[\t\n\r]/g, "");
}

/** The text and up to three successive lenient percent-decodings of it, stopping when a pass changes nothing. */
export function decodeLayers(text: string): string[] {
  const layers = [text];
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeLenient(layers.at(-1)!);
    if (next === layers.at(-1)) break;
    layers.push(next);
  }
  return layers;
}

/** Percent-decode as WHATWG does: escapes become bytes, invalid UTF-8 becomes U+FFFD, and nothing throws. */
function decodeLenient(text: string): string {
  if (!text.includes("%")) return text;
  return new TextDecoder().decode(new Uint8Array(percentBytes(text)));
}

/** UTF-8 bytes of text with `%XX` escapes replaced by their byte values. */
function percentBytes(text: string): number[] {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < text.length;) {
    if (text[index] === "%" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    for (const byte of encoder.encode(char)) bytes.push(byte);
    index += char.length;
  }
  return bytes;
}

/**
 * Exact credential values from a URL, for masking value-only echoes in server text. Pairs are split as URLSearchParams
 * does (`&` in the query and fragment, `;` in path segments) in the URL and up to three decodings of it. A pair is
 * credential-bearing when its whole decoded name contains a credential word or its value holds `@` or a nested
 * credential assignment; userinfo always is. Each such value (64 KiB in all) adds, in this order, itself and its
 * decodings, its letter, mark or digit runs and its pieces between separators of 4+ characters, then escape variants;
 * nested assignments add their outermost and innermost values and the segments between them.
 */
export function credentialValues(raw: string): string[] {
  const values = new Set<string>();
  let budget = MAX_VALUE_CHARS;
  // The budget is charged once per distinct value, however many scans or decode layers find it.
  const collect = (value: string) => {
    if (budget <= 0 || value.length < 4 || values.has(value)) return;
    values.add(value.slice(0, budget));
    budget -= value.length;
  };
  for (const layer of decodeLayers(whatwgClean(raw))) {
    for (const [name, value] of urlPairs(layer)) {
      if (isCredentialName(name) || decodeLayers(value).some(inner => inner.includes("@") || assignmentSpans(inner).length > 0)) collect(value);
    }
    for (const [start, end] of userinfoSpans(layer)) collect(layer.slice(start, end));
    // Nested assignments share their end. Each group adds its outermost and innermost values and the disjoint
    // segments between consecutive value starts, which hold every middle value, so the work stays linear.
    const byEnd = new Map<number, number[]>();
    for (const [start, end] of assignmentSpans(layer)) {
      const starts = byEnd.get(end);
      if (starts) starts.push(start);
      else byEnd.set(end, [start]);
    }
    for (const [end, starts] of byEnd) {
      collect(layer.slice(starts[0]!, end));
      collect(layer.slice(starts.at(-1)!, end));
      for (let index = 1; index < starts.length - 1; index++) collect(layer.slice(starts[index]!, starts[index + 1]!));
    }
  }
  const whole = [...values].flatMap(value => decodeLayers(value).flatMap(layer => [layer, layer.replace(/\+/g, " ")]));
  // Letter, mark or digit runs and punctuation pieces between separators, so a part of a value is masked on its own.
  const runs = whole.flatMap(value => [...(value.match(/[\p{L}\p{M}\p{N}]{4,}/gu) ?? []), ...value.split(/[\s&=;/:,?#]+/)]);
  const variants = whole.flatMap(value => [value.replace(/\//g, "\\/"), value.replace(/\//g, "\\u002f"), value.replace(/\//g, "\\u002F"),
    value.replace(/ /g, "+"), value.replace(/%[0-9a-f]{2}/gi, code => code.toUpperCase()), value.replace(/%[0-9a-f]{2}/gi, code => code.toLowerCase()),
    encodeLoosely(value)]);
  return [...new Set([...whole, ...runs, ...variants].filter(value => value.length >= 4))].slice(0, MAX_SECRETS);
}

/** Most characters of credential values `credentialValues` collects from one URL before expanding them. */
const MAX_VALUE_CHARS = 64 * 1024;

/** Most exact values `credentialValues` returns for one URL; runs come before variants, so the cap drops variants first. */
const MAX_SECRETS = 256;

/** Name-value pairs of a URL as URLSearchParams splits them, plus userinfo and `;` path parameters. */
function urlPairs(text: string): Array<[name: string, value: string]> {
  const pairs: Array<[string, string]> = [];
  const split = (part: string, separator: string) => {
    for (const pair of part.split(separator)) {
      const equals = pair.indexOf("=");
      if (equals > 0) pairs.push([pair.slice(0, equals), pair.slice(equals + 1)]);
    }
  };
  let url: URL | undefined;
  try { url = new URL(text); } catch { url = undefined; }
  if (url) {
    pairs.push(["password", url.username], ["password", url.password]);
    split(url.search.slice(1), "&");
    split(url.hash.slice(1), "&");
    for (const segment of url.pathname.split("/")) split(segment.slice(segment.indexOf(";") + 1), ";");
    return pairs;
  }
  // Unparsable: split the text after the first `?` on `&`, and `;` parameters before it.
  const query = text.indexOf("?");
  split(query < 0 ? "" : text.slice(query + 1), "&");
  split(query < 0 ? text : text.slice(0, query), ";");
  return pairs;
}

/** Percent-encode a component, keeping the input when it holds a lone surrogate. */
function encodeLoosely(value: string): string {
  try { return encodeURIComponent(value); } catch { return value; }
}

/** Best-effort linear masking of server text: the union of slash-run userinfo, credential assignment values and exact `secrets`. */
export function maskCredentialsInText(text: string, secrets: readonly string[] = []): string {
  // All scans read the original text; the union of their spans is masked, so none can expose another's tail.
  const spans = mergeSpans(mergeSpans(userinfoSpans(text), assignmentSpans(text)), exactSpans(text, secrets));
  const out: string[] = [];
  let copied = 0;
  for (const [start, end] of spans) {
    out.push(text.slice(copied, start), "***");
    copied = end;
  }
  out.push(text.slice(copied));
  return out.join("");
}

/** A half-open `[start, end)` range of text to replace with `***`. */
type Span = [start: number, end: number];

/** Characters that end a credential value in text: whitespace, `<`, `>` and `"`; a backtick or `#` does not. */
function isValueStop(code: number): boolean {
  return code <= 32 || code === 0x7f || code === 60 || code === 62 || code === 34;
}

/** Characters that start a parameter name in text: `?`, `&`, `#`, `;`, `/`, whitespace and the value stops. */
function isNameBoundary(char: string): boolean {
  return "?&#;/=".includes(char) || isValueStop(char.charCodeAt(0));
}

/**
 * Spans of the value after every credential name followed by `=`, `%3D` or `\u003d` anywhere in text. The name is
 * read back to a separator (`? & # ; / =` or whitespace, so `pass+word` and `token%20` count) and, as a second
 * candidate, as the letters, digits and `_.-[]` just before it. A value runs to `&`, whitespace, `<`, `>` or `"`, and
 * is scanned again for nested assignments. Linear: a precomputed stop table bounds each value.
 */
function assignmentSpans(text: string): Span[] {
  const stop = new Int32Array(text.length + 1).fill(text.length);
  for (let index = text.length - 1; index >= 0; index--) {
    stop[index] = text[index] === "&" || isValueStop(text.charCodeAt(index)) ? index : stop[index + 1]!;
  }
  const spans: Span[] = [];
  let from = 0;
  for (let index = 0; index < text.length;) {
    const equals = equalsLength(text, index);
    if (equals === 0) { index++; continue; }
    let start = index;
    while (start > from && !isNameBoundary(text[start - 1]!)) start--;
    let run = index;
    while (run > from && /[A-Za-z0-9_.\-[\]]/.test(text[run - 1]!)) run--;
    const valueStart = index + equals;
    if ((start < index && isCredentialName(text.slice(start, index))) || (run < index && isCredentialName(text.slice(run, index)))) {
      spans.push([valueStart, stop[valueStart]!]);
    }
    index = from = valueStart;
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Length of an equals sign at `index`: `=`, or encoded `%3D` or `\u003d`; else 0. */
function equalsLength(text: string, index: number): number {
  const char = text[index];
  if (char === "=") return 1;
  if (char === "%") return /^%3d$/i.test(text.slice(index, index + 3)) ? 3 : 0;
  if (char === "\\") return /^\\u003d$/i.test(text.slice(index, index + 6)) ? 6 : 0;
  return 0;
}

/** Spans of every exact occurrence of each secret, sorted by start. */
function exactSpans(text: string, secrets: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + secret.length)) spans.push([at, at + secret.length]);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Union two lists of spans, each sorted by start, into sorted non-overlapping spans. */
function mergeSpans(first: readonly Span[], second: readonly Span[]): Span[] {
  const merged: Span[] = [];
  let left = 0;
  let right = 0;
  while (left < first.length || right < second.length) {
    const next = right >= second.length || (left < first.length && first[left]![0] <= second[right]![0]) ? first[left++]! : second[right++]!;
    const last = merged.at(-1);
    if (last && next[0] <= last[1]) last[1] = Math.max(last[1], next[1]);
    else merged.push([next[0], next[1]]);
  }
  return merged;
}

/**
 * Spans of userinfo that follows a slash run (two or more of `/`, `\`, `%2F` or `%5C`, or one after `:` or `%3A`),
 * up to the last `@` or `%40` before whitespace, so a token or password holding `/`, `?`, `#` or `@` stays hidden.
 * A backward pass keeps this linear.
 */
function userinfoSpans(text: string): Span[] {
  const length = text.length;
  const lastAt = new Int32Array(length + 1).fill(-1);
  for (let index = length - 1, current = -1; index >= 0; index--) {
    if (text.charCodeAt(index) <= 32) current = -1;
    else if (current < 0 && (text[index] === "@" || (text[index] === "%" && /^%40$/.test(text.slice(index, index + 3))))) current = index;
    lastAt[index] = current;
  }
  const spans: Span[] = [];
  let index = 0;
  while (index < length) {
    if (slashLength(text, index) === 0) { index++; continue; }
    const runStart = index;
    let slashes = 0;
    for (let step = slashLength(text, index); step > 0; step = slashLength(text, index)) { index += step; slashes++; }
    const afterColon = text[runStart - 1] === ":" || /^%3a$/i.test(text.slice(runStart - 3, runStart));
    if (slashes < 2 && !afterColon) continue;
    const at = index < length ? lastAt[index]! : -1;
    if (at >= index) {
      spans.push([index, at]);
      index = at + 1;
      continue;
    }
    while (index < length && text.charCodeAt(index) > 32 && !"/?#".includes(text[index]!)) index++;
  }
  return spans;
}

/** Length of a slash at `index`: `/`, `\`, or encoded `%2F` or `%5C`; else 0. */
function slashLength(text: string, index: number): number {
  const char = text[index];
  if (char === "/" || char === "\\") return 1;
  return char === "%" && /^%(2f|5c)$/i.test(text.slice(index, index + 3)) ? 3 : 0;
}
