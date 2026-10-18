# Extension requests, tools, commands, and runtime observation

Load an explicitly enabled local TypeScript module with `--extension path.ts`.
Its default `defineExtension` initializer receives the public contract from
`schway/extensions`. Initializers run in flag order before model requests. Tool,
command, prompt, request hook, tool hook, observer, and disposal registration closes when the initializer returns.
All registrations are staged together; any invalid or conflicting declaration
fails startup even if the initializer catches the registration exception.

```ts
import { defineExtension } from "schway/extensions";

export default defineExtension((extension) => {
  extension.registerCommand({
    name: "ask-extension",
    description: "Ask through the current conversation",
    arguments: "<prompt>",
    execute(args, command) {
      command.signal.throwIfAborted();
      if (!args) return "Usage: /ask-extension <prompt>";
      command.submitPrompt(args);
      return "Submitting your prompt.";
    },
  });

  const unsubscribe = extension.onRuntimeEvent((event, { signal }) => {
    if (signal.aborted) return;
    // Update local counters or perform brief observation here.
    // Never print to stdout: headless --json reserves it for native JSONL events.
    if (event.type === "agent.finished") {
      // event.reason is the same value emitted to native consumers.
    }
  });
  extension.onDispose(unsubscribe);
});
```

## Public API

Extension exports from `schway/extensions` are public and semver-versioned; the
separate [application host](host.md) entry is `schway/host`. All other
imports are private. The package ships emitted `.d.ts` declarations; consumers
need no `allowImportingTsExtensions` setting or ambient Node/Bun type package.
The standard TypeScript `ESNext` and `DOM` libraries supply the required types,
including `AbortSignal`. `ToolContext.env` is a string-keyed map of strings or
`undefined`. Extensions that use Bun APIs in their own code still need
`@types/bun` for those APIs. Both TypeScript `bundler` and `nodenext` module
resolution are supported.

The checked-in [API report](../api/extensions.api.md) guards the complete reachable
surface. Run `bun scripts/extension-api-report.ts` to check it or append `--update`
after an intentional public contract change.

| Export | Contract |
| --- | --- |
| `AfterToolHook` | Transform settled output; returned isError sets terminal status, outcome.status stays original, and execution is never replayed. |
| `AfterToolInput` | Settled execution status with the current model-facing presentation, copied for each afterTool handler. |
| `ApprovalMode` | User-selected handling of tools that can change state. |
| `AssistantContent` | Allowed assistant content block: text, reasoning, or a requested tool invocation. |
| `AssistantMessage` | Assembled assistant output with ordered content blocks and opaque metadata retained for adapter replay. |
| `AssistantTelemetry` | Harness-measured timing and reported usage of the model call that produced a message; never sent to a provider. Durations are whole milliseconds. |
| `BeforeAgentHook` | Append turn-only sections, deny the turn, or leave the preceding hook's result unchanged. |
| `BeforeAgentInput` | Detached user input and accumulated turn-only context, supplied once per submitted turn. |
| `BeforeModelHook` | Replace ephemeral request data, deny the request, or retain the preceding hook's result. |
| `BeforeToolHook` | Replace tool arguments in load order, deny with an explanation, or leave the invocation unchanged. |
| `BeforeToolInput` | Detached validated invocation metadata; only an explicit arguments return may change execution input. |
| `CompactionReason` | Reason a compaction runs; surfaced to presentation clients and events. |
| `ContextHook` | Transform prepared dynamic sections in order while preserving each existing section's name. |
| `ContextSection` | Named block of volatile context sent with a model request. |
| `ConversationItem` | Provider-independent message or tool outcome that may be included in model context. |
| `DeepReadonly` | Preserve event shapes while making every nested property readonly. |
| `defineExtension` | Type-check and return an extension initializer without running it. |
| `Extension` | Default module initializer that registers capabilities without replacing harness infrastructure. |
| `ExtensionCommand` | Declare an interactive slash command with a raw trailing-argument handler and optional help usage. |
| `ExtensionCommandContext` | Limited capabilities for an idle interactive command; a queued prompt runs after successful completion. |
| `ExtensionContext` | Capabilities available while an explicitly enabled extension initializes, owned until runtime disposal. |
| `ExtensionDenial` | Deny an agent turn or model request with a nonempty explanation shown to the user. |
| `ExtensionEvent` | Recursively readonly event data, detached from authoritative runtime and session objects. |
| `ExtensionEventListener` | Observe native runtime events sequentially, using the signal to stop work on unsubscribe or session disposal. |
| `ExtensionModelRequest` | Detached provider-independent request with a cancellation signal owned by Schway; Schway adds hosted tools after hooks, so hooks never see or set them. |
| `HostedTool` | Provider-hosted read-only lookup a model may run inside one response; a closed union that adapters may ignore. |
| `JsonSchema` | JSON Schema object used as a public tool input contract. |
| `ModelRequest` | Provider-independent model request built by the agent loop. |
| `ModelTool` | Tool description sent to a provider adapter. |
| `ModelUsage` | Reported token counts for one provider attempt; null or absent means that dimension was not reported, while 0 means the provider reported none. |
| `ProviderMetadata` | Opaque adapter-owned data preserved alongside Schway's provider-independent conversation records. |
| `RuntimeEvent` | Normalized runtime events for TUI, headless `--json`, and diagnostics. |
| `TextContent` | Plain text carried in a user or assistant message. |
| `ThinkingContent` | Assistant reasoning text with optional opaque metadata needed for provider replay. |
| `ThinkingLevel` | User-facing reasoning level shared by all providers without assuming identical wire semantics. |
| `ToolCallContent` | Requested tool invocation whose id links its result and whose arguments require tool-schema validation. |
| `ToolCallStatus` | Outcome recorded for an accepted tool call. |
| `ToolContext` | Per-invocation context passed into every tool. |
| `ToolDefinition` | Public tool contract: schema for the model, execute for the harness. |
| `ToolEffect` | State-change declaration used by approval modes, independently of scheduling. |
| `ToolExecutionMode` | Declare whether sibling calls may overlap or must run behind an exclusive barrier. |
| `ToolExecutionResult` | Result of a single tool `execute` call, before it is stored on the session. |
| `ToolOutputChunk` | A stdout or stderr chunk emitted while a tool is running. |
| `ToolResult` | Model-facing outcome linked to a tool-call id, with errors marked explicitly. |
| `ToolTelemetry` | Harness-measured timing of one tool call from scheduler start to settlement, in whole milliseconds; never sent to a provider. |
| `UserContent` | Content accepted in user messages, currently limited to plain text. |
| `UserMessage` | Identified user input stored in session history and sent to the model. |
| `Workspace` | Workspace directories whose primary root anchors relative tool paths, with launch location and optional extra roots. |

## Registration methods

`ExtensionContext` provides these methods during initialization, plus the readonly
runtime lifetime `signal`. Await initialization work before returning.

| Method | Contract |
| --- | --- |
| `registerPrompt` | Add one named dynamic section to normal requests. |
| `beforeAgent` | Add context or deny once per submitted turn. |
| `context` | Transform assembled dynamic sections in order. |
| `beforeModel` | Transform or deny a native model request. |
| `beforeTool` | Rewrite validated arguments or deny a tool call. |
| `afterTool` | Transform settled tool output without replaying execution. |
| `registerTool` | Register a schema and executable tool before initialization ends. |
| `registerCommand` | Register an idle interactive slash command. |
| `onRuntimeEvent` | Subscribe to detached events and return an unsubscribe function. |
| `onDispose` | Register cleanup for failed initialization or runtime disposal. |

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
enabled separately through [`config.json`](#installed-npm-packages). There is no
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
    effect: "read-only",
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
works too. Tool registration accepts optional `effect: "read-only" | "mutating"`; an omitted effect means `"mutating"`. Invalid declarations fail startup. Declare read-only only for tools that do not change state. The declaration is public extension metadata and never reaches a provider.

The registration context exposes `registerTool`, `registerCommand`,
`registerPrompt`, `beforeAgent`, `context`, `beforeModel`, `beforeTool`, `afterTool`, `onRuntimeEvent`,
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

See [observers and disposal](#observers-and-disposal) for lifecycle details. The
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

## Prompt contributions and native request hooks

Register these capabilities during initialization through `schway/extensions`:

| Registration | Input | Accepted return |
| --- | --- | --- |
| `registerPrompt(section)` | `{ name: string, content: string }` | No handler; a detached section is added to each normal request |
| `beforeAgent(hook)` | `{ message: UserMessage, context: ContextSection[], signal }` | `{ context: [...] }`, `{ deny: "explanation" }`, or `undefined` |
| `context(hook)` | `{ context: ContextSection[], signal }` | The next section list, or `undefined` |
| `beforeModel(hook)` | `{ systemPrompt, context, items, tools?, signal }` | The next complete native request, `{ deny: "explanation" }`, or `undefined` |

Handlers may return promises. Each phase runs in extension load order and then
registration order within that extension, awaiting every handler before the next.
Later handlers see earlier accepted changes. `undefined` means no change, even
if the handler mutated its input. Inputs and accepted outputs are detached copies;
retained references cannot alter durable records or later requests.

`beforeAgent` runs once per submitted user turn, before the first model request.
`message` is a copy of the submitted user message and cannot be rewritten through
this phase. Its `context` starts empty. Return the accumulated list with additions
appended; preceding sections must remain unchanged. Turn context survives tool
rounds and overflow recovery, then is discarded when the turn ends. New or resumed
turns start fresh. Denials require a nonempty explanation and stop the affected
turn without sending an ordinary model request.

`registerPrompt` names must be unique across enabled extensions. Schway reserves
`environment`, `project-instructions`, `available-skills`, `active-skill`,
`summary`, and `schway-local-date`; prompt and turn contributions cannot claim
these names. Duplicate prompt registration reports both source paths. Before
each logical request, Schway prepares ordinary environment, applicable project
instructions, skill metadata/body, and any compaction summary, then the local
date (`schway-local-date`), which is always the last Schway section and stays
fixed for the whole user turn. It then appends registered prompts and turn
context. The `context` waterfall receives all of them. It may modify content,
reorder sections, or append sections; every existing name must occur exactly once.
This keeps structural sections identifiable throughout interception.

`beforeModel` runs after the context waterfall. Its native `items` are conversation
records (`user`, `assistant`, and `tool_result`), never provider wire messages or
durable compaction markers. Tool results from earlier user turns arrive shortened
as described in [replay earlier results](tools.md#replay-earlier-results); the
durable session keeps them in full. It may transform the ephemeral system prompt, context,
and conversation. Keep existing context names and complete tool-call/result groups.
The return must keep the exact supplied `signal`; spreading the input request is
the simplest way to do that. Extra request or conversation fields are rejected.
Opaque native `providerMetadata` is retained for replay, not a provider-payload
interception API. Schway attaches its prompt-cache key after `beforeModel`
returns, so hooks never see it and cannot set or change it (see
[prompt cache key](configuration.md#prompt-cache-key)). Hosted tools work the
same way: Schway sets the optional `ModelRequest.hostedTools` (such as
`["web_search"]`) on the request `beforeModel` returns, from its
[web search](configuration.md#web-search) decision for the session. The hook
input never has the field, so a hook cannot add, remove or change it, and a
result that sets `hostedTools` is rejected as an unsupported field with the
usual extension error. It is attached even when no `beforeModel` hook is
registered. `ExtensionModelRequest` therefore omits `hostedTools`. An extension
tool named `web_search` keeps its name; Schway then sends no hosted search for
that session. Public types include `BeforeAgentInput`, `BeforeAgentHook`,
`ContextHook`, `BeforeModelHook`, `ExtensionModelRequest`, `ExtensionDenial`,
`ContextSection`, `ConversationItem`, `UserMessage`, `ModelTool`, and
`HostedTool`.

The optional `tools` list contains descriptions only. A hook may select or reorder
registered definitions, including `activate_skill`, or return an empty/omitted
list. It cannot invent tools, duplicate names, or alter names, descriptions, or
schemas. Schway's executable registry and durable session remain unchanged.

Transport retries reuse the same prepared request without rerunning hooks.
Overflow recovery compacts, rebuilds normal context, and reruns `context` and
`beforeModel`; it does not rerun `beforeAgent`. Pressure, manual, and overflow
summarization use Schway's internal model request directly, without extension
prompt contributions or hooks. Normal skill and extension context is reassembled
afterward. System override files still supply the base system prompt before
interception; replacing that prompt does not remove structural context.

Throws, rejected promises, and invalid returns stop the affected request with a
source-labelled phase error and retry/disable guidance. Errors redact configured
credentials and are bounded to 50,000 characters. Later valid turns remain usable;
already accepted tool calls have settled before the next request hook runs.
Each invocation receives the turn/runtime cancellation signal. Cancellation stops
waiting even for an unresolved hook promise and observes any late rejection.
Extensions must still stop their own side effects when the signal aborts.

The installed package includes `examples/extensions/context.ts`, exercising all
three hooks and prompt contributions. Copy it into a project with Schway installed:

```sh
schway -p "Explain this project" --extension ./context.ts
# From this repository:
bun run dev -- -p "Explain this project" --extension examples/extensions/context.ts
```

For a request policy, a hook can return `{ deny: "Explain why this request cannot
proceed." }`. Denial is a user-visible failure, not an assistant answer, and does
not change the submitted durable user message.

## Tool argument and result hooks

For each tool call, evaluation follows this order:

1. Validate the original tool name and arguments.
2. Run the `beforeTool` waterfall, validating every returned argument replacement.
3. Make the approval decision using the final arguments. For `effect: "mutating"`
   or an omitted `effect`, `read-only` denies, `ask` prompts interactively (unless
   a session allowance applies) or denies headless, and `auto` allows.
   Tools declaring `effect: "read-only"` can execute in all three modes.
4. Execute the approved call.
5. Run the `afterTool` waterfall on the settled result.

An extension tool that declares no `effect` is treated as able to change state.
Neither approval denials nor read-only denials run `execute` or `afterTool`.
With parallel calls in `ask` mode, later calls' `beforeTool` hooks can run before
earlier approvals resolve; approval requests themselves are presented in source
order. Exclusive barriers and the concurrency limit still apply.

These contracts are pinned by `tests/extension-tool-hooks.test.ts` (read-only
checks after rewrites, ask denial skips execution and result hooks, and omitted
effects), `tests/tool-registry.test.ts` (effect defaults), and
`tests/tui-approval.test.ts` (parallel hooks with ordered approvals).

`beforeTool(hook)` and `afterTool(hook)` cover every registered executable,
including native file tools and `activate_skill`. Public types are
`BeforeToolInput`, `BeforeToolHook`, `AfterToolInput`, and `AfterToolHook`.
Both phases run in extension load order, then registration order, and await
each handler. Inputs and accepted outputs are detached; `undefined` keeps the
preceding value even if the handler mutated its input.

`beforeTool` receives `{ id, name, arguments, inputSchema, execution, signal }`.
Schway first validates the original tool name and arguments. Unknown names and
invalid original arguments produce ordinary tool errors without invoking hooks.
Return `{ arguments: replacement }` to replace finite JSON arguments, or
`{ deny: "explanation" }` to deny the invocation. Each replacement is validated
against the registered schema before another hook sees it and again before
execution. ID, name, schema, and execution mode cannot be replaced. Invalid
returns, denial, and exceptions settle one source-labelled bounded error without
running the tool or `afterTool`.

`afterTool` additionally receives `outcome: { status, content, isError, details? }`
and the arguments actually passed to execution. It runs after executed successes,
returned tool errors, and thrown execution errors. It does not run after rejected
original inputs, before-hook failures, approval or read-only denials, or cancelled execution. Return
`{ content: "replacement", isError?, details? }` to replace the presentation.
Omitting `isError` preserves its preceding value; omitting `details` removes
preceding details. `outcome.status` always reports the original execution status,
even after another hook changes error presentation. Final `tool.finished.status`
follows the transformed `isError`. Hooks cannot supply a status, change result or
call IDs, discard a result, or turn an unfinished invocation into a success.

Text is bounded to 50,000 characters after masking configured credentials.
Details must be JSON-serializable; nested string keys and values are redacted,
and details exceeding 50,000 serialized characters become a bounded
`{ truncated: true, preview }` object. Details remain runtime-only. Durable
records retain the original requested arguments and exactly one transformed
result per call in source order, regardless of completion order.

If `afterTool` throws or returns an invalid value, execution is never replayed.
One error explains that execution occurred, effects may already apply, and the
original outcome should be inspected before retrying. `tool.finished.details`
contains `{ afterToolFailure: true, execution: { status, content, isError, details } }`
with a detached, bounded, redacted original outcome. This diagnostic does not
change the durable session format or roll back filesystem changes.

The scheduler owns the entire before/execute/after sequence. An exclusive tool
holds its barrier through both waterfalls; independent parallel calls can run
their hooks concurrently. Extension authors must coordinate shared mutable
state and stop asynchronous work when the supplied signal aborts. These trusted
local hooks provide policy building blocks alongside Schway approval modes; they are not a sandbox. The approval decision runs after `beforeTool` hooks and re-validation, using the final arguments, before undo capture or execution. In ask mode, prompts show the final arguments after `beforeTool`; session allowances live only in the interactive controller and extensions receive no approval or confirm UI API. Headless ask denies mutations immediately. In read-only mode, mutating tools are refused without running `execute` or `afterTool`. A hook denial takes precedence over the mode denial.

Cancellation or runtime disposal before execution prevents execution and skips
remaining hooks. Cancellation may stop waiting for an uncooperative hook, with
late rejections observed. Actual tool execution is always awaited so its effects
settle once before a slot is released. If execution resolves despite cancellation,
its settled result is preserved. Cancellation during `afterTool` discards partial
transformations, preserves the original settled execution outcome, and skips
remaining hooks; queued calls settle as cancelled without running.

The shipped `examples/extensions/tool-policy.ts` denies `bash`, strips an initial
`./` from edit paths, and annotates settled results:

```sh
bun run dev -- -p "Use edit to replace before with after in ./note.txt" --extension examples/extensions/tool-policy.ts
# Installed package: copy the example beside your project, then use --extension ./tool-policy.ts.
```

## Interactive commands

`ExtensionCommand` has `name`, `description`, optional `arguments` help text,
and `execute(args, context)`. Names use 1–64 lowercase letters, digits, or
hyphens, beginning with a letter or digit. The handler receives the raw trailing
arguments, with outer whitespace trimmed; quoting and argument validation belong
to the handler. `/help` shows usage, description, and canonical extension path.

Built-in slash names are reserved. A command cannot shadow a discovered skill
(including ambiguous skill names) or another enabled extension. Diagnostics name
both conflicting owners. Skills are checked again at invocation against the active
session workspace, so `/new`, `/resume`, or newly installed skills cannot make
registration order silently choose a command winner. Commands are interactive;
headless `-p` remains the ordinary prompt/skill interface.

Handlers run only while the controller is idle, sharing the editor's busy and Esc
cancellation behavior. Busy invocation retains the editor input. A handler can
return a string for display, return nothing, or queue one nonempty normal prompt
through `context.submitPrompt(text)`. The prompt runs through Schway's controller
and agent loop only after the command succeeds. Errors, cancellation, replacement,
and disposal discard it. Retained prompt capabilities close when the handler
settles or its owner is cancelled; multiple prompt submissions are rejected.
Strings and errors are bounded to 50,000 characters and redact known credentials.
Command failures identify their extension and leave the editor usable.

## Usage and timing fields

These optional fields were added without changing any existing field, so
extensions that build `ModelUsage` with two fields or ignore the new ones keep
working.

- `ModelUsage.cachedInputTokens` is the part of `inputTokens` the provider
  served from its prompt cache, and `ModelUsage.reasoningTokens` is the part of
  `outputTokens` it reports as reasoning. Both are subsets, never added to their
  totals. `null` or absent means not reported; `0` means reported as none. The
  Responses adapters (OpenAI, xAI and the Grok subscription route) and the
  ChatGPT subscription adapter parse them; the OpenAI-compatible adapter does
  not report them yet.
- `ModelUsage.hostedSearchCalls` counts the hosted web searches a response
  returned that Schway kept, and is absent when there were none.
  `ModelUsage.reportedHostedSearchCalls` is the provider's own counter of
  executed web searches (xAI's `server_side_tool_usage_details.web_search_calls`),
  present only when the provider reports it. Neither is ever inferred. Kept
  hosted items live in the assistant message's `providerMetadata` under the
  provider's namespace, as `hosted_items`, and adapters replay them; treat them
  as opaque.
- `AssistantMessage.telemetry` (`AssistantTelemetry`) and `ToolResult.telemetry`
  (`ToolTelemetry`) are measured by the harness, never by adapters, and never
  sent to a provider. See [call telemetry](sessions.md#call-telemetry) for their
  fields, units and null semantics. A `beforeModel` hook sees them on items in
  `request.items`; adapters ignore them.
- The `model.usage` event adds `startedAt`, `firstDeltaMs` (null when no text
  or thinking delta arrived) and `attemptMs` for every turn attempt, including
  failed and cancelled ones. A failed attempt followed by a retry backoff also
  carries `retryWaitMs`, the backoff actually waited, even when cancellation cut
  it short. Compaction usage events carry none of them.
- The `tool.finished` event adds `startedAt`, `durationMs` and, when the call
  waited for approval, `approvalWaitMs`. They are absent for calls that never
  ran, such as unknown tools or invalid arguments.

## Observers and disposal

`onRuntimeEvent(listener)` returns an idempotent unsubscribe function. Its
`ExtensionEvent` argument is a readonly view of the canonical `RuntimeEvent`
union: agent/model/tool/compaction events and errors. Runtime events are not
durable session records. Each notification is detached from authoritative data,
redacted for known credentials, and deeply frozen. Mutation attempts, synchronous
throws, and asynchronous rejections are caught for each listener and diagnosed
with its extension identity. They cannot change the original event, model/tool
result, session record, or agent outcome.

Delivery is asynchronous and ordered per listener. A slow listener does not gate
another listener or the model/tool loop. Each listener may retain one executing
notification plus at most 128 queued notifications totalling 256,000 serialized
characters. Oversized or overflow notifications are dropped, with an immediate
diagnostic and a total count when the queue drains or is cleared. Queued events
discarded at unsubscribe, session replacement, or runtime disposal are reported.
This is best-effort observation, not a lossless audit log or an intervention hook.
Use authoritative JSONL/session output for complete results.

Each listener invocation receives `{ signal }`. Unsubscribe and runtime disposal
abort current work and clear pending notifications. Session replacement does the
same while preserving exactly one subscription for each registered listener;
late events from a draining old turn cannot enter the new session's observation
stream. Resuming a session does not replay old events or tool effects.

`extension.signal` lasts for the whole loaded runtime. Use it for other owned
asynchronous resources. `onDispose(cleanup)` runs registered callbacks once on
failed startup or runtime disposal, including headless early returns. Cleanup
may return a promise; its rejection is caught, but shutdown does not wait on it.
Release handles synchronously where possible. Observer/command waits also settle
on cancellation even if extension promises do not. Extensions must still stop
their own asynchronous work and side effects when signals abort. This shared
JavaScript runtime cannot forcibly stop synchronous loops or uncooperative code.

Headless observer diagnostics go to stderr. TUI observer diagnostics appear as
system notices and do not mark successful agent turns as errors. Disposal detaches
controller diagnostic handlers before asynchronous cleanup can complete.

## Run the example

The installed package includes `examples/extensions/commands-and-events.ts`:

```sh
schway --extension ./commands-and-events.ts
# /help
# /event-counts
# /ask-extension explain this project
```

From the repository, run `bun run dev -- --extension
examples/extensions/commands-and-events.ts` on one line.

## Installed npm packages

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
  "peerDependencies": { "schway": "^1.0.0-rc.2" },
  "schway": {
    "extensions": ["extensions/main.ts"],
    "skills": ["skills/review"]
  }
}
```

Each extension entry is a module file with the default initializer described
in [local TypeScript extensions](#local-typescript-extensions); each skill entry is a directory containing `SKILL.md`. Either array may
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

### Package resolution and lifecycle

A config file's `packages` array enables installed npm package names in that
scope. Project packages resolve directly in `<workspace-root>/node_modules`;
user packages resolve in `~/.schway/node_modules` (install with
`npm install --prefix "$HOME/.schway" schway <package>`). No installer or arbitrary
node_modules scan runs inside Schway.

A package's `schway` manifest accepts `extensions` (module files) and `skills`
(skill directories containing `SKILL.md`). Entries are package-relative and must
remain within the canonical package root. Schway validates every enabled manifest,
path, and declared `peerDependencies.schway` range before importing any extension.
Use `schway/extensions` from the installed Schway peer; keep other package
requirements in your own `dependencies`. Declaring Schway in `dependencies`,
`optionalDependencies`, `bundleDependencies`, or `bundledDependencies` is
rejected to avoid bundling a second harness. Peer ranges must be valid npm
semver ranges; package aliases, protocols, and dist-tags are rejected. Skills-only manifests execute no
JavaScript entrypoint or lifecycle scripts during discovery.

Initializers run global packages, then project packages, then explicit CLI modules;
list order and manifest order are preserved. Canonical executable duplicates
across these groups fail with both owners reported. Skill precedence is independent:
project directories, project packages, global directories, global packages. Names
ambiguous at the winning tier are unavailable until the duplicate is removed.

Interactive session switches stage fresh capabilities, then dispose the old
runtime only after success. Failure or cancellation disposes staged registrations
and retains the previous session. Late registrations from a cancelled initializer
are rejected. Initializers are trusted code: the host cannot undo arbitrary module
side effects, so use `onDispose` and the lifetime signal for owned resources.

See [the runnable mixed package](../examples/packages/greeting/package.json) and
[installation and enablement instructions](#installed-npm-packages).

Test coverage for this guide: [release verification](release-verification.md#extensions).

See the [stability policy](stability.md) for compatibility promises.
