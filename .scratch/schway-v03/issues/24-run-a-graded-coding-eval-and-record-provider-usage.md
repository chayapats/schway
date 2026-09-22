# #56: Run a graded coding eval and record provider usage

GitHub: https://github.com/chayapats/schway/issues/56

<!-- schway-roadmap:v03:24 -->

**Milestone:** v0.3
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Maintainers run one reproducible coding task through the real Schway harness and receive environment-graded success plus structured execution metrics. Scope: sections 86–87.

## Existing behavior and problem

The repository has deterministic harness tests, including a scripted coding workflow, but no separate eval runner. Native model events currently provide streaming/message completion rather than a complete usage metric contract. Add a single fully graded coding eval and the minimum usage normalization needed for trustworthy metrics.

## Prerequisite contract

No blockers. Reuse real loop/tool/context/persistence primitives. Introduce a minimal native usage contract that both runtime diagnostics and eval aggregation can consume without provider wire imports.

## Required behavior and decisions

1. Define an eval case with an initial isolated repository, user task, allowed bounded run and environment grader. Start with one simple bug whose correction is verified by a real test command and expected file behavior.

2. Run the actual Schway loop and tools against that temporary workspace using an explicitly selected provider/model or an offline scripted model. Never edit the developer's working checkout.

3. Capture run ID, case/version, source revision, provider/model/settings, outcome and wall-clock duration. Separate grader failure, model/task failure, harness error, timeout and skipped prerequisites.

4. Record input/output token usage, tool-call count, tool failures, provider retry count, compactions and repeated identical tool calls. Define repeated calls using tool name plus stable canonicalized arguments; report counts without storing credential-bearing arguments.

5. Add provider-independent usage events/metadata at adapter boundaries. Use reported counts where available and represent missing usage as unknown; do not present estimates as exact consumption.

6. Count all known model usage including compaction summarization and retry attempts that actually report usage, without double-counting a completed message. Interrupted/unreported attempts leave explicit unknown/incomplete usage.

7. The environment grader inspects actual files and exit status, with meaningful positive and negative fixtures. Agent prose cannot override a failing grader.

8. Produce a structured artifact and readable summary, keep credentials redacted and use bounded time/turn/output limits. Paid model runs are explicit; offline mode validates the runner in ordinary tests.

## Scope boundary

One coding case, runner, environment grading and metrics. No leaderboard, arbitrary performance budgets or broad task library yet.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Passing/failing task | A correct edit passes the real grader; unchanged or wrong edits fail even if the model claims success. |
| Metrics | Scripted tool failure/retry/compaction/repeated-call scenarios yield exact expected counts. |
| Usage fixtures | Native/compatible adapter records normalize reported counts and unknown/interrupted cases. |
| Isolation | Temporary repository cleanup and cancellation leave the source checkout unchanged. |
| Paid-call separation | Default tests use scripted/local fixtures; selecting a real provider requires explicit eval execution. |

## Acceptance criteria

- [ ] Use an isolated temporary repository, explicit provider/model selection, bounded run and grader based on file/test outcomes.
- [ ] Start with one simple bug-fix task and an offline scripted-model mode that proves the runner and grader.
- [ ] Record success, wall time, input/output tokens, tool calls/failures, retries, compactions and repeated identical calls.
- [ ] Normalize provider usage at adapter boundaries; represent unavailable usage as unknown rather than fabricated zero, and aggregate retry/compaction calls deliberately.
- [ ] Keep evals separate from unit tests, redact output artifacts and avoid making paid runs part of default CI.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
