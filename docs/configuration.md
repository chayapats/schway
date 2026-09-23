# Interactive models and configuration

Start Schway with `bun run start` (or `schway` after installation). Set the selected provider's API key in the environment or pass `--api-key` at launch. Configuration does not store API keys.

Enter `/model` to open model search. Type to filter by provider or model ID, press Up/Down to select a row, Enter to apply, or Esc to dismiss. Each row shows provider, context window and maximum output; `*` marks the active model. A typed ID appears as a selectable row even if absent from the catalog, using conservative fallback budgets. For a model ID containing a slash, include the provider first, for example `openai-compatible/org/custom-model`.

Textual commands remain available:

```text
/model openai/gpt-4o
/model anthropic claude-sonnet-4-6
/model my-custom-model
/config
/config set maxOutput 4096
/config set contextWindow 64000
/config reset contextWindow
/config set maxTurns 12 --scope user
/config set model gpt-4o --scope project
/config reset model --scope project
```

`/config` displays effective values and their origins: built-in default, user-global, project, CLI, or current-session override. Context/output limits show `catalog` when derived from model metadata (including conservative unknown-model fallback), and `explicit limit` when a layer supplies the limit. Connection headers and extra request bodies are shown as configured with values hidden; URLs omit credentials, queries and fragments, and known API keys are redacted.

Editable keys are `provider`, `model`, `profile`, `maxTurns`, `maxConcurrentTools`, `contextWindow`, `maxOutput`, `baseUrl`, and `auth`. Limits must be positive integers. Providers are `anthropic`, `openai`, and `openai-compatible`; compatible endpoints require a `baseUrl`, and accept auth modes `required`, `optional`, or `none`. Model IDs, profile names, and URLs must be nonempty. Use double-quoted JSON strings when needed. Unsupported keys, including API-key/token fields, are rejected. Existing `headers`, `extraBody`, `profiles`, and `packages` are preserved but `headers`/`extraBody`/`profiles` definitions cannot be edited live; change those supported file settings outside the TUI and restart. `/config set profile <name>` and `/config reset profile` switch or clear the active profile.

Saving `baseUrl` with `--scope user` or `--scope project` requires an absolute URL without userinfo (`user:password@`) or a query string. All query strings are runtime-only, including non-secret parameters. Use session scope for those URLs; errors do not echo the rejected value. For example, `/config set baseUrl https://example.test/v1 --scope project` is supported, while `/config set baseUrl https://example.test/v1?region=test` applies only to the current session. Existing files are not automatically migrated: edits to other keys preserve their existing URL. Use `/config reset baseUrl --scope project` (or `--scope user`) or save a safe replacement to remove that file's URL override.

Edits default to the current process's interactive session and create no configuration files. `/model` also applies a session override. These overrides survive `/new` and `/resume` in that process, and are not restored after a restart. An explicit `--scope user` writes `~/.schway/config.json`; `--scope project` writes `.schway/config.json` in the active session's canonical primary workspace root, including after resuming a different workspace. Attachments are not project config destinations. `--scope session` is also accepted explicitly. Put `--scope` at the end of the command.

Precedence is built-in → user → project → CLI → session. Saving a lower-priority value preserves any CLI/session override; the notice shows the saved value, effective value and shadowing origin. Reset removes only the named override in the chosen scope and recomputes inherited settings. Resetting an absent setting does not create a missing file. Selecting another provider clears an inherited lower-layer model when that provider override does not specify a model. When this suppresses a saved model, the notice identifies the provider override responsible while preserving `built-in default` as the effective model's origin.

Provider construction, credential checks and context/output budgets are staged before settings become live. Invalid values, missing credentials, load errors and cancellation before commit preserve the previous usable model and settings. Busy turns reject edits. Persistence validates the complete destination layer, retains its other valid settings, and uses an atomic rename. A malformed file is left untouched with repair guidance. If the file changes while an edit is staged, retry the edit against the current file. Once the atomic save commits, its matching runtime is applied even if Esc arrives at that boundary.

For example, start with a CLI override:

```sh
OPENAI_API_KEY=your-key bun run start --provider openai --max-turns 8
```

Then `/config set maxTurns 12 --scope project` saves 12 but reports that CLI value 8 remains effective. `/config set maxTurns 4` applies 4 immediately, and `/config reset maxTurns` restores CLI value 8. Restart without `--max-turns` to use the saved project value.

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, `selectProfile`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare`, `prepareModel`, and `prepareProfile` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider. These interfaces support deterministic controller/configuration tests without loading OpenTUI or using paid model APIs.

## Named OpenAI-compatible profiles

Define reusable compatible endpoints once, then select them without retyping URLs or risking another endpoint's credential:

```json
{
  "profiles": {
    "local-ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "llama3.2",
      "auth": "optional",
      "headers": { "X-Tenant": "local" },
      "extraBody": { "temperature": 0.2 }
    },
    "tenant-a": {
      "baseUrl": "https://example.test/tenant-a/v1",
      "model": "tenant-model-a",
      "contextWindow": 64000,
      "maxOutput": 2048,
      "auth": "required",
      "credentialEnv": "TENANT_A_API_KEY"
    }
  },
  "profile": "local-ollama"
}
```

Profile fields are `baseUrl` (required, absolute URL without userinfo or query parameters), `model`, `contextWindow`, `maxOutput`, non-secret `headers`, `extraBody`, `auth` (`required`/`optional`/`none`), plus reference-only `credentialEnv` (environment-variable name) and `credentialIdentity` (secure-store suffix). Secret values are never stored in config; credential headers, top-level `apiKey`/`token`/`secret` keys, and secret-like keys inside `extraBody` are rejected. Profile names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.

Merge and precedence:

- `profiles` maps merge by name across global (`~/.schway/config.json`) and project (`.schway/config.json`); a project definition replaces the whole same-name profile so connection fields are never accidentally inherited. CLI and session `profiles` maps are a local override extension for testing and follow the same whole-replacement-by-name rule.
- The selected `profile` name resolves by normal precedence: built-in → user → project → `--profile <name>` → session (`/config set profile`, `/model profile:<name>`).
- Precedence order is file direct settings below the selected profile below CLI and session explicit edits. The selected profile expands as a layer above file direct settings and below CLI/session explicit flags. Explicit `--base-url`, `--model`, `--header`, `--body`, `--auth`, and session edits apply last over the profile.
- Direct `--provider openai-compatible` flags keep working without any profile.

Credentials:

- Runtime `--api-key` has highest precedence. `auth: "none"` sends no automatic credentials and skips store reads.
- With a profile, the resolver checks the profile's `credentialEnv` var first (or `OPENAI_COMPATIBLE_API_KEY` when the profile sets no custom var), then the profile-scoped secure-store identity, then `optional` allows no key while `required` errors before any provider request. `credentialEnv` is exclusive by design: once a profile sets a custom variable, the generic endpoint key is not consulted for that profile, so one endpoint's credential never leaks into another profile.
- Store identities scope to profile name plus canonical endpoint (and optional `credentialIdentity` suffix). Changing an endpoint selects a different identity, so an old endpoint's saved key is never silently sent. Unselected profiles never instantiate providers or look up credentials.
- Unknown profile names and malformed values fail before a provider request. Switching profile, endpoint, model, headers, auth, and budgets stages as one change; failed validation, credential, loading, or cancellation retains the previous active selection.

Display and selection:

- `/config` and the status header show the active `profile` with redacted effective settings (`credentialEnv`/`credentialIdentity` names are shown, values hidden; URLs sanitized; headers/bodies hidden).
- `/model` opens the picker with profile rows (`profile:<name>`); `/model profile:<name>` and `/config set profile <name>` switch profiles. Only the explicit `profile:<name>` form switches profiles; a bare model token never selects a profile, so direct model IDs cannot collide with profile names. `/model <provider>/<id>` clears the profile for direct selection. `/model <provider>/<id>` and `/config reset profile` record a session-only cleared profile that outranks user, project, and CLI selections.

Runnable example with two local protocol fixtures (no paid APIs):

```sh
cat ~/.schway/config.json
# { "profiles": { "a": { "baseUrl": "http://127.0.0.1:8101/v1", "model": "model-a", "credentialEnv": "PROFILE_A_KEY" }, "b": { "baseUrl": "http://127.0.0.1:8102/v1", "model": "model-b", "credentialEnv": "PROFILE_B_KEY" } } }
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile a -p 'hello from a'
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile b --model override-model --header 'X-Test: ok' -p 'hello from b'
```

Each endpoint receives only its profile's model, body, headers, and sentinel credential; runtime overrides apply last; switching never leaks the earlier credential. See `tests/profiles.test.ts` for deterministic two-endpoint, precedence, isolation, auth-mode, and atomic-switch coverage.
