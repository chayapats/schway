# #44: Improve interactive model selection and configuration editing

GitHub: https://github.com/chayapats/schway/issues/44

<!-- schway-roadmap:v03:12 -->

**Milestone:** v0.2
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Users search/select a model in the TUI and change supported non-secret settings with visible provenance and scope, building on the existing text-based model picker and read-only configuration view.

## Existing behavior and problem

The baseline /model prints known models and accepts provider/model text, including unknown IDs. /config displays redacted effective settings. Shared validated configuration already merges defaults, global, project and runtime overrides; switching models updates budgets. This ticket improves interaction and intentional editing rather than reimplementing that foundation.

## Prerequisite contract

No blockers. Reuse shared resolution/validation, catalog fallback, credential redaction and controller model switching. Keep the editor renderer separate from these operations.

## Required behavior and decisions

1. Add a keyboard-navigable searchable model picker with current selection, provider and budget display. Allow a typed model ID even when it is absent from the catalog; retain the textual /model form for accessibility and automation.

2. Show effective non-secret settings with origin: built-in default, user-global, project, CLI or current-session override. Distinguish catalog-derived limits from explicit user limits.

3. Provide /config set <key> <value> with session scope by default, explicit --scope user or --scope project for persistence, and /config reset <key> with the same scope semantics. Limit editable keys to the supported validated configuration contract.

4. Session edits affect subsequent requests immediately but do not create configuration files. Persisted edits write only the selected scope/key after validating the whole resulting layer; resetting removes that override and recomputes lower-precedence values.

5. Preserve other valid settings and write atomically. If the selected file is malformed, refuse mutation and explain how to repair it instead of silently replacing it. Never accept API-key/token fields as ordinary configuration.

6. Keep CLI overrides higher than persisted layers. A saved lower-priority edit may be shadowed by a CLI setting; display both the saved value and why it is not currently effective. Session overrides can explicitly change the live selection.

7. Stage provider construction, credential checks and budget resolution before committing a live model switch. Failed validation/loading retains the previous usable state. Busy turns reject edits until idle.

8. Treat future profile/reasoning settings as additive integrations when present; this task must pass on the existing provider/config contract without depending on those future features.

## Scope boundary

Model selection and supported non-secret config editing. No named profiles, reasoning controls or secure credential management is required here.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Picker | Search/navigation, explicit unknown ID and current marker are exercised in controller tests. |
| Origin/precedence | Session, CLI, project, user and catalog-derived values display and resolve correctly. |
| Persistence | One intended key changes atomically; reset restores inherited value; defaults create no files. |
| Failure | Invalid key/value, malformed destination and provider-load failure leave previous state intact. |
| Real request | Selected model and resulting budget reach the next actual scripted/provider-fixture request. |

## Acceptance criteria

- [ ] Provide keyboard-driven searchable model selection including explicit unknown IDs; show provider, budgets and the active selection.
- [ ] Show whether effective values come from defaults, global/project configuration or current overrides.
- [ ] Allow validated session-only edits and explicit save/reset of non-secret settings to a chosen supported scope; no automatic configuration creation.
- [ ] Invalid changes or provider-load failures retain the previous usable model/settings; apply budgets consistently on subsequent model calls.
- [ ] Controller tests cover selection, persisted versus temporary scope, precedence, unknown models, redaction, failure and busy-state behavior. Existing basic picker/config work is reused.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
