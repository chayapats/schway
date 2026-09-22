# #39: Contribute prompt context and intercept model requests

GitHub: https://github.com/chayapats/schway/issues/39

<!-- schway-roadmap:v03:07 -->

**Milestone:** v0.2
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

An enabled extension can contribute context and influence an agent/model request through the supported beforeAgent, context and beforeModel hooks, without touching provider wire payloads.

## Existing behavior and problem

Schway prepares a stable system prompt plus dynamic context and native conversation items before requesting a model. Local extensions can register capabilities. This ticket adds supported intervention points around that preparation; observation alone cannot implement context contributions or intentional cancellation.

## Prerequisite contract

Requires explicit local extension initialization, deterministic load order and source-labelled registration. Prepared requests contain systemPrompt, named dynamic context, native items, tool descriptions and an AbortSignal; hooks operate on copies of these supported values.

## Required behavior and decisions

1. Expose prompt contributions and beforeAgent, context and beforeModel hooks from the enabled extension registration context. Execute hooks in extension load order, awaiting each result before the next hook.

2. beforeAgent runs once per submitted user turn before the first model request and may add turn-scoped context or deny that turn with an explanation. It does not rewrite the durable user message or rerun on a transport retry.

3. context runs after ordinary environment, applicable project instructions, skills and compaction summary are assembled. It returns the next list of dynamic context sections; later hooks see earlier supported changes. Keep named structural sections identifiable.

4. beforeModel sees a native prepared request, may return a transformed ephemeral system/context/conversation view or deny the request, and runs once per logical model request after context preparation. Transport retries reuse that prepared request; a post-compaction overflow recovery prepares a new request and reruns request hooks.

5. Validate hook outputs as Schway-native values. Durable session records and registered tools must remain unmodified; a model-facing tool list can only select registered tool definitions, not invent executable tools or alter their schemas.

6. Specify that internal compaction summarization is not a user-agent turn: these hooks do not recursively intercept its summarizer request. Extension/skill dynamic context is reassembled when the normal model request resumes.

7. Hook throws, rejection or invalid output produce an actionable extension error, stop the affected request safely and leave the process/controller usable. AbortSignal reaches hooks; cleanup must not create unresolved tool calls.

8. Keep provider wire payloads outside the public hook contract. System-prompt override files still affect the base prompt; structural context is assembled before extension interception.

## Scope boundary

The three named lifecycle/request hooks and prompt contributions. No provider-payload mutation, tool interception or replacement of context/compaction ownership.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Waterfall | Two extensions transform context/request; the real scripted model sees their ordered final output. |
| Invocation counts | Retries reuse prepared input; overflow recovery invokes request hooks again; beforeAgent remains once. |
| Durability | Hook transformations do not mutate saved messages or append repeated context bodies. |
| Denial/error | No provider call follows denial or invalid output; controller accepts a later valid turn. |
| Cancellation/compaction | Aborted hooks settle cleanly and summary calls do not recursively invoke request hooks. |

## Acceptance criteria

- [ ] Expose narrowly documented prompt contributions and the three hooks using Schway-native types.
- [ ] Compose hooks as deterministic waterfalls in extension load order; downstream hooks and the actual model see preceding supported changes.
- [ ] Define supported cancellation/denial and validation behavior; intervention errors name the extension, terminate the affected run safely and leave the process usable.
- [ ] Dynamic extension context is not repeatedly persisted, and user prompt overrides do not erase structural context.
- [ ] Real-loop fixtures prove hook ordering and supported changes in actual prepared requests, with error/cancellation and resumed-session cases.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

- #37: Run tools from explicitly enabled local TypeScript extensions
