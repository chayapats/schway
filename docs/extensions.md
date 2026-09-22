# Extension commands and runtime observation

Load an explicitly enabled local TypeScript module with `--extension path.ts`.
Its default `defineExtension` initializer receives the public contract from
`schway/extensions`. Initializers run in flag order before model requests. Tool,
command, observer, and disposal registration closes when the initializer returns.
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

## Runnable example and verification

The installed package includes `examples/extensions/commands-and-events.ts`:

```sh
schway --extension ./commands-and-events.ts
# /help
# /event-counts
# /ask-extension explain this project
```

From the repository, run `bun run dev -- --extension
examples/extensions/commands-and-events.ts` on one line. Deterministic tests use
the real controller and loop with scripted models, including cancellation,
collisions, listener failures/mutation, bounded queues, JSONL parity, and new/resume
cleanup. They do not provide live-provider or human terminal validation.
