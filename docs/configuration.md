# Interactive models and configuration

Start Schway with `bun run start` (or `schway` after installation). Set the selected provider's API key in the environment or pass `--api-key` at launch. Configuration does not store API keys.

Enter `/model` to open model search. Type to filter by provider or model ID, press Up/Down to select a row, Enter to apply, or Esc to dismiss. Each row shows provider, context window and maximum output; `*` marks the active model. A typed ID appears as a selectable row even if absent from the catalog, using conservative fallback budgets. For a model ID containing a slash, include the provider first, for example `openai-compatible/org/custom-model`. **Exception:** after a successful `/login codex`, Schway selects an account-visible model and the subscription transport in the current session, without modifying saved configuration. With ChatGPT subscription selected, `/model` fetches visible model slugs, available context limits, default thinking and supported levels from that account's Codex catalog; only account-visible subscription rows are shown, with no static provider rows. If login, refresh or discovery fails, the picker shows an error rather than pretending a hardcoded model is available. The catalog refreshes each time `/model` opens; selection does not use or fall back to the usage-billed Platform `/v1/models` endpoint. Unknown output limits still use conservative local defaults.

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

Editable keys are `provider`, `model`, `thinking`, `profile`, `maxTurns`, `maxConcurrentTools`, `contextWindow`, `maxOutput`, `baseUrl`, `auth`, and `openaiAuth`. Limits must be positive integers. Providers are `anthropic`, `openai`, and `openai-compatible`; compatible endpoints require a `baseUrl`, and accept auth modes `required`, `optional`, or `none`. OpenAI accepts the separate credential preference `openaiAuth` (`auto`, `codex`, or `api-key`; see ChatGPT subscription below). Thinking syntax accepts `off`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; each provider/model only accepts verified supported levels. Codex levels come from the signed-in account's catalog. Model IDs, profile names, and URLs must be nonempty. Use double-quoted JSON strings when needed. Unsupported keys, including API-key/token fields, are rejected. Existing `headers`, `extraBody`, `profiles`, and `packages` are preserved but `headers`/`extraBody`/`profiles` definitions cannot be edited live; change those supported file settings outside the TUI and restart. `/config set profile <name>` and `/config reset profile` switch or clear the active profile. `/config set thinking medium` and `/config reset thinking` switch or clear reasoning; `/thinking` shows requested and effective levels with provider/model.

Saving `baseUrl` with `--scope user` or `--scope project` requires an absolute URL without userinfo (`user:password@`) or a query string. All query strings are runtime-only, including non-secret parameters. Use session scope for those URLs; errors do not echo the rejected value. For example, `/config set baseUrl https://example.test/v1 --scope project` is supported, while `/config set baseUrl https://example.test/v1?region=test` applies only to the current session. Existing files are not automatically migrated: edits to other keys preserve their existing URL. Use `/config reset baseUrl --scope project` (or `--scope user`) or save a safe replacement to remove that file's URL override.

Edits default to the current process's interactive session and create no configuration files. `/model` also applies a session override. These overrides survive `/new` and `/resume` in that process, and are not restored after a restart. An explicit `--scope user` writes `~/.schway/config.json`; `--scope project` writes `.schway/config.json` in the active session's canonical primary workspace root, including after resuming a different workspace. Attachments are not project config destinations. `--scope session` is also accepted explicitly. Put `--scope` at the end of the command.

Precedence is built-in → user → project → CLI → session. Saving a lower-priority value preserves any CLI/session override; the notice shows the saved value, effective value and shadowing origin. Reset removes only the named override in the chosen scope and recomputes inherited settings. Resetting an absent setting does not create a missing file. Selecting another provider clears an inherited lower-layer model when that provider override does not specify a model. When this suppresses a saved model, the notice identifies the provider override responsible while preserving `built-in default` as the effective model's origin.

Provider construction, credential checks and context/output budgets are staged before settings become live. Invalid values, missing credentials, load errors and cancellation before commit preserve the previous usable model and settings. Busy turns reject edits. Persistence validates the complete destination layer, retains its other valid settings, and uses an atomic rename. A malformed file is left untouched with repair guidance. If the file changes while an edit is staged, retry the edit against the current file. Once the atomic save commits, its matching runtime is applied even if Esc arrives at that boundary.

For example, start with a CLI override:

```sh
OPENAI_API_KEY=your-key bun run start --provider openai --max-turns 8
```

Then `/config set maxTurns 12 --scope project` saves 12 but reports that CLI value 8 remains effective. `/config set maxTurns 4` applies 4 immediately, and `/config reset maxTurns` restores CLI value 8. Restart without `--max-turns` to use the saved project value.

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, `selectProfile`, `thinkingCommand`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare`, `prepareModel`, and `prepareProfile` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider. These interfaces support deterministic controller/configuration tests without loading OpenTUI or using paid model APIs.

## Reasoning levels

Select reasoning with config `"thinking": "medium"`, CLI `--thinking medium`, interactive `/thinking medium`, or `/config set thinking medium` (session only by default). Precedence is built-in → user → project → CLI → session, so a session choice overrides files and flags. `/thinking` without arguments shows requested and effective values with provider/model; `/thinking reset` clears the session override for ordinary providers; in Codex subscription mode it selects the backend default for this session, safely shadowing an incompatible saved level without changing the file. `/config` always shows `thinking` with origin and effective mapping, and the status header shows `(thinking <level>)` when set. Changing reasoning affects future requests only and never rewrites history; thinking and opaque provider metadata still round-trip across tool calls, compaction, and resume.

Per-provider mapping follows current official docs without forcing identical wire semantics:

- Anthropic extended thinking (`https://platform.claude.com/docs/en/build-with-claude/extended-thinking`): `off` on reasoning-capable models sends `thinking: { type: "disabled" }`, while `off` on unknown or known non-reasoning models sends no reasoning controls; `low`/`medium`/`high` send `thinking: { type: "enabled", budget_tokens: 1024/4096/8192 }`. Budgets require `budget_tokens >= 1024` and `< max_tokens`, so a level whose budget reaches `--max-output` fails before any request with the needed increase. Supported models are `claude-sonnet-4-6`, `claude-opus-4-6`, and `claude-haiku-4-5`; other Anthropic IDs expose only `off` as a no-op.
- OpenAI Platform API-key reasoning (`https://developers.openai.com/api/docs/guides/reasoning`): `off` on reasoning-capable models sends `reasoning: { effort: "none" }`, while `off` on unknown or known non-reasoning models sends no reasoning controls; `low`/`medium`/`high` send their corresponding effort and `summary: "auto"`. Without verified account metadata, only `gpt-5.4` has those known capabilities; `gpt-4o` and unknown IDs expose only safe `off`. Extended levels are not assumed to work on Platform models.
- Codex subscription: `/model` retrieves per-model `supported_reasoning_levels` and `default_reasoning_level` from the authenticated account. `/thinking` shows the advertised default and supported choices. Leaving thinking unset sends no reasoning controls so the backend applies its default; explicitly selected `low`/`medium`/`high`/`xhigh`/`max`/`ultra` (or `off` if advertised as `none`) map to their exact advertised efforts. Unsupported levels are rejected locally before inference. When changing model, an inherited level that the new model does not support is shadowed by a session-only provider-default marker; saved configuration is untouched.
- OpenAI-compatible Chat Completions has no standard reasoning field, so Schway never injects a vendor effort automatically. `off` (or unset) leaves provider defaults untouched and passes `extraBody` through unchanged. Explicit `low`/`medium`/`high` without a configured `extraBody` mapping fail before any request; configure reasoning directly via `--body '{"reasoning_effort":"medium"}'` or profile `extraBody` instead. Reasoning body keys are `reasoning`, `reasoning_effort`, `reasoningEffort`, `reasoning_budget`, `thinking`, `thinking_budget`, and `budget_tokens`. Bare `effort` is not treated as a reasoning control.

Truthful capability handling:

- Unset thinking leaves provider defaults untouched for every family, including unknown IDs. Outside a verified subscription catalog, explicit `off` on unknown or known non-reasoning models is a no-op; only known reasoning-capable models send the provider's documented disable control. In a Codex subscription, even `off` must be advertised as `none` for that account/model.
- Explicit reasoning levels absent from the selected model's known or verified catalog support fail before any request. Unknown Platform IDs explain that support cannot be established instead of pretending a mapping applied; only `off` is a safe no-op there. Codex subscription IDs use the signed-in catalog instead of this static fallback.
- `thinking` plus any reasoning body key in effective `extraBody` (direct or selected-profile `extraBody`) is rejected as `thinking "<level>" conflicts with extraBody.<key>`; remove one to define a single source of truth.
- Model and profile switches recompute capability and effective reasoning. Subscription model switches shadow incompatible saved thinking with a session-only provider default, without editing files. Other providers reject an incompatible request with the previous settings intact; set a compatible level or reset thinking first.

Runnable example (no paid APIs; fixtures in `tests/reasoning.test.ts` inspect outgoing controls):

```sh
# Anthropic budgets and OpenAI efforts via scripted fixtures
bun test tests/reasoning.test.ts
# Live-equivalent CLI (needs a key; shows validation, not fixtures)
schway --provider anthropic --model claude-sonnet-4-6 --thinking medium -p 'plan only'
schway --provider openai --model gpt-5.4 --thinking low -p 'plan only'
# Compatible: reasoning via extraBody, thinking stays unset
schway --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --body '{"reasoning_effort":"medium"}' -p 'hello'
```

See `src/model/catalog.ts` (`getThinkingSupport`, `describeThinkingSupport`), `src/model/providers/*` (`resolveAnthropicThinking`, `resolveOpenAIReasoning`, `resolveCompatibleThinking`, `resolveCodexReasoning`), and `src/config/config.ts` (`validateThinking`, `describeEffectiveThinking`) for the reasoning-mapping contract.

## ChatGPT subscription (Codex OAuth)

Sign in with a ChatGPT Plus/Pro subscription and run the same Schway-owned coding loop: Schway keeps its tools, context, sessions, retries, and compaction, while the isolated Codex adapter only translates the model transport (`POST https://chatgpt.com/backend-api/codex/responses` with a Bearer subscription token). There is no delegated Codex agent run, no sandbox delegation, and transport retries are disabled. Account prerequisites follow the provider docs: ChatGPT Plus/Pro with workspace membership/provisioning plus seat/role entitlements; MFA rules for Codex cloud; device-code beta enabled for headless login; Enterprise token permission for automation. Schway never reads another CLI's credential cache (`~/.codex/auth.json` or OS-store copies owned by other tools); you sign in directly to Schway.

Choose the credential explicitly so billing never changes silently:

```json
{
  "provider": "openai",
  "openaiAuth": "codex"
}
```

- `openaiAuth: "codex"` uses the stored subscription login only. Missing, expired, revoked, or refresh-failed sessions fail with distinct actionable errors and never fall back to paid API-key billing.
- `openaiAuth: "api-key"` uses only `--api-key`, `OPENAI_API_KEY`, or the stored native OpenAI key, and never touches the subscription.
- `openaiAuth: "auto"` (default) prefers an explicit/runtime or environment API key when one is set, otherwise uses a stored subscription login. Headless runs never start a browser automatically.

This preference is independent of compatible-endpoint `auth` (`required`/`optional`/`none`). Set it with config `"openaiAuth": "codex"`, CLI `--openai-auth codex`, or live with `/config set openaiAuth codex` (session only by default); `/config` shows its value and origin with tokens redacted.

Sign in interactively (never paste secrets after the slash command):

```text
/login codex
/login codex --device
/login codex --code <callback-url-or-authorization-code>
/logout codex
```

After a successful explicit `/login codex`, Schway discovers this account's visible Codex models and activates the subscription transport and an available model for the current session. It keeps the current model if still visible; otherwise it selects the first advertised visible model. Previous provider/settings remain active on login failure, cancellation or discovery failure. If sign-in succeeds but discovery fails, retry `/model` without repeating OAuth. Saved provider/auth preferences are never overwritten; use `/model` to browse this account's models or `/thinking` to see this model's default and supported levels. Headless Codex runs also discover visible model capabilities before inference: when no available model was selected, Schway uses the first advertised model for that run without editing config; an explicit unavailable `--model` fails instead of silently substituting another ID. `--thinking` is validated against that account's advertised levels before a request. The picker calls `GET https://chatgpt.com/backend-api/codex/models?client_version=0.156.1` using only Schway's stored subscription identity. The query is a verified Codex client compatibility version, **not** the Schway package version: sending Schway `0.1.0` returned an empty catalog on a real account. Update the pinned version only after verifying the model catalog and selected-model transport against that Codex protocol version. The endpoint and `models[].slug` / `visibility` response follow the official open-source [Codex models client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs) and [Codex model protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs). Only `visibility: list` entries are shown; errors do not disclose provider payloads or silently switch billing. A live subscription catalog request and TUI picker were tested on 2026-09-25 (7 visible models, 2 hidden); this does not prove inference or release readiness for every account.

`/login codex` opens the provider browser flow with a localhost callback and per-attempt PKCE/state; denial, expiry, timeout, and Esc cancellation settle without leaked listeners. On machines where the browser cannot reach the loopback callback, `/login codex --device` prints a user code to approve at `https://auth.openai.com/codex/device` (beta, 900 s timeout), and `--code` exchanges a manually pasted redirect URL or code. Tokens (short-lived access plus `offline_access` refresh) live only at the subscription secure-store identity with serialized pre-expiry refresh; `/logout codex` removes exactly that identity. Resume rebuilds the native conversation under the currently selected auth identity without replaying tools, and prior provider metadata round-trips across auth switches.

Runnable examples (deterministic; no paid APIs or live subscription calls):

```sh
# Scripted login/refresh/selection/resume/redaction coverage plus a real tool round trip
bun test tests/codex-subscription.test.ts
# Deterministic headless behavior without credentials: fails actionably, starts no browser
schway --provider openai --openai-auth codex -p 'hello'
# Live-equivalent API-key path (needs a key; shows validation, not fixtures)
schway --provider openai --openai-auth api-key -p 'hello'
```

See `src/model/providers/codex-subscription.ts` (verified OAuth/Responses contract, token lifecycle, wire conversion), `src/auth/credentials.ts` (`selectOpenAITransport`), and `src/auth/store.ts` (`codexSubscriptionIdentity`) for the implementation contract. Optional bounded live smoke stays separate evidence and is reported independently of fixture success.

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

## Git change tracking

Schway inspects repository state observationally; it never commits, stages, stashes, branches, worktrees, or restores files. Git remains the source of truth and the primary workspace root is the default inspection scope.

```json
{
  "git": { "changeTracking": "on-demand" }
}
```

Modes:

- `off` disables change inspection and performs no Git reads.
- `on-demand` (default) reads repository state only on explicit `/changes` inspection; no per-turn capture runs.
- `snapshot` captures a content-hash baseline immediately before each user turn and compares after the turn settles (completed, failed, or cancelled, once tool cleanup settles). Hashes distinguish pre-existing dirt from new turn edits; a filename list alone is never used as the comparison.

Inspect with:

```text
/changes
/changes status
/changes diff
/changes diff -- <path>
/changes mode
/config
/config set git {"changeTracking":"snapshot"}
/config reset git
```

`/changes` shows branch, HEAD, dirty counts, and bounded changed files (staged, unstaged, untracked, deleted, renamed, binary). Detached HEAD renders as `detached HEAD at <sha>`; a non-Git workspace reports `Not a Git workspace` and keeps coding. Large outputs truncate explicitly (`… truncated`) with follow-ups (`git status --short`, `git diff -- <path>`). Binary content is summarized, never dumped. Snapshot comparisons list new turn changes separately from pre-existing files changed further and pre-existing files left untouched. A failed capture reports `Snapshot unavailable: <reason>` instead of a fabricated clean diff. Snapshots retain only the latest turn pair for the current session/run and cannot restore files. Resume shows current on-demand state and never claims a historical snapshot unless one was retained with a valid identity.

Runnable example (no paid APIs; temporary filesystems in `tests/git-changes.test.ts`):

```sh
bun test tests/git-changes.test.ts
```

See `src/workspace/git.ts` (`inspectGitStatus`, `captureGitSnapshot`, `compareGitSnapshots`, `getGitDiffPreview`), `src/config/config.ts` (`git.changeTracking`, `DEFAULT_GIT_CHANGE_TRACKING`), and `src/tui/controller.ts` (`changesCommand`, `gitChangeTracking`) for the contract.
