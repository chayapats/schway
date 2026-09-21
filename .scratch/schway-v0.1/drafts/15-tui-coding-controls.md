# 15: Inspect edits and control models and compaction in the TUI

## What to build

An interactive user can inspect file changes, select a model, view effective basic configuration, and compact a long conversation without leaving Schway. This completes the v0.1 coding UI on top of the working interactive loop. Scope: specification sections 16, 26, 41, 61, 70, 72, 84, 89.

## Acceptance criteria

- [ ] Render edit diffs from structured tool details while keeping model-facing content bounded. Failed edits are clearly distinguished from applied changes.
- [ ] A model picker and `/model` select known models and allow explicit unknown IDs; subsequent requests use the selection and matching context budget.
- [ ] `/config` presents effective basic settings with secrets redacted; current-session model overrides follow established precedence without silently persisting credentials or config.
- [ ] `/compact` invokes the existing ContextManager operation, shows progress/success/failure, and preserves a usable conversation after cancellation or failure.
- [ ] Session/status information reflects model changes, tool completion, and compaction; command help describes the available v0.1 commands only.
- [ ] Controller/state tests prove actual model-selection propagation, diff presentation from a real edit result, manual compaction followed by continued conversation/resume, and error/cancellation handling.
- [ ] Skills, extension commands, additional-root commands, branching UI, richer reasoning controls, and login/logout flows remain outside v0.1.

## Blocked by

- 03: Create files and apply exact atomic edits.
- 13: Continue long coding sessions with durable compaction.
- 14: Use Schway interactively through OpenTUI.
