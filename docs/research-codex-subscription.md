# Research: Codex subscription integration feasibility for Schway (issue 49)

Status: **NO-GO for a live subscription-backed model-only transport; GO for offline mechanics-only replay.**
Live validation: **not-run** (no authorized credentials were used; no network calls to subscription endpoints were attempted).
Offline replay: **passed** (`bun test tests/codex-feasibility.test.ts`, 6 pass).

This file is the reserved handoff artifact for downstream issue 50. The coordinator may copy
Section 14 verbatim into issue 50. No GitHub writes were made by worker-49.

- Schway baseline: `6088930c1a8b92e193209d20dd014d7d97f91a97`, package `0.1.0`
- Worktree branch: `issue-49-batch-20260923-155723`
- Research date (UTC): 2026-09-23
- Prototype files: `src/model/providers/codex-feasibility.ts`,
  `tests/codex-feasibility.test.ts`, `tests/fixtures/codex-subscription/*.json`

## 1. Required boundary (pass/fail gate)

Schway must retain the agent loop:

1. Schway prepares context and requests a model response.
2. Schway receives normalized tool calls.
3. Schway executes its own tools.
4. Schway submits its own tool results.
5. Schway retains scheduling, retries, compaction, cancellation, and durable sessions.

Merely starting a Codex agent turn via the SDK (`thread.run`) or App Server (`turn/start`)
does **not** satisfy this contract, because Codex then owns tool execution, sandboxing,
approvals, and the run lifecycle.

Forbidden (none were done): reading another CLI's credential files, copying any private
OAuth client identity, assuming an undocumented token works against a paid endpoint, or
counting an API-key request as subscription access.

## 2. Dated official sources (reverified 2026-09-23)

All fetches below used `curl -sL` from this worktree on 2026-09-23 (~16:02 UTC).
Markdown variants were fetched by appending `.md` to the page URL, as the docs themselves direct.

| # | Source | Fetched | Evidence |
|---|--------|---------|----------|
| S1 | `https://learn.chatgpt.com/docs/auth` (+ `.md`) — Authentication: sign-in methods for ChatGPT web and Codex clients | 2026-09-23 | HTTP `200`, page `Last-Modified: Wed, 23 Sep 2026 08:20:58 GMT`; `.md` variant renders the same headings (`Sign in with ChatGPT`, `Sign in with an API key`, `Login caching`, `Credential storage`, `Login on headless devices`, `Alternative model providers`) |
| S2 | `https://learn.chatgpt.com/docs/app-server` (+ `.md`) — Codex App Server protocol | 2026-09-23 | Documents `initialize` → `thread/start` → `turn/start` → streamed `item/*` notifications → `turn/completed`; `turn/interrupt` cancels; `command/exec` runs under the server sandbox |
| S3 | `https://learn.chatgpt.com/docs/codex-sdk` (+ `.md`) — Codex SDK (TypeScript + Python) | 2026-09-23 | `thread.run("...")` runs a Codex-owned agent turn; Python SDK controls the local app-server over JSON-RPC; `codex mcp-server` removed in favor of app-server |
| S4 | npm registry `time` metadata for `@openai/codex-sdk` | 2026-09-23 | Latest stable observed: `0.156.1` published `2026-09-23T02:45:50.362Z`; prereleases up to `0.158.0-alpha.2` (`2026-09-23T13:23:35.823Z`) |
| S5 | Schway repo `package.json` at baseline | pinned base | `openai ^7.20.0`, `@anthropic-ai/sdk ^0.127.0`; Schway's existing adapters are API-key transports only |

No page above documents a subscription-backed, model-only completion endpoint
(Chat Completions / Responses style) that returns tool calls for a third-party loop to execute.

## 3. What the docs actually establish

### 3.1 Verified clients and auth flows (S1)

- **Sign in with ChatGPT (subscription access):** supported in the ChatGPT desktop app,
  Codex CLI (`codex login` → browser flow; `codex login --device-auth` headless beta),
  and IDE extension (`Sign in with ChatGPT` → browser flow). Codex cloud **requires**
  ChatGPT sign-in. After browser sign-in, the browser returns credentials to Codex.
- **Sign in with an API key (usage-based access):** `printenv OPENAI_API_KEY | codex login --with-api-key`
  (CLI), plus desktop/IDE equivalents. Billed through the OpenAI Platform at standard API
  rates. Some workspace/cloud features are limited or unavailable with API keys.
- **Enterprise automation:** ChatGPT Enterprise workspaces may grant a Codex access-token
  permission; automation then uses `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token`.
  Intended for trusted scripts/schedulers/private CI, not general third-party API use.
- No documented flow issues a caller-owned OAuth client for Schway, and no documented flow
  authorizes Schway to mint or replay ChatGPT subscription credentials.

### 3.2 Credential identity, storage, and refresh (S1)

- Login details are cached and reused; CLI and IDE extension share the same cache.
- File location (when file-backed): `~/.codex/auth.json` under `CODEX_HOME` (default `~/.codex`),
  otherwise the OS credential store. Treat the file like a password: it contains access tokens.
- `cli_auth_credentials_store = "file" | "keyring" | "auto" | "ephemeral"` controls placement;
  admins can enforce it plus `chatgpt_base_url` via managed configuration.
- ChatGPT sessions refresh tokens automatically during use before expiry.
- Headless fallback documented: authenticate locally, then copy `~/.codex/auth.json`
  (with explicit password-like handling warnings), or forward the localhost callback
  (`localhost:1455`), or use device-code auth (beta, must be enabled in security settings).
- **Schway rule:** this cache documents Codex behavior; Schway must never read, copy, or
  replay it. The feasibility prototype carries no credentials and touches no such path
  (asserted by test `feasibility prototype never scrapes CLI caches...`).

### 3.3 App Server request/response and why it fails the boundary (S2)

- Handshake: `initialize` + `initialized` per connection; `clientInfo.name` identifies the
  integration (enterprise clients should contact OpenAI to join the known-clients list).
- Conversation: `thread/start` (or `resume`/`fork`) → `turn/start` with user input →
  streamed notifications (`item/started`, `item/agentMessage/delta`, tool progress, ...) →
  `turn/completed`.
- Execution ownership stays server-side: `approvalPolicy`/`sandbox` (`workspaceWrite`,
  `read_only`, `full_access` presets in the SDK), `command/exec` under the server sandbox,
  permission profiles, `thread/shellCommand` outside the sandbox. These are Codex-runner
  controls, not model-only tool-call returns.
- Cancellation is `turn/interrupt` → turn ends `status: "interrupted"`. That cancels a
  Codex-owned run; it is not the same as Schway aborting its own model request and
  retaining scheduling/retry/compaction/session ownership.
- Transports (`stdio` default, experimental `ws://`, Unix socket) expose the same
  delegation semantics; WebSocket auth is deployment auth for the local listener, not a
  subscription model API.

### 3.4 SDK request/response and why it fails the boundary (S3)

- TypeScript: `new Codex()` → `startThread()` → `thread.run("...")` → `result.finalResponse`.
  Python: `Codex()` → `thread_start(model, sandbox)` → `thread.run("...")`.
- Both drive a Codex-owned agent that plans, executes, and finishes. The caller receives a
  final response, not a stream of normalized tool calls for its own executor.
- The SDK therefore proves the opposite of the required contract: it delegates the run.

### 3.5 Request/response mapping (required vs. available)

| Schway boundary need | Codex subscription-supported equivalent found? |
|---|---|
| Send system/context/items/tools; receive text deltas | No. No documented subscription Chat Completions/Responses endpoint. |
| Receive exactly one normalized tool call per turn for Schway to execute | No. Experimental `dynamicTools` can send `item/tool/call` requests to the client and accept client-produced results, but App Server still owns the agent turn and continuation rather than exposing Schway's model-only contract. |
| Submit Schway-executed tool results as the next model input | No. `turn/steer` appends user input to an in-flight Codex turn; `thread/inject_items` appends raw Responses items to a Codex-owned history — both stay inside Codex's loop. |
| Cancel a pending model request via Schway's `AbortSignal`, keep session/scheduling | No. `turn/interrupt` cancels Codex's run; Schway does not retain the loop. |
| Credential identity Schway can mint/store/refresh itself | No. Only Codex-client browser/device-code flows and Enterprise access tokens exist, both bound to Codex clients. |

Positive-result fields (client, credential, mapping, cancellation) therefore cannot be
specified for a live subscription transport: **the transport does not exist in the
verified docs.**

## 4. Account prerequisites (for any Codex subscription use, not for Schway's loop)

Per S1: a ChatGPT account; workspace membership/provisioning; seat and role entitlements
for the surfaces used; MFA for Codex cloud (mandatory for email+password accounts,
including multi-method accounts where one method is email+password); device-code beta
enabled for headless ChatGPT login; Enterprise access-token permission for non-interactive
workspace automation. API-key use instead follows Platform billing and loses
workspace/cloud-dependent features.

## 5. Unsupported cases (explicit)

- Schway sending a ChatGPT subscription token (OAuth access/refresh, `auth.json` contents,
  Enterprise access token, or any browser-returned credential) as a Bearer credential to
  `api.openai.com` or any undocumented inference URL. No doc authorizes it; the issue
  forbids assuming it works.
- Schway spawning or driving `codex app-server` / `@openai/codex-sdk` / `codex login`
  artifacts to obtain model-only tool calls. Those APIs delegate execution to Codex.
- Copying `~/.codex/auth.json` into Schway's credential store, CI cache, or fixtures.
- Copying any OAuth client identity (client id/secret, token URLs, PKCE verifier patterns)
  from Codex artifacts into Schway. None were extracted; the prototype contains none.
- Production login UI, background refresh daemons, or token persistence for Codex
  credentials in Schway. Out of scope by design.
- Treating an OpenAI Platform API-key request as subscription access. It is billed
  separately and is already covered by Schway's existing adapters.

## 6. Bounded prototype: what was built (offline replay only)

Isolated new files only; no production adapter, auth, session, CLI, TUI, or config touched.

- `src/model/providers/codex-feasibility.ts` — `createCodexFeasibilityModel()` exposes the
  Schway `Model` contract (`provider: "codex-feasibility"`, `stream(request)`), backed by a
  scripted replay transport. It maps `ModelRequest` to an observable wire-equivalent
  (`toWireRequest`: instructions/input/tools), yields `text_delta` then `message_complete`,
  assembles at most the replayed tool calls, never executes tools (`executedTools` is
  constant `0`), performs no retries (single attempt), redacts configured secrets from
  errors, and honors `request.signal` (throws `AbortError`, including while parked in
  `waitForAbort`). It imports only Schway conversation/model types; no TUI, no provider SDK,
  no `codex` process, no credential paths.
- `tests/codex-feasibility.test.ts` — 6 deterministic tests, no network, no paid APIs.
- `tests/fixtures/codex-subscription/turn-text.json`,
  `turn-tool-call.json`, `turn-tool-result.json` — sanitized synthetic replays
  (`version: 1`, `capturedAt: 2026-09-23`, explicit `source` stating they are not live
  Codex responses, `schwayBaseline` pinned). No tokens, no accounts, no PII.

Run:

```sh
cd /Users/chayapats/Projects/schway-worktrees/batch-20260923-155723-47-48-49/issue-49
bun test tests/codex-feasibility.test.ts
bun run typecheck
```

Observed 2026-09-23: `6 pass, 0 fail, 37 expect() calls`; `tsc --noEmit` clean.

## 7. Concrete trace (Schway executes the requested tool itself)

Test `Schway executes the requested tool itself and submits its own result`:

1. Turn 1 request: system prompt + environment context + user `read note.txt` + `read` tool schema →
   wire-equivalent observed via `onRequest`; replay streams `Let me read that.` then
   `message_complete` with `tool_call { id: call_read1, name: read, arguments: { path: note.txt } }`.
   Transport executed 0 tools (asserted).
2. Schway-side execution via the real tool path (`executeToolCall` + `readTool` on an
   isolated temp workspace): validate arguments, read `note.txt`, and submit the
   executed file content as the Schway-owned `tool_result`.
3. Turn 2 request: original items + assistant message + Schway's own
   `tool_result { toolCallId: call_read1, content: <executed read output>, isError: false }` →
   replay streams final `note.txt says hello` + `message_complete`.
4. Assertions: `requestCount === 2`, `executedTools === 0` throughout, second wire input
   contains the Schway-submitted `role: tool` entry.

Cancellation trace: `cancellation at the Schway boundary...` aborts a parked stream and
rejects with `AbortError`; `already-aborted requests fail fast...` rejects before any delta.
Failure trace: `transport failures surface once...` throws the replayed error with
`requestCount === 1` (no adapter-level retry; Schway's own retry policy would own any retry).
Isolation trace: source scan asserts the prototype contains no `~/.codex/auth.json`,
`turn/start`, `app-server`, `codex login`, or client-secret material, and exposes only
`{ provider, id, requestCount, executedTools, stream }` — no delegated `run`/`turn`/`exec`.

## 8. Cancellation behavior (contract)

- Schway side (proven by prototype): the caller passes `request.signal`; the adapter checks
  before every delta, while parked awaiting abort, and before assembling `message_complete`.
  Abort → `DOMException { name: "AbortError" }`, no further events, no tool execution, no retry.
- Codex side (documented, not used): `turn/interrupt` ends a Codex-owned turn with
  `status: "interrupted"`. Not equivalent: it cancels Codex's execution rather than Schway's
  request, and leaves scheduling/retries/compaction/sessions with Codex.
- A future live transport would need to specify: abort propagation to the HTTP/SSE stream,
  whether a partial assistant message is recoverable, per-turn idempotency keys, and that
  abort never triggers Codex-side tool execution. None of this is documented for a
  subscription model-only endpoint, so it is specified here only for the replay.

## 9. Go / no-go

- **NO-GO for v0.3 subscription integration via any currently documented path.** S1–S3
  describe ChatGPT login for Codex clients, API-key usage billing, Enterprise access tokens
  for Codex automation, and agent-delegating SDK/App Server APIs. None provides a supported
  model-only subscription transport preserving Schway's loop. Closing this research must not
  weaken loop ownership, so the no-go keeps downstream gated.
- **GO for mechanics only:** the offline replay proves the Schway-owned
  model → tool → model shape, single tool-call round trip, failure surfacing without
  adapter retries, and boundary cancellation — without delegating the run and without any
  credential use. Fixture success is not live or human evidence.

## 10. Unknowns and next prerequisite (downstream stays gated until resolved)

- U1: Does OpenAI offer, or plan to offer, a supported subscription-backed inference
  endpoint usable with model-only semantics (system/instructions + input + function tools in,
  text deltas + executable tool calls out, caller-executed results in)? Not found in S1–S4.
- U2: Is there a supported first-party scope/claim that authorizes a non-Codex loop to
  consume subscription entitlements, distinct from Codex-client login and Enterprise
  automation tokens? Not found; do not assume `auth.json`/access-token replay works.
- U3: What are the supported token lifetime, refresh, revocation, residency, and audit
  rules for such third-party use? Only Codex-client refresh/storage rules are documented.
- Prerequisite P1 (blocks issue 50 implementation): an OpenAI-published contract or explicit
  product decision naming the supported model-only subscription transport — endpoint,
  credential type and owner, tool-call/result schema, cancellation semantics, rate/entitlement
  behavior, and unsupported cases — or an explicit decision that Schway will not support
  subscription auth and will remain API-key only. Until P1 lands with dated sources,
  issue 50 must remain a contract/design issue, not an implementation issue.

## 11. Live validation

- Status: **not-run**. No authorized ChatGPT/API credentials were provisioned or used; no
  subscription or API-key calls were made (live calls would also be out of scope for the
  forbidden API-key-as-subscription substitution). Bounded live validation, if ever
  authorized, must use explicitly provided credentials, a bounded call budget, redacted
  logging, and must still demonstrate the model → tool → model round trip with Schway-side
  execution — `thread.run`/`turn/start` success alone would not count.

## 12. Limitations and risks

- Offline fixtures are synthetic; they prove control-flow mechanics, not service behavior,
  latency, pricing, entitlements, or model quality.
- Docs are versioned by fetch date, not pinned server versions; App Server/SDK surface is
  experimental in places (`--listen ws://`, `experimentalApi`, paginated history) and may drift.
- npm `codex` 0.2.3 was observed via `npm view` but its package identity is ambiguous;
  it is intentionally not cited as evidence.
- No human-factors or approval-UX evidence was gathered; permission profiles and sandbox
  policies were read from docs only.

## 13. Runnable example (uses only the replay; no credentials)

```ts
import type { AssistantMessage, ToolResult } from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createCodexFeasibilityModel } from "../src/model/providers/codex-feasibility.ts";

const model = createCodexFeasibilityModel({
  turns: [
    { chunks: ["Let me read that."], toolCalls: [{ id: "call_1", name: "read", arguments: { path: "note.txt" } }] },
    { chunks: ["note.txt says hello"] },
  ],
});

const request: ModelRequest = {
  systemPrompt: "You are Schway.",
  context: [],
  items: [{ type: "user", id: "user-1", content: [{ type: "text", text: "read note.txt" }] }],
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
};

// Turn 1: Schway requests a model response.
const first = await Array.fromAsync(model.stream(request)); // text_delta*, message_complete{tool_call}
const firstComplete = first.find((event) => event.type === "message_complete");
if (firstComplete?.type !== "message_complete") {
  throw new Error("expected message_complete");
}
const assistantMsg: AssistantMessage = firstComplete.message;
// Schway executes `read` itself via its own tools, producing "note.txt says hello".
const toolResult: ToolResult = {
  type: "tool_result",
  id: "result-1",
  toolCallId: "call_1",
  content: "note.txt says hello",
  isError: false,
};
// Turn 2: Schway submits its own tool_result and streams the follow-up text.
const second = await Array.fromAsync(model.stream({ ...request, items: [...request.items, assistantMsg, toolResult] }));
// Abort anytime via request.signal; the stream rejects with AbortError and executes nothing.
```

Run from the docs directory with `bun docs-runnable-example.ts` after saving this block
to `docs/docs-runnable-example.ts` (imports above resolve to `../src/...`).

Full version with assertions: `tests/codex-feasibility.test.ts`.

## 14. Handoff contract for issue 50 (coordinator may copy verbatim)

> **Codex subscription feasibility (issue 49, researched 2026-09-23, Schway base 6088930c, package 0.1.0): NO-GO for live use; replay-only GO for mechanics.**
>
> **Verified docs:** learn.chatgpt.com `Authentication` (fetched 2026-09-23; page Last-Modified Wed, 23 Sep 2026 08:20:58 GMT), `Codex App Server` (fetched 2026-09-23), `Codex SDK` (fetched 2026-09-23); `@openai/codex-sdk` latest stable observed 2026-09-23 is `0.156.1` (published 2026-09-23T02:45:50.362Z). Markdown variants via append-`.md`.
>
> **Verified clients/auth:** Sign in with ChatGPT (browser flow) for ChatGPT desktop app, Codex CLI (`codex login`, headless beta `codex login --device-auth`), IDE extension; Codex cloud requires ChatGPT sign-in. API-key sign-in (`codex login --with-api-key`) is usage-billed Platform access with reduced workspace/cloud features. Enterprise automation may use `CODEX_ACCESS_TOKEN` (`codex login --with-access-token`) for trusted Codex automation. No documented flow mints a Schway-owned subscription credential.
>
> **Credential identity/storage/refresh:** Codex caches login in `~/.codex/auth.json` (under `CODEX_HOME`) or OS credential store per `cli_auth_credentials_store = file|keyring|auto|ephemeral` (admin-enforceable); ChatGPT sessions auto-refresh before expiry; headless options are device-code beta, localhost-callback forwarding (`localhost:1455`), or copying `auth.json` with password-like handling. Schway must never read/replay this cache; prototype carries no credentials.
>
> **Request/response mapping:** No supported subscription model-only endpoint exists in the verified docs. SDK `thread.run` and App Server `turn/start` both delegate planning, tool execution, sandbox/approvals, and run lifecycle to Codex (`sandbox` presets `read_only|workspace_write|full_access`, `command/exec` under server sandbox, streamed `item/*` progress, `turn/completed`). `turn/steer` and `thread/inject_items` stay inside Codex's loop. Experimental `dynamicTools` can route selected tool calls to the client as `item/tool/call` requests and accept client-produced results back into the model tool pipeline, but Codex retains planning, continuation, and overall run ownership — still not Schway's model-only contract.
>
> **Cancellation:** Schway-side `AbortSignal` → replay rejects `AbortError` with zero tool execution (proven). Codex-side `turn/interrupt` → `status: interrupted` cancels Codex's run (documented, not equivalent, not used).
>
> **Account prerequisites:** ChatGPT account + workspace membership/provisioning + seat/role entitlements; MFA for Codex cloud (mandatory for email+password, incl. multi-method accounts); device-code beta enabled for headless login; Enterprise token permission for automation. API-key path follows Platform billing instead.
>
> **Unsupported:** Bearer-reuse of any ChatGPT/Codex token against `api.openai.com` or undocumented URLs; driving `app-server`/SDK/`auth.json` for model-only calls; copying private OAuth client identity; counting API-key traffic as subscription access; production login UI/refresh in Schway.
>
> **Fixtures/reproducer (offline only, dates+versions):** `tests/fixtures/codex-subscription/turn-{text,tool-call,tool-result}.json` (`version: 1`, `capturedAt: 2026-09-23`, synthetic, no credentials, `schwayBaseline: 6088930c...`); `bun test tests/codex-feasibility.test.ts` → 6 pass; `bun run typecheck` clean. Trace proves Schway-side `read` execution and own `tool_result` submission across two turns, plus abort and single-attempt failure paths.
>
> **Live status:** not-run (no authorized credentials used; no subscription calls attempted). Fixture success is not live/human evidence.
>
> **Unknowns / gating prerequisite:** U1 supported subscription model-only endpoint? U2 third-party scope/claim for non-Codex loops? U3 token lifecycle/audit for such use? Prerequisite P1: OpenAI-published model-only subscription contract (endpoint, credential owner/type, tool schemas, cancellation, entitlements, unsupported cases) or explicit decision to stay API-key only. Until P1 lands, issue 50 stays design-only.
