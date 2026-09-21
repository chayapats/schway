# Schway

A lean, light, fast, and hackable coding-agent harness.

Schway owns its agent loop, model abstraction, session format, tool execution,
and context assembly. It does not depend on an orchestration framework.

## Requirements

- [Bun](https://bun.sh) 1.2+

## Development

```bash
bun install
bun test
bun run typecheck
bun run dev -- -p "hello"
```

## Headless usage

```bash
export ANTHROPIC_API_KEY=...
schway -p "explain this repository"
schway -p "explain this repository" --json
schway -p "continue this work" --resume <session-id>

export OPENAI_API_KEY=...
schway -p "explain this repository" --provider openai
schway -p "explain this repository" --provider openai --model my-custom-gpt

schway -p "explain this repository" --provider openai-compatible \
  --base-url http://127.0.0.1:11434/v1 --model llama3.2
schway -p "explain this repository" --provider openai-compatible \
  --base-url http://127.0.0.1:8080/v1 --auth required --api-key sk-local
```

`--json` streams normalized runtime events as JSONL on stdout. Diagnostics stay on stderr.

`--provider` selects `anthropic` (default), `openai`, or `openai-compatible`. `--model` is passed through even if it is not in a catalog. Unknown IDs use conservative defaults of a 32768-token context window and 16384 maximum output tokens; known catalog models supply richer context-window metadata. Override either limit with `--context-window`, `--max-output`, or the same keys in config.

OpenAI-compatible endpoints use Schway's own Chat Completions fetch/SSE adapter. `--base-url` is required. `--header Name:Value` may be repeated, `--body` is a JSON object of extra request fields, and `--auth` is `required`, `optional` (default), or `none`. Compatible mode does not read `OPENAI_API_KEY`. Named provider profiles are not supported in v0.1.

Runtime credentials (`--api-key`) take precedence over environment variables, including keys loaded with `--env-file`. Project `.env` files are not loaded automatically. Missing credentials fail with a non-zero exit and do not open an interactive login. Codex/ChatGPT subscription authentication and OS keychain storage are not supported in v0.1. API keys must not be stored in `config.json`.

`--max-turns` bounds agent rounds (default 32). `--max-concurrent-tools` caps overlapping parallel-safe tools (default 10).

Headless runs share one `AbortSignal` from the CLI (SIGINT/SIGTERM) through model streaming, tools, and provider requests. Transient provider failures (network resets, 429, 5xx) retry up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried. Cancelled or failed streams are not written as durable assistant messages; a cancelled run still leaves a resumable session.

## Configuration

Schway is zero-config-first. Valid credentials are enough to run `schway -p "..."`. Config files are never created automatically.

Precedence, later wins:

1. built-in defaults
2. `~/.schway/config.json`
3. `<workspace-root>/.schway/config.json`
4. CLI flags

Project config is read from the workspace root (nearest Git root, otherwise the launch directory), not from a nested launch cwd.

```json
{
  "provider": "openai",
  "model": "gpt-5.4",
  "maxTurns": 16,
  "maxConcurrentTools": 4,
  "contextWindow": 128000,
  "maxOutput": 4096,
  "baseUrl": "http://127.0.0.1:11434/v1",
  "headers": { "X-Test": "ok" },
  "extraBody": { "temperature": 0.2 },
  "auth": "optional"
}
```

Unknown or misspelled settings fail with an actionable error. `baseUrl`, `headers`, `extraBody`, and `auth` apply only when the selected provider is `openai-compatible`.

```bash
schway -p "explain this repository" --env-file ~/.config/my-ai.env
schway -p "explain this repository" --max-turns 8 --max-output 2048
```

## Project instructions

Schway loads `AGENTS.md` from general to specific:

- `~/.schway/AGENTS.md`
- the workspace root
- nested directories on the launch path, then on tool `path` / `cwd` targets

Nested files are discovered when work enters that subtree. Sibling directories are not loaded.

Replace the base system prompt with `~/.schway/SYSTEM.md` and append with `~/.schway/APPEND_SYSTEM.md`. Project-local `SYSTEM.md` is ignored; put project instructions in `AGENTS.md`.
