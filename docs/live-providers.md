# Opt-in live provider smoke checks

This is a **paid/remote opt-in**, not a default Bun test, CI job, or capability eval. Run from the revision you want to test. Each selected provider gets a separate temporary workspace containing a random sentinel; Schway's real streaming loop must call its `read` tool and return **exactly** the value read. No session is persisted. The workspace is removed after the scenario. The exposed read tool rejects any path except the relative sentinel name (including absolute paths). No extensions, interactive login, other filesystem tools or TUI are loaded.

```sh
# One API-key lane. Explicitly opt in before any credential lookup or network call.
ANTHROPIC_API_KEY=... bun run live-smoke --enable-live --provider anthropic
# Other lanes (select exactly the lanes you intend to bill):
bun run live-smoke --enable-live --provider openai-api-key
bun run live-smoke --enable-live --provider compatible --base-url https://example.org/v1 --auth required
bun run live-smoke --enable-live --provider codex
# All four only with express operator consent:
bun run live-smoke --enable-live --provider all --base-url https://example.org/v1
# Inspect selection/report shape without looking up credentials or calling providers:
bun run live-smoke --provider all
```

Prerequisites: Bun; for Anthropic `ANTHROPIC_API_KEY` or the Schway OS secure-store Anthropic identity; for native OpenAI `OPENAI_API_KEY` or its own secure-store API-key identity; for compatible an explicit HTTP(S) `--base-url` plus `OPENAI_COMPATIBLE_API_KEY` or endpoint-scoped secure-store key. `--auth none` explicitly permits a no-key compatible endpoint; this is not the default. `--credential-env NAME`, `--profile NAME`, and `--credential-identity NAME` select the same compatible credential scopes as production. These only apply with `--provider compatible`. Avoid putting keys in arguments, URLs, profiles, or model IDs. The runner does not read `.env` files (`--no-env-file`); export environment values deliberately, or use OS secure storage. Do not put credentials in shell history.

For ChatGPT subscription, sign in **separately** in interactive Schway with `/login codex` (or `/login codex --device` on headless machines) first; the runner uses the same Schway secure-store identity and store-backed automatic token refresh as production. It never opens a browser, requests a device code or silently switches subscription to API-key billing. Expired/revoked sessions needing interaction report `pending` with `subscription_requires_login`. Refresh failures unrelated to re-login report `failed_provider`.

Selection: `--provider` accepts `anthropic`, `openai-api-key`, `compatible`, `codex`, `all`, or a comma-separated subset. Use `--model provider=model-id` to override a selected lane (repeat for more than one). By default the built-in model IDs are used; choose tool-capable models. `--timeout-ms N` controls each lane (default 30000, max 120000); exactly two model rounds, 256 requested output tokens per round, 4096 streamed output characters, and Schway's bounded transient retry policy constrain usage. Select **only** providers you intend to contact; a multi-provider invocation runs them sequentially. An unreachable/non-cooperative transport may not settle immediately after cancellation; no generic hard kill is available for a single in-process streaming request.

Report: JSON on stdout with UTC `testedAt`, checked-out Git `revision` (or `unknown` outside a Git checkout), per-lane `provider`, actual `model`, auth source **category** (`env`, `stored`, `stored-subscription`, `none`), duration milliseconds, `toolRoundTrip`, status and fixed reason code. It never includes a key, raw provider response, endpoint, sentinel, tool output or temp path. Preserve the JSON **with its date/revision/model selection** for live evidence. `passed` means the actual read result was returned verbatim in the final response; `failed_provider` covers transport/timeout/turn limit/tool-protocol failure; `failed_runner` covers setup/cleanup failure or pre-stream timeout; `skipped` covers unavailable key/disabled opt-in; `pending` covers unavailable subscription/integration or user cancellation. Aggregate is `passed` (exit 0) only if **all selected** lanes pass; `incomplete` (exit 2) for any skip/pending without failure; `failed` (exit 1) for any failure, including CLI usage errors. Missing credentials are never passed. A fixture result is not live evidence. No paid live run has been performed as part of deterministic tests.
