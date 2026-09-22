# Agent Skills

Schway discovers reusable instructions in project `.agents/skills/<name>/SKILL.md`
and user-global `~/.schway/skills/<name>/SKILL.md`. Project definitions take
precedence over global definitions with the same name. Discovery advertises
eligible names and descriptions; bodies enter dynamic context only on activation.

## Try a skill

From your project root:

```sh
mkdir -p .agents/skills/review
cat > .agents/skills/review/SKILL.md <<'EOF'
---
name: review
description: Review changes for correctness and missing tests.
---
Read the diff and relevant tests. Explain concrete correctness problems,
including a reproducible trigger and the affected file.
EOF
schway -p "/skills"
schway -p "/review check the current changes"
schway -p "Use the review skill to check the current changes."
```

Listing requires no model. The last two commands require a configured provider;
the slash form explicitly activates the skill, while an ordinary prompt lets the
model request activation. In a source checkout, replace `schway` with
`bun run dev --`. Interactive `/skills` and `/review ...` work the same way.

Add `disable-model-invocation: true` to frontmatter for a user-only workflow.
The `user-only: true` alias is also accepted. It remains listed to users and can
be invoked with `/review ...`, but the model cannot activate it. Hiding its name
from model metadata is accompanied by an execution-time eligibility check.

## Model activation

The native `activate_skill` tool accepts exactly one argument:

```json
{"name":"review"}
```

The name must be a discovered lowercase skill token, up to 64 characters.
Paths, additional arguments, unknown names and unavailable definitions are
rejected. Discovery and loading use the same precedence and canonical resource
directory as explicit user invocation. Eligibility is checked again in the file
read for activation, including when that skill is already active. A user-only
skill cannot be activated through a directory alias or resource path.

The operation uses Schway's normal validated tool request/result path. Its
exclusive execution mode waits for preceding sibling tools, then completes
before later tools start. A successful result says
`Activated skill 'review' for this user turn.` The body appears once in the
`active-skill` section of the next model request. Project instructions and
system prompt overrides remain separate and continue to apply.

## Lifetime and failures

One skill is active per submitted user turn, across all model/tool rounds in
that turn. Activating a different canonical skill directory replaces the prior
body. Repeating the same identity validates it again and keeps the already
loaded body snapshot, without duplicating context. To pick up body edits for
the same active identity, invoke it in a new user turn.

Pressure, manual and overflow compaction keep the active body for the rest of
the turn. The body is excluded from durable messages and compaction input.
Only the ordinary invocation/tool call and short result are saved; there is no
persisted activation flag. A resumed conversation therefore starts without
active instructions, even when its history contains earlier invocations. The
user or model may activate a skill again.

Completion, cancellation, errors and the model-round limit clear active context.
New sessions, resume and terminal disposal also clear it. Late completion of an
old turn cannot replace or clear a later turn's activation. There is no separate
deactivation command; activation ends with the user turn or is replaced by
another eligible skill.

Failed replacement leaves the prior valid body intact until normal turn cleanup.
User-only targets, unknown names, changed canonical sources or names, unreadable,
invalid, empty and oversized bodies return tool errors. Bodies are limited to
32,000 characters and activation diagnostics to 1,000 characters. Cancellation
returns the standard `Tool call cancelled` result, and accepted sibling calls
settle before the turn exits. Activating a user-only skill explicitly does not
grant the model permission to activate other user-only workflows.

## Native contracts

- `prepareSkillInvocation` and `loadSkillBody` accept `modelInvocation: true`
  to enforce eligibility and an optional `AbortSignal`. Explicit invocation is
  the default; both routes share discovery and body validation.
- `ContextManager.activateSkill(name, { signal })` validates and replaces
  volatile context only on success. `setActiveSkill` attaches an explicitly
  prepared user invocation; `clearActiveSkill` invalidates pending replacements.
- `ContextManager.beginTurn()` retains a prepared explicit activation and
  returns cleanup scoped to that turn. `runAgentLoop` owns this cleanup in
  `finally`, and binds the native activation tool to its current manager without
  changing the caller's tool registry. Loop consumers must drain cancellation
  events so every accepted tool call can settle. Keep each explicit invocation's
  manager paired with its session until its caller finishes cleanup; the app
  creates a fresh manager on new/resume.
- Skill resources resolve relative to their canonical skill directory and
  continue to load on demand. Skills remain instructions; the core does not
  interpret workflow steps or implement a workflow engine.

Run deterministic coverage with `bun test tests/skill-activation.test.ts tests/skills.test.ts`
and `bun run typecheck`. The tests use scripted models,
temporary skill files, and persisted JSONL; they do not establish live-provider
or human dogfood results.
