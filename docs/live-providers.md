# Opt-in live provider smoke checks

This is a **paid/remote opt-in**, not a default Bun test, CI job, or capability eval. Run from the revision you want to test. Each selected provider runs in its own OS subprocess and temporary workspace containing a random sentinel; Schway's real streaming loop must call its `read` tool and return **exactly** the value read. No session is persisted. The parent removes the workspace only after the worker and its process group are proven stopped. The exposed read tool rejects any path except the relative sentinel name (including absolute paths); any unadvertised non-`read` call fails with `failed_provider` / `disallowed_tool` **before any tool executes**. No extensions, interactive login, other filesystem tools or TUI are loaded.

```sh
# One API-key lane. Explicitly opt in before any credential lookup or network call.
OPENAI_API_KEY=... bun run live-smoke --enable-live --provider openai-api-key
XAI_API_KEY=... bun run live-smoke --enable-live --provider xai-api-key
# Other lanes (select exactly the lanes you intend to bill):
bun run live-smoke --enable-live --provider compatible --base-url https://example.org/v1 --auth required
bun run live-smoke --enable-live --provider codex
# Local no-key compatible fixture only (no HTTP credentials):
bun run live-smoke --enable-live --provider compatible --base-url http://127.0.0.1:1234/v1 --auth none
# All five only with express operator consent:
bun run live-smoke --enable-live --provider all --base-url https://example.org/v1
# Inspect selection/report shape without looking up credentials or calling providers:
bun run live-smoke --provider all
```

Prerequisites: Bun; for native OpenAI `OPENAI_API_KEY` or its own secure-store API-key identity; for xAI `XAI_API_KEY` or the stored `api-key:xai` identity (the lane defaults to `grok-4.7` unless `--model xai-api-key=<id>` is set, and reports `skipped` / `missing_credentials` without a key); for compatible an explicit **HTTPS** `--base-url` plus `OPENAI_COMPATIBLE_API_KEY` or endpoint-scoped secure-store key. Plain HTTP is allowed **only** for `localhost`, `127.0.0.1`, or `[::1]` with explicit `--auth none`, never with credentials or on remote endpoints; this is not the default. All selected adapters use a smoke-only fetch policy that rejects redirects (including HTTPS-to-HTTP downgrades) rather than forwarding keys or subscription tokens. `--credential-env NAME`, `--profile NAME`, and `--credential-identity NAME` select the same compatible credential scopes as production. These only apply with `--provider compatible`. Avoid putting keys in arguments, URLs, profiles, or model IDs. The runner does not read `.env` files (`--no-env-file`); export environment values deliberately, or use OS secure storage. Do not put credentials in shell history.

For ChatGPT subscription, sign in **separately** in interactive Schway with `/login codex` (or `/login codex --device` on headless machines) first; the runner uses the same Schway secure-store identity and store-backed automatic token refresh as production. It never opens a browser, requests a device code or silently switches subscription to API-key billing. Expired/revoked sessions needing interaction report `pending` with `subscription_requires_login`. A locked/unavailable OS secure store reports `pending` with `credential_store_unavailable`: unlock or restore store access before retrying, rather than signing in again. Refresh failures unrelated to re-login report `failed_provider`.

Selection: `--provider` accepts `openai-api-key`, `xai-api-key`, `compatible`, `codex`, `grok`, `all`, or a comma-separated subset. Use `--model provider=model-id` to override a selected lane (repeat for more than one). By default the built-in model IDs are used; choose tool-capable models. `--timeout-ms N` controls each lane (default 30000, max 120000); exactly two model rounds, 256 requested output tokens per round, a 4096-character budget over streamed text, assembled messages/tool-call arguments and tool results, a cumulative 256 KiB HTTP response-body limit across requests/retries/ordinary subscription refresh before selected adapters parse streams, and Schway's bounded transient retry policy constrain usage. Select **only** providers you intend to contact; a multi-provider invocation runs them sequentially. The installed command has a per-lane deadline including worker startup, followed by a 1500 ms SIGKILL/reap/check **window** for its dedicated POSIX process group; polling, scheduler and filesystem cleanup can add overhead beyond this window. Even if an adapter ignores abort, no later lane launches after a timeout (`prior_run_timeout`). If an output-limit abort leaves a worker unsettled, its framed result is received before exit; after a proven process-group kill and workspace removal it remains `failed_provider` / `output_limit`, never a fabricated timeout. If a worker claims success but leaves a descendant, the supervisor kills the group and reports `failed_runner` / `process_group_leak`, not pass. If stop cannot be certified, it reports `failed_runner` / `process_stop_unverified`, retains the workspace (`cleanup: deferred`) and marks later lanes `prior_run_unsettled`; do not delete that directory until checking for outstanding processes. On Windows the command does **not** launch live workers: it reports `pending` / `supervision_unavailable` because Bun's direct-child kill cannot certify descendants without an OS Job Object. POSIX process-group supervision cannot certify deliberately detached processes escaping that group or a machine failure; do not use executable extensions or external tools in smoke tasks. A streamed tool call may grow before the loop emits a complete message, but the smoke-only fetch wrapper rejects response bytes before adapter SSE parsers consume more than the cumulative ceiling; the assembled-message check still rejects oversized calls before execution. This bounds bytes *delivered to adapters*, not total process memory (a single oversized upstream chunk may be allocated by fetch before the wrapper checks it). Credentials stay in the worker environment/secure store, never subprocess argv, stdin, stdout/stderr, or JSON reports; private stdin carries only selected settings (max 8 KiB), stdout is capped at 8 KiB and raw stderr is discarded. The separately exported `runLiveSmoke` is an **in-process test/programmatic seam**, not a hard-stop API: injected scripted models can bypass the production fetch wrapper, and an uncooperative stream may retain its workspace until settlement. Use the installed CLI for OS-supervised execution.

Report: JSON on stdout with UTC `testedAt`, checked-out Git `revision` (or `unknown` outside a Git checkout), per-lane `provider`, actual `model`, explicit requested `thinking` when selected (including skipped/pending/failed outcomes), auth source **category** (`env`, `stored`, `stored-subscription`, `none`, `unavailable`), duration milliseconds, `toolRoundTrip`, status and fixed reason code. It never includes a key, raw provider response, endpoint, sentinel, tool output or temp path. Preserve the JSON **with its date/revision/model selection** for live evidence. `passed` means the actual read result was returned verbatim in the final response; `failed_provider` covers transport/model-started timeout/output limit/turn limit/tool-protocol failure; `failed_runner` covers setup/cleanup failure, a hard deadline before the stream starts, or an unverified process stop; `skipped` covers unavailable key/disabled opt-in; `pending` covers unavailable subscription/integration or user cancellation. Aggregate is `passed` (exit 0) only if **all selected** lanes pass; `incomplete` (exit 2) for any skip/pending without failure; `failed` (exit 1) for any failure, including CLI usage errors. Missing credentials are never passed. A fixture result is not live evidence. No paid live run has been performed for this issue.

Started lanes include numeric `diagnostics`: `modelAttemptsStarted` (including Schway retries), `modelRoundsCompleted`, `toolResultsCompleted`, `providerRetries`, `httpRequestsStarted`, `httpResponsesReceived`, and optional `lastHttpStatus`. HTTP counts include selected-adapter retries and subscription refresh. When thinking is explicit, HTTP counts also include selected account/endpoint capability discovery. Counts record observed boundaries: receiving HTTP 200 does not mean its body finished, and a completed tool result does not prove the final answer. On a supervisor deadline, a bounded, validated private checkpoint preserves these counters and the resolved auth category after the process group is proven stopped. A missing or invalid checkpoint leaves auth `unavailable`; that category alone does not establish an authentication failure. Neither partial progress nor a timeout establishes zero usage or exact spend.

The deadline covers the **whole two-round lane**, including startup, credential lookup, both model responses, and tool execution. Two individually successful responses can exceed it in sum. For example, `modelRoundsCompleted: 1`, `toolResultsCompleted: 1`, `modelAttemptsStarted: 2` locates a timeout after the first tool round; HTTP counters then distinguish a pending response from a received response whose stream has not completed. The runner retains its deadline, byte/output limits, and refusal to start later lanes after timeout. These diagnostics address lost progress in #174; they do not establish the cause of the historical 120-second failure or attribute HTTP 503 to any upstream provider. No paid verification or historical result has been replaced.

## Live evidence (2026-09-25)

**Tested live revision: none**; local scripted/protocol fixtures are not live evidence. These are *planned defaults*, not outcomes or a claim that any model was reached. An operator must supply consent and record the actual revision/model/date from the JSON report before changing any row to passed or failed.

| Provider/auth | Planned default model | Live status | Evidence |
| --- | --- | --- | --- |
| OpenAI API key | `gpt-5.4` | **Pending** | No paid call authorized. |
| Compatible endpoint | `gpt-4o` (override as needed) | **Pending** | No configured endpoint or paid call authorized. |
| ChatGPT subscription | `gpt-5.4` | **Pending** | No operator sign-in/paid call authorized. |

Offline scripted/local HTTP fixtures exercise the runner only, not live compatibility.

## Grok subscription lane

Select `--provider grok` and optionally `--model grok=<id>`. `--provider all` includes this lane. It uses the saved `grok-subscription:xai` login and the xAI fallback model unless overridden. It never starts sign-in or reads an API key.

Without `--enable-live`, the lane reports `skipped/live_disabled` and exits 2 without opening the secure store. An absent login reports `pending/missing_subscription`; malformed, expired without refresh, or revoked logins report `pending/subscription_requires_login`. Unavailable secure storage reports `pending/credential_store_unavailable`. Sign in interactively with `/login grok` or `/login grok --device` before enabling a live run.

## Reasoning controls and deterministic verification

Normal Schway CLI/TUI requests share the reasoning policy described in
[configuration](configuration.md#reasoning-levels). OpenAI Luna and Sol use
documented Responses efforts. Codex, Grok and xAI use route model metadata;
OpenRouter uses its endpoint-scoped reasoning catalog. Other compatible endpoints
retain explicit `extraBody` configuration. Unset thinking leaves provider defaults
untouched, and unadvertised choices fail before inference.

`bun test tests/thinking-policy.test.ts tests/reasoning.test.ts` verifies actual
request bodies, unsupported-level rejection, configuration and interactive
selection using protocol fixtures. These are deterministic checks, not new live
provider results.

The smoke runner accepts repeatable lane-scoped `--thinking provider=level`
alongside `--model provider=model-id`. Levels are `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`, and `ultra`; a valid spelling still requires support from
the selected route/model. Overrides must target selected lanes. Malformed values
and unselected lanes fail before credentials, network access, or worker launch.
If a lane is repeated, its last explicit override wins. Omit thinking to retain
existing smoke behavior and send no explicit reasoning control; no additional
catalog lookup runs for omission. Eval and TUI behavior is unchanged.

```sh
bun run live-smoke --enable-live --provider openai-api-key,codex,compatible,grok \
  --model openai-api-key=gpt-6-luna --thinking openai-api-key=high \
  --model codex=gpt-6-sol --thinking codex=medium \
  --base-url https://openrouter.ai/api/v1 --auth required \
  --model compatible=meta/muse-spark-1.3-contributor --thinking compatible=medium \
  --model grok=grok-4.7 --thinking grok=medium
```

This example selects four lanes; it does not replace the five-lane release gate,
which also requires the separately credentialed `xai-api-key` lane.
Explicit thinking on Codex fetches the saved subscription's catalog; xAI/Grok
fetches the selected API-key/subscription model list; OpenRouter fetches its
endpoint-scoped reasoning catalog. Discovery uses the same cumulative 256 KiB
response budget, redirect rejection, and whole-lane deadline as inference and
subscription refresh. No credentials or catalogs are read without `--enable-live`.
Capabilities are never transferred across account, auth route, model, or endpoint.
Unavailable metadata reports `failed_runner/thinking_capability_unavailable`;
unadvertised levels or missing selected models report
`failed_runner/unsupported_thinking` before inference. No model, level, auth, or
billing fallback occurs. Other compatible endpoints follow the shared production
policy, which does not infer reasoning support from model names.

JSON `thinking` records the explicit request, even when the lane is skipped,
pending, fails, or times out; it is omitted when unspecified. It is request
evidence, not proof the provider completed inference. Both model rounds use the
production loader and adapter mapping. CLI/parser, bounded worker protocol,
actual OS-supervised worker, and request-body fixtures are covered by
`bun test tests/live-cli.test.ts tests/live-process.test.ts tests/live-smoke.test.ts`.
These fixtures exercise OpenAI high, Codex medium, OpenRouter medium, and Grok
medium in both rounds, plus unsupported-choice refusal, without paid remote calls.
