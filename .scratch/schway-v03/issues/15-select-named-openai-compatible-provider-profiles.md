# #47: Select named OpenAI-compatible provider profiles

GitHub: https://github.com/chayapats/schway/issues/47

<!-- schway-roadmap:v03:15 -->

**Milestone:** v0.3
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Users switch between named compatible endpoints from CLI/TUI without retyping connection settings or accidentally reusing another endpoint's credentials.

## Existing behavior and problem

OpenAI-compatible transport already supports a base URL, custom headers, extra body options, arbitrary model IDs and required/optional/none auth. Configuration currently describes one endpoint. This ticket adds named reusable selections while keeping direct flags backward compatible.

## Prerequisite contract

No feature blockers because the current compatible adapter and runtime/environment credential path suffice. If secure storage is already present, use its identity-based resolver rather than a parallel secret implementation.

## Required behavior and decisions

1. Add validated profile definitions with name, base URL, default model, context/output overrides, non-secret headers, extra request body options and auth mode. Support a selected profile in config and --profile <name> in CLI; extend the model picker/command to select it interactively.

2. Merge profile maps by name across global and project configuration, with the project definition replacing the whole same-name profile to avoid accidentally inheriting credentials or connection fields. Resolve selected name by normal config/CLI/session precedence.

3. For the selected profile, apply explicit connection/model flags and session edits last. Unselected profiles do not instantiate providers or look up credentials. Unknown profile names and malformed profile values fail before a provider request.

4. Secrets are references rather than stored values: allow a credential environment-variable name and a credential-store identity when secure storage is available. Runtime --api-key still has highest precedence. Auth none sends no automatic credentials; auth required reports missing credentials before a request.

5. Scope profile credentials to profile identity and canonical endpoint. Changing an endpoint must not silently send the old endpoint's stored key; require a matching identity/reference or an explicit runtime override.

6. Switch profile, endpoint, model, headers, auth and budgets as one staged state change. Failed validation/credential resolution/loading retains the previous active selection.

7. Display active profile and redacted effective settings in status/config. Existing direct --provider openai-compatible connection flags continue to work without defining a profile.

8. Do not require secure storage for the initial profile path: environment references and explicit runtime keys fully support it. Integrate the secure-store resolver only when that feature is available.

## Scope boundary

Named compatible profiles only. No new provider family, automatic endpoint discovery or key values in configuration.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Two endpoints | Two local protocol servers receive only their profile's model/body/headers and sentinel credential. |
| Precedence | Global/project same-name replacement and explicit runtime overrides are observed in actual requests. |
| Isolation | Switching profiles or changing an endpoint never leaks an earlier credential. |
| Auth modes | Required, optional and none behave correctly with present/missing references. |
| Atomic switch | Unknown/malformed profile and credential failure leave the earlier working selection intact. |

## Acceptance criteria

- [ ] Validate named profile configuration containing endpoint, model, budgets, non-secret headers/body options and auth mode.
- [ ] Define global/project profile merge and CLI/current-session precedence; show the active profile and effective values.
- [ ] Resolve profile-specific credentials through explicit environment or secure-store references when available; never place secret values in config.
- [ ] Switch endpoint/model/budgets/auth atomically and prevent credential/header leakage between profiles; retain existing direct connection flags and required/optional/none auth.
- [ ] Protocol fixtures and controller tests prove requests go to two distinct endpoints with the correct bodies and credentials, including failed switches and unknown profiles.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
