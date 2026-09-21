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

`--provider` selects `anthropic` (default), `openai`, or `openai-compatible`. `--model` is passed through even if it is not in a catalog.

OpenAI-compatible endpoints use Schway's own Chat Completions fetch/SSE adapter. `--base-url` is required. `--header Name:Value` may be repeated, `--body` is a JSON object of extra request fields, and `--auth` is `required`, `optional` (default), or `none`. Compatible mode does not read `OPENAI_API_KEY`. Named provider profiles are not supported in v0.1.

Runtime credentials (`--api-key`) take precedence over `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Missing credentials fail with a non-zero exit and do not open an interactive login. Codex/ChatGPT subscription authentication is not supported in v0.1.

## Project instructions

Schway loads `AGENTS.md` from general to specific:

- `~/.schway/AGENTS.md`
- the workspace root
- nested directories on the launch path, then on tool `path` / `cwd` targets

Nested files are discovered when work enters that subtree. Sibling directories are not loaded.

Replace the base system prompt with `~/.schway/SYSTEM.md` and append with `~/.schway/APPEND_SYSTEM.md`. Project-local `SYSTEM.md` is ignored; put project instructions in `AGENTS.md`.
