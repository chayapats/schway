# Schway — Design & Implementation Specification

**Status:** Draft for implementation  
**Target:** v0.1 → v1.0  
**Language:** TypeScript  
**Runtime / Toolchain:** Bun  
**Primary interface:** Terminal UI + CLI  
**Package:** `schway`

---

# 1. Overview

Schway is a lean, light, fast, and hackable coding-agent harness.

It is designed to be useful immediately after installation without requiring extensions, while exposing a small and stable extension surface for users who want to add capabilities such as MCP, subagents, browser automation, permissions, sandboxing, workflows, or custom tools.

Schway owns its agent loop, model abstraction, session format, tool execution, context assembly, and extension contract.

It does not depend on an orchestration framework such as LangChain, LangGraph, DeepAgents, or a third-party agent loop.

The conceptual core is deliberately simple:

```text
user
 ↓
context preparation
 ↓
model
 ↓
tool calls?
 ├── no  → finish
 └── yes
      ↓
    execute
      ↓
    tool results
      ↓
    model
```

The loop is intentionally simple.

The harness around it is intentionally capable.

---

# 2. Product principles

## 2.1 Lean

A fresh Schway installation should contain only functionality that is broadly useful for normal coding-agent work.

Optional functionality must stay off the default startup path whenever practical.

Lean applies primarily to:

- the base distribution;
- startup behavior;
- built-in dependencies;
- default memory and runtime overhead.

Lean does **not** impose a weight restriction on user-installed extensions.

A user may intentionally install heavy extensions and accepts their associated cost.

---

## 2.2 Light

Schway should avoid:

- large orchestration frameworks;
- unnecessary middleware stacks;
- dependency-injection frameworks;
- plugin systems where every internal component is replaceable;
- infrastructure abstractions without a demonstrated second consumer.

A dependency is acceptable when it pays for itself through correctness, interoperability, cross-platform behavior, protocol maintenance, substantial implementation savings, or clearly better UX.

---

## 2.3 Fast

Fast refers to both perceived UX and runtime behavior.

Optimize:

- startup;
- TUI initialization;
- provider loading;
- tool execution;
- parallel read/search operations;
- session loading;
- context preparation.

Optional subsystems should be lazy-loaded when possible.

Performance must be measured rather than assumed.

---

## 2.4 Hackable

A developer cloning Schway should be able to understand the major execution path quickly.

Source layout should remain direct and unsurprising.

The implementation should prefer:

```text
CLI
 ↓
TUI / headless
 ↓
Agent
 ↓
Model + Tools + Session + Context
```

over layered framework abstractions.

---

## 2.5 Practical defaults

Schway should avoid both extremes:

- excessive safety friction;
- reckless implicit behavior.

Defaults should work well for ordinary users without configuration.

Power users should have explicit escape hatches.

---

# 3. Goals

Schway must:

1. work as a capable coding agent with no extensions installed;
2. own a simple and inspectable agent loop;
3. support Anthropic, OpenAI, and OpenAI-compatible models;
4. support Codex / ChatGPT subscription authentication by v1;
5. provide core file, shell, and search tools;
6. persist resumable sessions;
7. support automatic and manual context compaction;
8. support Agent Skills;
9. support optional extensions through a small stable API;
10. provide an interactive TUI and headless CLI;
11. work well for long-running real coding sessions;
12. remain provider-independent internally;
13. allow heavy optional functionality without making the base harness heavy.

---

# 4. Non-goals

The base harness does not need to include:

- built-in subagents;
- built-in MCP;
- built-in browser control;
- built-in permission framework;
- built-in sandbox;
- built-in workflow engine;
- built-in planner;
- built-in todo manager;
- built-in code-review workflow;
- built-in worktree orchestration;
- automatic commits;
- persistent personal memory;
- Telegram;
- server mode;
- web UI.

These may be implemented as extensions or later official packages.

Schway is not intended to become an "everything is a plugin" framework.

Core components such as the agent loop, session engine, compaction engine, and model abstraction are not replaceable through the stable v1 extension API.

---

# 5. Repository strategy

Schway begins as a new project and new repository rather than a refactor of JARN.

JARN remains a historical reference and source of lessons but is not an implementation dependency.

Schway should begin as a **single npm package** rather than a multi-package monorepo.

```text
schway/
├── package.json
├── bun.lock
├── tsconfig.json
├── README.md
├── LICENSE
├── AGENTS.md
├── src/
├── tests/
├── evals/
└── docs/
```

Internal modularity should not require separately published packages.

A package should be extracted only once there is a genuine second consumer.

Do not create `@schway/core`, `@schway/sdk`, or similar packages preemptively.

---

# 6. Recommended source structure

```text
src/
├── cli/
│   ├── main.ts
│   ├── args.ts
│   └── commands/
│
├── agent/
│   ├── loop.ts
│   ├── events.ts
│   └── types.ts
│
├── model/
│   ├── model.ts
│   ├── catalog.ts
│   └── providers/
│       ├── anthropic.ts
│       ├── openai.ts
│       └── openai-compatible.ts
│
├── conversation/
│   └── types.ts
│
├── context/
│   ├── manager.ts
│   ├── prompt.ts
│   ├── agents.ts
│   └── compaction.ts
│
├── session/
│   ├── session.ts
│   ├── jsonl.ts
│   └── branching.ts
│
├── tools/
│   ├── registry.ts
│   ├── executor.ts
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   ├── bash.ts
│   ├── grep.ts
│   ├── find.ts
│   └── ls.ts
│
├── skills/
│   ├── discovery.ts
│   └── loader.ts
│
├── extensions/
│   ├── api.ts
│   ├── loader.ts
│   └── manifest.ts
│
├── auth/
│   ├── secrets.ts
│   ├── anthropic.ts
│   ├── openai-api.ts
│   └── codex.ts
│
├── workspace/
│   ├── workspace.ts
│   └── git.ts
│
├── config/
│   ├── config.ts
│   └── defaults.ts
│
└── tui/
    ├── app.ts
    ├── chat.ts
    ├── editor.ts
    ├── tool-call.ts
    └── status.ts
```

Dependency direction must remain intentional.

Core modules must not import the TUI.

---

# 7. Runtime and toolchain

Schway uses:

- TypeScript;
- Bun;
- npm-compatible packages;
- `bun.lock` committed to source control.

Development:

```bash
bun install
bun run dev
bun test
```

Bun is the implementation/runtime choice.

Schway architecture should avoid unnecessarily exposing Bun-specific APIs through public extension contracts.

---

# 8. Agent loop

Schway owns the agent loop.

Conceptually:

```ts
while (!done) {
  const prepared = await contextManager.prepare(session, model)

  const response = await model.stream({
    systemPrompt: prepared.systemPrompt,
    context: prepared.context,
    items: prepared.items,
    tools: toolRegistry.definitions(),
    signal
  })

  session.append(response)

  if (response.toolCalls.length === 0) {
    break
  }

  const results = await toolExecutor.execute(response.toolCalls, signal)

  session.append(results)
}
```

The concrete implementation must additionally support:

- streaming;
- cancellation;
- tool errors;
- provider errors;
- bounded loop execution;
- parallel tool calls;
- retry policy;
- context-overflow recovery.

The loop must not directly implement:

- planning;
- verification;
- permissions;
- workflows;
- subagents;
- MCP;
- memory;
- sandboxing.

Those behaviors live outside the loop.

---

# 9. Internal conversation model

Schway must not use provider-specific message types as its internal canonical model.

Use a small Schway-native representation.

Recommended structure:

```ts
type ConversationItem =
  | UserMessage
  | AssistantMessage
  | ToolResult

interface UserMessage {
  type: "user"
  id: string
  content: UserContent[]
}

interface AssistantMessage {
  type: "assistant"
  id: string
  content: AssistantContent[]
}

interface ToolResult {
  type: "tool_result"
  id: string
  toolCallId: string
  content: string
  isError: boolean
}
```

Assistant content initially supports:

```ts
type AssistantContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
```

Example:

```ts
interface TextContent {
  type: "text"
  text: string
}

interface ThinkingContent {
  type: "thinking"
  text: string
  providerMetadata?: ProviderMetadata
}

interface ToolCallContent {
  type: "tool_call"
  id: string
  name: string
  arguments: unknown
}
```

Provider-specific information that must survive round-tripping is stored in opaque provider metadata.

Core code should not depend on provider-specific metadata.

---

# 10. System prompt

The base system prompt should remain small and stable.

It should describe only enduring Schway behavior, such as:

- operate as a coding agent;
- inspect relevant files before targeted changes;
- use tools efficiently;
- follow project instructions;
- report outcomes clearly.

Do not inject volatile project information into the stable prompt.

---

# 11. Dynamic context assembly

Dynamic context is assembled separately from durable conversation history.

Possible sections:

```text
environment
project-instructions
available-skills
active-skill
extension-context
```

Example internal type:

```ts
interface ContextSection {
  name: string
  content: string
}
```

Dynamic context must not be persisted repeatedly into session JSONL.

---

# 12. AGENTS.md

Schway uses `AGENTS.md` as the standard project-instruction file.

Support:

- optional global `~/.schway/AGENTS.md`;
- parent-directory discovery;
- repository root instructions;
- nested directory scopes.

Instruction precedence is from general to specific.

Example:

```text
repo/AGENTS.md
repo/apps/AGENTS.md
repo/apps/web/AGENTS.md
```

The deepest applicable file has highest precedence.

Nested instructions should be discovered when work enters that subtree rather than scanning every directory into startup context.

---

# 13. User system prompt overrides

Support:

```text
~/.schway/SYSTEM.md
~/.schway/APPEND_SYSTEM.md
```

`SYSTEM.md` replaces the base Schway prompt.

`APPEND_SYSTEM.md` appends to it.

Tool guidelines, context assembly, AGENTS.md, skills, and other structural harness information must still be assembled normally.

Project-specific instructions belong in `AGENTS.md`, not a project-local system-prompt replacement.

---

# 14. Model providers

v1 provider families:

1. Anthropic native;
2. OpenAI native;
3. OpenAI-compatible.

Provider adapters convert between provider wire formats and Schway-native request/event types.

Schway owns:

- retry policy;
- cancellation behavior;
- normalized model events;
- context budgeting.

SDKs own provider wire/protocol details.

---

# 15. Provider implementation strategy

Use:

```text
Anthropic
→ official Anthropic TypeScript SDK

OpenAI
→ official OpenAI TypeScript SDK

OpenAI-compatible
→ Schway-owned fetch/SSE implementation

Codex subscription
→ isolated Codex-specific integration
```

Disable SDK automatic retries when possible so Schway controls retry policy consistently.

The OpenAI-compatible adapter must support:

- custom base URL;
- custom headers;
- optional authentication;
- no authentication;
- additional request-body parameters.

---

# 16. Model catalog

Schway ships a small built-in model catalog for known models.

Metadata may include:

```ts
interface ModelInfo {
  id: string
  provider: string
  contextWindow?: number
  maxOutput?: number
  supportsTools?: boolean
  supportsThinking?: boolean
}
```

Unknown model IDs must still be usable.

Known models provide richer UX and context budgeting.

Unknown models use conservative defaults and optional user overrides.

Do not require catalog membership to use a model.

---

# 17. Thinking levels

Expose a small user-facing abstraction:

```text
off
low
medium
high
```

Provider adapters map these values to provider-specific controls where supported.

Do not pretend all providers implement reasoning identically.

Unsupported levels should be disabled or ignored appropriately.

---

# 18. Core tools

A fresh Schway installation includes:

```text
read
write
edit
bash
grep
find
ls
```

No extension is required for ordinary coding tasks.

---

# 19. read

Recommended schema:

```ts
read({
  path,
  offset?,
  limit?
})
```

Requirements:

- ranged reads;
- line-numbered output;
- bounded output;
- continuation information;
- support relative and absolute paths.

No built-in tool may inject unbounded output into model context.

---

# 20. write

Recommended schema:

```ts
write({
  path,
  content
})
```

Semantics:

- nonexistent file → create;
- existing file → full replacement.

The model should prefer `edit` for targeted modifications.

Do not enforce read-before-write in core.

---

# 21. edit

Use exact string replacement.

Recommended schema:

```ts
edit({
  path,
  edits: [
    {
      oldText,
      newText
    }
  ]
})
```

Rules:

- `oldText` must uniquely match;
- multiple edits per file are supported;
- all matches are computed against the original file;
- overlapping edits are rejected;
- all edits succeed or none are applied;
- line endings are preserved;
- BOM is preserved;
- TUI-facing diff metadata is returned.

Initial implementation does not use fuzzy matching.

Initial implementation does not expose `apply_patch` as a built-in tool.

An apply-patch tool may be implemented later as an extension.

---

# 22. bash

Recommended schema:

```ts
bash({
  command,
  cwd?,
  timeout?
})
```

Requirements:

- streaming output;
- cancellation;
- optional timeout;
- bounded model-facing output;
- spill full oversized output to a temporary file;
- fresh shell for each invocation.

A non-zero exit code is ordinary command data.

Example result:

```ts
{
  stdout,
  stderr,
  exitCode: 1
}
```

Do not classify normal test or command failure as infrastructure failure.

---

# 23. grep

Provide a structured search tool.

Example:

```ts
grep({
  pattern,
  path?,
  glob?,
  ignoreCase?,
  maxResults?
})
```

Results must be bounded.

Use an efficient backend such as ripgrep where practical.

---

# 24. find

Provide simplified file discovery rather than exposing full Unix `find` syntax.

Example:

```ts
find({
  pattern: "**/*.ts",
  path?: "src"
})
```

Advanced filesystem searching remains possible through `bash`.

---

# 25. ls

Provide bounded shallow directory inspection.

Example:

```ts
ls({
  path?,
  depth?
})
```

Do not recursively dump arbitrarily large trees by default.

---

# 26. Tool results

Tool results have two layers:

```ts
interface ToolResult {
  content: string
  details?: unknown
}
```

`content` is optimized for the model.

`details` contains richer structured information for:

- TUI;
- extensions;
- debugging.

Example edit details may contain a diff without requiring that full diff to enter model context.

---

# 27. Tool schemas

Public tool contracts use JSON Schema.

Schway built-ins use TypeBox for authoring and validation.

Third-party extensions are not required to use TypeBox.

Example public definition:

```ts
interface ToolDefinition<TInput = unknown> {
  name: string
  description: string
  inputSchema: JsonSchema
  execution: "parallel" | "exclusive"

  execute(
    input: TInput,
    ctx: ToolContext
  ): Promise<ToolResult>
}
```

Compile validators once at tool registration.

Validate every model-generated tool invocation before execution.

---

# 28. Tool schema subset

Support a practical JSON Schema subset appropriate for model tools.

Expected constructs include:

- object;
- array;
- string;
- number;
- integer;
- boolean;
- null;
- enum;
- const;
- properties;
- required;
- additionalProperties;
- basic unions where supported.

Reject unsupported schema constructs early with actionable errors.

Do not build a Schway-specific schema DSL.

---

# 29. Parallel tool execution

Tools declare:

```text
parallel
exclusive
```

Default built-in modes:

```text
parallel:
  read
  grep
  find
  ls

exclusive:
  write
  edit
  bash
```

Consecutive parallel-safe calls may execute concurrently.

Exclusive calls form barriers.

Default maximum concurrent parallel tools:

```text
10
```

Persist/model tool results in source call order even if execution completes in a different order.

Runtime completion events may reflect actual completion order.

Every accepted tool call must produce exactly one result:

```text
success
error
cancelled
```

Sibling failures must not lose unrelated results.

---

# 30. Cancellation

Use shared `AbortSignal` propagation.

Cancellation must reach:

- model streaming;
- currently executing tools;
- applicable provider operations.

Session state must not be left with unresolved durable tool calls.

---

# 31. Retry philosophy

Schway automatically retries transport/infrastructure failures.

Default behavior:

```text
rate limit / 429
→ retry

temporary overload / 5xx
→ retry

network reset / transient network failure
→ retry

maximum transient attempts
→ 3
```

Use exponential backoff and provider `Retry-After` hints when available.

Do not retry automatically:

- authentication failures;
- malformed requests;
- invalid tool arguments;
- failed shell commands;
- edit mismatches.

Those are surfaced to the model or user.

Principle:

> Schway retries transport failures; the model handles reasoning failures.

---

# 32. Workspace

A Schway session has:

```ts
interface Workspace {
  root: string
  launchCwd: string
  extraRoots: string[]
}
```

Primary root:

1. nearest Git root;
2. otherwise launch cwd.

Canonicalize using real paths.

Workspace is not a security boundary.

Absolute filesystem paths are permitted when the OS permits them.

---

# 33. Path semantics

Tool-relative paths resolve from the primary workspace root.

Example:

```ts
read({ path: "src/foo.ts" })
```

always means:

```text
<workspace-root>/src/foo.ts
```

A `bash` command changing directories does not change persistent Schway path resolution.

`bash.cwd` may specify a different working directory explicitly.

---

# 34. Additional roots

Support:

```bash
schway --add-dir ../shared
```

and interactive:

```text
/add-dir ../shared
```

Extra roots are contextual project roots, not permission boundaries.

They may contribute:

- AGENTS.md;
- skills;
- project context.

Primary root remains authoritative for relative paths and session identity.

---

# 35. Git integration

Schway is Git-aware but not Git-managed.

Default mode:

```text
git.changeTracking = "on-demand"
```

Supported modes:

```text
off
on-demand
snapshot
```

Built-in awareness may include:

- repository root;
- branch;
- HEAD;
- dirty state.

Do not build core functionality for:

- auto commits;
- checkpoints via commits;
- branch management;
- worktrees.

Use Git itself as the source of truth.

---

# 36. Sessions

Session persistence uses per-session versioned JSONL.

Canonical location:

```text
~/.schway/sessions/
```

Session files are the durable source of truth.

The storage model is append-oriented, not an event-sourcing framework.

Persist semantic durable records only.

Do not persist every runtime stream delta.

---

# 37. Session tree

Entries use identifiers and parent identifiers to support branching.

Concept:

```json
{
  "id": "entry-3",
  "parentId": "entry-2"
}
```

This allows one session file to represent:

```text
A
└── B
    ├── C
    └── X
```

The current branch is reconstructed by walking parent relationships.

---

# 38. Session header

Session metadata should include at minimum:

```json
{
  "type": "session",
  "version": 1,
  "id": "...",
  "createdAt": "...",
  "workspaceRoot": "...",
  "launchCwd": "...",
  "extraRoots": []
}
```

Format versioning must exist from the first release.

---

# 39. Session migrations

Loaders are version-specific.

Prefer:

```text
loadV1()
loadV2()
```

over a permanently growing universal union schema.

Old sessions should be migrated or interpreted deliberately.

---

# 40. SQLite

SQLite is not the canonical session store in v1.

It may later be introduced as a disposable/rebuildable index for:

- session search;
- metadata;
- fast listing;
- large-history indexing.

Deleting the index must not destroy session history.

---

# 41. Compaction

Compaction is built-in.

It lives in `ContextManager`, not the agent loop.

Triggers:

- token pressure;
- manual `/compact`;
- provider context-overflow recovery.

On actual provider context overflow:

1. force compaction;
2. retry once.

---

# 42. Compaction algorithm

Initial algorithm:

1. identify oldest complete turns;
2. retain recent complete turns;
3. prune oversized tool outputs from compaction input only;
4. generate a structured coding summary;
5. append a compaction record;
6. preserve original history.

Do not delete raw historical records.

Initial version does not require split-turn compaction.

---

# 43. Compaction summary

Use a coding-oriented structure such as:

```text
## Goal

## Constraints

## Progress

## Key Decisions

## Current State

## Next Steps

## Files
### Read
### Modified
```

Avoid generic conversation summaries that discard implementation state.

---

# 44. Compaction persistence

Compaction is a special durable session record.

It may include:

```ts
interface CompactionRecord {
  type: "compaction"
  id: string
  parentId: string
  summary: string
  firstKeptId: string
  tokensBefore?: number
}
```

When preparing context, use:

```text
summary
+
recent records
```

Raw historical records remain inspectable.

---

# 45. Skills

Skills are a first-class built-in capability.

Schway follows the Agent Skills standard.

A skill is a directory containing:

```text
skill/
├── SKILL.md
├── scripts/       optional
├── references/    optional
└── assets/        optional
```

Do not invent a proprietary skill format.

---

# 46. Skill discovery

Preferred discovery order:

1. project-local skills;
2. configured project package skills;
3. user-global skills;
4. configured global package skills.

Project-local convention:

```text
.agents/skills/
```

User-global:

```text
~/.schway/skills/
```

Project definitions override global definitions of the same skill name.

Ambiguous duplicates at the same precedence level must generate an explicit warning/error.

---

# 47. Progressive skill loading

At startup, load only:

- skill name;
- description;
- invocation metadata.

Do not inject entire skill bodies into context.

Full `SKILL.md` is loaded only when activated.

Related scripts/references/assets are loaded only when needed.

---

# 48. Skill invocation

Support:

- model-invoked skills;
- user-only skills.

User-only workflows may be invoked through direct slash commands:

```text
/grill-with-docs
/to-spec
/implement
```

Schway itself does not know workflow ordering.

---

# 49. Workflow philosophy

Schway must not contain a workflow engine for chains such as:

```text
grill-with-docs
→ to-spec
→ to-tickets
→ implement
→ code-review
```

That relationship belongs in skills and artifacts.

The harness knows only that these are skills.

---

# 50. Extensions

Extensions are optional executable modules.

The stable v1 extension surface should remain small.

Conceptual API:

```ts
interface ExtensionContext {
  tools: ToolRegistryApi
  commands: CommandRegistryApi
  prompt: PromptContributionApi
  events: EventApi
  hooks: HookApi
}
```

Extensions may not replace:

- agent loop;
- session engine;
- compaction engine;
- model abstraction;
- tool scheduler.

---

# 51. Events vs hooks

Schway distinguishes observation from intervention.

## Events

Events are read-only notifications.

They cannot modify execution.

## Hooks

Hooks are explicit interception points.

They may modify, deny, or replace supported values.

---

# 52. Runtime events

A representative event union:

```ts
type RuntimeEvent =
  | AgentStarted
  | AgentFinished
  | ModelStarted
  | ModelDelta
  | ModelFinished
  | ToolStarted
  | ToolFinished
  | CompactionStarted
  | CompactionFinished
  | SessionChanged
  | ErrorEvent
```

The same runtime-event vocabulary should support:

- TUI;
- headless JSON output;
- extensions;
- diagnostics.

Observer failures must be isolated.

---

# 53. Hooks

Stable v1 hooks:

```text
beforeAgent
context
beforeModel
beforeTool
afterTool
```

Do not expose raw provider-payload mutation as part of the initial stable API.

---

# 54. Hook ordering

Hook execution order equals extension load order.

Hooks compose as deterministic waterfalls.

Avoid priority numbers unless a real need emerges.

---

# 55. Tool hook validation

Tool inputs are validated:

```text
model output
 ↓
schema validation
 ↓
beforeTool hooks
 ↓
schema validation again
 ↓
tool execution
```

If a hook mutates tool arguments into an invalid shape, execution must not proceed.

---

# 56. Hook failures

Observer/event listener failure:

```text
log error
continue execution
```

Intervention hook failure:

```text
surface actionable extension error
do not silently continue
do not crash entire Schway process
```

A `beforeTool` failure should produce an appropriate tool error/result rather than executing unchecked.

---

# 57. Extension packaging

Use ordinary npm packages.

Extension/skill packages declare a small manifest in `package.json`.

Example:

```json
{
  "name": "@someone/schway-tools",
  "schway": {
    "extensions": [
      "./dist/index.js"
    ],
    "skills": [
      "./skills"
    ]
  }
}
```

A package may contain:

- extensions only;
- skills only;
- both.

---

# 58. Extension loading

Extensions are explicitly installed/enabled.

Do not automatically scan and execute arbitrary `node_modules` packages.

Development should support local TypeScript extensions directly:

```bash
schway --extension ./my-extension.ts
```

Bun may load local TypeScript directly.

---

# 59. Extension dependencies

Extensions own their own runtime dependencies.

A third-party extension may intentionally be heavy.

Schway should not artificially restrict this.

Extensions should peer-depend on Schway rather than bundle their own duplicate Schway runtime.

---

# 60. Configuration philosophy

Schway is zero-config-first.

A user with valid credentials should be able to run:

```bash
schway
```

without creating a config file.

Config files exist only to override defaults.

---

# 61. Config locations and precedence

Recommended:

```text
built-in defaults
 ↓
~/.schway/config.json
 ↓
./.schway/config.json
 ↓
CLI flags / current TUI overrides
```

Do not create config files automatically unless needed.

---

# 62. Config validation

Use TypeBox for first-party config schema and runtime validation.

Invalid config must fail with actionable messages.

Do not silently ignore misspelled settings.

---

# 63. Secrets

API keys must not be written into normal `config.json`.

Credential resolution order:

1. runtime override;
2. environment variable;
3. secure stored credential;
4. missing credential.

Environment variables override stored credentials for predictable temporary overrides.

---

# 64. Bun secrets

Use OS-native secure credential storage through Bun where appropriate.

Supported underlying stores may include:

- macOS Keychain;
- Windows Credential Manager;
- Linux secret-service implementations.

---

# 65. Dotenv behavior

Disable Bun automatic project `.env` loading for Schway.

Schway credentials should not unexpectedly change merely because the user entered another repository.

Support explicit env files if desired:

```bash
schway --env-file ~/.config/my-ai.env
```

---

# 66. Authentication

v1 target:

```text
Anthropic
✓ API key

OpenAI
✓ API key
✓ Codex / ChatGPT subscription login

OpenAI-compatible
✓ required auth
✓ optional auth
✓ no auth
```

---

# 67. Codex subscription requirement

Codex/ChatGPT subscription support is a v1 requirement.

It must not compromise Schway's ownership of the agent loop.

Prefer officially supported OpenAI/Codex authentication integration.

Codex-specific behavior must remain isolated in the auth/provider layer.

Do not make core agent/session/tool/context modules depend on Codex internals.

Do not scrape credentials from another CLI's credential files.

---

# 68. Auth selection

OpenAI auth preference may support:

```text
auto
codex
api-key
```

Interactive mode may favor the user's previously selected subscription auth.

Headless/CI should remain deterministic and favor explicit configuration/environment credentials.

---

# 69. TUI

Use:

```text
@opentui/core
```

directly.

Do not require React or Solid.

OpenTUI is a presentation dependency only.

Core modules must not depend on OpenTUI.

---

# 70. TUI responsibilities

Initial TUI should support:

- streaming Markdown/text;
- tool-call state;
- tool results;
- diffs;
- input editor;
- model picker;
- session information;
- cancellation;
- status information.

TUI consumes runtime events from the agent.

## Conversation design and usability gate

The default layout is a single conversation column, a stable multiline composer,
and a compact model/status footer. Keep session IDs and full workspace metadata
behind `/session`. Model selection is a transient, bounded panel, and opening or
closing it must preserve the prompt draft.

Use semantic dark/light palettes: neutral body text, readable muted metadata,
blue interaction/running state, green success/additions, amber warning/cancelled
state, and red errors/removals. Always pair status colors with text or symbols.
Follow terminal appearance when available, provide `/theme auto|dark|light`, and
honor `NO_COLOR`. Document the tokens in `docs/tui.md`.

Render Markdown structure, code blocks, and tables. Collapse successful tool
output by default, allow expansion, and keep failure previews visible. Keep
message widgets stable during streaming; new output must not pull a reader out
of scrollback. Support multiline paste, prompt history, command completion, and
keyboard-only scrolling and cancellation.

Before calling the TUI daily-driver ready, verify both palettes, narrow and wide
terminals, Thai/Unicode input, long output, draft preservation, credential masking,
and terminal cleanup with an offline scripted model. Controller tests alone do
not establish visual quality. This usability gate applies before v1.0 alongside
the release gates in section 92.

---

# 71. CLI modes

Interactive:

```bash
schway
```

Headless:

```bash
schway -p "explain this repository"
```

Structured headless:

```bash
schway -p "..." --json
```

`--json` streams runtime events as JSONL.

This JSONL is **not** the same schema as durable session JSONL.

---

# 72. Built-in slash commands

Baseline:

```text
/new
/resume
/sessions
/model
/compact
/skills
/config
/add-dir
/help
/quit
/login
/logout
```

User-invoked skills may become slash commands automatically.

Extensions may register additional commands.

---

# 73. Headless behavior

Headless execution must never open an interactive login flow.

Missing credentials must produce an actionable error and non-zero exit code.

---

# 74. Server

Server mode is intentionally deferred.

Future official server implementation may use Elysia.

The core must be designed such that a future server can consume the same runtime event interface without changing the agent loop.

---

# 75. Diagnostics

Provide:

```bash
schway doctor
```

It should inspect information such as:

- Schway version;
- Bun/runtime;
- platform;
- provider authentication;
- workspace;
- Git;
- built-in tools;
- skills;
- extensions;
- session directory.

---

# 76. Debug logging

Support:

```bash
schway --debug
```

Structured logs may be written locally.

Never log:

- API keys;
- bearer tokens;
- raw auth headers;
- secure credentials.

---

# 77. Telemetry

No usage telemetry by default.

Crash reporting or analytics, if ever added, must be explicit opt-in.

---

# 78. Dependency philosophy

The base Schway distribution should remain lean.

No arbitrary limit is imposed on dependency count.

A dependency must justify itself through:

- correctness;
- protocol maintenance;
- cross-platform behavior;
- implementation savings;
- UX;
- performance.

Avoid reimplementing difficult non-core infrastructure merely to reduce dependency count.

---

# 79. Lazy loading

Optional subsystems should be loaded lazily.

Examples:

```text
interactive Schway
→ load TUI

headless Schway
→ do not load TUI

Anthropic selected
→ load Anthropic provider

OpenAI selected
→ load OpenAI provider

Codex auth unused
→ do not initialize Codex integration

extension disabled
→ do not load it
```

---

# 80. Testing strategy

Default CI must be deterministic and must not require paid model APIs.

Use a scripted/fake model capable of predetermined responses and tool calls.

Core tests should exercise the real agent loop.

---

# 81. Agent-loop contract tests

Include at minimum:

- plain text response;
- single tool call;
- multiple tool calls;
- parallel tool scheduling;
- exclusive barriers;
- tool errors;
- cancellation;
- provider retry;
- context overflow recovery;
- save/resume;
- branching;
- compaction;
- extension hooks;
- AGENTS.md scoping;
- skills;
- unknown model fallback.

---

# 82. Tool tests

Use real temporary filesystems rather than excessive filesystem mocking.

`edit` tests must cover:

- unique match;
- duplicate match rejection;
- missing match;
- multiple edits;
- atomic failure;
- overlapping edits;
- CRLF preservation;
- BOM preservation.

---

# 83. Provider tests

Use recorded/protocol fixtures for adapter behavior.

Test both directions:

```text
provider response
→ Schway events

Schway request
→ provider request
```

Ensure provider-specific metadata survives required round trips.

---

# 84. TUI tests

Prefer controller/state tests.

Use visual/snapshot tests only for stable major layouts.

Do not create a fragile snapshot suite for every terminal cell.

---

# 85. Live provider smoke tests

Live tests are opt-in.

Example:

```bash
bun run test:providers
```

Smoke-test:

- Anthropic;
- OpenAI API key;
- OpenAI-compatible;
- Codex subscription.

These tests are not part of normal per-commit CI.

---

# 86. Evals

Agent evals are separate from unit tests.

Create small coding repositories/tasks such as:

```text
fix-simple-bug
multi-file-refactor
locate-implementation
failing-tests
long-context
tool-error-recovery
parallel-read
```

Grade through environment-verifiable outcomes whenever possible.

Do not trust the model's self-reported success when tests/files can determine the result.

---

# 87. Eval metrics

Record at least:

- success;
- wall-clock duration;
- input tokens;
- output tokens;
- tool-call count;
- tool failures;
- provider retries;
- compactions;
- repeated identical tool calls.

Comparisons with other harnesses may be used internally for regression investigation, not as a leaderboard requirement.

---

# 88. Performance benchmarks

Measure:

- cold startup;
- time to first TUI render;
- idle memory;
- 1 MB session load;
- 50 MB session load;
- read;
- grep;
- 10 parallel reads;
- prompt/context assembly.

Establish empirical baselines before enforcing absolute performance budgets.

---

# 89. Release strategy

## v0.1 — Schway can build Schway

Goal:

> Schway is capable enough to develop Schway itself.

Required:

- Bun/TypeScript runtime;
- own agent loop;
- Anthropic/OpenAI/OpenAI-compatible;
- streaming;
- core tools;
- parallel scheduling;
- OpenTUI;
- headless mode;
- basic config;
- API-key authentication;
- workspace/Git-root detection;
- AGENTS.md;
- JSONL save/resume;
- compaction;
- cancellation/retries/bounded outputs;
- basic model catalog;
- deterministic tests.

Not required to block v0.1:

- Codex subscription;
- package installer;
- mature extension ecosystem;
- workflow package;
- rich session tree UI;
- server;
- MCP;
- subagents.

---

# 90. v0.2 — Schway becomes hackable

Add/mature:

- Agent Skills support;
- extension API;
- hooks/events;
- local TypeScript extensions;
- npm manifest support;
- project/global skills;
- extension commands;
- `/add-dir`;
- branching primitives;
- better configuration/model UX.

Dogfood the Matt-style workflow as an external skills package:

```text
grill-with-docs
→ to-spec
→ to-tickets
→ implement
→ code-review
```

This workflow must not require Schway-specific workflow logic in core.

---

# 91. v0.3 — Daily-driver polish

Target:

- Codex/ChatGPT subscription login;
- secure credential storage;
- named compatible-provider profiles;
- richer provider reasoning controls;
- improved session tree UX;
- Git snapshot tracking;
- `schway doctor`;
- debug logs;
- live provider tests;
- coding eval suite.

The approved [experience-polish implementation plan](docs/plans/experience-polish.md)
turns this milestone into 20 complete user journeys, covering startup, auth/model
continuity, input preservation, progress, recovery, inspection, and returning to
saved work. Each ticket has observable acceptance criteria and concrete test
scenarios. Its installed-journey gate remains open until required real-use
evidence passes; implementation completion alone is not daily-driver readiness.

---

# 92. v1.0 release bar

Schway v1 is reached when Schway functions reliably as a daily-driver coding harness and its public seams are stable enough for extension authors.

Required gates:

## Dogfood

Schway is used to develop Schway itself as a primary tool over an extended period.

## Reliability

No known serious defects involving:

- corrupted sessions;
- missing tool results;
- edits applied to wrong files;
- broken resume state;
- invalid compaction reconstruction.

## Capability

Coding evals remain consistently successful across supported providers.

## Extensibility

The external workflow:

```text
grill
→ spec
→ tickets
→ implement
→ review
```

can be implemented entirely using skills/extensions without special-case Schway core behavior.

## Stability

The following are stable enough to support migration/semver expectations:

- session format;
- extension API;
- config format;
- core tool semantics.

---

# 93. v1 non-requirements

v1 does not require built-in:

- MCP;
- subagents;
- browser;
- Elysia server;
- sandbox;
- permission framework;
- worktrees;
- persistent memory;
- workflow engine.

These remain optional.

---

# 94. Architectural invariants

The following should be treated as long-term invariants unless deliberately revised by a future design process.

### 94.1 Schway owns the agent loop.

No provider SDK or orchestration framework owns agent execution.

### 94.2 The agent loop remains conceptually simple.

Complex behavior belongs around the loop.

### 94.3 Fresh Schway is useful without extensions.

Extensions expand capability; they do not complete an otherwise-empty kernel.

### 94.4 Core is not "everything is a plugin."

Only intentional public seams are extensible.

### 94.5 Provider-specific details stop at adapters.

Core conversation/session/tool logic remains provider-independent.

### 94.6 Session history remains inspectable.

Durable state uses straightforward versioned JSONL.

### 94.7 Runtime events and durable session records are different concepts.

Do not persist every transient event.

### 94.8 User project instructions use standard formats where available.

Prefer `AGENTS.md` and Agent Skills rather than proprietary equivalents.

### 94.9 Tool output is always bounded.

No built-in tool may flood model context without limit.

### 94.10 Extension power must remain explicit.

Executable extensions are installed/enabled intentionally.

### 94.11 Optional complexity stays off the base path.

Heavy extensions are acceptable; heavy default startup is not.

### 94.12 Framework dependencies must never become architectural owners.

OpenTUI is a renderer.

Provider SDKs are protocol clients.

TypeBox is a schema implementation tool.

Bun is the runtime.

None defines Schway's architecture.

---

# 95. Product definition

Schway is:

> A fast, hackable, batteries-included coding harness with a deliberately simple agent loop and powerful optional composition.

Its primary design influences are:

```text
Pi
→ simplicity
→ coding usability
→ hackability
→ skills
→ lightweight sessions

Codex
→ practical workspace behavior
→ nested AGENTS.md semantics
→ Git-aware CLI ergonomics
→ subscription-auth requirement

DeepSeek Harness
→ clean capability seams
→ parallel/exclusive tool scheduling
→ runtime/persistence separation
→ explicit interception semantics
```

Schway adopts useful lessons from these systems without inheriting their full accumulated complexity.

---

# 96. Implementation rule

When a future implementation choice is unclear, prefer the option that preserves these priorities in order:

1. real-world usability;
2. correctness and recoverability;
3. simple mental model;
4. hackability;
5. runtime efficiency;
6. extensibility;
7. architectural elegance.

Architectural purity must not make Schway harder to use.
