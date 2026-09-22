# #55: Run opt-in live provider smoke tests

GitHub: https://github.com/chayapats/schway/issues/55

<!-- schway-roadmap:v03:23 -->

**Milestone:** v0.3
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Maintainers explicitly smoke-test all supported provider/auth paths and receive honest per-provider results, independent of default deterministic CI. Scope: section 85.

## Existing behavior and problem

Protocol fixtures already validate the three API-key/compatible adapter families deterministically. The subscription prerequisite adds an isolated verified auth/provider path. A separate opt-in runner should now measure real protocol compatibility without introducing paid calls into default tests or CI.

## Prerequisite contract

The subscription adapter must already supply production auth resolution, stream normalization, cancellation and one real Schway tool round trip. Other provider adapters are existing v0.1 functionality. The runner consumes the common native Model interface.

## Required behavior and decisions

1. Provide an explicit live-provider test command with provider/auth selection and opt-in enablement. Discover no real credentials until the user has selected live execution.

2. Cover Anthropic API key, native OpenAI API key, a configurable compatible endpoint and ChatGPT subscription. Run each through the real Schway model/loop and a tiny isolated tool task, such as reading a sentinel file and returning its value.

3. Bound per-scenario time, model rounds and output. The task checks real tool/result exchange and a final observable response; it does not trust a generic model success statement.

4. Use runtime/environment/secure-store resolution consistently with production. Missing credentials/integration are skipped or pending with a reason, not passed; explicit required-provider absence should yield an incomplete/non-success aggregate.

5. Never initiate interactive login inside the runner. An expired subscription requiring interaction returns actionable pending/error status; ordinary authorized automatic refresh may follow the production contract.

6. Produce a redacted report with provider/model/auth source category, actual result, timings and bounded diagnostics. Distinguish provider failure from runner failure and skipped cases.

7. Keep all discovery and test modules safe to import in bun test. Default scripts/Travis jobs neither invoke live runs nor require credentials; test runner behavior against local fake transports.

8. Document prerequisites, how to select one provider and how to interpret aggregate status. Live evidence is dated and tied to the tested revision/model selection.

## Scope boundary

Small protocol smoke checks. Broad coding capability grading belongs to the eval suite; default CI remains deterministic.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Offline runner contract | Fake providers cover success, transport error, timeout, missing credentials and disabled live mode. |
| Tool evidence | A passing scenario proves the sentinel read result reached the final provider conversation. |
| Selection | Only requested providers instantiate; no unwanted paid call is made. |
| Safety/cleanup | Temporary workspace, cancellation, redaction and no-interactive-login behavior are verified. |
| Live run report | If opt-in credentials are available, record real per-provider outcomes; otherwise mark the evidence pending honestly. |

## Acceptance criteria

- [ ] Provide an opt-in live command covering Anthropic, OpenAI API key, configurable compatible endpoint and the verified Codex subscription integration.
- [ ] Each selected scenario performs a minimal streaming/tool round trip with observable outcome and controlled temporary workspace.
- [ ] Missing credentials or unavailable integration report skipped/pending, never passed; explicit selection and bounded turns/time constrain calls.
- [ ] Never open interactive login from the runner or expose credentials in output/artifacts.
- [ ] Default Bun tests and Travis jobs remain free of paid calls; test the runner and status reporting with fake providers.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

- #50: Log in with ChatGPT and run the Schway coding loop
