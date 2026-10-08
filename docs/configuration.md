# Interactive models and configuration

## Configuration files

Schway does not select a model before you configure or sign in. Interactive launch with neither config nor a remembered model choice shows no model and will not send until one is usable. Headless runs need `--model` or a model in config; `--provider` is optional when using the default OpenAI provider. Config files are never created automatically.

Precedence, later wins:

1. built-in defaults
2. `~/.schway/config.json`
3. `<workspace-root>/.schway/config.json`
4. CLI flags

Project config is read from the workspace root (nearest Git root, otherwise the launch directory), not from a nested launch cwd. The `packages` enablement lists are scope-specific and additive across user/project files; they do not follow scalar-setting replacement.

```json
{
  "provider": "openai-compatible",
  "model": "<id>",
  "maxTurns": 16,
  "maxConcurrentTools": 4,
  "contextWindow": 128000,
  "maxOutput": 4096,
  "baseUrl": "http://127.0.0.1:11434/v1",
  "headers": { "X-Test": "ok" },
  "extraBody": { "temperature": 0.2 },
  "auth": "optional"
}
```

Unknown or misspelled settings fail with an actionable error. `baseUrl`, `headers`, `extraBody`, and `auth` apply only when the selected provider is `openai-compatible`.

For example, change `{"approval":{"mode":"readonly"}}` to
`{"approval":{"mode":"read-only"}}`. Previously, startup named a validation
failure and doctor reported both a config failure and an apparent package fault.
Both now report `Invalid approval.mode · Use auto, ask, or read-only`, with the
affected config file. Doctor reports each invalid source under `config.user` or
`config.project` and continues independent checks. Package inspection explains
which config check to repair when that scope could not be inspected; a missing
package in another valid scope is still reported.
If both scopes resolve to the same file, its failure is reported once; doctor
links the dependent scope to the primary config check.

Diagnostics describe expected types, supported values and constraints without
printing invalid values. Unknown keys and dynamic profile/header names appear as
`<unknown setting>`; recognized paths such as `approval.mode` remain specific.
For example, a profile endpoint error names
`profiles.<unknown setting>.baseUrl`. Check the named file to identify the entry.
Source labels are bounded and terminal control sequences are removed. Config
reads and doctor never repair files automatically.
Startup and doctor hide known credentials in source labels before shortening
them, including CLI keys, secret headers, provider keys from the supplied
environment or explicit `--env-file`, and environment values named by valid
`credentialEnv` references in either config file. Both files are read before
these labels are formatted, even when another setting is invalid. This does not
read saved credentials or treat unrelated environment values as secrets.

Doctor JSON keeps `schemaVersion: 1` and each check's required `id`, `status`,
`summary` and `remedy`. Config errors and deprecation warnings may additionally
include `diagnostics`, an array of `{ source, path, category, constraint, values? }`.
`source` is the sanitized file label or settings source, `path` is a safe setting path (empty for a
whole-file failure), and `values` lists supported enum strings when applicable.
Categories are `json`, `root`, `unknown-setting`, `enum`, `type`, `range`,
`constraint`, `secret`, `unreadable`, `removed-provider`, and `deprecated`.
Use these categories and the config check ID for automation; avoid matching
human-readable messages or relying on `package.<index>` ordering. Multiple
dynamic entries can share the same redacted path. Deprecations remain warnings;
removed-provider migration instructions remain available.

For a first task, follow a [complete route/model guide](headless.md#choose-your-route-run-and-resume).
For example, after preparing an OpenAI API key, these **POSIX shell** commands
choose an advertised ID explicitly. The first line also uses the same explicit
environment file as the first task; no `.env` file loads automatically.

```sh
schway models list --provider openai --openai-auth api-key --env-file ~/.config/my-ai.env
IFS= read -r MODEL_ID
schway -p "Explain this repository" --provider openai --openai-auth api-key --model "$MODEL_ID" --env-file ~/.config/my-ai.env --show-session
schway -p "Explain this repository" --provider openai --openai-auth api-key --model "$MODEL_ID" --env-file ~/.config/my-ai.env --max-turns 8 --max-output 2048 --show-session
```

An interactive choice remains separate from file settings and is ignored by
headless tasks. `--resume` selects [saved history](sessions.md), not old auth or
billing. Reuse the chosen route/model flags, or immediately save the required
settings as shown in the [saved-config flow](headless.md#use-explicit-saved-settings).
[Credentials](credentials.md) stay out of config; [doctor](doctor.md) checks local
readiness without proving remote access.

## Approval modes

`approval.mode` accepts `auto` (default), `ask`, or `read-only`; unknown modes are rejected. Ask previews mutating tools for an interactive decision; headless ask refuses them immediately with `approval required; headless cannot ask`. A denial alone does not change the exit code. Read-only lets tools investigate but refuses tools that can change files or run commands. Skill activation remains available.

Read-only does not mean offline. Tools that only read, including `web_fetch`, run without a prompt in every mode, and a fetch sends its URL to a remote host. In `ask` and `read-only`, the model can still put workspace content into a fetched URL without asking. See [Fetch web pages](tools.md#fetch-web-pages).

```json
{ "approval": { "mode": "read-only" } }
```

Approval uses a stricter-only rule for project configuration: the user file's mode (or `auto` when unset) is the baseline, and a project mode applies only if it is equally strict or stricter. A looser project value is ignored, with one notice per project config path in a process. The strictness order is `auto` → `ask` → `read-only`. A project `ask` applies over user `auto`; project `auto` or `ask` is ignored under user `read-only`. CLI `--approval auto|ask|read-only` and session values replace the result in either direction because they are the user's own actions; session values win over CLI flags. Interactive memory never carries approval mode.

`/config set approval {"mode":"read-only"}` changes the current session setting. Add `--scope user` or `--scope project` to save a file setting. A looser project edit is saved but ignored under the same rule. Shift+Tab cycles the live process mode without saving configuration; that choice survives `/new`, `/resume`, and model changes in the process.

## Project instructions

Schway loads `AGENTS.md` from general to specific:

- `~/.schway/AGENTS.md`
- applicable primary or attached project roots
- nested directories on the current turn’s launch path or latest tool `path` / `cwd` targets

Nested files are discovered when work enters that subtree. Sibling directories are not loaded.

Replace the base system prompt with `~/.schway/SYSTEM.md` and append with `~/.schway/APPEND_SYSTEM.md`. Project-local `SYSTEM.md` is ignored; put project instructions in `AGENTS.md`.

Each turn's model requests also include your local date, weekday, time zone name and UTC offset, captured once when the turn starts, so the selected provider receives them. Time of day and location are not sent. `SYSTEM.md` does not remove this context.

## Interactive configuration

Start Schway with `bun run start` (or `schway` after installation). Set the selected provider's API key in the environment or pass `--api-key` at launch. Configuration does not store API keys.

A fresh install names no model. The screen shows `Not connected; Connect a provider · Alt+L sign in`, and sending stays unavailable until a model is usable. Typed text is kept. Headless runs do not invent a model: without a provider and model in config or `--provider` and `--model`, Schway exits non-zero with `No model configured · Pass --provider and --model, or set them in config`

Enter `/model` or press Alt+M to choose a model without losing your draft. The initial list has at most eight model rows: current choice, user-wide favorites, then recent successful choices. Rows are deduplicated by exact model, auth route, endpoint and profile identity. Disconnected routes and their favorites stay hidden. With no favorites or history, Schway offers a small selection from connected providers instead of their full catalogs.

Type to search all models on connected routes immediately, including models outside the shortlist. Search ignores case and ranks exact, prefix, substring and subsequence matches against readable names, exact IDs, `provider/modelId` and route labels. **Browse all models** opens the complete connected catalog; Esc returns to your shortlist, then closes the picker. **Connect a provider** reveals connection targets, including configured endpoints and profiles. Up/Down selects a row and Enter uses it or opens its action. Connection cancellation restores the selected target and query; successful connection returns to matching models.

Press Ctrl+P to pin or unpin a model. Pins and recents are shared across workspaces in `~/.schway/model-preferences.sqlite`; only successful activations enter recents. The file stores bounded model IDs and hashed exact route identities, never endpoint URLs, credentials or credential references. Independent writers merge transactionally. Invalid or busy storage leaves the active model usable and offers a retry notice. Disconnected favorites remain saved for reconnection.

Rows show readable names and subscription/API identity, with ✓ for the current model and ★ for a favorite. F2 reveals the exact ID and context/output budgets. Ctrl+I remains an alias when the terminal reports it distinctly. Ctrl+R retries failed discovery. Reopening uses compatible cached lists while refreshing access, and a stale response cannot select another route. A typed `provider/model-id` remains selectable on a connected API route even when absent from the catalog. For an ID containing a slash, include the provider first, such as `openai-compatible/org/custom-model`. Unknown IDs keep conservative budgets; advertised metadata supplies known limits.

When ordinary sign-in or initial setup activates a recommended model, Schway chooses the provider's marked default when the list includes one, otherwise the documented fallback (`gpt-6-astra` for OpenAI API key and ChatGPT subscription, `gpt-4o` for a compatible endpoint) when it is listed, otherwise the first listed model that is also in the static catalog for that provider, otherwise the first listed model. The OpenAI API-key recommendation uses the chat-only list. A connection started from the picker with a model already selected restores the query and highlights a model; Enter selects it. An activated choice is remembered for the next interactive launch in this workspace. It does not change saved config files and is ignored by headless runs.

ChatGPT subscription rows come from the account catalog, not the usage-billed Platform `/v1/models` endpoint, and are shown as returned. The OpenAI API-key route uses `https://api.openai.com/v1/models` and shows chat models only. A compatible endpoint uses `{baseUrl}/models` and shows its list as returned. A connected subscription route with discovery failure offers fallback models and a Ctrl+R retry action.

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
/config set ui {"splash":"never"} --scope user
/config reset ui --scope user
```

`/config` (or Alt+P) opens the basic preferences list: **Model**, **Thinking**, **Connections**, **Appearance**, **Track file changes**, and **Welcome screen**. Model opens the model picker; Connections opens connection management. Both actions are available before a model is active. Appearance and the welcome screen can be changed before login. These actions keep the pending task and cursor.

Choose **Advanced** for numeric limits, provider/profile/access overrides, saved layers and effective sources. `/config show` retains the complete textual inspection. Limits show `catalog` when derived from model metadata and `explicit limit` when supplied by a layer. Connection headers and extra request bodies are shown as configured with values hidden; URLs omit credentials, queries and fragments, and known API keys are redacted.

Up/Down selects a row; Enter opens Model, Connections or Advanced. For settings, Left/Right selects a bounded value or **Reset (inherit)**. Tab/Shift+Tab chooses This session, All workspaces or This project. Advanced also offers workspace memory; returning from that scope to Basic restores This session. Enter validates and previews; a second Enter confirms that exact staged edit. Escape discards a preview, returns from Advanced to Basic, then returns to the unchanged task and cursor. PageUp/PageDown or the mouse scrolls details on narrow terminals. Basic settings distinguish the value saved in the selected scope from the effective value. Advanced shows saved lower layers and the source that shadows them. Remove a CLI flag to reset a CLI override; resetting a lower scope does not remove the flag.

The scope explanation appears before confirmation:

- **Session:** changes only the running process; it is not automatically remembered.
- **Workspace memory (Advanced only):** explicitly remembers the complete currently activated provider/model/auth/profile/reasoning choice, or resets just that workspace's memory. An eligible saved choice also becomes the default for new workspaces. Reset leaves explicit config and session overrides intact and suppresses that workspace's global fallback. Headless ignores interactive memory.
- **User:** deliberately writes `~/.schway/config.json`, shared across workspaces.
- **Project:** deliberately writes the canonical primary workspace's `.schway/config.json`; opening the view never changes repository files.

Thinking choices come from supported model capabilities (verified account metadata for Codex); unknown Codex capabilities expose reset only. Numeric controls offer presets; exact positive limits remain available through textual commands. A preset incompatible with the current model is rejected with the selection retained. Advanced connection rows expose scoped reset and the separate **model picker**, which activates and remembers a successful choice regardless of the preferences scope; it does not write user/project config. URLs, headers, request bodies and credentials are excluded from the preference inspector. Existing unrelated settings are preserved during explicit file edits.

Malformed files, unavailable models, cancellation, and changes made by another writer retain the previous working state. Confirmation commits the transaction prepared for that preview, so a file changed between preview and confirmation is not overwritten. A lower value saved beneath CLI/session overrides is labeled **saved but not effective** with its overriding source.

Editable keys are `provider`, `model`, `thinking`, `profile`, `maxTurns`, `maxConcurrentTools`, `contextWindow`, `maxOutput`, `baseUrl`, `auth`, and `openaiAuth`, plus `git`, `undo`, `approval`, `appearance`, and `ui`. Appearance accepts `auto`, `dark`, or `light`; the launch environment `SCHWAY_THEME=dark|light` wins over every config scope. The `ui.splash` preference accepts `always`, `first-run` (default), or `never`. `SCHWAY_MOTION=full|reduced|off` controls motion, and reduced or off suppresses both splash and bolt accent regardless of `ui.splash` (see [TUI motion](tui.md#motion-and-startup-splash)). Limits must be positive integers. Providers are `openai`, `xai`, and `openai-compatible`; compatible endpoints require a `baseUrl`, and accept auth modes `required`, `optional`, or `none`. OpenAI accepts the separate credential preference `openaiAuth` (`auto`, `codex`, or `api-key`; see ChatGPT subscription below). Thinking syntax accepts `off`, `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; each provider/model only accepts verified supported levels. Codex levels come from the signed-in account's catalog. Model IDs, profile names, and URLs must be nonempty. Use double-quoted JSON strings when needed. Unsupported keys, including API-key/token fields, are rejected. Existing `headers`, `extraBody`, `profiles`, and `packages` are preserved but `headers`/`extraBody`/`profiles` definitions cannot be edited live; change those supported file settings outside the TUI and restart. `/config set profile <name>` and `/config reset profile` switch or clear the active profile. `/config set thinking medium` and `/config reset thinking` switch or clear reasoning; `/thinking` shows requested and effective levels with provider/model.

Saving `baseUrl` with `--scope user` or `--scope project` requires an absolute URL without userinfo (`user:password@`) or a query string. All query strings are runtime-only, including non-secret parameters. Use session scope for those URLs; errors do not echo the rejected value. For example, `/config set baseUrl https://example.test/v1 --scope project` is supported, while `/config set baseUrl https://example.test/v1?region=test` applies only to the current session. Existing files are not automatically migrated: edits to other keys preserve their existing URL. Use `/config reset baseUrl --scope project` (or `--scope user`) or save a safe replacement to remove that file's URL override.

Config edits default to the current interactive session and create no configuration files. Successful explicit `/model`, picker, `/thinking`, and direct ChatGPT activation choices also remember the complete provider, billing route or profile, model and supported reasoning tuple for the canonical primary workspace. Merely starting Schway, resuming, or passing CLI overrides never rewrites that memory. Session overrides survive `/new` and `/resume` within the same primary workspace in that process. Resuming a different workspace loads that workspace's effective settings and clears the previous workspace's session overrides, including its auth route. An explicit `--scope user` writes `~/.schway/config.json`; `--scope project` writes `.schway/config.json` in the active session's canonical primary workspace root, including after resuming a different workspace. Attachments are not project config destinations. `--scope session` is also accepted explicitly. Put `--scope` at the end of the command.

Interactive precedence is built-in → interactive memory → user → project → CLI → session. Interactive memory uses the workspace record when present, otherwise the latest eligible successful choice across workspaces. Headless execution ignores interactive memory and keeps built-in → user → project → CLI precedence. Saving a lower-priority value preserves any CLI/session override; the notice shows the saved value, effective value and shadowing origin. Reset removes only the named override in the chosen scope and recomputes inherited settings. Resetting an absent setting does not create a missing file. Selecting another provider clears an inherited lower-layer model when that provider override does not specify a model. No built-in model is substituted. The notice identifies the provider override responsible, and the model stays unset until you choose one.

Provider construction, credential checks and context/output budgets are staged before settings become live. Invalid values, missing credentials, load errors and cancellation before commit preserve the previous usable model and settings. Busy turns reject edits. Persistence validates the complete destination layer, retains its other valid settings, and uses an atomic rename. A malformed file is left untouched with repair guidance. If the file changes while an edit is staged, retry the edit against the current file. Once the atomic save commits, its matching runtime is applied even if Esc arrives at that boundary.

For example, start with a CLI override:

```sh
OPENAI_API_KEY=your-key bun run start --provider openai --max-turns 8
```

Then `/config set maxTurns 12 --scope project` saves 12 but reports that CLI value 8 remains effective. `/config set maxTurns 4` applies 4 immediately, and `/config reset maxTurns` restores CLI value 8. Restart without `--max-turns` to use the saved project value.

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, `selectProfile`, `thinkingCommand`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare`, `prepareModel`, and `prepareProfile` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider.

## Startup splash

`ui.splash` chooses `always`, `first-run`, or `never`; the default is `first-run`.
Alt+P exposes a **ui.splash** row with these choices and **Reset (inherit)**.
Reset on that row removes only `splash` from the selected layer, preserving
`ui.inlineDiffLines`. `/config set ui {"splash":"never"}` also preserves sibling
keys in that same layer. `/config reset ui` deliberately removes the entire
selected `ui` override. Across layers, the `ui` object still follows ordinary
whole-object replacement precedence. Unknown `ui` keys and modes are rejected.

The preference is read at launch. The first full splash of a version is recorded
in `~/.schway/ui-state.json`; subsequent launches use a nonblocking bolt accent.
Changing the installed version triggers another first-run splash. `never`,
reduced/off motion and resume never play the full splash; small terminals use
only the accent. See [startup behavior](tui.md#motion-and-startup-splash) for gates
and best-effort state persistence.

## Inline file diffs

Set `ui.inlineDiffLines` in user or project config to control how many changed rows appear beneath successful edits and newly created files. The default is `12`; `0` disables inline diffs. The value must be a non-negative integer. Larger diffs keep their result summary and expand through the tool details controls. Existing-file writes show their overwritten line count without a diff.

```json
{
  "ui": { "inlineDiffLines": 12, "splash": "first-run" }
}
```

This file setting has no preferences-panel row. Change the config file and restart Schway to apply it.

## Upgrading from the Anthropic provider

Anthropic support ended in 0.4 Configuration or `--provider anthropic` that names it stops before the terminal opens, in interactive and headless runs, prints the notice below and exits non-zero. Remove `"provider": "anthropic"` from `~/.schway/config.json` or `.schway/config.json`.

```text
Anthropic support ended in 0.4
Use Claude through a compatible endpoint:
  schway --provider openai-compatible --base-url <url> --model <id>
```

Old sessions recorded with Anthropic resume under the route you select now. Anthropic-specific reasoning data in them is not sent to another provider. Schway never reads a stored Anthropic key; `schway doctor` reports one as unused and prints the command that deletes it from the OS secure store.

## Remembering and forgetting choices

Preferences live in user-owned `~/.schway/interactive/<workspace-hash>.json`, separate from credentials, project configuration and conversation history. Git-root subdirectories and symlink aliases share the same canonical workspace preference; different roots and non-Git launch directories remain separate. Only the selection tuple is saved: never API keys, tokens, headers, endpoint URLs or conversation text. Compatible endpoints must remain configured explicitly, preferably as named profiles.

Existing workspace choices stay independent: if A remembers X and B remembers Y, they continue restoring X and Y. A workspace with no memory record inherits the latest eligible successful choice from `~/.schway/interactive/global/latest.json`. The provider, model, billing route and reasoning preference travel together. Compatible endpoints and profiles, selections with explicit endpoint URLs, and legacy xAI records without a billing route are workspace-only. They do not replace the last eligible global choice. This prevents a project-only profile from leaking or binding to a different same-name endpoint in another project. Without an eligible global choice, a new workspace leaves its model unset unless explicit configuration selects one.

Startup identifies interactive memory and explains when explicit settings shadow it; `/config` shows the source of each effective setting. Explicit provider/profile changes discard incompatible remembered models and reasoning. Ordinary launch still starts a new conversation; `/sessions` lists recent sessions for explicit `/resume`. Resume resolves the destination workspace's current settings rather than restoring historical billing selection.

Use `/model forget` (alias `/model reset`) to remove only this workspace's memory and its current-session provider/model/profile/auth/reasoning overrides. This reveals inherited explicit settings or built-in defaults; credentials, other workspaces, the global choice and config files remain intact. A local reset record prevents the global choice from returning on the next launch. Existing version 1 workspace records need no migration and take priority over the global fallback. If inherited access is unavailable, the UI remains open for `/model` or `/login` repair.

Missing profiles or credentials keep the stale choice visible and repairable without switching billing routes. Restored ChatGPT models and reasoning are checked against the current account catalog. API and custom endpoint model availability is established by the provider on a request; request failures retain the chosen route. Choose another model or forget the preference to recover. A failed or cancelled activation preserves the last remembered choice. If the runtime activates but saving fails, it stays usable and a notice says **not remembered**; no second login is needed. Concurrent sessions use revisions: a stale writer cannot replace a newer choice and must reopen before remembering again. Process termination releases writer ownership automatically; a retained secret-free `.lock` file is normal. Unreadable memory blocks automatic model activation unless explicit settings independently select the full provider/model/billing connection (or a valid named profile); that override leaves the unreadable state unchanged and displays an explanation.

Global publication is locked across workspaces. Both records are staged before the workspace save; if publishing the global record then fails, the workspace keeps its saved choice and the previous global fallback remains. Details explain that retrying the selection updates new workspaces; the running editor adopts the saved workspace revision so that retry works. Process termination between the two saves can likewise leave the global fallback unchanged. Malformed global state never overrides an existing workspace record. In a new workspace, choose an eligible model to repair it or use `/model forget` to suppress fallback locally. Startup, resume and headless runs do not rewrite either record.

## Reasoning levels

Select reasoning with config `"thinking": "medium"`, CLI `--thinking medium`, interactive `/thinking medium`, or `/config set thinking medium` (session only by default). Interactive precedence is built-in → interactive memory → user → project → CLI → session, so a session choice overrides files and flags. `/thinking` without arguments shows requested and effective values with provider/model; `/thinking reset` clears the session override for ordinary providers; in Codex subscription mode it selects the backend default for this session, safely shadowing an incompatible saved level without changing the file. `/config` always shows `thinking` with origin and effective mapping. The status bar's reasoning chip always shows the effective effort while a model is selected: the explicit level, `Provider default` when nothing is sent (with the advertised level, such as `Provider default (medium)`, when the model list names one), or `<level> unavailable`. Each turn records the effort its adapter used in the [turn history sidecar](sessions.md#turn-history-sidecar), and `/history` shows it. Changing reasoning affects future requests only and never rewrites history; thinking and opaque provider metadata still round-trip across tool calls, compaction, and resume.

Per-provider mapping follows current official docs without forcing identical wire semantics:

- OpenAI Platform API-key reasoning (`https://developers.openai.com/api/docs/guides/reasoning`): `off` on reasoning-capable models that support disabling sends `reasoning: { effort: "none" }`, while `off` on unknown or known non-reasoning models sends no reasoning controls. Static metadata records current models: `gpt-6-luna` and `gpt-6-sol` support `off`/`low`/`medium`/`high`/`xhigh`/`max`, with provider default `medium`; `gpt-6-astra` supports `low`/`medium`/`high`/`xhigh`/`max` (no off); `gpt-5.6-terra` and `gpt-5.6-luna` also support `off`; `gpt-5.4` supports `off`/`low`/`medium`/`high`; `gpt-4.1`, `gpt-4o` and unknown IDs expose only safe `off`.
- Codex subscription: `/model` retrieves per-model `supported_reasoning_levels` and `default_reasoning_level` from the authenticated account. `/thinking` shows the advertised default and supported choices. Leaving thinking unset sends no reasoning controls so the backend applies its default; explicitly selected `low`/`medium`/`high`/`xhigh`/`max`/`ultra` (or `off` if advertised as `none`) map to their exact advertised efforts. Unsupported levels are rejected locally before inference. Saved Codex thinking can load provisionally before sign-in or catalog discovery so the session remains recoverable; no explicit reasoning control is sent without verified capabilities, and `/thinking` loads the catalog before showing or changing levels. When changing model, an inherited level that the new model does not support is shadowed by a session-only provider-default marker; saved configuration is untouched.
- OpenRouter at `https://openrouter.ai/api/v1`: Schway reads the model list’s `reasoning.supported_efforts`, `default_effort`, `default_enabled`, and `mandatory` fields. Use normal `--thinking medium`, `/thinking medium`, or config; accepted choices map exactly to `reasoning.effort` (`off` maps to `none`). Mandatory reasoning models do not offer `off`. `minimal` is available only when advertised. Missing effort metadata never implies support. This discovery is bounded and runs before a requested effort can reach inference, including headless and remembered interactive choices. No catalog inference requests are made.
- Other OpenAI-compatible Chat Completions endpoints have no standard reasoning field, so Schway never injects a vendor effort automatically. `off` (or unset) leaves provider defaults untouched and passes `extraBody` through unchanged. Explicit `low`/`medium`/`high` without a configured `extraBody` mapping fail before any request; configure reasoning directly via `--body '{"reasoning_effort":"medium"}'` or profile `extraBody` instead. Reasoning body keys are `reasoning`, `reasoning_effort`, `include_reasoning`, `reasoningEffort`, `reasoning_budget`, `thinking`, `thinking_budget`, and `budget_tokens`. Bare `effort` is not treated as a reasoning control.

Truthful capability handling:

- Unset thinking leaves provider defaults untouched for every family, including unknown IDs. Schway sends no per-model default of its own (see [Schway model defaults](#schway-model-defaults)). For the static Platform catalog and arbitrary compatible services, explicit `off` on unknown or known non-reasoning models is a no-op; only known reasoning-capable models send the provider's documented disable control. In a Codex subscription or OpenRouter catalog, even `off` must be advertised as `none` for that account/model. Unset/default never means “off”: no control is sent, and `/thinking` displays the advertised default when available.
- Explicit reasoning levels absent from the selected model's known or verified catalog support fail before any request. Unknown Platform IDs explain that support cannot be established instead of pretending a mapping applied; only `off` is a safe no-op there. Codex subscription IDs use the signed-in catalog instead of this static fallback.
- `thinking` plus any reasoning body key in effective `extraBody` (direct or selected-profile `extraBody`) is rejected as `thinking "<level>" conflicts with extraBody.<key>`; remove one to define a single source of truth.
- Model and profile switches recompute capability and effective reasoning. Subscription model switches shadow incompatible saved thinking with a session-only provider default, without editing files. Other providers reject an incompatible request with the previous settings intact; set a compatible level or reset thinking first.

Set reasoning for a task only after preparing that route's credentials and
choosing an ID from its catalog, as in the [headless flows](headless.md).
The named models below illustrate capability syntax; use them only if your
route advertises them and the requested effort. `MODEL_ID` for the final local
command must be an exact ID chosen from that running endpoint's list.

```sh
schway --provider openai --openai-auth api-key --model gpt-5.4 --thinking low -p 'plan only'
# OpenRouter: exact provider-advertised effort
schway --provider openai-compatible --base-url https://openrouter.ai/api/v1 --auth required --model meta/muse-spark-1.3-contributor --thinking medium -p 'hello'
# Other compatible services: reasoning via extraBody, thinking stays unset
schway --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth none --model "$MODEL_ID" --body '{"reasoning_effort":"medium"}' -p 'hello'
```

The shared contract lives in `src/model/thinking.ts`: capability provenance, selected model/endpoint checks, validation, conflicts, and effective descriptions. Config, command completion, preferences and adapters reuse it; only `src/model/providers/*` builds wire fields.

Capability sources: [OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), and [OpenRouter reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

### Schway model defaults

Schway ships no reasoning default of its own for any model, including `grok-4.x`. Issue #321 evaluated sending one, such as `low` or `medium`, for `grok-4.x` when every layer leaves thinking unset. The rule is to ship it only after a recorded run of the [reasoning effort evaluation](live-providers.md#reasoning-effort-evaluation) shows, on each route the default covers, that:

- the route accepts the level for `grok-4.x` without a 4xx; and
- the level cuts median reasoning tokens and median model time compared with leaving thinking unset.

No operator has recorded that run, so the decision is no default. Unset thinking sends no reasoning control on the Grok subscription and xAI API-key routes, and the chip says `Provider default`.

The policy table `MODEL_THINKING_DEFAULTS` in `src/model/thinking.ts` is empty. Effective descriptions, the footer chip and per-turn records already handle a Schway default (`Schway default (low)`, source `model-default`). Adopting an entry also requires:

- sending it from the xAI adapter only with a verified capability for that exact model and route;
- a bounded model-list fetch when thinking is unset that never blocks startup or a headless run and sends nothing on failure (no such fetch runs today);
- honoring the session-only `null` marker so `/thinking reset` can select the provider's own default for one session;
- this section and a CHANGELOG entry.

An explicit level always wins. A resolved default is never written into interactive memory, `config.json` or the session, so users who never chose a level would get it, and any later change to it, without a migration.

## xAI API key

An xAI API key bills the xAI console account. It is not the Grok subscription route: that sign-in, its OAuth flow, and any selector between the subscription and this key are a separate route. This route talks to the public xAI Responses API at `https://api.x.ai/v1` and does not read `OPENAI_API_KEY`.

Set `XAI_API_KEY` explicitly or save the key with `/login xai`, then choose an
exact ID. In a POSIX shell:

```sh
schway models list --provider xai --xai-auth api-key
IFS= read -r MODEL_ID
schway --provider xai --xai-auth api-key --model "$MODEL_ID" -p "Explain this repository" --show-session
```

```text
/login xai
/logout xai
```

`/login xai` asks for the key in the masked prompt and stores it at the `api-key:xai` identity. Headless runs never open that prompt. With no model named, headless exits with `No model configured · Pass --provider and --model, or set them in config` and does not invent `grok-4.7`. After an interactive sign-in with no model set, Schway selects the recommended listed model, falling back to `grok-4.7` when the list names no default.

Reasoning levels come from that model's `capabilities.reasoning_effort` in `GET https://api.x.ai/v1/models`. `none` is offered as `off` and is the only level that sends `reasoning.effort: none`. A model whose efforts omit `none` offers no `off`. A model with no reasoning capability offers only `off`, which sends no `reasoning` field. An unlisted level is rejected. With thinking unset, Schway does not fetch the model list and sends no reasoning control; there is no Schway default for `grok-4.x` (see [Schway model defaults](#schway-model-defaults)). With thinking set, headless fetches the list once and validates the level before the turn. Capabilities are bound to the API-key or Grok subscription auth route, even when both offer the same model ID. Switching routes fetches the target route’s list before activation; a rejected effort keeps the previous settings and route active. Credential replacement and logout invalidate the affected route’s evidence. If a replacement Grok account’s catalog cannot be verified, its previous adapter stays blocked; another active provider remains usable.

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
  "openaiAuth": "chatgpt"
}
```

- `openaiAuth: "chatgpt"` uses the stored subscription login only. Missing, expired, revoked, or refresh-failed sessions fail with distinct actionable errors and never fall back to paid API-key billing.
- `openaiAuth: "api-key"` uses only `--api-key`, `OPENAI_API_KEY`, or the stored native OpenAI key, and never touches the subscription.
- `openaiAuth: "auto"` (default) prefers an explicit/runtime or environment API key when one is set, otherwise uses a stored subscription login. Headless runs never start a browser automatically.

This preference is independent of compatible-endpoint `auth` (`required`/`optional`/`none`). Set it with config `"openaiAuth": "chatgpt"`, CLI `--openai-auth chatgpt`, or live with `/config set openaiAuth chatgpt` (session only by default); `/config` shows its value and origin with tokens redacted. `codex` is an accepted alias for `chatgpt` in config, flags and `/login`/`/logout`. Schway saves the value as `codex` so older builds can read the file, and `/config` shows `codex`; a hand-written `"chatgpt"` changes to `"codex"` only when Schway next rewrites that file.

Sign in interactively (never paste secrets after the slash command):

```text
/login chatgpt
/login chatgpt --device
/login chatgpt --code <callback-url-or-authorization-code>
/logout chatgpt
```

After a successful explicit `/login chatgpt`, Schway discovers this account's visible Codex models and activates the subscription transport and an available model for the current session. It keeps the current model if still visible; otherwise it selects the first advertised visible model. Previous provider/settings remain active if OAuth itself fails or is cancelled. After a successful re-login that replaces subscription credentials, a previous Codex adapter is blocked until the new account's catalog and model activate; this prevents an old model from silently using the new account. Other active providers remain usable if discovery fails. Retry `/model` without repeating OAuth. Saved provider/auth preferences are never overwritten; use `/model` to browse this account's models or `/thinking` to see this model's default and supported levels. Headless Codex runs also discover visible model capabilities before inference: when no available model was selected, Schway uses the first advertised model for that run without editing config; an explicit unavailable `--model` fails instead of silently substituting another ID. `--thinking` is validated against that account's advertised levels before a request. The picker calls `GET https://chatgpt.com/backend-api/codex/models?client_version=0.156.1` using only Schway's stored subscription identity. The query uses a Codex client compatibility version rather than the Schway package version. Update the pinned version only after verifying the model catalog and selected-model transport against that Codex protocol version. The endpoint and `models[].slug` / `visibility` response follow the official open-source [Codex models client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs) and [Codex model protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs). Only `visibility: list` entries are shown; errors do not disclose provider payloads or silently switch billing.

`/login chatgpt` opens the provider browser flow with a localhost callback and per-attempt PKCE/state; denial, expiry, timeout, and Esc cancellation settle without leaked listeners. On machines where the browser cannot reach the loopback callback, `/login chatgpt --device` prints a user code to approve at `https://auth.openai.com/codex/device` (beta, 900 s timeout), and `--code` exchanges a manually pasted redirect URL or code. Tokens (short-lived access plus `offline_access` refresh) live only at the subscription secure-store identity with serialized pre-expiry refresh; `/logout chatgpt` removes exactly that identity. Resume rebuilds the native conversation under the currently selected auth identity without replaying tools, and prior provider metadata round-trips across auth switches.

The login survives restarts, but the provider selected by `/login chatgpt` applies only to the current session. To use the saved subscription by default on future launches, save both settings once:

```text
/config set provider openai --scope user
/config set openaiAuth chatgpt --scope user
```

Without a saved provider preference, Schway starts with its built-in OpenAI provider, where automatic auth uses a stored Codex login when no API key is supplied. You can also use `schway --provider openai --openai-auth chatgpt` without repeating login. Project settings and CLI flags still override user settings.

`/model` checks configured credentials whenever it opens. It starts with the current choice, favorites and recents on connected routes. Search and Browse all models expose the complete connected catalog; Connect a provider reveals other routes. Subscription/API labels describe configured access, not proof that a remote service will accept a request. In automatic auth mode, a saved Codex login exposes that account's models even when the session started with another provider. Selecting one activates Codex for the session. Explicit API-key preferences and runtime/environment key precedence remain in effect.

The browser returning to `http://localhost:1455/auth/callback` is expected. Schway starts that listener before launching the browser and finishes sending the callback page before closing the connection. The page confirms receipt; the terminal reports whether the tokens were saved. A callback from an older browser tab returns an error without cancelling the current attempt.

Use the [complete subscription flow](headless.md#existing-chatgptcodex-subscription)
or the separate [API-key flow](headless.md#openai-api-key). Each prepares its
credentials, lists the intended route, asks you to choose an exact ID, and
retains that route and model for both the task and resume. A saved `openaiAuth`
preference by itself does not configure a headless model.

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
- `/model` includes connected profiles with their name and host in the row’s API route label; `/model profile:<name>` and `/config set profile <name>` switch profiles. Only the explicit `profile:<name>` form switches profiles; a bare model token never selects a profile, so direct model IDs cannot collide with profile names. `/model <provider>/<id>` clears the profile for direct selection. `/model <provider>/<id>` and `/config reset profile` record a session-only cleared profile that outranks user, project, and CLI selections.

This is an isolated two-endpoint fixture example, not a ready-to-run public
service or real credential. It assumes both local servers advertise `model-a`
and `model-b` respectively, and server b also accepts `override-model`. The
sentinel values below are fixture keys. For real endpoints, choose exact IDs
using the [compatible flow](headless.md#compatible-endpoint-or-profile) and keep
credentials in your environment or secure store.

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
- `on-demand` (default) captures paths and content hashes before and after each accepted turn, with no file content retained. This detects shell changes while excluding untouched pre-existing dirt and successful file-tool paths. Current content diffs load only on explicit review or `/changes diff`.
- `snapshot` performs the same before/after path-and-hash capture and also includes the retained comparison in `/changes status`. Capture settles after completed, failed, or cancelled turns and tool cleanup. Neither mode stores file content; hashes distinguish pre-existing dirt from new turn edits.

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

After interactive sign-in, use the [complete Grok headless flow](headless.md#existing-grok-subscription) to list that route, choose an exact model ID, run and resume. Headless runs refresh stored tokens when needed and never open a browser. Missing or revoked logins require interactive sign-in. `/logout grok` removes only the Grok OAuth credential and blocks an active Grok account until sign-in and activation succeed again.

Test coverage for this guide: [release verification](release-verification.md#configuration).

## Prompt cache key

xAI caches a repeated prompt prefix on the server that handled it. On both xAI
routes (API key and Grok subscription), every conversation request carries a
`prompt_cache_key`, so a conversation's requests go to the same server and its
prefix can be served from cache. xAI documents this field for
`POST /v1/responses`, the endpoint both routes call
([Maximizing cache hits](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits)).
Schway does not send the `x-grok-conv-id` header: xAI documents it for Chat
Completions and gRPC, not for Responses.

- **One key per session branch.** The key is `schway-v1-` followed by 32
  lowercase hex digits, the start of a SHA-256 digest of the session ID and the
  selected branch ID. It contains no session or branch ID, path, model ID,
  account or credential.
- **Stable within a conversation.** Every model round, every turn, transport
  retries, the Grok token refresh resend, compaction, overflow recovery and a
  model or reasoning change keep the same key. Resuming a session gives back
  its key; the key is derived each time and never saved.
- **New for new work.** `/new`, `/clear` and a headless run without `--resume`
  start a session with a new key. Forking or selecting a branch uses that
  branch's key, and returning to a branch gives back its original key.
- **Only conversation requests.** Compaction summaries, model lists and
  capability checks send no key. Extension hooks never see it.
- **Other routes are unchanged.** The ChatGPT subscription endpoint has no
  public documentation of `prompt_cache_key`, so its requests send none. Native
  OpenAI API-key and OpenAI-compatible requests also send none.

`/history` shows how much of each turn's input the provider served from its
cache. To measure the effect on a route, an operator can run the opt-in
[prompt cache probe](live-providers.md#prompt-cache-probe).

## Web search

`webSearch` controls xAI's server-side web search, where xAI runs a search inside
one model response instead of Schway fetching pages through tools.

```json
{ "webSearch": "off" }
```

- `"auto"` (the default) sends hosted search only where Schway's allowlist
  confirms the route and model. Today that is the xAI API-key route with
  `grok-4.7`, which xAI documents
  ([web search](https://docs.x.ai/developers/tools/web-search)).
- `"off"` never sends it. Any other value fails with
  `Invalid webSearch · Use auto or off`.

The Grok subscription route, native OpenAI, the ChatGPT subscription and
OpenAI-compatible endpoints never get hosted search, whatever the setting. An
extension that registers its own tool named `web_search` keeps it, and hosted
search stays off for that session.

- **Billing.** xAI may bill hosted searches separately from tokens on some
  routes. On the API-key route it charges per search call
  ([pricing](https://docs.x.ai/developers/pricing)). Set `"off"` to avoid that
  charge.
- **Approval.** Hosted search reads only, so it runs in every approval mode,
  like `web_fetch`. xAI derives each search query from the conversation, so
  workspace content can reach its search engine.
- **One choice per session model.** Schway decides when it builds the
  session's model and sends the same choice on every round and turn, which
  keeps the request prefix cacheable. Changing the model or route decides
  again. Compaction summaries, model lists, evals and live-smoke runs never
  send hosted search.
- **Storage.** Each search xAI returns is kept in the session with the answer
  and sent back with later requests, as xAI documents for conversations that
  keep no state on its servers. Search queries are saved like other session
  content. Each kept search is capped at 8 KiB, and each answer at 32 searches.
- **What you see.** An answer that searched shows one line such as
  `Searched the web (2)`. Headless text and `--json` output are unchanged,
  except that the `model.usage` record carries the search counts
  ([usage fields](extensions.md#usage-and-timing-fields)).

The decision is recorded in
[ADR 0007](adr/0007-provider-hosted-lookups.md). An operator can check a route
with the opt-in [hosted web search check](live-providers.md#hosted-web-search-check).

## Undo retention

`undo.maxAgeDays` defaults to `30`; `undo.maxSizeMB` defaults to `500` MiB.
Both accept positive integers. Unknown keys in the `undo` object are rejected.
Set them in either config file or interactively:

```text
/config set undo {"maxAgeDays":14,"maxSizeMB":250}
```

Like `git`, each higher-precedence `undo` object replaces the lower object;
omitted members use built-in defaults. Each interactive or headless startup
prunes expired turns, then the oldest turns across sessions until the store fits
its size limit, and collects unreferenced blobs. It runs before the first turn;
failures go to the opt-in diagnostics sink and do not block startup. There is no
pruning timer within a running process. Pruned turns are skipped by `/undo`.

Retention also applies to incomplete manifests for active turns. Startup in
another process may prune an eligible turn before its file changes settle.
Settlement then reports missing undo data, and that turn is unavailable for undo.

Undo writes, session-data deletion and pruning share a process lock. If another
Schway process is updating the store, startup skips pruning and records the failure
in enabled diagnostics. A file-tool change is refused if its pre-image cannot be
saved. The private lock file stays outside the undo directory and does not count
toward retention or the doctor's size check.

See the [stability policy](stability.md) for compatibility promises.

## Deprecated keys

There are currently no deprecated config keys (`CONFIG_DEPRECATIONS` is empty).
A deprecated key remains supported until the next major version. When a
replacement exists, Schway resolves the old value as the new key before
validation. If both keys are present in the same file, the replacement wins.

Each warning identifies the absolute file path, replacement (if any), and removal
major version. Interactive startup shows it as a notice; headless runs print it
once to stderr, keeping `--json` stdout as JSONL. `schway doctor --json` includes
one `config.deprecated.<key>` warning check per deprecated key found. Warnings
alone do not make doctor fail.

Saving another setting preserves the deprecated key as written. Edit the key in
the named config file to stop its warning; saving does not silently migrate it.
