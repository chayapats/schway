# Changelog

## [Unreleased]

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

### Changed

- New sessions use `SESSION_FORMAT_VERSION = 4`. Schway 0.6 reads formats 1–4
  and preserves existing bytes. An older session gains an appended format-4
  marker immediately before its first `turn_undo` record; ordinary format-3
  writes do not upgrade it. Schway 0.5 and earlier cannot open format-4 sessions
  or sessions upgraded to format 4. Downgrade is not supported (#153).

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
