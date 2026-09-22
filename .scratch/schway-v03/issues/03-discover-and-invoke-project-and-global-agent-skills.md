# #35: Discover and invoke project and global Agent Skills

GitHub: https://github.com/chayapats/schway/issues/35

<!-- schway-roadmap:v03:03 -->

**Milestone:** v0.2
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Users can list local/global skills and explicitly invoke a skill from the interactive editor or a headless prompt, with its instructions reaching the next real model request. Scope: spec sections 45–48, 72, 90.

## Existing behavior and problem

The baseline already assembles environment and scoped project instructions separately from durable messages. It has a fixed slash-command parser and all seven coding tools, but no skill discovery, activation or listing. Add the Agent Skills capability as a complete user-invoked path first. Package skills and model-directed activation are separate later integrations.

## Prerequisite contract

Use the existing context preparation, user-message submission and command-dispatch seams. Export a small discovery/activation service usable by both entry modes and by later model activation; renderer types stay out of it.

## Required behavior and decisions

1. Discover project-local and user-global skill directories using the standard SKILL.md convention. Parse the standard name/description and supported invocation metadata, including disable-model-invocation. Keep source identity and the canonical resource base with each discovered skill.

2. Project-local definitions override user-global definitions of the same name. Ambiguous names within one precedence level are explicitly diagnosed and unavailable for invocation; filesystem enumeration order must not choose a winner.

3. At startup expose metadata only. The available-skills context names each eligible skill and how to invoke it without embedding every body. User-only skills remain visible to the user even though they are not model-activatable.

4. Provide /skills and /<skill-name> [arguments] in the TUI. Accept the same explicit skill invocation as a headless prompt. A command-only listing must not call a model. Built-in command names are reserved; explain collisions rather than silently overriding commands.

5. On invocation, read and validate the selected body, attach it as active-skill dynamic context before the next model request, and pass trailing arguments as user input with their meaning preserved. Referenced scripts/assets are available by skill-relative location and are read only when requested.

6. Activation is scoped to the submitted user turn, including all model/tool rounds and automatic compaction in that turn. Clear it on completion, failure or cancellation; a later ordinary turn or resumed session starts without an active body. Durable user invocation text may remain, but full body copies are not appended repeatedly.

7. A malformed skill reports source and reason while unrelated valid skills remain usable. A missing or unreadable body fails that invocation without starting an uninstructed model turn. Bound loaded content using an explicit documented limit and report oversize failure rather than silently truncating instructions.

## Scope boundary

Local/global skill discovery and explicit invocation. No npm package resolution, workflow sequencing or model activation tool in this ticket.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Project/global duplicate | The project body reaches the actual prepared request; global body does not. |
| Same-level ambiguity or built-in collision | Explicit diagnostic and no arbitrary invocation. |
| Progressive loading | Unused bodies/resources are never read or injected; explicit activation loads only its body. |
| Real-loop invocation | Scripted model sees body plus arguments alongside project instructions; raw session contains no repeated body. |
| Lifecycle and errors | Subsequent normal turn, resume, cancellation, missing body and malformed metadata behave as specified. |

## Acceptance criteria

- [ ] Discover standard skill directories from project and user-global locations; validate name, description and invocation metadata with actionable diagnostics.
- [ ] Project skills override global names; same-precedence duplicates are reported explicitly. Built-in command collisions never silently shadow core commands.
- [ ] Load metadata at startup, full body only on explicit activation, and referenced resources only on demand, resolving resources relative to their skill.
- [ ] Implement skill listing and direct slash invocation including arguments; honor user-only invocation metadata and retain ordinary prompt behavior.
- [ ] Scripted real-loop/controller tests prove actual prompt content, precedence, missing/malformed skills and lazy loading. Update obsolete v0.1 absence guards only for the new skills surface, retaining architectural invariants.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
