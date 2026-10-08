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

For ChatGPT subscription, sign in **separately** in interactive Schway with `/login chatgpt` (or `/login chatgpt --device` on headless machines) first; the runner uses the same Schway secure-store identity and store-backed automatic token refresh as production. It never opens a browser, requests a device code or silently switches subscription to API-key billing. Expired/revoked sessions needing interaction report `pending` with `subscription_requires_login`. A locked/unavailable OS secure store reports `pending` with `credential_store_unavailable`: unlock or restore store access before retrying, rather than signing in again. Refresh failures unrelated to re-login report `failed_provider`.

Selection: `--provider` accepts `openai-api-key`, `xai-api-key`, `compatible`, `codex`, `grok`, `all`, or a comma-separated subset. Use `--model provider=model-id` to override a selected lane (repeat for more than one). By default the built-in model IDs are used; choose tool-capable models. `--timeout-ms N` controls each lane (default 30000, max 120000); exactly two model rounds, 256 requested output tokens per round, a 4096-character budget over streamed text, assembled messages/tool-call arguments and tool results, a cumulative 256 KiB inference HTTP response-body limit across requests/retries/ordinary subscription refresh before selected adapters parse streams, and Schway's bounded transient retry policy constrain usage. Select **only** providers you intend to contact; a multi-provider invocation runs them sequentially. The installed command has a per-lane deadline including worker startup, followed by a 1500 ms SIGKILL/reap/check **window** for its dedicated POSIX process group; polling, scheduler and filesystem cleanup can add overhead beyond this window. Even if an adapter ignores abort, no later lane launches after a timeout (`prior_run_timeout`). If an output-limit abort leaves a worker unsettled, its framed result is received before exit; after a proven process-group kill and workspace removal it remains `failed_provider` / `output_limit`, never a fabricated timeout. If a worker claims success but leaves a descendant, the supervisor kills the group and reports `failed_runner` / `process_group_leak`, not pass. If stop cannot be certified, it reports `failed_runner` / `process_stop_unverified`, retains the workspace (`cleanup: deferred`) and marks later lanes `prior_run_unsettled`; do not delete that directory until checking for outstanding processes. On Windows the command does **not** launch live workers: it reports `pending` / `supervision_unavailable` because Bun's direct-child kill cannot certify descendants without an OS Job Object. POSIX process-group supervision cannot certify deliberately detached processes escaping that group or a machine failure; do not use executable extensions or external tools in smoke tasks. A streamed tool call may grow before the loop emits a complete message, but the smoke-only fetch wrapper rejects response bytes before adapter SSE parsers consume more than the cumulative ceiling; the assembled-message check still rejects oversized calls before execution. This bounds bytes *delivered to adapters*, not total process memory (a single oversized upstream chunk may be allocated by fetch before the wrapper checks it). Credentials stay in the worker environment/secure store, never subprocess argv, stdin, stdout/stderr, or JSON reports; private stdin carries only selected settings (max 8 KiB), stdout is capped at 8 KiB and raw stderr is discarded. The separately exported `runLiveSmoke` is an **in-process test/programmatic seam**, not a hard-stop API: injected scripted models can bypass the production fetch wrapper, and an uncooperative stream may retain its workspace until settlement. Use the installed CLI for OS-supervised execution.

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

## Reasoning effort evaluation

This operator procedure decides whether Schway may send its own reasoning default
for `grok-4.x` (see [Schway model defaults](configuration.md#schway-model-defaults)).
It is a **paid/remote opt-in**: never a default `bun test` case, CI job or eval, and
it runs only when an operator chooses to. It reads `reasoningTokens` and
`outputTokens` from the `ModelUsage` contract.

```sh
# Plan only: prints a skipped report, opens no credential store and sends nothing.
bun --no-env-file src/live/reasoning-eval.ts --route grok
# Grok subscription (sign in first with /login grok):
bun --no-env-file src/live/reasoning-eval.ts --enable-live --route grok --model grok-4.7
# xAI API key, only if a default would also cover that route (save the key first with /login xai):
bun --no-env-file src/live/reasoning-eval.ts --enable-live --route xai-api-key --model grok-4.7
```

- **Opt-in and credentials.** Nothing is read or sent without `--enable-live`.
  The runner uses only stored credentials: the saved `grok-subscription:xai`
  login or the stored `api-key:xai` key. It ignores `XAI_API_KEY` and other
  environment keys, never starts a sign-in and never switches routes. A missing
  login reports `pending/missing_subscription`; a missing key reports
  `skipped/missing_credentials`.
- **Arms.** The same fixed short question (`REASONING_EVAL_PROBE`) goes to the
  model with thinking unset (no `reasoning` field), at `low` and at `medium`
  (`--levels` changes the explicit levels). Each arm runs at least three times
  (`--runs`, 3–10), interleaved per run so drift affects every arm alike. An
  explicit level first reads the route's model list, as production does, and a
  level the list does not offer is refused before inference
  (`unsupported_thinking`).
- **Bounds.** Every call sends `max_output_tokens` (`--max-output-tokens`,
  default 16384, 1024–65536). The cap counts reasoning tokens, so keep it high
  enough that reasoning is not cut off. A response that ends `incomplete` at the
  cap is reported but is not evidence. Each call has its own deadline
  (`--timeout-ms`, default 120000) and a 2 MiB response-body budget; model-list
  reads keep the 1 MiB discovery budget. Redirects are refused. No retries run.
- **Report.** JSON on stdout with UTC `testedAt`, checked-out `revision`,
  `route`, `model`, `maxOutputTokens` and `runs`. For each call it gives the
  arm, run, status or error class (`ok`, `incomplete`, `http_error`,
  `network_error`, `timeout`, `output_limit`, `error`, `unsupported_thinking`,
  `thinking_capability_unavailable`), the last HTTP status, `reasoningTokens`,
  `outputTokens`, time to the first text or thinking delta and total time. Each
  arm adds medians over its `ok` calls. It never includes a token, header,
  endpoint, the question, the answer, reasoning text or a raw response.
- **Verdict.** Each level's `meetsDefaultBar` is true only when no call for it got
  a 4xx or was refused, both it and the unset arm have at least three `ok`
  calls, and its median reasoning tokens and median total time are both lower
  than unset. Exit code 0 means every call produced evidence, 2 means skipped or
  incomplete, 1 a failure or usage error.

Preserve the JSON with its date, revision, model and route. A PR that adopts a
default records that JSON and the decision, here and in
[configuration](configuration.md#schway-model-defaults), for every route the
default covers. `bun test tests/reasoning-eval.test.ts` checks the runner with
protocol fixtures only; that is not live evidence.

**Recorded runs: none.** No operator has run this evaluation, so no default ships.

## Prompt cache probe

This operator procedure measures whether the
[prompt cache key](configuration.md#prompt-cache-key) produces cache hits on an
xAI route. It is a **paid/remote opt-in**: never a default `bun test` case, CI
job or eval, and it runs only when an operator chooses to. It reads
`inputTokens` and `cachedInputTokens` from the `ModelUsage` contract. The
ChatGPT subscription route sends no key, so the probe does not cover it. The
live smoke's `xai-api-key` and `grok` lanes send the key on both rounds, as
production does, so a passing lane also shows the route accepts the field.

```sh
# Plan only: prints a skipped report, opens no credential store and sends nothing.
bun --no-env-file src/live/prompt-cache-probe.ts --route grok
# Grok subscription (sign in first with /login grok):
bun --no-env-file src/live/prompt-cache-probe.ts --enable-live --route grok --model grok-4.7
# xAI API key (save the key first with /login xai):
bun --no-env-file src/live/prompt-cache-probe.ts --enable-live --route xai-api-key --model grok-4.7
```

- **Opt-in and credentials.** Nothing is read or sent without `--enable-live`.
  The probe uses only stored credentials: the saved `grok-subscription:xai`
  login or the stored `api-key:xai` key. It ignores `XAI_API_KEY` and other
  environment keys, never starts a sign-in and never switches routes. A missing
  login reports `pending/missing_subscription`; a missing key reports
  `skipped/missing_credentials`.
- **Turns.** Each arm is two turns of one probe conversation. Turn 1 sends a
  fixed reference text of about 20k tokens and asks for one word. Turn 2 resends
  turn 1, a fixed one-word reply and one more short question, so its prompt
  extends turn 1 exactly. A fresh random line leads each arm's system prompt, so
  no arm or run can reuse another one's cached prefix.
- **Arms (A/B).** The `key` arm sends one derived key (`schway-v1-…`) on both
  turns, exactly as a conversation would. The `no-key` arm sends none. The arm
  is chosen inside the probe only; no setting, config key or flag turns the key
  off for normal use. Each run does both arms, and the arm that goes first
  alternates between runs (`--runs`, 1–5, default 1).
- **Bounds.** Every call sends `max_output_tokens` (`--max-output-tokens`,
  default 4096, 1024–65536); the cap counts reasoning tokens. Each call has its
  own deadline (`--timeout-ms`, default 120000) and a 2 MiB response-body
  budget. Thinking stays unset, so no model list is read. Redirects are refused.
  No retries run.
- **Report.** JSON on stdout with UTC `testedAt`, checked-out `revision`,
  `route`, `model`, `maxOutputTokens` and `runs`. For each call it gives the
  arm, run, turn, status or error class (`ok`, `incomplete`, `http_error`,
  `network_error`, `timeout`, `output_limit`, `error`), the last HTTP status,
  `inputTokens`, `cachedInputTokens`, `outputTokens`, time to the first text or
  thinking delta and total time. It never includes a token, header, endpoint,
  the key, the prompt, the answer or a raw response.
- **Verdict.** A turn 2 counts as a cache hit when it reports
  `cachedInputTokens > 0`. `summary.keyTurn2Hits` and `summary.noKeyTurn2Hits`
  count hits per arm, and `summary.cacheHit` is true when any keyed turn 2 hit.
  A 4xx status on every `key` call but none on `no-key` calls means the
  route rejects the field: record it, and turn the key off for that route.
  Exit code 0 means every call completed, 2 means skipped or incomplete, 1 a
  failure or usage error.

Preserve the JSON with its date, revision, model and route, and record it in the
PR that relies on it. `bun test tests/prompt-cache-probe.test.ts` checks the
probe with protocol fixtures only; that is not live evidence.

**Recorded runs: none.** No operator has run this probe. The key ships on both
xAI routes because xAI documents `prompt_cache_key` for its Responses API, not
because of a probe result.

## Hosted web search check

This operator procedure decides whether an xAI route may receive hosted
[web search](configuration.md#web-search) and whether it accepts the hosted
items Schway replays. It is a **paid/remote opt-in**: never a default
`bun test` case, CI job or eval, and it runs only when an operator chooses to.
Run it for the Grok subscription route, and for the xAI API-key route when a
key is available. It reads `hostedSearchCalls`, `reportedHostedSearchCalls`,
`inputTokens` and `outputTokens` from the `ModelUsage` contract.

```sh
# Plan only: prints a skipped report, reads no credential and sends nothing.
bun --no-env-file src/live/web-search-probe.ts --route grok
# Grok subscription (sign in first with /login grok):
bun --no-env-file src/live/web-search-probe.ts --enable-live --route grok --model grok-4.7
# xAI API key, from the environment only (export it deliberately, not in argv):
bun --no-env-file src/live/web-search-probe.ts --enable-live --route xai-api-key --model grok-4.7
```

- **Opt-in and credentials.** Nothing is read or sent without `--enable-live`.
  Each lane uses its existing credential source only: the saved
  `grok-subscription:xai` login for `grok`, and `XAI_API_KEY` in the
  environment for `xai-api-key`. No credential is accepted in argv, and none
  appears in the output. The check never starts a sign-in and never switches
  routes. A missing login reports `pending/missing_subscription`; a missing
  `XAI_API_KEY` reports `skipped/missing_credentials`.
- **Calls.** One turn asks a question that needs current web facts, with hosted
  web search enabled. Two follow-ups then resend that turn: one replays its
  hosted items in their original positions, and one leaves them out, as the
  per-route omit switch would. All three send `{"type": "web_search"}`.
- **Bounds.** Every call sends `max_output_tokens` (`--max-output-tokens`,
  default 4096, 1024–65536); the cap counts reasoning. Each call has its own
  deadline (`--timeout-ms`, default 120000) and a 2 MiB response-body budget.
  Thinking stays unset, so no model list is read. Redirects are refused. No
  retries run.
- **Report.** JSON on stdout with UTC `testedAt`, checked-out `revision`,
  `route`, `model` and `maxOutputTokens`. For each call it gives the phase
  (`search`, `replay-with-hosted`, `replay-without-hosted`), status or error
  class (`ok`, `incomplete`, `http_error`, `network_error`, `timeout`,
  `output_limit`, `error`), the last HTTP status, the hosted items kept from the
  response and replayed in the request, `hostedSearchCalls`,
  `reportedHostedSearchCalls`, `inputTokens`, `outputTokens`, time to the first
  text or thinking delta and total time. It never includes a token, header,
  endpoint, the question, a search query, a source URL, the answer or a raw
  response.
- **Verdict.** `summary` gives `firstAccepted`, `hostedItems`,
  `replayWithHostedAccepted`, `replayWithoutHostedAccepted` and a `verdict`:
  `pass` (search accepted, hosted items returned, replay accepted),
  `replay_rejected` (a 4xx on the replay with hosted items, while the follow-up
  without them passed), `unsupported` (a 4xx on the search request),
  `no_search` (accepted, but no hosted item came back) or `inconclusive`.
  Exit code 0 means every call completed, 2 means skipped or incomplete, 1 a
  failure or usage error.

Preserve the JSON with its date, revision, model and route, and record it in
the PR that changes the allowlist (`HOSTED_TOOL_ALLOWLIST` in
`src/model/hosted-tools.ts`) and in the table below. A `pass` admits the route
and model. `replay_rejected` admits it with that route's
`XAI_HOSTED_ITEM_REPLAY` switch turned off. `unsupported` is recorded here as
unsupported. `bun test tests/web-search-probe.test.ts` checks the procedure with
protocol fixtures only; that is not live evidence.

| Route | Model | Status | Evidence |
| --- | --- | --- | --- |
| xAI API key | `grok-4.7` | **Allowed from documentation; live check not run** | xAI documents hosted web search on `/v1/responses` with `grok-4.7` ([web search](https://docs.x.ai/developers/tools/web-search), read 2026-10-08) and resending earlier output items for stateless conversations ([advanced usage](https://docs.x.ai/docs/guides/tools/advanced-usage)). Replay is on. |
| Grok subscription | `grok-4.7` | **Off; live check not run** | No official xAI page covers server-side tools with a subscription login. |

**Recorded runs: none.** No operator has run this check.

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
endpoint-scoped reasoning catalog. Discovery has a separate cumulative 1 MiB response budget, matching the
production catalog readers. It shares redirect rejection and the whole-lane deadline with inference and
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
