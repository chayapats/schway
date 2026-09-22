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
/add-dir <directory> - attach project context while idle
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
files, plus explicitly configured [npm packages](#installed-skill-and-extension-packages). Each `SKILL.md` carries `name`/`description` frontmatter; only that
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

## Installed skill and extension packages

Install an npm package yourself, then list its installed name in the appropriate
config file. Schway only reads enabled packages; it never downloads packages or
runs package lifecycle scripts. Normal `npm install` has npm's usual behavior.

```bash
# Project scope: run at the primary workspace root.
npm install schway your-schway-package
# Add to <workspace-root>/.schway/config.json:
# { "packages": ["your-schway-package"] }

# User scope: the installation directory is ~/.schway, not npm's -g prefix.
npm install --prefix "$HOME/.schway" schway your-schway-package
# Add to ~/.schway/config.json:
# { "packages": ["your-schway-package"] }
```

Merge `packages` into existing config rather than replacing your other settings.
Each config's list is independent: project enablement does not erase global
packages. Only direct `node_modules/<name>` entries in that scope are resolved;
missing packages report the matching `npm install --prefix ...` command. Versions,
URLs, and paths belong in npm installation commands, not enablement lists.

A package declares capabilities in its `package.json`:

```json
{
  "name": "your-schway-package",
  "version": "1.0.0",
  "type": "module",
  "peerDependencies": { "schway": "^0.1.0" },
  "schway": {
    "extensions": ["extensions/main.ts"],
    "skills": ["skills/review"]
  }
}
```

Each extension entry is a module file with the default initializer described
below; each skill entry is a directory containing `SKILL.md`. Either array may
be omitted. Paths must stay inside the canonical package root, including symlinks.
All manifests, paths, and declared Schway peer ranges are checked before any
extension is imported. A skills-only package's JavaScript entrypoint is never
imported. Extensions use the installed `schway/extensions` public API, declare
Schway as a peer, and declare their own other dependencies normally; bundling
Schway in `dependencies`, `optionalDependencies`, or either bundled-dependency
list is rejected. Declared peer ranges must be valid npm semver ranges.

Skills select the first defining tier: primary and attached project `.agents/skills`, configured
project packages, global `~/.schway/skills`, then configured global packages.
Two distinct definitions at the same winning tier make that name unavailable
with both sources reported; package list order never picks a skill winner.
Extension initialization and hooks instead follow global package list order,
project package list order, then `--extension` argument order, preserving each
manifest's array order. Enabling the same canonical executable twice is an error,
including aliases and enablement across scopes.

Startup `--resume` uses the saved workspace. Interactive `/resume` and `/new`
stage the destination workspace's enabled capabilities and replace the runtime
only after successful initialization; failure or Esc cancellation keeps the
previous session usable. Package enablement is read from config, never persisted
as executable code in sessions.

The shipped `examples/packages/greeting` directory is a complete mixed package.
With Schway installed locally, try it without publishing anything:

```bash
npm pack ./node_modules/schway/examples/packages/greeting
npm install ./schway-example-greeting-1.0.0.tgz
# Add "packages": ["schway-example-greeting"] to .schway/config.json.
schway -p "/skills"
schway -p "/greeting Ada"
schway
# In the editor: /greeting Ada
```

## Local TypeScript extensions

Explicitly enable local extension modules with repeatable `--extension` flags. Both
interactive and headless startup await their default initializers in argument
order before sending any tool definitions to the model:

```bash
schway --extension ./greet.ts
schway -p "Use greet to greet Ada" --extension ./greet.ts --extension ./other.ts
# From this checkout, with dependencies installed:
bun run dev -- -p "Use greet to greet Ada" --extension examples/extensions/greet.ts
```

Paths resolve from the primary workspace root (nearest Git root, otherwise the
launch directory), including when launched from a subdirectory. Absolute paths
are also accepted. Symlinks resolve to their real paths; duplicate module
identities fail before any enabled module runs. A startup `--resume` uses the
saved workspace root. Pass the flags again on each process launch: extension
CLI module enablement is not saved in sessions. Installed npm packages are
enabled separately through [`config.json`](#installed-skill-and-extension-packages). There is no
arbitrary directory scan, automatic install, or dependency guessing.
Unmentioned modules are never imported by Schway.

Use the installed package's public `schway/extensions` entry; extension authors
do not need private source imports or TypeBox. Resolve this import from the
extension's project with Schway installed locally. The same entry works for
examples inside this checkout. A complete example is included in
`examples/extensions/greet.ts` in the package:

```ts
import { defineExtension } from "schway/extensions";

export default defineExtension(({ registerTool }) => {
  registerTool<{ name: string }>({
    name: "greet",
    description: "Greet someone by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
    execution: "parallel",
    async execute({ name }, ctx) {
      ctx.signal?.throwIfAborted();
      ctx.onOutput?.({ stream: "stdout", text: "Preparing greeting…\n" });
      return { content: `Hello, ${name}!` };
    },
  });
});
```

`defineExtension` only supplies typing; a default function typed as `Extension`
works too. The registration context exposes `registerTool`, `registerCommand`,
`registerPrompt`, `beforeAgent`, `context`, `beforeModel`, `onRuntimeEvent`,
`onDispose`, and a runtime lifetime `signal`. Await all
initialization work before returning; registration closes when initialization
finishes. A thrown initializer, invalid tool/schema, duplicate name, or even a
caught registration error fails startup with the extension's identity and leaves
no partially installed capabilities; registered cleanup runs on failure.
Interactive startup also exits with that error,
so fix the module and restart. Native tool names, including `activate_skill`,
are reserved.

`ToolDefinition`, `ToolContext`, `ToolExecutionResult`, `ToolExecutionMode`,
`ToolOutputChunk`, `JsonSchema`, and `Workspace` are public types. Schemas are
ordinary JSON Schema objects, compiled once without argument coercion; TypeBox
objects are accepted too. Supported constructs include primitive types, object
properties/required/additionalProperties, array items, enum/const, anyOf/oneOf,
nullable, and numeric/string/array bounds. Unsupported keywords such as `$ref`,
`pattern`, and `format`, or malformed schemas, fail at registration.

Calls use Schway's normal validator and scheduler. Choose `parallel` only when
overlapping calls are safe; `exclusive` waits for preceding calls and blocks
later calls. `--max-concurrent-tools` still applies. `ctx.workspace` supplies
canonical workspace paths, `ctx.signal` carries cancellation, and `ctx.onOutput`
emits stdout/stderr runtime deltas. Tools must cooperate with cancellation and
resolve or reject; Schway waits for running calls and cancels queued calls.

Return `{ content: string, isError?: boolean, details?: unknown }`; `details`
must be JSON-serializable and appears only in runtime events. Extension results
and thrown errors are capped at 50,000 characters with truncation guidance;
live output has a separate 50,000-character per-call cap. Argument-validation
errors are bounded too. Known configured API keys are masked in extension
results, errors, and output. Runtime deltas/details are not durable conversation
records; each accepted call produces one durable tool result.

Interactive commands declare a lowercase name, a help description, optional
`arguments` usage text, and `execute(args, ctx)`. `/help` lists enabled commands
and their source paths. Names conflicting with built-ins, discovered skills, or
another extension fail with both owners identified. Commands run only while
idle; a busy command leaves its input in the editor. Return display text, or
call `ctx.submitPrompt(text)` once to queue a normal user turn after successful
completion. Esc cancels a command through `ctx.signal`, discards its queued
prompt, and releases the editor even when its promise never settles.

`onRuntimeEvent((event, { signal }) => { ... })` observes the same native events
as headless JSONL and the TUI, using detached, deeply frozen data. Listeners run
in registration order with independent sequential queues; their promises never
delay the model or tools. Each queue holds at most 128 notifications and 256,000
serialized characters. Excess notifications are dropped with source-labelled
diagnostics, preserving authoritative output and durable results. Keep callbacks
short and heed their signal. Unsubscribe, session replacement, and disposal
cancel pending listener work; late events from a replaced turn are fenced out.
Headless diagnostics go to stderr, preserving JSONL stdout.

`registerPrompt({ name, content })` adds named dynamic context to ordinary model
requests. `beforeAgent` runs once per user turn and may add turn context or deny
with an explanation. `context` transforms the assembled named sections, and
`beforeModel` transforms a Schway-native request or denies it. Each waterfall
awaits hooks in extension load order, using detached copies and validated returns.
Changes are ephemeral; durable user messages and registered tools stay intact.
Transport retries reuse the prepared request. Compaction summaries bypass hooks;
normal request hooks run again after overflow recovery. See the guide for return
contracts, structural section retention, cancellation, and tool selection.

The shipped context example works in either mode:

```bash
bun run dev -- -p "Explain this project" --extension examples/extensions/context.ts
```

Tool hooks run inside the native scheduler: `beforeTool` may return validated
replacement arguments or deny an invocation; `afterTool` may transform settled
content, details, and error presentation. Original inputs are validated before
hooks, and rewritten inputs are validated again. A post-hook failure reports
that execution occurred, preserves the original outcome in runtime details, and
never replays the tool. Exclusive barriers include both phases; parallel tool
hooks may overlap, so extensions must coordinate their shared state. Cancellation
during result processing keeps the original settled outcome. See
`examples/extensions/tool-policy.ts` for a runnable policy example.

See [the extension API guide](docs/extensions.md) for lifecycle details. The
shipped `examples/extensions/commands-and-events.ts` provides `/event-counts`
and `/ask-extension <prompt>`:

```bash
bun run dev -- --extension examples/extensions/commands-and-events.ts
# In the editor: /help, /event-counts, /ask-extension explain this project
```

Extensions are trusted local code with the process's full filesystem, network,
and environment access. This is not a sandbox, and startup cannot roll back
arbitrary module side effects. The registration API does not expose replacements
for Schway's loop, models, sessions, context management, or scheduler. Custom
provider payload hooks and package installation are outside this API. JavaScript callbacks
share the process thread; Schway cannot preempt synchronous blocking code or
undo side effects from work that ignores cancellation.

## Configuration

Schway is zero-config-first. Valid credentials are enough to run `schway -p "..."`. Config files are never created automatically.

Precedence, later wins:

1. built-in defaults
2. `~/.schway/config.json`
3. `<workspace-root>/.schway/config.json`
4. CLI flags

Project config is read from the workspace root (nearest Git root, otherwise the launch directory), not from a nested launch cwd. The `packages` enablement lists are scope-specific and additive across user/project files; they do not follow scalar-setting replacement.

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
- applicable primary or attached project roots
- nested directories on the current turn’s launch path or latest tool `path` / `cwd` targets

Nested files are discovered when work enters that subtree. Sibling directories are not loaded.

Replace the base system prompt with `~/.schway/SYSTEM.md` and append with `~/.schway/APPEND_SYSTEM.md`. Project-local `SYSTEM.md` is ignored; put project instructions in `AGENTS.md`.

## Workspace paths

Tool-relative paths resolve from the primary workspace root: the nearest Git root, otherwise the launch directory. Both are canonicalized through real paths (symlinks resolved) before use.

- `read`, `write`, `edit`, `grep`, `find`, and `ls` resolve `path` against the workspace root.
- `bash` defaults `cwd` to the workspace root; relative explicit `cwd` operands resolve there too.
- Launching from a nested subdirectory keeps the Git root as the workspace root; nested `AGENTS.md` files are still discovered when work enters that subtree.

Attach contextual projects with repeatable `--add-dir <directory>` flags, or `/add-dir <directory>` while idle. Operands resolve from the primary root and must identify accessible existing directories; symlink aliases and duplicate roots attach once. An invalid batch leaves roots unchanged. Relative tools and default bash cwd keep using the primary root; attachments are not filesystem permissions.

```sh
schway --add-dir ../library --add-dir ../service -p "/skills"
schway --resume <session-id> --add-dir ../library
```

Attached project instructions apply only after work enters their scope, and attached local skills share primary-local precedence (same-tier duplicates are explicit ambiguities). Roots appear in model environment context, interactive status, and `/config`. Attachments persist session-wide; unavailable saved directories are reported and excluded from usable context while keeping their saved identity. See [workspaces](docs/workspaces.md) for scoping, recovery, public contracts, and a complete runnable example.

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

Resume rebuilds history from the saved JSONL without replaying old tool effects. Interrupted sessions settle unresolved tool calls on load instead of rerunning them. Partial or malformed trailing records are skipped without destroying valid history. Runtime-only stream deltas (`model.delta`, `tool.delta`) are never persisted; the durable file holds `session`, `user`, `assistant`, `tool_result`, `compaction`, and versioned session-wide metadata records. New files use format 2; format 1 gains an append-only upgrade marker on its first root change. See [session format](docs/sessions.md).

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
