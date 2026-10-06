# Changelog

## [Unreleased]

### Breaking

- Extensions can no longer name a prompt or turn context section
  `schway-local-date`. Schway now reserves that name for its own local-date
  section, so an extension that registers it fails to load or stops its turn
  with an error naming the extension. Rename the section to keep it (#319).

### Added

- Model requests include the local date, weekday, time zone and UTC offset as
  the last Schway context section, captured once per turn. Time of day is never
  sent. When the built-in `web_fetch` tool is registered, the base prompt also
  steers web lookups to it instead of curl against search-engine pages (#319).
- `/history` browses recorded turn outcomes on the selected branch, newest first:
  outcome, time, duration, file and command counts, and per-turn evidence with
  observed command exits, observed files, undo state and an on-request current
  diff labelled as current content. Evidence lives in a private append-only
  sidecar beside each saved session, written by interactive and headless turns
  and removed with the session (#257).
- Retry status names its cause and the upcoming attempt. The TUI shows
  `Rate limited`, `Provider unavailable` or `Connection lost` with `Attempt 2/3`,
  and the pill counts down as `Retry · Attempt 2/3 in 2s`; headless stderr uses
  the same form. The `model.retry` runtime event, headless `--json` output and
  diagnostics gain an optional `cause` (`rate-limit`, `provider` or `offline`)
  that matches the `error` event's categories (#313).
- Each model call and tool call now records its timing and reported tokens, so a
  slow turn shows whether the model or the tools took the time and whether the
  prompt cache was hit. `ModelUsage` gains optional `cachedInputTokens` and
  `reasoningTokens` (parsed for OpenAI, xAI, Grok and ChatGPT subscription
  responses). Saved `assistant` and `tool_result` items gain an optional
  `telemetry` object (`AssistantTelemetry`, `ToolTelemetry`) without a session
  format change. The `model.usage` event gains `startedAt`, `firstDeltaMs`,
  `attemptMs` and, after a retry backoff, `retryWaitMs` (the backoff actually
  waited, also when a stop cut it short); `tool.finished` gains `startedAt`,
  `durationMs` and `approvalWaitMs`. History finalize records gain optional
  `telemetry` totals with per-dimension call coverage and `inconsistentCalls`
  for counts that exceed their own call's total. `/history` turn detail shows
  `Model … · Tools … · N% cached` and each command's run time, F2 details list calls, retries, tool wall time,
  approval wait and token coverage, `/context` adds cached and reasoning counts,
  and `--debug` records the same counts and timings (#317).

### Changed

- Esc hints use one verb per meaning, from the new Esc verbs table in the voice
  guide: `Esc stop` in the status bar, `Esc cancel` while an undo is offered and
  `Esc back` after it, `Esc keep editing` for slash suggestions, `Esc back` in
  inspection and `Esc back to request` while an approval waits. Narrow activity
  and reader find rows keep the whole Esc phrase. A catalog lint checks every
  screen against the table (#315).

## [1.0.0-rc.1] - 2026-10-02

### Added

- Stability policy for 1.0 and later: forward-only, append-only session and
  undo pre-image compatibility; config deprecation support until the next major;
  semver for `schway/extensions`; and major-version protection for core tool
  semantics. Published-version session fixtures enforce discovery, resume,
  branches, compaction and undo history (#158).
- The public extension API now also exports `AssistantContent`,
  `AssistantMessage`, `ProviderMetadata`, `TextContent`, `ThinkingContent`,
  `ToolCallContent`, `ToolResult`, `UserContent`, `ModelRequest`, `ModelUsage`,
  `ThinkingLevel`, `RuntimeEvent`, `ApprovalMode`, `CompactionReason`,
  `ToolCallStatus` and `DeepReadonly`. No public exports were removed. Published
  declarations and an API report guard the documented surface (#159).
- `/clear` starts a fresh conversation, like `/new`, keeping login, model and
  settings. The prior session and its unsent draft remain resumable; file edits
  stay in place (PR #227).
- ChatGPT and Grok subscription eval routes (`codex` and `grok`) use existing
  Schway sign-ins, record subscription billing and zero usage-billed spend,
  and report unavailable sign-ins as skips rather than successes. They never
  start login or fall back to API keys (#167, PR #232).
- Eval `--thinking` validates explicit reasoning selections against the chosen
  route and model and records the requested value in reports. Unsupported or
  unavailable capabilities skip without inference or fallback; omission keeps
  provider defaults (#235, PR #236).

### Changed

- Successful eligible interactive model choices become defaults for new
  workspaces, without replacing existing workspace choices or affecting
  headless runs. Model, billing route and thinking stay together; endpoint and
  profile choices remain workspace-only (PR #228).
- Connecting a provider prepares a usable model when none is active, while
  preserving an existing active model and billing route (PR #229).
- Preferences show common settings first, explicit save scopes and an Advanced
  view for limits, connection overrides and saved-layer details (PR #230).
- The model picker starts with current, favorite and recent choices, searches
  all connected models, and offers separate browse/connect actions. Ctrl+P
  manages user-wide favorites; Ctrl+I shows model details (PR #231).
- `ToolContext.env` uses the self-contained
  `Record<string, string | undefined>` shape, removing its ambient
  `NodeJS.ProcessEnv` dependency (#159).

### Fixed

- Updated the Codex account-catalog protocol compatibility pin so model
  discovery uses the supported client version (#237, PR #238).

### Deprecations

- Config deprecation infrastructure preserves old keys, applies replacement
  precedence and surfaces warnings in the TUI, headless stderr and `doctor`.
  No config keys are deprecated in this release (#158).

## [0.6.0] - 2026-10-02

### Added

- `/undo` previews and reverts file changes from `edit` and `write`, with an
  undo stack for earlier turns. Files changed afterwards are skipped; conversation
  history stays intact (#153, #154).
- Change review marks shell changes `changed by shell · not undoable`.
  File undo also works in non-Git workspaces. Startup prunes undo data using
  `undo.maxAgeDays` (default `30`) and `undo.maxSizeMB` (default `500` MiB)
  (#154).
- Approval modes `auto` (default), `ask` and `read-only`. Shift+Tab cycles modes
  in the TUI; `approval.mode` configures the starting mode and headless
  `--approval` overrides it. Ask previews tools that can change state before
  approval; headless ask refuses them without waiting for input (#155, #156).
- Extension tools can declare `effect: "read-only" | "mutating"` on
  `ToolDefinition`. Omitted declarations mean `mutating`: interactive ask
  prompts before execution and read-only refuses execution (#155, #156).
- Headless `--json` output emits a `session.ready` preamble with the persisted
  `sessionId` before agent activity for a created or resumed session. Use the ID
  with `--resume`, including after a failed turn (#209).

### Changed

- New sessions use `SESSION_FORMAT_VERSION = 4`. Schway 0.6 reads formats 1–4
  and preserves existing bytes. An older session gains an appended format-4
  marker immediately before its first `turn_undo` record; ordinary format-3
  writes do not upgrade it. Schway 0.5 and earlier cannot open format-4 sessions
  or sessions upgraded to format 4. Downgrade is not supported (#153).

### Fixed

- `/login codex --device` follows the current ChatGPT device authorization
  flow and reports actionable device sign-in failures. Browser sign-in retains
  its localhost callback (#216).
- `session.ready` preserves the exact session ID. If the ID would expose a
  collected secret, the preamble is omitted rather than returning a modified
  ID (#209, #219).

## [0.5.0] - 2026-10-01

### Added

- Numbered inline edit diffs and concise tool-result summaries. Set
  `ui.inlineDiffLines` to choose how many changed rows appear; the default is
  `12`, and `0` disables inline diffs (#144).
- A compact turn outcome line with file, command and elapsed-time summaries,
  plus two-column change review through Alt+R (#145).
- A once-per-version first-run splash and the `ui.splash` setting:
  `first-run` (default), `always`, or `never`. Reduced/off motion, resume and
  small-terminal rules still apply (#147).

### Changed

- User guides focus on how to use Schway; contributor verification details
  live separately. A voice and copy guide sets the shared UI style (#139).
- First launch shows a neutral not-connected state with a clear sign-in
  action (#140).
- The sign-in chooser groups subscriptions and API keys, with advanced
  ChatGPT and Grok options behind Tab (#141).
- The model picker groups models by sign-in route and keeps unavailable
  routes visible with a connect action (#142).
- The command palette uses a stable group order and fuzzy ranking, with
  concise labels and descriptions (#143).
- Header paths retain the repository name when space is limited (#147).
- TUI and CLI copy is shorter and action-oriented; internal diagnostics stay
  in details and count labels agree with their values (#148).
- `--help` has grouped options, examples and command-specific help (#149).
- The README has a short install/sign-in/task flow, focused guide links and
  a reproducible offline demo recording (#150).

### Fixed

- Tables and code blocks retain their content at narrow widths, across
  notices and while resizing the terminal (#146).

## [0.4.0] - 2026-09-30

Versions before 0.4.0 were not published to npm.

### Breaking

- The Anthropic provider was removed (#131). Selecting it prints this notice:

  ```text
  The Anthropic provider was removed in 0.4.
  Use Claude through an OpenAI-compatible endpoint:
    schway --provider openai-compatible --base-url <url> --model <id>
  See docs/configuration.md
  ```

  Run `schway doctor` to detect an unused Anthropic key in the OS secure store.
  If present, doctor prints this cleanup command:

  ```sh
  bun -e 'await Bun.secrets.delete({ service: "schway", name: "api-key:anthropic" })'
  ```

- Headless runs without a configured model now fail with
  `No model configured. Pass --provider and --model, or set them in config.`
  (#132).

### Added

- xAI API-key access through `--provider xai --xai-auth api-key`, with
  `XAI_API_KEY` or a key saved through `/login xai` (#133).
- Grok subscription browser and device sign-in through `/login grok` and
  `/login grok --device`, with separate secure storage and no API-key billing
  fallback (#134).
- Provider model lists, account model discovery after sign-in, and model
  selection from advertised capabilities (#132).
- `bun run eval --max-spend <usd>` to limit live eval spend between cases,
  including a stop when usage is incomplete (#130).
- Lane-specific `bun run live-smoke --thinking provider=level` selections,
  validated against the selected route's reasoning capabilities and recorded
  in the smoke report (#185).
