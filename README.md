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
```

`--json` streams normalized runtime events as JSONL on stdout. Diagnostics stay on stderr.

Runtime credentials (`--api-key`) take precedence over `ANTHROPIC_API_KEY`. Missing credentials fail with a non-zero exit and do not open an interactive login.

## Project instructions

Schway loads `AGENTS.md` from general to specific:

- `~/.schway/AGENTS.md`
- the workspace root
- nested directories on the launch path, then on tool `path` / `cwd` targets

Nested files are discovered when work enters that subtree. Sibling directories are not loaded.

Replace the base system prompt with `~/.schway/SYSTEM.md` and append with `~/.schway/APPEND_SYSTEM.md`. Project-local `SYSTEM.md` is ignored; put project instructions in `AGENTS.md`.
