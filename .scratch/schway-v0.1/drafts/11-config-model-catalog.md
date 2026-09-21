# 11: Select providers and models with validated basic configuration

## What to build

A developer runs Schway with valid credentials and sensible defaults, or overrides provider, model, and runtime limits predictably through config and CLI options. Known models improve budgeting while custom model IDs remain usable. Scope: specification sections 16, 60–65, 73, 79, 89.

## Acceptance criteria

- [ ] Merge built-in defaults, user-global config, project config, and CLI/current-session overrides in that order. Do not create configuration files merely to use defaults.
- [ ] TypeBox validates first-party config and reports actionable errors for invalid or misspelled settings rather than silently ignoring them.
- [ ] A small built-in model catalog supplies available context-window, maximum-output, tool, and thinking capability metadata for known models; unknown IDs use documented conservative defaults with explicit overrides.
- [ ] All three provider families are selectable. Compatible connection options from ticket 10 pass through correctly without adding a named-profile subsystem.
- [ ] Runtime credential overrides outrank environment credentials, keys are never written to ordinary config, and project dotenv files cannot silently switch credentials. Secure credential storage remains deferred.
- [ ] Basic options expose model/context limits, bounded agent execution, and tool concurrency using shared validated settings; only selected providers initialize.
- [ ] Headless real-loop/fixture tests cover all providers, config precedence, zero-config defaults, invalid settings, unknown-model fallback, and credential redaction. Explicitly supplied overrides are reflected in the actual prepared provider request.

## Blocked by

- 09: Run coding conversations with the native OpenAI provider.
- 10: Run coding conversations against OpenAI-compatible endpoints.
