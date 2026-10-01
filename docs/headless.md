# Headless usage

Schway owns its agent loop, model abstraction, session format, tool execution,
and context assembly. It does not depend on an orchestration framework.

Choose a model with `--model "<id>"`, or save it in
[configuration](configuration.md#configuration-files), before running a task.
Use `--provider` to override the default OpenAI provider. Replace `<id>` with a model available to your account or endpoint. Commands
without those flags use your saved configuration. Headless mode ignores the TUI's
remembered workspace model choice.

## Run a task

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

## Cancellation

Cancellation is orderly and never corrupts session state.

- Headless: one `AbortSignal` flows from SIGINT/SIGTERM through model streaming, tools, and provider requests. Cancelling exits non-zero and still leaves a resumable session; cancelled streams are not written as durable assistant messages.
- Interactive: Esc cancels the running turn and returns to the input editor; Ctrl+C cancels when running and quits when idle. Quitting restores the terminal and releases resources.
- Provider retries cover transient failures only (network resets, 429, 5xx) up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried.
