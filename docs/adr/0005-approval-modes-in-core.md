# Keep approval modes in core

Users need a way to inspect work before a tool can change state, including when no extensions are installed. The 0.6 milestone will add three fixed approval modes in core: `auto` (the default, preserving today's behavior), `ask`, and `read-only`. This is an accepted decision that is not yet implemented.

Each tool declares whether it reads only or can change state. Built-ins `read`, `grep`, `find` and `ls` read only; `edit`, `write` and `bash` can change state. An extension tool without a declaration counts as able to change state. This declaration is part of the public extension API and freezes with it. Effect declarations from extensions are trusted. Read-only mode does not isolate arbitrary side effects from extension code, including hooks. The existing `execution` declaration controls scheduling (parallel or exclusive); it is separate from the effect declaration used for approval.

Read-only tools run in all three modes. For tools that can change state, `auto` runs them, `ask` requests approval, and `read-only` refuses them. Extension before-tool hooks run first and may rewrite arguments or deny execution. The approval decision applies to the final validated arguments, then the tool runs if allowed. A denial becomes an error tool result carrying the user's reason.

Headless execution accepts `--approval auto|ask|read-only`. In `ask`, a tool that needs approval is denied with `approval required; headless cannot ask`; it never waits. Denials appear in JSONL runtime events.

Shift+Tab cycles the mode for the process. `approval.mode` in config sets the default. The approval prompt keeps the composer draft, following existing panel conventions and [ADR 0002](0002-ordinary-draft-recovery.md). It neither accepts nor discards the draft. V1 has no extension-facing UI or confirm API.

## Consequences

This deliberately narrows the original section 4 non-goal of a built-in permission framework. These are three fixed toggles without per-path rules, command allowlists or a policy language, and safety cannot depend on an optional extension. Approval settings do not change the model/auth choice or credential precedence in [ADR 0001](0001-interactive-choice-memory.md).

## Note: `web_fetch` (#318)

The built-in `web_fetch` tool joins the tools that read only. It declares `effect: "read-only"` and `execution: "parallel"`, so it runs without a prompt in all three modes, and the decision above is unchanged. Reading only is not the same as staying offline: a fetch sends its URL to a remote host, so in `ask` and `read-only` the model can put workspace content into a URL without approval. The configuration, headless and [tools](../tools.md#fetch-web-pages) docs say so. Loopback and private addresses stay reachable. `bash` keeps `effect: "mutating"` and `execution: "exclusive"`; scheduling stays separate from effect, and no shell command is classified as read-only.
