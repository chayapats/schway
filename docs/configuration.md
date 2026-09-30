# Interactive models and configuration

Start Schway with `bun run start` (or `schway` after installation). Set the selected provider's API key in the environment or pass `--api-key` at launch. Configuration does not store API keys.

A fresh install names no model. The screen shows `No model yet · Sign in to choose one · Alt+L`, and sending stays unavailable until a model is usable. Typed text is kept. Headless runs do not invent a model: without a provider and model in config or `--provider` and `--model`, Schway exits non-zero with `No model configured. Pass --provider and --model, or set them in config.`

Enter `/model` to choose a model. Search ignores case and ranks exact, prefix, substring and subsequence matches against model IDs, `provider/modelId` and group labels. Routes stay grouped in this order: ChatGPT subscription, Grok subscription, OpenAI API key, xAI API key, the configured OpenAI-compatible endpoint, then named profiles in config order. Endpoint headers show host and port; profile headers show their name and host. Up/Down skips headers, Enter uses the selected model or opens a `Sign in · Enter` row, and Esc goes back. Disconnected routes show one sign-in row and no models. Successful sign-in restores the query and highlights that route's first matching model; cancellation restores its sign-in row. Each connected route lists models from its model-list endpoint. The OpenAI API-key picker shows chat models only. Static metadata fills missing context, reasoning support and per-model maximum output; unknown IDs keep conservative budgets. A failed list shows `list unavailable` once on the route header, with fallback models still selectable. A typed `provider/model-id` appears last in its group even if absent from the catalog. For a model ID containing a slash, include the provider first, for example `openai-compatible/org/custom-model`.

When ordinary sign-in or initial setup activates a recommended model, Schway chooses the provider's marked default when the list includes one, otherwise the documented fallback (`gpt-6-astra` for OpenAI API key and ChatGPT subscription, `gpt-4o` for a compatible endpoint) when it is listed, otherwise the first listed model that is also in the static catalog for that provider, otherwise the first listed model. The OpenAI API-key recommendation uses the chat-only list. A connection started from the picker with a model already selected restores the query and highlights a model; Enter selects it. An activated choice is remembered for the next interactive launch in this workspace. It does not change saved config files and is ignored by headless runs.

ChatGPT subscription rows come from the account catalog, not the usage-billed Platform `/v1/models` endpoint, and are shown as returned. The OpenAI API-key route uses `https://api.openai.com/v1/models` and shows chat models only. A compatible endpoint uses `{baseUrl}/models` and shows its list as returned. A connected subscription route with discovery failure shows fallback models, with `list unavailable` on its header.

Textual commands remain available:

```text
/model openai/gpt-4o
/model openai gpt-5.4
/model my-custom-model
/model forget
/config
/config set maxOutput 4096
/config set contextWindow 64000
/config reset contextWindow
/config set maxTurns 12 --scope user
/config set model gpt-4o --scope project
/config reset model --scope project
/config set appearance dark --scope user
/config reset appearance --scope user
```

`/config` (or Alt+P) opens keyboard preferences; `/config show` prints the textual inspection. Both show effective values and their origins: built-in default, interactive memory, user-global, project, CLI, or current-session override. Context/output limits show `catalog` when derived from model metadata (including conservative unknown-model fallback), and `explicit limit` when a layer supplies the limit. Connection headers and extra request bodies are shown as configured with values hidden; URLs omit credentials, queries and fragments, and known API keys are redacted.

In preferences, Up/Down selects a setting, Left/Right selects a bounded value or **Reset (inherit)**, and Tab/Shift+Tab chooses scope. Enter first validates and previews; a second Enter confirms the staged edit. Escape discards the preview, then returns to the unchanged task and cursor. PageUp/PageDown or the mouse scrolls details on narrow terminals. The view shows separately saved lower-layer values and identifies which source shadows them. Remove a CLI flag to reset a CLI override; resetting a lower scope does not remove the flag.

The scope explanation appears before confirmation:

- **Session:** changes only the running process; it is not automatically remembered.
- **Workspace memory:** explicitly remembers the complete currently activated provider/model/auth/profile/reasoning choice, or resets just that workspace's memory. Reset leaves explicit config and session overrides intact. Headless ignores interactive memory.
- **User:** deliberately writes `~/.schway/config.json`, shared across workspaces.
- **Project:** deliberately writes the canonical primary workspace's `.schway/config.json`; opening the view never changes repository files.

Thinking choices come from supported model capabilities (verified account metadata for Codex); unknown Codex capabilities expose reset only. Numeric controls offer presets; exact positive limits remain available through textual commands. A preset incompatible with the current model is rejected with the selection retained. Connection rows expose scoped reset and the separate **model + route picker**, which activates and remembers a successful choice regardless of the preferences scope; it does not write user/project config. URLs, headers, request bodies and credentials are excluded from the preference inspector. Existing unrelated settings are preserved during explicit file edits.

Malformed files, unavailable models, cancellation, and changes made by another writer retain the previous working state. Confirmation commits the transaction prepared for that preview, so a file changed between preview and confirmation is not overwritten. A lower value saved beneath CLI/session overrides is labeled **saved but not effective** with its overriding source.

Editable keys are `provider`, `model`, `thinking`, `profile`, `maxTurns`, `maxConcurrentTools`, `contextWindow`, `maxOutput`, `baseUrl`, `auth`, and `openaiAuth`, plus `git` and `appearance`. Appearance accepts `auto`, `dark`, or `light`; the launch environment `SCHWAY_THEME=dark|light` wins over every config scope. Animation is an environment choice only: `SCHWAY_MOTION=full|reduced|off` (see [TUI motion](tui.md#motion-and-startup-splash)). Limits must be positive integers. Providers are `openai`, `xai`, and `openai-compatible`; compatible endpoints require a `baseUrl`, and accept auth modes `required`, `optional`, or `none`. OpenAI accepts the separate credential preference `openaiAuth` (`auto`, `codex`, or `api-key`; see ChatGPT subscription below). Thinking syntax accepts `off`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; each provider/model only accepts verified supported levels. Codex levels come from the signed-in account's catalog. Model IDs, profile names, and URLs must be nonempty. Use double-quoted JSON strings when needed. Unsupported keys, including API-key/token fields, are rejected. Existing `headers`, `extraBody`, `profiles`, and `packages` are preserved but `headers`/`extraBody`/`profiles` definitions cannot be edited live; change those supported file settings outside the TUI and restart. `/config set profile <name>` and `/config reset profile` switch or clear the active profile. `/config set thinking medium` and `/config reset thinking` switch or clear reasoning; `/thinking` shows requested and effective levels with provider/model.

Saving `baseUrl` with `--scope user` or `--scope project` requires an absolute URL without userinfo (`user:password@`) or a query string. All query strings are runtime-only, including non-secret parameters. Use session scope for those URLs; errors do not echo the rejected value. For example, `/config set baseUrl https://example.test/v1 --scope project` is supported, while `/config set baseUrl https://example.test/v1?region=test` applies only to the current session. Existing files are not automatically migrated: edits to other keys preserve their existing URL. Use `/config reset baseUrl --scope project` (or `--scope user`) or save a safe replacement to remove that file's URL override.

Config edits default to the current interactive session and create no configuration files. Successful explicit `/model`, picker, `/thinking`, and direct ChatGPT activation choices also remember the complete provider, billing route or profile, model and supported reasoning tuple for the canonical primary workspace. Merely starting Schway, resuming, or passing CLI overrides never rewrites that memory. Session overrides survive `/new` and `/resume` within the same primary workspace in that process. Resuming a different workspace loads that workspace's effective settings and clears the previous workspace's session overrides, including its auth route. An explicit `--scope user` writes `~/.schway/config.json`; `--scope project` writes `.schway/config.json` in the active session's canonical primary workspace root, including after resuming a different workspace. Attachments are not project config destinations. `--scope session` is also accepted explicitly. Put `--scope` at the end of the command.

Interactive precedence is built-in → remembered workspace choice → user → project → CLI → session. Headless execution ignores interactive memory and keeps built-in → user → project → CLI precedence. Saving a lower-priority value preserves any CLI/session override; the notice shows the saved value, effective value and shadowing origin. Reset removes only the named override in the chosen scope and recomputes inherited settings. Resetting an absent setting does not create a missing file. Selecting another provider clears an inherited lower-layer model when that provider override does not specify a model. No built-in model is substituted. The notice identifies the provider override responsible, and the model stays unset until you choose one.

Provider construction, credential checks and context/output budgets are staged before settings become live. Invalid values, missing credentials, load errors and cancellation before commit preserve the previous usable model and settings. Busy turns reject edits. Persistence validates the complete destination layer, retains its other valid settings, and uses an atomic rename. A malformed file is left untouched with repair guidance. If the file changes while an edit is staged, retry the edit against the current file. Once the atomic save commits, its matching runtime is applied even if Esc arrives at that boundary.

For example, start with a CLI override:

```sh
OPENAI_API_KEY=your-key bun run start --provider openai --max-turns 8
```

Then `/config set maxTurns 12 --scope project` saves 12 but reports that CLI value 8 remains effective. `/config set maxTurns 4` applies 4 immediately, and `/config reset maxTurns` restores CLI value 8. Restart without `--max-turns` to use the saved project value.

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, `selectProfile`, `thinkingCommand`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare`, `prepareModel`, and `prepareProfile` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider.

## Upgrading from the Anthropic provider

The Anthropic provider was removed in 0.4. Configuration or `--provider anthropic` that names it stops before the terminal opens, in interactive and headless runs, prints the notice below and exits non-zero. Remove `"provider": "anthropic"` from `~/.schway/config.json` or `.schway/config.json`.

```text
The Anthropic provider was removed in 0.4.
Use Claude through an OpenAI-compatible endpoint:
  schway --provider openai-compatible --base-url <url> --model <id>
```

Old sessions recorded with Anthropic resume under the route you select now. Anthropic-specific reasoning data in them is not sent to another provider. Schway never reads a stored Anthropic key; `schway doctor` reports one as unused and prints the command that deletes it from the OS secure store.

## Remembering and forgetting choices

Preferences live in user-owned `~/.schway/interactive/<workspace-hash>.json`, separate from credentials, project configuration and conversation history. Git-root subdirectories and symlink aliases share the same canonical workspace preference; different roots and non-Git launch directories remain separate. Only the selection tuple is saved: never API keys, tokens, headers, endpoint URLs or conversation text. Compatible endpoints must remain configured explicitly, preferably as named profiles.

Startup identifies interactive memory and explains when explicit settings shadow it; `/config` shows the source of each effective setting. Explicit provider/profile changes discard incompatible remembered models and reasoning. Ordinary launch still starts a new conversation; `/sessions` lists recent sessions for explicit `/resume`. Resume resolves the destination workspace's current settings rather than restoring historical billing selection.

Use `/model forget` (alias `/model reset`) to remove only this workspace's memory and its current-session provider/model/profile/auth/reasoning overrides. This reveals inherited explicit settings or built-in defaults; credentials, other workspaces and config files remain intact. If inherited access is unavailable, the UI remains open for `/model` or `/login` repair.

Missing profiles or credentials keep the stale choice visible and repairable without switching billing routes. Restored ChatGPT models and reasoning are checked against the current account catalog. API and custom endpoint model availability is established by the provider on a request; request failures retain the chosen route. Choose another model or forget the preference to recover. A failed or cancelled activation preserves the last remembered choice. If the runtime activates but saving fails, it stays usable and a notice says **not remembered**; no second login is needed. Concurrent sessions use revisions: a stale writer cannot replace a newer choice and must reopen before remembering again. Process termination releases writer ownership automatically; a retained secret-free `.lock` file is normal. Unreadable memory blocks automatic model activation unless explicit settings independently select the full provider/model/billing connection (or a valid named profile); that override leaves the unreadable state unchanged and displays an explanation.

## Reasoning levels

Select reasoning with config `"thinking": "medium"`, CLI `--thinking medium`, interactive `/thinking medium`, or `/config set thinking medium` (session only by default). Interactive precedence is built-in → remembered workspace choice → user → project → CLI → session, so a session choice overrides files and flags. `/thinking` without arguments shows requested and effective values with provider/model; `/thinking reset` clears the session override for ordinary providers; in Codex subscription mode it selects the backend default for this session, safely shadowing an incompatible saved level without changing the file. `/config` always shows `thinking` with origin and effective mapping, and the status header shows `(thinking <level>)` when set. Changing reasoning affects future requests only and never rewrites history; thinking and opaque provider metadata still round-trip across tool calls, compaction, and resume.

Per-provider mapping follows current official docs without forcing identical wire semantics:

- OpenAI Platform API-key reasoning (`https://developers.openai.com/api/docs/guides/reasoning`): `off` on reasoning-capable models that support disabling sends `reasoning: { effort: "none" }`, while `off` on unknown or known non-reasoning models sends no reasoning controls. Static metadata records current models: `gpt-6-luna` and `gpt-6-sol` support `off`/`low`/`medium`/`high`/`xhigh`/`max`, with provider default `medium`; `gpt-6-astra` supports `low`/`medium`/`high`/`xhigh`/`max` (no off); `gpt-5.6-terra` and `gpt-5.6-luna` also support `off`; `gpt-5.4` supports `off`/`low`/`medium`/`high`; `gpt-4.1`, `gpt-4o` and unknown IDs expose only safe `off`.
- Codex subscription: `/model` retrieves per-model `supported_reasoning_levels` and `default_reasoning_level` from the authenticated account. `/thinking` shows the advertised default and supported choices. Leaving thinking unset sends no reasoning controls so the backend applies its default; explicitly selected `low`/`medium`/`high`/`xhigh`/`max`/`ultra` (or `off` if advertised as `none`) map to their exact advertised efforts. Unsupported levels are rejected locally before inference. Saved Codex thinking can load provisionally before sign-in or catalog discovery so the session remains recoverable; no explicit reasoning control is sent without verified capabilities, and `/thinking` loads the catalog before showing or changing levels. When changing model, an inherited level that the new model does not support is shadowed by a session-only provider-default marker; saved configuration is untouched.
- OpenRouter at `https://openrouter.ai/api/v1`: Schway reads the model list’s `reasoning.supported_efforts`, `default_effort`, `default_enabled`, and `mandatory` fields. Use normal `--thinking medium`, `/thinking medium`, or config; accepted choices map exactly to `reasoning.effort` (`off` maps to `none`). Mandatory reasoning models do not offer `off`. `minimal` is available only when advertised. Missing effort metadata never implies support. This discovery is bounded and runs before a requested effort can reach inference, including headless and remembered interactive choices. No catalog inference requests are made.
- Other OpenAI-compatible Chat Completions endpoints have no standard reasoning field, so Schway never injects a vendor effort automatically. `off` (or unset) leaves provider defaults untouched and passes `extraBody` through unchanged. Explicit `low`/`medium`/`high` without a configured `extraBody` mapping fail before any request; configure reasoning directly via `--body '{"reasoning_effort":"medium"}'` or profile `extraBody` instead. Reasoning body keys are `reasoning`, `reasoning_effort`, `include_reasoning`, `reasoningEffort`, `reasoning_budget`, `thinking`, `thinking_budget`, and `budget_tokens`. Bare `effort` is not treated as a reasoning control.

Truthful capability handling:

- Unset thinking leaves provider defaults untouched for every family, including unknown IDs. For the static Platform catalog and arbitrary compatible services, explicit `off` on unknown or known non-reasoning models is a no-op; only known reasoning-capable models send the provider's documented disable control. In a Codex subscription or OpenRouter catalog, even `off` must be advertised as `none` for that account/model. Unset/default never means “off”: no control is sent, and `/thinking` displays the advertised default when available.
- Explicit reasoning levels absent from the selected model's known or verified catalog support fail before any request. Unknown Platform IDs explain that support cannot be established instead of pretending a mapping applied; only `off` is a safe no-op there. Codex subscription IDs use the signed-in catalog instead of this static fallback.
- `thinking` plus any reasoning body key in effective `extraBody` (direct or selected-profile `extraBody`) is rejected as `thinking "<level>" conflicts with extraBody.<key>`; remove one to define a single source of truth.
- Model and profile switches recompute capability and effective reasoning. Subscription model switches shadow incompatible saved thinking with a session-only provider default, without editing files. Other providers reject an incompatible request with the previous settings intact; set a compatible level or reset thinking first.

Set reasoning for a task:

```sh
schway --provider openai --model gpt-5.4 --thinking low -p 'plan only'
# OpenRouter: exact provider-advertised effort
schway --provider openai-compatible --base-url https://openrouter.ai/api/v1 --model meta/muse-spark-1.3-contributor --thinking medium -p 'hello'
# Other compatible services: reasoning via extraBody, thinking stays unset
schway --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --body '{"reasoning_effort":"medium"}' -p 'hello'
```

The shared contract lives in `src/model/thinking.ts`: capability provenance, selected model/endpoint checks, validation, conflicts, and effective descriptions. Config, command completion, preferences and adapters reuse it; only `src/model/providers/*` builds wire fields.

Capability sources: [OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), and [OpenRouter reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## xAI API key

An xAI API key bills the xAI console account. It is not the Grok subscription route: that sign-in, its OAuth flow, and any selector between the subscription and this key are a separate route. This route talks to the public xAI Responses API at `https://api.x.ai/v1` and does not read `OPENAI_API_KEY`.

Set the key in the environment, pass it for one process, or save it interactively:

```sh
export XAI_API_KEY=...
schway --provider xai --model grok-4.7 -p "explain this repository"
```

```text
/login xai
/logout xai
```

`/login xai` asks for the key in the masked prompt and stores it at the `api-key:xai` identity. Headless runs never open that prompt. With no model named, headless exits with `No model configured. Pass --provider and --model, or set them in config.` and does not invent `grok-4.7`. After an interactive sign-in with no model set, Schway selects the recommended listed model, falling back to `grok-4.7` when the list names no default.

Reasoning levels come from that model's `capabilities.reasoning_effort` in `GET https://api.x.ai/v1/models`. `none` is offered as `off` and is the only level that sends `reasoning.effort: none`. A model whose efforts omit `none` offers no `off`. A model with no reasoning capability offers only `off`, which sends no `reasoning` field. An unlisted level is rejected. With thinking unset, Schway does not fetch the model list and sends no reasoning control. With thinking set, headless fetches the list once and validates the level before the turn. Capabilities are bound to the API-key or Grok subscription auth route, even when both offer the same model ID. Switching routes fetches the target route’s list before activation; a rejected effort keeps the previous settings and route active. Credential replacement and logout invalidate the affected route’s evidence. If a replacement Grok account’s catalog cannot be verified, its previous adapter stays blocked; another active provider remains usable.

## ChatGPT subscription (Codex OAuth)

The subscription transport does not send an output-token cap: its endpoint rejects
`max_output_tokens`. The `maxOutput` setting remains visible in configuration but
does not limit subscription responses. API-key transport still sends its output
limit.

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

After a successful explicit `/login codex`, Schway discovers this account's visible Codex models and activates the subscription transport and an available model for the current session. It keeps the current model if still visible; otherwise it selects the first advertised visible model. Previous provider/settings remain active if OAuth itself fails or is cancelled. After a successful re-login that replaces subscription credentials, a previous Codex adapter is blocked until the new account's catalog and model activate; this prevents an old model from silently using the new account. Other active providers remain usable if discovery fails. Retry `/model` without repeating OAuth. Saved provider/auth preferences are never overwritten; use `/model` to browse this account's models or `/thinking` to see this model's default and supported levels. Headless Codex runs also discover visible model capabilities before inference: when no available model was selected, Schway uses the first advertised model for that run without editing config; an explicit unavailable `--model` fails instead of silently substituting another ID. `--thinking` is validated against that account's advertised levels before a request. The picker calls `GET https://chatgpt.com/backend-api/codex/models?client_version=0.156.1` using only Schway's stored subscription identity. The query uses a Codex client compatibility version rather than the Schway package version. Update the pinned version only after verifying the model catalog and selected-model transport against that Codex protocol version. The endpoint and `models[].slug` / `visibility` response follow the official open-source [Codex models client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs) and [Codex model protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs). Only `visibility: list` entries are shown; errors do not disclose provider payloads or silently switch billing.

`/login codex` opens the provider browser flow with a localhost callback and per-attempt PKCE/state; denial, expiry, timeout, and Esc cancellation settle without leaked listeners. On machines where the browser cannot reach the loopback callback, `/login codex --device` prints a user code to approve at `https://auth.openai.com/codex/device` (beta, 900 s timeout), and `--code` exchanges a manually pasted redirect URL or code. Tokens (short-lived access plus `offline_access` refresh) live only at the subscription secure-store identity with serialized pre-expiry refresh; `/logout codex` removes exactly that identity. Resume rebuilds the native conversation under the currently selected auth identity without replaying tools, and prior provider metadata round-trips across auth switches.

The login survives restarts, but the provider selected by `/login codex` applies only to the current session. To use the saved subscription by default on future launches, save both settings once:

```text
/config set provider openai --scope user
/config set openaiAuth codex --scope user
```

Without a saved provider preference, Schway starts with its built-in OpenAI provider, where automatic auth uses a stored Codex login when no API key is supplied. You can also use `schway --provider openai --openai-auth codex` without repeating login. Project settings and CLI flags still override user settings.

`/model` checks configured credentials whenever it opens. It groups the current model and active-auth choices first, followed by other configured providers/profiles, then choices that need login. Search keeps the same ordering. Rows show `ChatGPT`, `API key`, `No key required`, or `Login required`; these describe credential configuration, not a guarantee that a remote service will accept a key. In automatic auth mode, a saved Codex login exposes that account's models even when the session started with another provider. Selecting one activates Codex for the session. Explicit API-key preferences and runtime/environment key precedence remain in effect.

The browser returning to `http://localhost:1455/auth/callback` is expected. Schway starts that listener before launching the browser and finishes sending the callback page before closing the connection. The page confirms receipt; the terminal reports whether the tokens were saved. A callback from an older browser tab returns an error without cancelling the current attempt.

Use the saved subscription or an API key:

```sh
# Use a saved ChatGPT login
schway --provider openai --openai-auth codex -p 'hello'
# Use an API key
schway --provider openai --openai-auth api-key -p 'hello'
```

See `src/model/providers/codex-subscription.ts` (verified OAuth/Responses contract, token lifecycle, wire conversion), `src/auth/credentials.ts` (`selectOpenAITransport`), and `src/auth/store.ts` (`codexSubscriptionIdentity`) for the implementation contract.

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

- `/config show` and the status header show the active `profile` with redacted effective settings (`credentialEnv`/`credentialIdentity` names are shown, values hidden; URLs sanitized; headers/bodies hidden).
- `/model` opens the picker with profile groups (`<name> · <host>`) and model IDs; `/model profile:<name>` and `/config set profile <name>` switch profiles. Only the explicit `profile:<name>` form switches profiles; a bare model token never selects a profile, so direct model IDs cannot collide with profile names. `/model <provider>/<id>` clears the profile for direct selection. `/model <provider>/<id>` and `/config reset profile` record a session-only cleared profile that outranks user, project, and CLI selections.

Use two local endpoints:

```sh
cat ~/.schway/config.json
# { "profiles": { "a": { "baseUrl": "http://127.0.0.1:8101/v1", "model": "model-a", "credentialEnv": "PROFILE_A_KEY" }, "b": { "baseUrl": "http://127.0.0.1:8102/v1", "model": "model-b", "credentialEnv": "PROFILE_B_KEY" } } }
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile a -p 'hello from a'
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile b --model override-model --header 'X-Test: ok' -p 'hello from b'
```

Each endpoint receives only its profile's model, body, headers, and sentinel credential; runtime overrides apply last; switching never leaks the earlier credential.

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

See `src/workspace/git.ts` (`inspectGitStatus`, `captureGitSnapshot`, `compareGitSnapshots`, `getGitDiffPreview`), `src/config/config.ts` (`git.changeTracking`, `DEFAULT_GIT_CHANGE_TRACKING`), and `src/tui/controller.ts` (`changesCommand`, `gitChangeTracking`) for the contract.

## Grok subscription (xAI OAuth)

A SuperGrok account can connect through `/login grok` for browser approval or `/login grok --device` for a remote machine. Approval saves tokens in the OS secure store, lists account models and activates the recommended xAI model. Some Grok plans do not include public API access; a plan-level 403 asks you to choose an xAI API key instead. The saved login remains available if you change plans.

`xaiAuth` selects `auto` (the default), `grok` or `api-key`. Set it with `/config set xaiAuth grok` or `--provider xai --xai-auth grok`. Automatic selection prefers a supplied API key or `XAI_API_KEY`, then a saved Grok login, then a saved xAI API key. Explicit `grok` ignores API keys. Explicit `api-key` ignores Grok tokens. There is no automatic billing fallback.

After interactive sign-in, headless runs can use `schway --provider xai --xai-auth grok --model <id> -p "…"`. They refresh stored tokens when needed and never open a browser. Missing or revoked logins require interactive sign-in. `/logout grok` removes only the Grok OAuth credential and blocks an active Grok account until sign-in and activation succeed again.

Test coverage for this guide: [release verification](release-verification.md#configuration).
