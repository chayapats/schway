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

Editable keys are `provider`, `model`, `maxTurns`, `maxConcurrentTools`, `contextWindow`, `maxOutput`, `baseUrl`, and `auth`. Limits must be positive integers. Providers are `anthropic`, `openai`, and `openai-compatible`; compatible endpoints require a `baseUrl`, and accept auth modes `required`, `optional`, or `none`. Model IDs and URLs must be nonempty. Use double-quoted JSON strings when needed. Unsupported keys, including API-key/token fields, are rejected. Existing `headers`, `extraBody`, and `packages` are preserved but cannot be edited live; change those supported file settings outside the TUI and restart.

Edits default to the current process's interactive session and create no configuration files. `/model` also applies a session override. These overrides survive `/new` and `/resume` in that process, and are not restored after a restart. An explicit `--scope user` writes `~/.schway/config.json`; `--scope project` writes `.schway/config.json` in the active session's canonical primary workspace root, including after resuming a different workspace. Attachments are not project config destinations. `--scope session` is also accepted explicitly. Put `--scope` at the end of the command.

Precedence is built-in → user → project → CLI → session. Saving a lower-priority value preserves any CLI/session override; the notice shows the saved value, effective value and shadowing origin. Reset removes only the named override in the chosen scope and recomputes inherited settings. Resetting an absent setting does not create a missing file. Selecting another provider clears an inherited lower-layer model when that provider override does not specify a model.

Provider construction, credential checks and context/output budgets are staged before settings become live. Invalid values, missing credentials, load errors and cancellation before commit preserve the previous usable model and settings. Busy turns reject edits. Persistence validates the complete destination layer, retains its other valid settings, and uses an atomic rename. A malformed file is left untouched with repair guidance. If the file changes while an edit is staged, retry the edit against the current file. Once the atomic save commits, its matching runtime is applied even if Esc arrives at that boundary.

For example, start with a CLI override:

```sh
OPENAI_API_KEY=your-key bun run start --provider openai --max-turns 8
```

Then `/config set maxTurns 12 --scope project` saves 12 but reports that CLI value 8 remains effective. `/config set maxTurns 4` applies 4 immediately, and `/config reset maxTurns` restores CLI value 8. Restart without `--max-turns` to use the saved project value.

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare` and `prepareModel` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider. These interfaces support deterministic controller/configuration tests without loading OpenTUI or using paid model APIs.
