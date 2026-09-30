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
`environment`, `project-instructions`, `available-skills`, `active-skill`, and
`summary`; prompt and turn contributions cannot claim these names. Duplicate
prompt registration reports both source paths. Before each logical request,
Schway prepares ordinary environment, applicable project instructions, skill
metadata/body, and any compaction summary, then appends registered prompts and
turn context. The `context` waterfall receives all of them. It may modify content,
reorder sections, or append sections; every existing name must occur exactly once.
This keeps structural sections identifiable throughout interception.

`beforeModel` runs after the context waterfall. Its native `items` are conversation
records (`user`, `assistant`, and `tool_result`), never provider wire messages or
durable compaction markers. It may transform the ephemeral system prompt, context,
and conversation. Keep existing context names and complete tool-call/result groups.
The return must keep the exact supplied `signal`; spreading the input request is
the simplest way to do that. Extra request or conversation fields are rejected.
Opaque native `providerMetadata` is retained for replay, not a provider-payload
interception API. Public types include `BeforeAgentInput`, `BeforeAgentHook`,
`ContextHook`, `BeforeModelHook`, `ExtensionModelRequest`, `ExtensionDenial`,
`ContextSection`, `ConversationItem`, `UserMessage`, and `ModelTool`.

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
original inputs, before-hook failures, or cancelled execution. Return
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
local hooks provide policy building blocks, not a sandbox or a built-in
permission framework.

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
[installation and enablement instructions](../README.md#installed-skill-and-extension-packages).

Test coverage for this guide: [release verification](release-verification.md#extensions).
