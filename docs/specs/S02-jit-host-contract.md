# S02 — Schway public host contract for Jit

Tracker: https://github.com/chayapats/schway/issues/393

Owner: Schway. Status: ready for ticket breakdown; new public API remains a proposed contract until implementation review. This specification authorizes design work, not runtime changes or live inference.

## Problem Statement

Jit needs to run independent project specialists through Schway while controlling tools, context sources, persistence and credentials. Schway currently exposes a stable extension surface but no supported embedding lifecycle. A CLI wrapper or private imports would make Jit depend on internals and cannot establish the required context/tool policy.

The existing context manager discovers AGENTS.md and skills from its workspace. A PR reviewer must be able to read such files as untrusted evidence without activating their instructions, packages or code.

## Solution

Expose a versioned, headless host entry point for trusted applications. The host selects an auth route/model, session, trusted context sources, tool capabilities and finite limits. Schway continues to own model requests, context budgeting/compaction, native conversation persistence, tool scheduling, retries and cancellation.

The proposed package entry point is schway/host. Naming and exact TypeScript signatures are settled in the public API ticket; the behavior below is the compatibility contract. Jit remains responsible for groups, project memory, task/job state, notifications and authorization above the tool boundary.

## User Stories

1. As a host application, I want to import one supported entry point so that private source layout changes do not break my application.
2. As a host application, I want to discover contract capabilities without loading unrelated providers or the TUI.
3. As a host application, I want to choose a model and auth route explicitly so that billing and identity stay under owner control.
4. As a host application, I want opaque credential references so that tokens never enter model context or UI payloads.
5. As a host application, I want service-backed subscription renewal so that simultaneous runs reuse the correct credential lifecycle.
6. As a host application, I want to create and resume durable native sessions without writing provider wire messages.
7. As a host application, I want one writer per session and independent sessions for specialists so that runs cannot mix their histories.
8. As a host application, I want accepted input persisted before a model request so that a crash leaves a resumable conversation.
9. As a PR reviewer, I want workspace instructions, skills and packages disabled unless explicitly trusted.
10. As a host application, I want a supplied tool registry so that unwanted built-ins and activate-skill behavior cannot appear implicitly.
11. As a host application, I want context sources controlled by policy so that untrusted source material cannot become operator instructions.
12. As a host application, I want to disable provider-hosted lookups so that selected tools do not bypass data-recipient policy.
13. As a host application, I want normalized progress and terminal outcomes so that provisional output is distinct from committed results.
14. As a host application, I want usage completeness reported honestly so that absent counters are not presented as zero cost.
15. As a host application, I want cancellation and disposal to settle accepted work without accepting late success.
16. As a Schway maintainer, I want existing CLI, extensions and session compatibility preserved while adding the host contract.

## Implementation Decisions

### Contract ownership

- Add a semver-governed host surface that composes the existing engine; avoid reimplementing the agent loop or exposing every internal helper.
- Use native provider-independent conversation, model, tool and outcome contracts. Provider wire types and TUI types are not canonical host inputs.
- Capabilities describe API/features and configured access. Only an actual successful request establishes observed inference availability.
- Keep existing extension exports compatible. Native session formats and forward-only migration remain owned by Schway.

### Lifecycle and persistence

The host can create/open a session, start an accepted turn/run, inspect its native reference and close/dispose its resources. Each run is bound to its selected session ancestry, auth route, context/tool policy and finite limits.

Accepting input appends native conversation data before requesting inference. At most one run mutates a session at once. A second writer receives a typed busy/conflict outcome. Durable outcomes are referenced explicitly; runtime event streams remain transient observations.

Closing/cancelling stops new work, cancels queued work, settles cooperative accepted calls and releases session ownership. The host contract must not promise preemption of arbitrary synchronous extension code. A terminal transport/model outcome is not an application-level task acceptance result.

### Context policy

Provide explicit controls for operator instructions, workspace AGENTS discovery, skills discovery/activation, packages and extensions. A strict host policy with all repository discovery disabled must not silently fall back to CLI defaults.

The PR-review profile has only operator-controlled instructions and host-supplied source documents. Repository AGENTS/skills/config are data. Disabling discovery also prevents later activate-skill calls from rediscovering disabled sources. Existing CLI defaults remain unchanged unless a separately reviewed compatibility decision changes them.

The same policy applies during ordinary requests, overflow recovery and compaction/replay. Unsupported requested restrictions fail startup before inference.

### Tool and provider policy

The host supplies selected tool definitions and capabilities. Automatic registration of built-ins or skill activation must respect that registry and context policy. Approval modes apply after hooks to effective arguments, but are not advertised as isolation.

Only a provider selected by an actual run is loaded; importing the host contract loads neither TUI nor all provider adapters. Multiple selected routes across independent runs are allowed. SDK automatic retries stay disabled; Schway's bounded retry policy remains authoritative.

Provider-hosted web lookup is explicitly off for Jit's MVP profile. No implicit provider, model, credential or billing fallback occurs after auth/quota failures.

### Credentials

Use a shared route-scoped credential lifecycle and opaque identities. Preserve existing renewal, logout/revocation fencing and endpoint isolation. The host configures trusted access; neither tools nor model prompts receive raw credential values.

Expose needs-login/store-unavailable/rejected/ready-or-unverified states without native secret errors. S01 must verify service-context boot/renewal on Linux; this API spec does not select a new secret backend or import credentials from another CLI.

## Acceptance Criteria

- [ ] A consumer fixture imports only the public host entry and completes a scripted turn with a persisted session reference.
- [ ] A fresh consumer can reopen that session and continue its selected ancestry without replaying tool effects.
- [ ] Two simultaneous runs against one session produce one owner and one explicit conflict.
- [ ] A strict review profile ignores malicious AGENTS/skills/packages as instructions and never executes module code from the snapshot.
- [ ] A host-supplied empty/narrow registry cannot acquire bash, write, edit, arbitrary fetch or skill activation through defaults.
- [ ] Cancellation, provider failure, overflow recovery and compaction keep the same context/tool restrictions.
- [ ] Import/startup traces show no TUI and no unselected provider adapter.
- [ ] Authentication/quota errors retain the selected route and never use API-key billing silently.
- [ ] Session persistence failure prevents inference from starting for the unaccepted input.
- [ ] Terminal outcomes distinguish completed, failed, cancelled and limit exhaustion; transient deltas are not durable accepted answers.
- [ ] Credential values are absent from events, returned diagnostics, prompts and exported host metadata.
- [ ] Existing CLI/extension/session compatibility tests and public declaration checks pass.

## Testing Decisions

Use a highest-level external host-consumer fixture as the primary seam: public import → session/input → scripted model/tools → durable outcome → reopen. Keep provider protocol fixtures at the existing adapter seam rather than testing a new network client.

Reuse patterns from existing extension API-report/CLI tests, context/replay/compaction fixtures, session JSONL/resume/contract tests, agent retry tests and Grok/Codex subscription route fixtures. Test observable inputs/outcomes/import boundaries rather than private method names.

Run deterministic checks with Bun, scripted models, fake credential stores, fake clocks and protocol fixtures. No paid or real-account inference belongs in the deterministic suite. Live boot/auth observations belong to opt-in S01 evidence.

## Out of Scope

Jit groups, memory, job queue, Telegram, Web, task acceptance, application DB transactions, isolated coding execution and a second provider SDK/loop.

## Further Notes

Requirements traced: Jit FR-02, FR-13–FR-17 and NFR-02–NFR-05/NFR-10. Jit must fence/reconcile its own app results; Schway session append is not atomic with Jit's application store.

This is a design parent for focused implementation tickets. It is not an instruction for one agent to implement the entire API at once. The product parent is [Jit MVP spec #1](https://github.com/chayapats/jit/issues/1); related host evidence is [Jit S01 #2](https://github.com/chayapats/jit/issues/2).
