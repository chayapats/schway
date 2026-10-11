# Changelog

## [Unreleased]

## [1.0.0-rc.2] - 2026-10-11

### Breaking

- Extensions can no longer name a prompt or turn context section
  `schway-local-date`. Schway now reserves that name for its own local-date
  section, so an extension that registers it fails to load or stops its turn
  with an error naming the extension. Rename the section to keep it (#319).
- The tool name `web_fetch` is now reserved by a built-in tool. An extension that
  registers its own `web_fetch` fails to load with `Tool already registered:
  web_fetch`; rename the extension tool (#318).

### Added

- An in-app reader opens long code blocks and wide tables with `R` from
  inspection. Search, wrapping and horizontal navigation keep canonical source
  anchors, and copying uses the source rather than the displayed rows (#256).
- `--version` and `-v` report the installed package version without loading
  the TUI, reading credentials or creating a session (#258).
- Headless users can list saved sessions with safe previews and discover
  route-specific models before starting a turn. Help names the JSON session ID
  and resume commands; discovery does not start a conversation or load the TUI
  (#259, #260, #261).
- xAI server-side web search on routes that are verified for it. With the new
  `webSearch` setting at its default `"auto"`, requests on the xAI API-key route
  with `grok-4.7` add `{"type": "web_search"}` after the function tools; the
  Grok subscription route, native OpenAI, the ChatGPT subscription and
  compatible endpoints send nothing new. `"webSearch": "off"` turns it off. xAI
  bills hosted searches per call on the API-key route. Returned
  `web_search_call` items are kept, capped at 8 KiB each and 32 per answer, in
  the message's existing `providerMetadata` and replayed in their original
  positions; the session format is unchanged. The TUI shows one `Searched the
  web` line per answer that searched. Extension API (minor): `ModelRequest`
  gains optional `hostedTools` with the new `HostedTool` type, set by Schway
  after `beforeModel` and never visible to hooks (`ExtensionModelRequest` omits
  it), and `ModelUsage` gains optional `hostedSearchCalls` and
  `reportedHostedSearchCalls`. ADR 0007 records the boundary. An opt-in
  `src/live/web-search-probe.ts --enable-live` check confirms a route; see
  docs/live-providers.md (#323).
- `chatgpt` names the ChatGPT subscription route wherever you type it:
  `--openai-auth chatgpt`, `/login chatgpt [--device] [--code …]`,
  `/logout chatgpt`, `"openaiAuth": "chatgpt"` and `/config set openaiAuth
  chatgpt`. Help, usage and recovery text now say `chatgpt`. `codex` stays
  accepted everywhere with the same behavior. Schway still resolves and saves
  the value as `codex`, and machine output (`route`, `authRoute`, doctor JSON)
  keeps `codex` (#314).
- xAI requests, on both the API-key and Grok subscription routes, send a
  `prompt_cache_key` so a conversation's requests reach the server that holds
  its cached prompt prefix. The key is derived from the session and selected
  branch, so it stays the same across rounds, turns, retries and resume, and
  changes with `/new`, `/clear` and a different branch. Compaction summaries
  and model lists send none, and extension hooks never see it. ChatGPT
  subscription and native OpenAI requests are unchanged. An opt-in
  `src/live/prompt-cache-probe.ts --enable-live` run measures cache hits with
  and without the key; see docs/live-providers.md (#320).
- Model requests include the local date, weekday, time zone and UTC offset as
  the last Schway context section, captured once per turn. Time of day is never
  sent. When the built-in `web_fetch` tool is registered, the base prompt also
  steers web lookups to it instead of curl against search-engine pages (#319).
- Built-in `web_fetch` tool: one `GET` of an `http` or `https` URL that returns
  readable text, with HTML converted to plain text and no JavaScript. It reads
  only and runs in parallel, with a 5 s response deadline, a 15 s total deadline,
  a 2 MiB body cap, a 32 KiB UTF-8 output cap with a private spill file, at most
  5 redirects and a distinct error for each failure. It runs without a prompt in
  every approval mode and sends its URL to the remote host (#318).
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
  `Model … · Tools … · N% cached` and each command's run time, F2 details list
  calls, retries, tool wall time, approval wait and token coverage, `/context`
  adds cached and reasoning counts, and `--debug` records the same counts and
  timings (#317).
- Each turn records the reasoning effort its adapter used. History finalize
  records gain an optional `reasoning` object (provider, model, route, the level
  sent or `null`, and its source: `explicit`, `model-default`,
  `provider-default` or `custom`) beside `telemetry`, written by TUI and headless
  turns; the record `version` stays 1 and older readers ignore it. `/history`
  turn detail shows `Reasoning: …`, and records written before this say
  `Reasoning: not recorded` (#321).
- `bun --no-env-file src/live/reasoning-eval.ts --enable-live --route grok` runs
  an opt-in, paid evaluation that compares reasoning tokens and model time for
  `grok-4.x` with thinking unset, at `low` and at `medium`, using stored
  credentials only. It is never part of `bun test` or CI (#321).

### Changed

- F2 opens details for the visible turn, notice, tool, code or model target
  and Esc returns to its prior draft and reading position. Notice and recovery
  rows hide F2 and `Esc keep editing` offers while details own those keys;
  closing details restores the offers without changing copied text
  (#244, #351, #356, #376, #377).
- Sign-in hints consistently say `Alt+L sign in`, and configuration panels and
  diagnostics name the ChatGPT subscription route `chatgpt`. Stored config and
  machine identifiers remain `codex` (#347, #368, #371).
- Help is a searchable action palette with key guidance, change review works
  after resume, and saved drafts remain distinct from accepted turns. The ready
  screen offers task examples, approval mode stays visible, and review separates
  recorded turn evidence from the current Git diff
  (#243, #248, #250, #251, #262, #263, #264).
- Inspection names the selected copy target and keeps copy hints accurate.
  Selected rows and diff backgrounds improve secondary-text contrast; review
  explains why shell changes cannot be undone and directs users to the current
  diff (#249, #254, #255).
- Approval prompts keep their choices and Enter action visible on short
  terminals, and failed-turn details show the cause before recovery steps
  (#295, #298).
- Narrow undo and review panels stay readable. A wrapped diff row continues
  under a blank gutter at its text column instead of under the line numbers;
  undo notes and read-only explanations wrap between ` · ` segments and at
  words, never mid-word; review and history hint rows wrap only between
  segments; and below 30 columns the undo hint ends with its Esc action alone
  when the status bar does not name one. Layout widths live in
  `LAYOUT_BREAKPOINTS`, and `bun run screens:sweep` renders every catalog
  screen either side of each breakpoint (#307).
- Model picker discovery failures say what failed and keep the provider's
  message behind F2. Offline discovery reads `Models offline` (or `Connections
  offline`) instead of the same `Models unavailable` used for other failures, a
  single failed route list is named (`xAI models unavailable`) and several show a
  count. While the error shows, F2 opens the redacted diagnostic and Esc returns
  to the list; otherwise F2 still shows the selected model's details. The
  unreachable `tool` turn recovery category is removed. The screen catalog adds
  every turn and startup recovery category, the picker's loading, offline,
  failed and partial states, and automatic compaction during a running turn
  (#306).
- Core tool output bounds count UTF-8 bytes instead of UTF-16 characters. The
  50,000 cap for `bash` stdout and stderr, `read`, `grep`, `find`, `ls` and tool
  error results is now 50,000 bytes, so ASCII output keeps the same bound and
  Thai, emoji and other multibyte output can no longer reach about three times
  that size. Cuts never split a character. A truncated `bash` result now says
  how many bytes it shows out of the total, names the spill file and says to
  read the rest with `read` and `offset`; `BashDetails` gains optional
  `shownBytes` and `totalBytes`. The `web_fetch` tool shares the same byte
  measure (#322).
- Tool results from earlier user turns that are over 8,000 bytes are sent to
  the model as their first 8,000 bytes plus a note to run the call again for the
  full text, when that makes them shorter. The turn in progress, the saved session, resume, `/history` and
  compaction summaries keep full results. Extension `beforeModel` hooks see the
  shortened results (#322).
- Every key hint pairs its key with an imperative verb on one row:
  `Enter continue` in the sign-in chooser, `Alt+L sign in` after
  `Connect a provider` and the Grok plan error, `Type a task · Enter send`,
  `Enter save` in a staged preference and `C copy` in the reader. Notices,
  error and recovery lines, panel headings and empty-state actions wrap at
  ` · ` so a key never ends a row apart from its action, and narrow rows drop
  whole segments instead of cutting a verb. The undo panel's hint row and the
  `Esc back to request` hint now show key chips. A catalog lint checks every
  screen for these rules (#302).
- The status bar's reasoning chip always shows the effective effort while a
  model is selected, not only an explicit level: `Provider default` when Schway
  sends no reasoning control, with the advertised level such as
  `Provider default (medium)` when the model list names one, or
  `xhigh unavailable` for a level the model does not offer. Schway still sends
  no reasoning default of its own for `grok-4.x` or any other model: no
  recorded live evaluation supports one (#321).

- While work runs, the hint row names the Esc action (`Esc stop`,
  `Esc restore`, `Esc back`) and the status bar no longer repeats it, so the
  status bar has room for the model name at 50 columns (a retry pill can still
  fill that width). The status bar names Esc only when
  the hint row is hidden on short terminals, as in `Auto · Esc stop`. A model
  chip too narrow for `provider/model` shows the model ID without the provider
  before shortening it with `…` (#310).

- Esc hints use one verb per meaning, from the new Esc verbs table in the voice
  guide: `Esc stop` in the status bar, `Esc cancel` while an undo is offered and
  `Esc back` after it, `Esc keep editing` for slash suggestions, `Esc back` in
  inspection and `Esc back to request` while an approval waits. Narrow activity
  and reader find rows keep the whole Esc phrase. A catalog lint checks every
  screen against the table (#315).
- Compaction shows its progress and `Esc stop` only in the activity row, hints
  and status bar, and the transcript records each result once. No stale
  `Esc stop` row remains after compaction ends, `/compact` results no longer
  repeat in the activity row, and stopping a turn during compaction shows only
  the turn's `Stopped` result with `Ctrl+R continue` (#308).
- Enter in the slash suggestion list inserts the highlighted command when it
  differs from the draft, as Tab does, instead of reporting `Unknown command`;
  the next Enter sends it. Enter still sends a draft that already matches, and
  Esc, then Enter, sends the typed text unchanged. The hint row says
  `Enter insert` or `Enter send` and keeps it at 40 columns (#296).
- Find hints now match their keys. Conversation and reader find show
  `↑↓ previous/next` and `Enter keep` only while a match is selected, and use
  `Esc restore` in every find state. Conversation find names one scope, `this
  branch`, in its placeholder and statuses, and narrow status lines drop their
  trailing Esc instead of clipping it (#300).
- The ChatGPT and Grok sign-in wait screen starts with `Sign in to ChatGPT` or
  `Sign in to Grok`, lists device steps as `1 Open <address>` before
  `2 Enter <code>` at every width, and names Esc once as `Esc cancel sign-in`
  (`Esc cancel` in the compact status bar). The pill reads `Signing in`; the
  dead `Enter confirm` hint and the stale `Esc cancel` in transcript notices are
  gone. Timeouts read `Sign-in timed out · Alt+L retry · F2 details` with the
  recovery steps in F2 details, and a browser that cannot open shows
  `Browser didn't open · Open the link above` (#297).
- The empty-conversation card hides its action line, such as
  `Connect a provider · Alt+L` or `Type a task · Enter sends`, while a panel,
  the slash or help palette, find, inspection, F2 details or an approval owns
  the keys. Its status line stays, and the action line returns when that
  surface closes. The outcome strip decides `Alt+R review` and `F2 details`
  separately, so it names each key only while it acts (#301).

### Fixed

- Edit, write and undo preserve existing file permissions (#242).
- Failed shell spawns settle with an actionable outcome, pipe cleanup is bounded,
  and requested stops preserve completed work without reporting a failure
  (#245, #246, #267).
- Doctor names invalid configuration fields and a missing configured model;
  startup rejects empty headless tasks and unavailable interactive terminal
  input/output before loading the application (#247, #252, #253).
- Sign-in entry keeps its keys and caret above the status bar on short terminals;
  narrow recovery hints keep each key and action together (#340, #354, #360).
- The Grok picker keeps the active model available when discovery fails, including
  its current marker and known reasoning capabilities (#354, #372).
- Tool expansion hints appear only when a row can expand or collapse, and
  `/branch tree` no longer leaves a stale key notice (#339, #355).
- The context meter uses the same shortened earlier-turn tool results that the
  model request sends (#346).
- Catalog captures wait for measured review layout and a live command composer;
  the reader caret regression uses a fixed presentation clock, and deferred
  approval checks wait for the painted reader banner and completed branch-tree
  dispatch. These checks remain stable when two full suites run concurrently
  (#359, #384, #385).

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
