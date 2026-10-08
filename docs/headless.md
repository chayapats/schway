# Headless usage

Choose credentials, an auth route and an exact model ID before running a task.
Interactive sign-in saves credentials, but the TUI's remembered workspace model
choice is intentionally ignored here. `--resume` restores conversation and
workspace history; it does not restore old credentials or billing settings.

The examples below use **POSIX shell syntax** (`sh`, Bash or Zsh), not PowerShell
or Windows Command Prompt. Run them from your project directory. Each `read`
waits for you to paste the requested exact ID and press Enter. Model IDs vary by
account and endpoint: choose a returned ID yourself; do not type `$MODEL_ID`,
`<id>` or an example name as if it were a catalog result.

## Choose your route, run, and resume

Complete the credential prerequisite for **one** route. Online listing can
refresh that route's saved subscription token, but never runs inference or
switches billing when a request fails. A successful listing does not prove that
inference is available. See [model discovery](#discover-model-ids) for partial,
error and offline results; offline entries are unverified built-in data.

### OpenAI API key

In interactive Schway, use `/login openai` to save an OpenAI Platform API key,
then return to your shell. An explicitly supplied `OPENAI_API_KEY` also works;
keys do not belong in config files. These commands select usage-billed API access,
even if a ChatGPT subscription is also saved.

<!-- headless-flow:openai-api -->
```sh
schway models list --provider openai --openai-auth api-key
# Paste an exact ID from the list, then press Enter.
IFS= read -r MODEL_ID
schway -p "Explain this project" --provider openai --openai-auth api-key --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
# Paste the ID from the Session hint (or the matching saved-work row).
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

### Existing ChatGPT/Codex subscription

First sign into **Schway** interactively with `/login chatgpt` or
`/login chatgpt --device`, then return to your shell. Schway does not read another
CLI's login cache. These commands use only the stored subscription, even when
`OPENAI_API_KEY` is set. Missing or rejected subscription access needs sign-in or
an explicit route change; there is no automatic API-key billing fallback.

<!-- headless-flow:codex -->
```sh
schway models list --provider openai --openai-auth chatgpt
IFS= read -r MODEL_ID
schway -p "Explain this project" --provider openai --openai-auth chatgpt --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --provider openai --openai-auth chatgpt --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

### xAI API key

Save an xAI API key through interactive `/login xai`, or explicitly supply
`XAI_API_KEY`, then return to your shell. Native xAI never uses `OPENAI_API_KEY`.
The API-key route below ignores a saved Grok subscription.

<!-- headless-flow:xai-api -->
```sh
schway models list --provider xai --xai-auth api-key
IFS= read -r MODEL_ID
schway -p "Explain this project" --provider xai --xai-auth api-key --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --provider xai --xai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

### Existing Grok subscription

First use interactive `/login grok` or `/login grok --device` in Schway. Your plan
must permit this access. The explicit `grok` route below uses only that login,
even when an xAI API key is available. A plan-level rejection does not switch to
API billing; choose that route yourself if desired.

<!-- headless-flow:grok -->
```sh
schway models list --provider xai --xai-auth grok
IFS= read -r MODEL_ID
schway -p "Explain this project" --provider xai --xai-auth grok --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --provider xai --xai-auth grok --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

### Compatible endpoint or profile

Start your compatible server first; Schway does not install or start it. The
example assumes its API is at `http://127.0.0.1:11434/v1` and requires a key.
Merge this profile into `~/.schway/config.json` (preserving existing settings),
and supply the server's key through `LOCAL_MODEL_KEY` or the profile's secure-store
login. Use `auth: "none"` instead only when your server intentionally needs no key.
Native OpenAI credentials are never reused for a compatible endpoint.

<!-- headless-config:compatible -->
```json
{
  "profiles": {
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "auth": "required",
      "credentialEnv": "LOCAL_MODEL_KEY"
    }
  }
}
```

<!-- headless-flow:compatible -->
```sh
schway models list --profile local
IFS= read -r MODEL_ID
schway -p "Explain this project" --profile local --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --profile local --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

Without a profile, replace **each** `--profile local` above with
`--provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth required`
and provide that endpoint's key through `OPENAI_COMPATIBLE_API_KEY` or its own
secure-store login. Retain the chosen `--model "$MODEL_ID"` on task and resume
commands. See [profiles](configuration.md#named-openai-compatible-profiles) and
[credential identities](credentials.md).

### Use explicit saved settings

A flag-light task is also valid when its required settings are saved. For
example, after the OpenAI API-key discovery above, replace the marked model value
with your chosen exact ID and merge these settings into `~/.schway/config.json`:

<!-- headless-config:saved -->
```json
{
  "provider": "openai",
  "openaiAuth": "api-key",
  "model": "<replace with your chosen exact ID>"
}
```

The following commands require that saved config and the API-key credential
prepared above. The model value in the JSON example is a placeholder, not a
usable model ID.

<!-- headless-flow:saved -->
```sh
schway models list
schway -p "Explain this project" --approval read-only --show-session
schway sessions list
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --resume="$SESSION_ID" --approval read-only --show-session
```

Project settings override user settings; explicit CLI flags override both.
A selected profile supplies its endpoint and model defaults, while an explicit
`--model` overrides its model. Saved credentials and remembered TUI choices are
separate from these config layers. Review [configuration precedence](configuration.md)
and [credential selection](credentials.md) when changing routes.

## Output and session IDs

Default text mode writes model text to stdout and diagnostics to stderr.
`--show-session` adds one stderr line once a persisted task session is ready:
`Session <exact-id> · Resume with --resume <exact-id>`. It works for new and resumed
tasks. Later model/tool failure or cancellation does not remove that hint;
a setup failure before readiness, an unpersisted session or a `/skills` listing
prints none. If the exact ID contains an already-observed credential, the hint
is suppressed rather than redacted into an unusable ID. IDs with terminal/format
controls or line/paragraph separators also produce no text hint. For unquoted
resume guidance, the hint accepts only Unicode letters, marks, numbers,
pictographic emoji and `._-`, with no leading `-`. Other exact IDs remain
available through the JSONL workflow below; they are never rewritten into shell
syntax. The hint contains no prompt, file path or auth settings. Default text
streams are unchanged without the flag. It is rejected without `-p`, with
`--json`, or on doctor/version/list
commands; use it only for text tasks.

`--json` already emits runtime events as **JSONL** on stdout, including
`session.ready` with `sessionId` at the same safe persisted boundary. Its format
and timing are unchanged; do not add `--show-session`. Errors/retries remain on
stderr. Capture the complete stream before extracting its exact ID, so a short
pipeline does not close a running task's stdout early. With the OpenAI API-key
route and `MODEL_ID` chosen above:

<!-- headless-flow:jsonl -->
```sh
schway -p "Explain this project" --provider openai --openai-auth api-key --model "$MODEL_ID" --json > task.jsonl
SESSION_ID=$(bun -e 'const rows = (await Bun.file("task.jsonl").text()).split("\n").filter(Boolean).map(JSON.parse); const ready = rows.find(row => row.type === "session.ready"); if (!ready || typeof ready.sessionId !== "string" || !ready.sessionId) process.exit(1); process.stdout.write(ready.sessionId + ".");') &&
SESSION_ID=${SESSION_ID%.} &&
schway -p "Continue this explanation" --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only
```

The temporary final dot preserves trailing newlines during shell capture and is
then removed exactly once. Quoted `--resume="$SESSION_ID"` preserves the argument,
including a leading `-`. The `&&` chain stops before resume if extraction fails;
do not substitute a guessed ID. `models list --json` and `sessions list --json` each emit one versioned JSON
object, unlike task JSONL. Runtime events also differ from durable session JSONL.
See [saved sessions and branches](sessions.md).

## Task input and recovery

Pass a nonempty task with `-p`. Empty or whitespace-only tasks exit 1 before
reading setup or changing saved work. Valid tasks retain leading/trailing
whitespace and multiline text. Stdin is not implicitly a task. Explicit tasks
work with terminal or redirected input/output; without `-p`, both stdin and
stdout must be terminals. Help, version, doctor and list commands need no TTY.

If a task reports no configured model, run the intended route's `models list`,
choose an exact ID and retry with that route and `--model`. For local diagnosis
of the OpenAI API-key example above, use
`schway doctor --provider openai --openai-auth api-key --model "$MODEL_ID"`.
Doctor checks local setup; it does not contact a model or prove live access.
See [doctor](doctor.md) for other routes and exit meanings.

`--approval read-only` refuses tools that change files or run commands.
Headless `ask` denies mutations immediately with
`approval required; headless cannot ask`; it never waits for input. A tool denial
alone need not make the task exit nonzero. Use `--approval auto` only when those
tool actions are intended.

Neither mode is offline. Read-only tools, including `web_fetch`, still run, and a
fetch sends its URL to a remote host, so the model can put workspace content into
a URL without approval. See [Fetch web pages](tools.md#fetch-web-pages).

`--max-turns` bounds agent rounds (default 32); `--max-concurrent-tools` caps
parallel-safe tools (default 10). Unknown exact model IDs remain accepted by
`--model` even when absent from a catalog, using conservative budgets of 32768
context tokens and 16384 output tokens; known models supply richer metadata.
Override these with `--context-window` and `--max-output` when needed.

Compatible endpoints use Chat Completions. `--header Name:Value` is repeatable,
`--body` adds JSON request fields, and `--auth` is `required`, `optional` (default)
or `none`. Runtime `--api-key` wins over environment values (including explicit
`--env-file` overlays), then the selected secure-store credential. Project `.env`
files are not loaded automatically. Headless mode never opens a login prompt.

SIGINT/SIGTERM requests cancellation through model streaming, tools and provider
requests. Transient network/429/5xx failures retry up to three attempts;
authentication errors and ordinary tool failures do not. Each retry writes one
stderr line naming its cause and the upcoming attempt, such as
`Provider unavailable · Attempt 2/3 in 3s · Ctrl+C stop`, followed by the redacted
provider message. In `--json` output the `model.retry` event keeps `attempt` (the
failed attempt), `maxAttempts`, `delayMs` and `message`, and adds `cause`:
`rate-limit` for HTTP 429, `provider` for HTTP 5xx or `offline` for a network
failure with no HTTP status. These match the `error` event's `category` names. Failed/cancelled
streams are not committed assistant answers. A hint confirms persisted session
readiness, not that tools were rolled back or the turn succeeded.

`--debug` or `--debug-file ./schway-debug.jsonl` opts into local diagnostics on a
separate file; it never adds stdout or session records. See [diagnostics](diagnostics.md).
From a source checkout with dependencies installed, use `bun run dev --` instead
of `schway`, keeping the full route/model/task flags from the chosen flow.

## Browse saved work

```bash
schway sessions list
schway sessions list --workspace ../project --limit 10 --offset 20
schway sessions list --all --preview --json
# With MODEL_ID and SESSION_ID chosen in the OpenAI API-key flow above:
schway --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" -p "Continue this work"
schway --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --branch "$BRANCH_ID" -p "Continue this branch"
```

For `--branch`, first copy the exact conversation branch ID shown by interactive
`/branch list` into `BRANCH_ID`; it is not a Git branch. Omit `--branch` to use the
saved active branch. Explicit resume validates and restores that history.

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
schway models list --provider openai --openai-auth chatgpt
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
`--openai-auth chatgpt|api-key` and `--xai-auth grok|api-key` use only that identity;
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
- Interactive: press Esc to stop the running turn and return to the input editor; Ctrl+C cancels when running and quits when idle. Quitting restores the terminal and releases resources.
- Provider retries cover transient failures only (network resets, 429, 5xx) up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried.
