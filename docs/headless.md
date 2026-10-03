# Headless usage

Schway owns its agent loop, model abstraction, session format, tool execution,
and context assembly. It does not depend on an orchestration framework.

Choose a model with `--model "<id>"`, or save it in
[configuration](configuration.md#configuration-files), before running a task.
Use `--provider` to override the default OpenAI provider. Replace `<id>` with a model available to your account or endpoint. Commands
without those flags use your saved configuration. Headless mode ignores the TUI's
remembered workspace model choice.

## Run a task

Pass a nonempty task with `-p`. Empty or whitespace-only tasks exit 1 before
reading setup or changing saved work. Valid tasks keep their leading and trailing
whitespace, including multiline text. Stdin is not implicitly used as a task.

Explicit tasks work with terminal or redirected input and output. Without `-p`,
both stdin and stdout must be terminals; stderr may be redirected. Help, version,
doctor, session listing and model listing do not need a terminal. Embedded `runCli` callers may provide
`terminal: { stdin: true, stdout: true }` for an interactive renderer; omitted
capabilities default to false. The executable reads the actual stdin/stdout
terminal capabilities.

```bash
export OPENAI_API_KEY=...
schway -p "explain this repository"
schway -p "explain this repository" --json
schway -p "continue this work" --resume <session-id>
schway -p "continue the alternate path" --resume <session-id> --branch <branch-id>

schway -p "explain this repository" --provider openai
schway -p "explain this repository" --provider openai --model "<id>"

export XAI_API_KEY=...
schway -p "explain this repository" --provider xai --model "<id>"

schway -p "explain this repository" --provider openai-compatible \
  --base-url http://127.0.0.1:11434/v1 --model "<id>"
schway -p "explain this repository" --provider openai-compatible \
  --base-url http://127.0.0.1:8080/v1 --auth required --api-key sk-local
```

`--json` streams normalized runtime events as JSONL on stdout. Errors/retries still appear on stderr. Opt in to local structured diagnostics with `--debug` or `--debug-file ./schway-debug.jsonl` (implies `--debug`); log writes never enter stdout or durable sessions. See [local diagnostics](diagnostics.md) for redaction and retention defaults.

`--provider` selects `openai` (default), `xai`, or `openai-compatible`. `--model` is passed through even if it is not in a catalog. xAI uses `XAI_API_KEY` or `--api-key`, never `OPENAI_API_KEY`, and does not invent a model when `--model` is omitted. See [xAI API key](configuration.md#xai-api-key). Unknown IDs use conservative defaults of a 32768-token context window and 16384 maximum output tokens; known catalog models supply richer context-window metadata. Override either limit with `--context-window`, `--max-output`, or the same keys in config.

OpenAI-compatible endpoints use Schway's own Chat Completions fetch/SSE adapter. `--base-url` is required. `--header Name:Value` may be repeated, `--body` is a JSON object of extra request fields, and `--auth` is `required`, `optional` (default), or `none`. Compatible mode does not read `OPENAI_API_KEY`. Select named endpoint profiles with `--profile <name>` or `/config set profile <name>`;
see [profiles](configuration.md#named-openai-compatible-profiles).

Runtime credentials (`--api-key`) take precedence over environment variables, including keys loaded with `--env-file`, followed by the OS secure store. Project `.env` files are not loaded automatically. Headless mode never opens a login prompt. Interactive `/login <provider>` and `/logout <provider>` manage credentials; `--openai-auth codex` selects a stored ChatGPT subscription without silent API-key fallback. API keys must not be stored in `config.json`. See [credentials](credentials.md) and [subscription setup](configuration.md#chatgpt-subscription-codex-oauth).

`--max-turns` bounds agent rounds (default 32). `--max-concurrent-tools` caps overlapping parallel-safe tools (default 10).

Headless runs share one `AbortSignal` from the CLI (SIGINT/SIGTERM) through model streaming, tools, and provider requests. Transient provider failures (network resets, 429, 5xx) retry up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried. Cancelled or failed streams are not written as durable assistant messages; a cancelled run still leaves a resumable session.

From a source checkout with dependencies installed, run:

```bash
bun run dev -- -p "hello"
```

## Browse saved work

```bash
schway sessions list
schway sessions list --workspace ../project --limit 10 --offset 20
schway sessions list --all --preview --json
schway --resume <session-id> -p "continue this work"
```

Listing uses process `HOME` and defaults to the launch directory's canonical
primary workspace. `--all` includes other and unknown workspaces; it conflicts
with `--workspace`. Limit defaults to 20 (1–100); offset defaults to 0.
Use `schway sessions --help` for options. Starting or resuming a task still needs
your configured model and route.

This command reads saved work without loading configuration, environment files,
provider credentials or the TUI. It does not resume, repair, recover drafts,
prune, delete or change saved files. Default output contains exact session IDs,
time, workspace and observed state. `--preview` opts into a short task excerpt;
draft text and tool payloads are never shown. Recognized credential patterns are
suppressed and known environment secrets are masked, including trimmed values.
Excerpts may still contain user-sensitive content; arbitrary secrets are not
detected. Sensitive IDs are omitted with a partial warning rather than changed
into an unusable resume token. Sensitive workspace paths are also omitted.

Session listing's `--json` emits one versioned inventory object, not runtime
JSONL events. It includes `scope`, `limit`, `offset`, `hasMore`, inventory
`status`, `sessions` and `warnings`; preview keys appear only when requested and
safe to show. Exit 0 means the captured inventory completed, 1 means an
operational failure, cancellation or incomplete inventory, and 2 means invalid
arguments (stdout stays empty). Diagnostics use stderr. A corrupt or unsupported
history remains a discoverable row and does not itself fail the command.

Each history receives at most 64 KiB of transcript inspection and bounded
metadata reads. A `partial` row with `previewIncomplete: true` does not imply
corruption or full validation; explicit resume validates the complete history.
The captured rows are sorted by valid activity/creation time, then exact ID,
before filtering and pagination. Concurrent changes can move offset pages
between invocations. See [session discovery](sessions.md) for saved-work states.

## Discover model IDs

```bash
schway models list
schway models list --provider openai --openai-auth codex
schway models list --provider xai --xai-auth api-key --filter grok
schway models list --profile local --json
schway models list --offline --json
```

Model listing resolves one connection without requiring a configured model or
sending a prompt. It reads normal user/project configuration and explicit CLI
connection options, including profiles, base URL, auth selectors, runtime keys,
headers and `--env-file`. Project settings come from the canonical primary
workspace; process `HOME` anchors user settings even if an explicit env file sets
another `HOME`. Env files load only when requested, with later files taking
precedence. A selected profile uses its own endpoint and credential identity.
Valid execution-only settings such as model and thinking do not limit discovery;
malformed configuration still reports its source and repair guidance.

Online listing makes the selected route's catalog request. Explicit
`--openai-auth codex|api-key` and `--xai-auth grok|api-key` use only that identity;
`auto` uses the existing credential precedence. A selected subscription may
refresh its token. One five-second remote-operation deadline covers route
credential reads, token refresh, catalog request and response-body consumption.
Failure never switches billing routes or substitutes a built-in result.

`--offline` reads local settings and explicit env files, without credential-store
access, refresh or network. An explicit route is labelled with built-in metadata
and unverified account access. Auto remains `route: "unresolved"`. Arbitrary
compatible endpoints without a local catalog return an explained empty list.

Rows contain exact, sorted, deduplicated IDs and only known capability metadata.
`--filter <text>` matches a literal, case-insensitive ID substring. No matches is
a complete result with guidance to clear the filter; an empty filter argument is
invalid. Listed IDs do not guarantee live access. Unknown IDs remain accepted by
`schway -p "<task>" --model <id>`.

`--json` emits one object, distinct from task JSONL:

```text
{schemaVersion:1, provider, route, profile?, source, status, models, warnings}
```

`provider` names `openai`, `xai` or `openai-compatible`; it is `null` only for an
error before provider resolution. `route` is `api-key`, `codex`, `grok`,
`compatible` or `unresolved`. `source` is `remote` or `builtin`; `status` is
`complete`, `partial` or `error`. The optional `profile` identifies the resolved
compatible profile when safe to show. Each model has `id`; optional
`contextWindow`, `maxOutput`, `supportedThinking` and `recommended` fields appear
only when known. Warnings explain incomplete or unverified results. Credential
values, endpoint headers and raw provider payloads are never output.

Exit **0** means complete, including offline results and filters with no matches;
**1** means partial, operational failure or cancellation; **2** means invalid arguments.
Usage errors leave stdout empty. Operational JSON output remains one parseable
object, with `models: []` when no usable data exists; diagnostics go to stderr.
Use `schway models list --help` for options. Task, resume, approval, debug, body
and limit options are rejected before setup or network.

Model listing does not create sessions, run tools, read TUI memory, open sign-in
or write configuration, drafts or other application state. The selected
subscription's required token refresh is its only permitted credential write.

## Cancellation

Cancellation is orderly and never corrupts session state.

- Headless: one `AbortSignal` flows from SIGINT/SIGTERM through model streaming, tools, and provider requests. Cancelling exits non-zero and still leaves a resumable session; cancelled streams are not written as durable assistant messages.
- Interactive: Esc cancels the running turn and returns to the input editor; Ctrl+C cancels when running and quits when idle. Quitting restores the terminal and releases resources.
- Provider retries cover transient failures only (network resets, 429, 5xx) up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried.
