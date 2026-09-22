# #33: Isolate CLI process tests from personal configuration

GitHub: https://github.com/chayapats/schway/issues/33

<!-- schway-roadmap:v03:01 -->

**Milestone:** v0.1 follow-up
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Make the existing deterministic CLI checks give the same result on a clean machine and a developer machine with Schway configured. This repairs an observed verification defect; it does not rebuild basic configuration.

## Existing behavior and problem

The baseline CLI is supposed to load user-global configuration before project and CLI overrides. That behavior is correct. The process-test helper, however, inherits the real user's home while stripping only the Anthropic/OpenAI key variables. At audited revision 875055e, the machine's global configuration selected an OpenAI-compatible endpoint with required authentication. Three assertions therefore observed 'Missing API key for OpenAI-compatible endpoint' instead of their expected missing Anthropic key or missing base URL. The full suite reported 348 pass / 3 fail; the isolated process-test suite reproduced 5 pass / 3 fail.

## Prerequisite contract

No prerequisite implementation is needed. Existing CLI argument/configuration and credential resolution behavior is the contract under test.

## Required behavior and decisions

1. Give each process-test case an explicit temporary user-state root, empty unless the case intentionally writes a fixture. Pass that location through the child process environment; leave the invoking user's actual configuration and sessions untouched.

2. Make environment construction explicit: keep runtime/executable lookup necessities, remove ambient provider credentials and Schway-affecting settings, then apply per-test overrides. Tests that need configuration create it themselves.

3. Retain the production precedence defaults < global < project < runtime. Fixing this by disabling global configuration in the real CLI, changing the default provider, weakening assertions, or skipping failing cases does not satisfy this ticket.

4. Retain the existing project-dotenv assertion: entering a project containing a provider key must not silently load that key. Explicit env-file behavior remains a separate intentional input.

5. Exercise both a clean temporary user root and a controlled conflicting compatible-provider configuration. An intentionally configured subprocess must still respect its fixture, proving isolation did not break production configuration.

6. Add a sentinel outside each fixture and verify the harness did not create sessions or modify configuration there. Ensure failed setup and assertion paths clean up temporary state.

## Scope boundary

Test fixtures and subprocess test setup only. No new config features, authentication methods or provider behavior.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Default invocation without credentials | Actionable missing Anthropic key, nonzero exit, empty stdout. |
| Compatible selection without endpoint | Missing base URL regardless of the developer's real configuration. |
| Conflicting fixture explicitly selected | Compatible fixture is honored; no contact with a paid service. |
| Project dotenv with a fake secret | No automatic credential loading and no secret in output. |
| Full validation | Focused process suite and full bun test pass; bun run typecheck passes. |

## Acceptance criteria

- [ ] Use isolated temporary user configuration and session storage for every CLI subprocess test; retain only explicitly required environment values.
- [ ] Regression coverage installs a conflicting global compatible-provider configuration in a controlled fixture and proves default-provider, missing-base-URL, and dotenv assertions remain independent of the real user's files.
- [ ] Prove subprocess tests neither read nor write real user sessions or credentials and make no paid provider calls.
- [ ] Run the focused CLI process suite and the full Bun test/typecheck checks successfully. Baseline evidence: 348 pass, 3 fail; focused suite 5 pass, 3 fail at revision 875055e.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
