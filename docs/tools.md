# Tool output limits

## Read bounded output

Every core tool returns bounded model-facing output; oversized results are truncated with continuation guidance and never flood model context.
Bounds count UTF-8 bytes, not characters, so Thai, emoji and other multibyte text gets the same byte budget as ASCII. Cuts fall on a code-point boundary and never split a character.

- `read`: ranged reads default to 2000 lines; model-facing text is capped at 50,000 bytes with continuation info.
- `bash`: combined stdout and stderr are capped at 50,000 bytes, keeping stdout first. Oversized output spills the full stdout and stderr to a private `0600` temporary file, and the result ends with `[Output truncated: showing N of M bytes. Full output: <path>. Use read with offset to see the rest.]`. The `Exit code:` header and this notice do not count against the cap. Details add `shownBytes` and `totalBytes` when output is truncated.
- `grep`: defaults to 100 matches; model-facing text is capped at 50,000 bytes. Truncated searches say to narrow with `path`, `glob`, `maxResults`, or a more specific pattern.
- `find`: model-facing text is capped at 50,000 bytes. Truncated listings say to narrow with a more specific pattern or path.
- `ls`: lists to depth 1 by default; model-facing text is capped at 50,000 bytes.
- The error result Schway builds when a tool call fails, such as a thrown tool error or an unknown tool, is capped at 50,000 bytes.
- `web_fetch`: model-facing text is capped at 32 KiB (32,768 UTF-8 bytes); oversized text spills to a temporary file whose path the result names. See [Fetch web pages](#fetch-web-pages).
- A non-zero `bash` exit code is ordinary command data (`{ stdout, stderr, exitCode }`), not infrastructure failure.

## Replay earlier results

Each model request resends the conversation. A tool result from an earlier user
turn that is over 8,000 bytes is sent as its first 8,000 bytes, cut on a
code-point boundary, followed by
`[Earlier output shortened from N bytes. Run the call again if you need the full text.]`.
A result only slightly over 8,000 bytes, where the note would leave it no
shorter, is sent whole.
Results from the turn in progress are always sent in full. Shortening applies
only to the request: the session file, resume, branches, `/history` and
compaction summaries keep the full result. The shortened text depends only on
the result, so it is the same in every later request. The resent prefix
therefore changes once per result, at the first request of the next user turn,
which costs one prompt-cache miss for the rest of the request at that point.
Extension `beforeModel` hooks see the shortened results. The status bar's
context meter and `/context` count the same shortened view the request sends.

## Fetch web pages

`web_fetch` sends one `GET` request to an absolute `http` or `https` URL and
returns readable text. It declares `effect: "read-only"` and
`execution: "parallel"`, so several calls in one round run together, up to
`maxConcurrentTools`; `bash` keeps its exclusive barrier. Its only parameter is
`url`.

A fetch goes over the network. The URL, including its query string, reaches the
remote host and any proxy on the way. Approval modes do not change that: because
the tool reads only, it runs without a prompt in `auto`, `ask` and `read-only`, so
the model can put workspace content into a URL without asking. Extension
`beforeTool` and `afterTool` hooks apply to it like any other tool, so a hook can
deny or rewrite a fetch. Loopback and private destinations are blocked by the
default address guard, including when a hook rewrites the URL.

### Requests

- `GET` only, with no body, no cookies, no `Authorization` or other credential
  headers, and the fixed `User-Agent` `Schway/<version> (web_fetch)`.
- Other schemes (`file:`, `data:`, `ftp:` and so on) and URLs with a user name or
  password are refused before any network activity.
- At most 5 redirects are followed. Each hop must again be `http` or `https`
  without credentials. The status line reports the final URL.
- JavaScript does not run, and pages are not cached.

### Destination guard

The CLI and TUI refuse nonpublic destinations by default. Before each connection,
including redirects, Schway checks every resolved address and pins that connection
to a checked numeric IP. It retains the original HTTP Host and TLS certificate
identity and never performs a second hostname lookup or uses an environment proxy.
Loopback, private, CGNAT, link-local, unspecified, broadcast, multicast, reserved,
IPv4-mapped/translated IPv6 and tunnel destinations are blocked, as are known
metadata hostnames. Mixed public/private DNS answers fail closed. Refusals return
`details.errorKind: "blocked-address"` without disclosing any resolved address.

An embedder may restrict exact normalized hostnames with `allowHosts` (an empty
list denies all). The allowlist never overrides the baseline. Deliberate local
development requires `dangerouslyAllowPrivateAddressesForDevelopment: true`;
the CLI never sets it. Custom DNS and connect seams are trusted host code; a
custom transport must connect only to the supplied numeric address.

### Deadlines and caps

The module exports each limit as a constant from `src/tools/web-fetch.ts`.

| Limit | Value | Constant |
| --- | --- | --- |
| Response deadline: DNS, connect, TLS and response headers, per request hop | 5 s | `WEB_FETCH_RESPONSE_DEADLINE_MS` |
| Total deadline: every hop plus reading the body | 15 s | `WEB_FETCH_TOTAL_DEADLINE_MS` |
| Raw body read, after decompression | 2 MiB | `WEB_FETCH_MAX_RAW_BYTES` |
| Model-facing result, including the status line and notices | 32 KiB (UTF-8 bytes) | `WEB_FETCH_MAX_OUTPUT_BYTES` |
| Redirects followed | 5 | `WEB_FETCH_MAX_REDIRECTS` |
| Body excerpt for a non-2xx status | 2 KiB (UTF-8 bytes) | `WEB_FETCH_ERROR_EXCERPT_BYTES` |

Reading stops at the raw cap; the result says the rest was not fetched. Output is
cut on a code-point boundary, so multibyte text such as Thai or emoji is never
split. Cancelling the turn aborts the request, closes the connection and settles
the call as cancelled.

### Content

Text is decoded with the charset from a byte-order mark, the `Content-Type`
header or an HTML `<meta>` declaration, in that order. Unknown or missing
charsets fall back to UTF-8 with replacement characters. HTML and XHTML become
plain text: `script`, `style`, `noscript`, `template` and `svg` content is
dropped; headings, paragraphs, list items, table rows and preformatted blocks
keep their lines; link text is kept without the link target; entities are
decoded and whitespace collapses outside preformatted blocks, which keep their
spacing. List indentation stops growing after six levels, so conversion stays
linear in the body size (a 2 MiB page converts in well under a second).
`text/*`, JSON and XML pass through as text. Images, PDF,
`application/octet-stream` and other declared types are errors that name the
type and the declared `Content-Length`, or `size unknown`; their bodies are not
read and binary bytes are never returned. A body without a `Content-Type` is
read as text unless it contains NUL bytes.

### Results

Every result that got a response starts with one status line:
`HTTP <code> <reason> · <content type> · <size> · <final URL>`, such as
`HTTP 200 OK · text/html · 48,213 bytes · https://example.com/page`. The content
type reads `no content type` when none was declared. The size is the bytes read;
it reads `<n> bytes (read limit)` at the raw cap and `<n> bytes read` when a
deadline stopped the body. For a body that is not read (a redirect or an
unsupported type), it is the declared `Content-Length` or `size unknown`. After
redirects, ` · after N redirects` follows the URL.

Outcomes without a response use a short form: `No response · <url>` when no
response arrived, and `No request sent · <url>` for a refused URL, with any user
name and password masked and control characters percent-encoded so the echo
stays on one line.

When text exceeds the output cap, the full extracted text is written to a private
`0600` file in the system temporary directory, and the result ends with
`[Showing the first N of M bytes of text. Full text: <path>. Use read with offset L to continue.]`.
A 2xx response with an empty body says `The response body is empty.`; a page with
no readable text says so too. No result is empty.

These are tool errors (`isError: true`), each with its own message:

| Failure | Message starts with |
| --- | --- |
| Non-2xx status | `The server returned HTTP <code> <reason>.`, then a body excerpt |
| DNS failure | `DNS lookup failed for <host>.` |
| Connection refused | `<host>:<port> refused the connection.` |
| Connection reset | `The connection to <host> closed before the response finished.` |
| TLS failure | `The secure connection to <host> failed.` |
| Response deadline | `The server sent no response within 5 s.` |
| Total deadline | `The response did not finish within 15 s.` |
| Redirect limit | `Stopped after 5 redirects.` |
| Unsupported scheme | `Only http and https URLs are supported` |
| URL with credentials | `URLs with a user name or password are not supported.` |
| Not an absolute URL | `Use an absolute http or https URL.` |
| Redirect to an unsupported scheme or a URL with credentials | `The server redirected to a URL that web_fetch does not follow.` |
| Redirect to an invalid URL | `The server redirected to an invalid URL.` |
| Other network failure | `The request to <host> failed` |
| Unsupported content type | `Unsupported content type <type> (<size>).` |
| Raw cap reached before any text | `The body reached the read limit (2 MiB) before any readable text appeared.` |

Structured details (`WebFetchDetails`) hold the display form of the requested
and final URLs, a display-safe copy of the result's first line (`statusLine`),
the status, content type, raw bytes, text bytes, a truncated flag, the spill path
(`outputPath`) when there is one, the duration in milliseconds and an
`errorKind` on failure. Headless `--json` tool events carry them after the usual
secret redaction.

### Display-safe URLs

The model-facing result keeps the real URL, because the model may need a signed
final URL. Everything the tool shows people uses a display form that never shows
a query or fragment value, so a credential in one cannot leak through it:

- A URL with a special scheme (`http`, `https`, `ws`, `wss`, `ftp`, `file`) and a
  plain host (letters, digits, `.` and `-`, or a bracketed IP literal, with an
  all-digit port, both as parsed and as written) is rebuilt as
  `scheme://host[:port]/path?name=…&name=…#…`. A parameter name shows only when it matches `[A-Za-z0-9_.-]{1,32}`
  after one decoding; otherwise the whole pair, like a pair without `=`, is `…`.
  A non-empty fragment is `#…`. A path segment that holds `=`, `;`, `@`, `%`,
  `:`, `\`, `?`, `#` or non-ASCII, raw or after up to three percent-decodings,
  is `…`, and the whole path is `/…` when the input holds `\`.
- Input with `@` in any of those decodings, any other host, an opaque path,
  another scheme, or unparsable input shows only `<scheme>://…`, `<scheme>:…` or
  `the requested URL`.

The display form has no notion of credential names; it hides every value, so
`?city=Bangkok` shows as `?city=…`.

The TUI row target is this display form. For the result, the TUI replaces the
tool's own first line (status line, final URL, redirect URL or `No request sent`
echo) with `statusLine`. A resumed session has no details, so it always rebuilds
a stored `HTTP`, `No response` or `No request sent` line from recognized fields
only (`HTTP <code>`, plus a plain reason phrase, type and size when they match)
and the display form of the requested URL; the stored URL is never shown. The
`/tree` branch previews of web_fetch results use the same rebuilt form, masking
only the part of the result a preview can show: the first line and about two
preview lengths, cut at ASCII whitespace when one is near. A cut never splits a
known credential value, and an open userinfo span is masked up to the cut.

The rest of the result comes from the server, so it gets best-effort, linear
masking: every exact occurrence of a known credential value, plus two heuristic
detectors. Known values come from the requested URL and the final URL in the
tool's first line, using the same splitting as the display (`&`-separated query
and fragment pairs, `;` path parameters and userinfo) on the URL and up to three
percent-decodings of it. A pair is credential-bearing when its whole decoded
name contains, ignoring case, `key`, `token`, `secret`, `pass`, `pwd`, `auth`,
`sig`, `jwt`, `session`, `credential`, `appid` or `code`, or when its value
holds `@` or a nested credential assignment; userinfo always is. Up to 64 KiB of
such value text is collected per URL; nested assignments add their outermost
and innermost values. Each value adds itself and its strict and lenient
(U+FFFD) decodings, then every run of four or more Unicode letters, combining
marks or digits and every piece of four or more characters between separators
(`& = ; / : , ? #` or whitespace), then its `+`/space, hex-case, re-encoded and
JSON-escaped (`\/`, `\u002f`) forms, up to 256 values per URL. The heuristic detectors also mask userinfo after a slash run up to the
last `@` or `%40` before whitespace, and the value after a credential name
followed by `=`, `%3D` or `\u003d` anywhere, with the name read back to a
separator (`?`, `&`, `#`, `;`, `/` or whitespace); a value runs to `&`,
whitespace, `<`, `>` or `"` and is scanned again for nested assignments.

Known values are derived again from the call's `url` argument when needed and
are never stored. The first line echoes final URLs up to 8,192 characters,
clipped on a code-point boundary, with the server's reason phrase cut to 64
characters and its media type to 100, so long presigned URLs are covered and the
line stays bounded.

Residual risks: pieces of a value shorter than four characters, such as `Xy` in
`Xy/9abcd`; a credential whose parameter name is not credential-like and that the
server echoes without its name; and values that appear only in an intermediate
redirect hop or past the echo length. A successful row shows its status, size
and time.

## File permissions

`edit` and replacement `write` preserve an existing regular file's ordinary POSIX
permission bits (`mode & 0777`), including executable and private modes, even under
a restrictive umask. New files keep the usual `0666 & ~umask` creation defaults.
Replacement files are created exclusively with `0600` or stricter permissions
inside an owner-only staging directory beside the destination. The final mode is
applied only after the content is complete and before rename. The directory keeps
completed bytes inaccessible to other local users until publication, including
when final validation rejects a replacement with a readable final mode.
Its ordinary permissions are `0700`; inherited directory setgid is retained so
new files keep the parent directory's group inheritance.
On POSIX, preparation first checks the canonical parent and its ancestors using
ordinary owner, traversal, write and sticky bits. It refuses a path where another
user could replace the staging directory, with `Cannot safely prepare file
replacement` and guidance to use a directory protected from other users. This
limits compatibility with shared writable workspaces: a non-sticky shared parent
is accepted only behind a protected ancestor. Sticky temporary directories and
ordinary protected projects remain supported. Directory identities and access
bits are rechecked during preparation and before publication; observed symlink
substitutions are rejected before directory chmod.
Cancellation or failure before publication leaves the destination intact and
attempts to remove the owned temporary file and empty staging directory. Cleanup
does not recursively delete unexpected entries. If cleanup fails or the process
is killed, remaining staged bytes stay behind the private directory.

The destination's identity, mutation metadata and permissions are rechecked just
before publication; reads used by edit are also checked against their original
bytes. Observable saves, chmods and replacements cause the operation to fail.
This check and rename are separate filesystem operations, not a kernel-level
compare-and-swap. Path resolution and existing symlink behavior are unchanged.
`write` still replaces dangling symlinks and non-directory special entries such
as FIFOs or sockets using fresh-file defaults; it observes the link entry
separately from any existing target. Nonregular reads used by `edit` retain their
single-read behavior and revalidate metadata instead of consuming the stream again.

Windows does not provide the ordinary POSIX permission model: permission metadata
is omitted, final POSIX chmod is skipped, and native creation/access rules apply.
Other platforms rely on their filesystem's POSIX mode support; a failed chmod
aborts publication instead of silently weakening permissions. The staging checks
use ordinary POSIX path access, trusting the effective user and privileged UID 0;
they do not fence changes by those users, existing directory handles or ACL access.
ACLs, ownership, extended attributes and setuid/setgid/sticky restoration are
outside this behavior.
