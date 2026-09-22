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
bun run dev
```

## Interactive usage

```bash
schway
schway --resume <session-id>
```

Running without `-p` opens the OpenTUI terminal conversation. It uses the same
agent loop, sessions, and runtime events as headless mode. The TUI is lazy-loaded;
headless runs never initialize it.

```text
/new - start a new session
/sessions - list saved sessions
/resume <id> - resume a saved session
/model - show the current provider and model
/help - show help
/quit - quit schway
```

Esc cancels the running turn through the shared AbortSignal path and returns to
the input editor. Ctrl+C cancels when running and quits when idle. Quitting
restores the terminal and releases resources. Resume rebuilds history from the
saved JSONL without replaying old tool effects. Missing credentials and runtime
failures appear as actionable errors; there is no interactive subscription login
flow in v0.1.

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

## Agent Skills

Skills are reusable instruction packs discovered from project-local
`.agents/skills/<name>/SKILL.md` and user-global `~/.schway/skills/<name>/SKILL.md`
files. Each `SKILL.md` carries `name`/`description` frontmatter; only that
metadata reaches the model until you invoke the skill. A project skill overrides
a global skill of the same name. Skills marked user-only
(`disable-model-invocation: true`) stay listed for you but are not advertised
to the model.

List them without calling a model, in the TUI or headlessly:

```text
/skills
```

```bash
schway -p "/skills"
```

Runnable example — add a project skill, list it, then invoke it with arguments:

```bash
mkdir -p .agents/skills/greet
cat > .agents/skills/greet/SKILL.md <<'EOF'
---
name: greet
description: Greet the user warmly.
---
Greet the user warmly in pirate voice.
EOF
schway -p "/skills"            # lists greet, no model call
schway -p "/greet Ahoy, crew"  # skill body plus arguments reach the model
```

In the TUI the same commands apply: `/skills` lists, `/greet Ahoy, crew`
attaches the skill body to that turn only. The invocation text stays in
history; later turns and resumed sessions start without the body. Duplicate
names at one level and names colliding with built-in commands (for example
`/compact`) are reported in the listing and cannot be invoked.

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

## Workspace paths

Tool-relative paths resolve from the primary workspace root: the nearest Git root, otherwise the launch directory. Both are canonicalized through real paths (symlinks resolved) before use.

- `read`, `write`, `edit`, `grep`, `find`, and `ls` resolve `path` against the workspace root.
- `bash` defaults `cwd` to the workspace root and accepts an explicit `cwd` under it.
- Launching from a nested subdirectory keeps the Git root as the workspace root; nested `AGENTS.md` files are still discovered when work enters that subtree.

## Tool output limits

Every core tool returns bounded model-facing output; oversized results are truncated with continuation guidance and never flood model context.

- `read`: ranged reads default to 2000 lines; model-facing text is capped at 50,000 characters with continuation info.
- `bash`: streaming stdout/stderr is capped at 50,000 characters; oversized output spills the full content to a temporary file and reports its path.
- `grep`: defaults to 100 matches; model-facing text is capped at 50,000 characters. Truncated searches say to narrow with `path`, `glob`, `maxResults`, or a more specific pattern.
- `find`: model-facing text is capped at 50,000 characters. Truncated listings say to narrow with a more specific pattern or path.
- `ls`: lists to depth 1 by default; model-facing text is capped at 50,000 characters.
- A non-zero `bash` exit code is ordinary command data (`{ stdout, stderr, exitCode }`), not infrastructure failure.

## Sessions: save and resume

Headless and interactive runs persist versioned JSONL sessions under `~/.schway/sessions`. Config files are never created automatically, but sessions are written so work can resume.

```bash
schway -p "start the migration"
schway -p "continue the migration" --resume <session-id>
schway --resume <session-id>   # interactive resume
```

Resume rebuilds history from the saved JSONL without replaying old tool effects. Interrupted sessions settle unresolved tool calls on load instead of rerunning them. Partial or malformed trailing records are skipped without destroying valid history. Runtime-only stream deltas (`model.delta`, `tool.delta`) are never persisted; the durable file holds `session`, `user`, `assistant`, `tool_result`, and `compaction` records only.

`--json` streams normalized runtime events as JSONL on stdout for tooling; diagnostics stay on stderr. Runtime JSONL and durable session JSONL are different concepts: the first is transient observability, the second is resumable state.

## Compaction

Long sessions compact context instead of failing when pressure builds.

- Automatic pressure compaction triggers at 80% of the resolved context window and retains the 10 most recent complete turns plus the running summary.
- Context overflow (`context_length_exceeded` / `prompt-too-long`) forces one compaction and retries once; repeated overflow terminates with a clear error instead of looping.
- Compaction never splits a tool-call/result group: the retained window starts at a turn boundary.
- Oversized tool output is pruned only for summarization input; raw history keeps the full records.
- The summary plus retained records reconstruct identically after `--resume`.

There is no interactive `/compact` command in v0.1 beyond the automatic path and the same recovery inside headless runs.

## Cancellation

Cancellation is orderly and never corrupts session state.

- Headless: one `AbortSignal` flows from SIGINT/SIGTERM through model streaming, tools, and provider requests. Cancelling exits non-zero and still leaves a resumable session; cancelled streams are not written as durable assistant messages.
- Interactive: Esc cancels the running turn and returns to the input editor; Ctrl+C cancels when running and quits when idle. Quitting restores the terminal and releases resources.
- Provider retries cover transient failures only (network resets, 429, 5xx) up to three total attempts with exponential backoff and `Retry-After`. Authentication errors, malformed requests, and ordinary tool failures are not retried.
