# #45: Dogfood the external Matt-style skills package

GitHub: https://github.com/chayapats/schway/issues/45

<!-- schway-roadmap:v03:13 -->

**Milestone:** v0.2
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

An external skills-only package drives grill → spec → tickets → implement → review using generic Schway skill support, proving that workflow order lives outside the harness.

## Existing behavior and problem

The prerequisites provide eligible model activation and explicit npm package discovery. A skill activation uses shared discovery precedence and lasts for the submitted turn; user-only skills require a user invocation. Packages can declare skills without executing an extension entrypoint. Use those generic capabilities to prove the external Matt-style workflow.

## Prerequisite contract

Requires metadata/body loading, model eligibility enforcement, turn-scoped activation, configured package manifests and normal tool execution. The full handoff behavior required from those prerequisites is stated here.

## Required behavior and decisions

1. Create an independently consumable skills-only package/example containing five roles: grill-with-docs, to-spec, to-tickets, implement and code-review. Each uses standard skill metadata and contains enough instructions to consume the prior artifact.

2. Keep workflow transitions in those skill bodies and generated artifacts. The core recognizes skill invocation only; it must not switch on workflow names or maintain a special grill/spec/ticket state machine.

3. Use deliberate user-only invocation for actions requiring user initiation. Explicit skill invocation carries the current artifact/task as arguments; a following turn reactivates the desired skill rather than relying on hidden persistent workflow state.

4. Define an offline demonstration in an isolated repository: questioning creates resolved decisions, specification captures them, ticket drafting produces independently actionable work, implementation changes a simple fixture, and review compares observable behavior against that specification.

5. Use a local fixture tracker for the demonstration. Real GitHub/email/other external writes are not a prerequisite for the scripted test and must not occur as test side effects.

6. Install/enable the package through the ordinary manifest path and assert project override/duplicate behavior still follows normal discovery rules. Removing the package restores the base harness with no special cleanup logic.

7. Provide a separate optional human dogfood procedure using Schway on a real coding task. Record exact artifacts and verification outcomes, including skipped/pending when credentials or human input are unavailable.

## Scope boundary

External workflow package and dogfood evidence. No core planner/workflow engine, subagents or publishing to a package registry.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Installed package | The packed skills-only artifact is discovered without executing package JavaScript. |
| Artifact handoff | A scripted sequence consumes and produces the intended artifacts through real turns/tools. |
| User-only eligibility | Model activation cannot trigger a user-only workflow; explicit invocation can. |
| Observed implementation | Real temporary files and a test command prove the implementation step changed the intended behavior. |
| Removal | No workflow-specific core code or residual capabilities remain after disabling the package. |

## Acceptance criteria

- [ ] Package the five workflow roles with standard skill metadata and resources in an independently consumable fixture/example package; no workflow-specific core branching.
- [ ] Configure and invoke the package through normal discovery and activation, respecting user-only workflows and project overrides.
- [ ] Run a scripted offline artifact handoff sequence and verify generated artifacts/tool effects rather than a model's success claim.
- [ ] Document an opt-in real dogfood procedure and record passed, failed or pending evidence explicitly.
- [ ] Demonstrate the package can be removed without changing the base coding workflow; validate its artifact locally without registry publication.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

- #36: Activate skills from model requests with a defined lifecycle
- #41: Load skills and extensions from configured npm manifests
