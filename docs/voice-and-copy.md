# Voice and copy

Use this guide for every user-visible string in the TUI and CLI: status pills, notices, errors, panel titles, hints, command descriptions, `--help`, `doctor` output and stderr messages. Docs follow the same tone, but reviewers check these rules against UI text. The primary view is the conversation, composer, status bar and ordinary panels; Ctrl+I details holds diagnostics. This guide sets the reference for the design spec (#136) and copy tickets #140–#148; those tickets change the UI strings.

## Voice

Write calm, terse, verb-first copy. Name what the user can do, use familiar words and let one short status carry the current state. Put the key or command beside its action so the user can continue without reading a diagnostic explanation.

## Rules

### Keep statuses to six words

A status is the text before the first ` · ` separator in a pill, notice, empty state or outcome word; keep it to six words or fewer, counting space-separated words and key names such as `Alt+L` as one word. Hints after ` · ` are actions, not status text; a separate action line serves the same purpose.

Good: `Done · Alt+R review`  
Bad: `The requested turn has now finished successfully · Alt+R review`

### Name the next action

Every state names the next available action; every empty, waiting, failed and blocked state shows the key or command that moves forward, such as `Alt+L`, `Esc` or `/sessions`. Pair the control with a verb, including cancellation when waiting is the only progress available.

Good: `Connect to continue · Alt+L sign in`  
Bad: `No connection`

### Use sentence case

Use sentence case for statuses, titles, descriptions and hints, with no exclamation marks in sentences. Keep established key names in their normal case; the standalone `!` status glyph remains available.

Good: `Choose model · Esc back`  
Bad: `CHOOSE MODEL! · Esc back`

### Hide internal identifiers

Keep tool-call IDs (`b1`, `call_…`), entry and operation IDs, error codes such as `ENETUNREACH`, raw `git diff` headers and `i/` `w/` prefixes, wire field names and Schway source paths out of the primary view; put necessary diagnostics in Ctrl+I details. Session and branch IDs are allowed in `/session`, `/branch`, `/sessions` and resume commands because users need them to select saved work.

Good: `Connect to continue · Alt+L sign in`  
Bad: `ENETUNREACH · call_abc123 · src/tui/view.ts`

### Put evidence in details

Move evidence and caveat language behind Ctrl+I details or into docs, including attribution caveats, “not a guarantee”, exit-code tallies and “unverified”. Keep the primary view focused on the state and next action; describe observed command outcomes briefly without claiming a test suite passed.

Good: `Done · Alt+R review · Ctrl+I details`  
Bad: `Done · unverified · not a guarantee`

### Pair status colors with meaning

Every status color comes with a glyph or a word so the state remains clear without color; current pairs include `✓` for success, `!` for attention, `●` for active work and `◌` for waiting. Keep the symbol or word visible at narrow widths and with `NO_COLOR`.

Good: `✓ Done · Alt+R review`  
Bad: A green block with no symbol or word.

### Write UI text in English

UI text is English; Thai and other Unicode input stay fully supported, and user text keeps its original language. Write translated UI labels in English without translating the user's task, paths or content.

Good: `Ready · Enter send`  
Bad: `พร้อม · Enter send`

### Match counts to nouns

Counts agree with their noun: `1 file`, `2 files`, `1 command`, `2 commands`; use `1 changed path`, never `1 changed paths`. Check both singular and plural forms when a count changes.

Good: `1 file changed · Esc back`  
Bad: `1 files changed · Esc back`

## Before and after

Before values reproduce current UI text on the pinned `main` revision `d8c1340`; interpolated examples use the stated counts. After values are copy targets, not changes made by this guide. `(moved to Ctrl+I details)` marks relocation rather than replacement UI text; `<br>` separates the two lines in the readiness target.

| Before | After | Rule | Source |
| --- | --- | --- | --- |
| `Turn completed · commands: 2 exit 0 / 0 nonzero / 0 unknown · Alt+R review` | `✓ Done · 1 file +1 −1 · 2 commands ok · 14s · Alt+R review` | Short status, evidence in details, counts; #145 | `src/tui/view.ts`, outcome line |
| `[built-in] /model Choose model or profile` | `/model          Choose model` | Hide identifiers, terse description; #143 | `src/tui/view.ts`, completion row; `COMMAND_DESCRIPTIONS` in `src/tui/command-catalog.ts` |
| `No model yet · Sign in to choose one · Alt+L` | `Not connected`<br>`Sign in to choose a model · Alt+L` | Short status, next action; #140 | `src/tui/view.ts`, empty conversation |
| `Choose model + route · ↑/↓ select · Enter apply/connect · Ctrl+R retry · Esc back` | `Choose model · ↑↓ select · Enter use · Esc back` | Short status, next action; #142 | `src/tui/view.ts`, model picker |
| `ChatGPT · Paste browser callback` | `Tab more options` | Disclose the callback option in the ChatGPT flow; #141 | `LOGIN_CHOICES` in `src/tui/controller-credentials.ts` |
| `Current working-tree content is unattributed; external edits may be included.` | `(moved to Ctrl+I details)` | Evidence in details | `openChangeReview`, `src/tui/controller-changes.ts` |
| `Command results (latest 50; exit codes, not a test-suite guarantee):` | `(moved to Ctrl+I details)` | Evidence in details | `openChangeReview`, `src/tui/controller-changes.ts` |
| `Current working tree: 1 changed paths.` | `1 file changed · Esc back` | Match counts to nouns, next action | `openChangeReview`, `src/tui/controller-changes.ts`; one changed path |
| `Snapshots show changes observed during the turn, not exclusive Schway authorship. Current diffs may include later edits.` | `(moved to Ctrl+I details)` | Evidence in details | `openChangeReview`, `src/tui/controller-changes.ts` |
| `Busy: credential changes require an idle session.` | `Wait for this turn · Esc stop` | Short status, next action | `src/tui/controller-credentials.ts`, credential actions |
| `Already running. Press Esc to cancel first, then retry the retained command.` | `Stop before retrying · Esc stop` | Short status, next action | `dispatchEditorInput`, `src/tui/commands.ts` |
| `Preview incomplete · resume validates history` | `Resume saved work · Alt+B resume · /sessions browse` | Next action, evidence in details | `src/tui/view.ts`, recent-work offer |
| `Ctrl+I failure details · Your task stays in the editor` | `Repair connection · Alt+L sign in · Ctrl+I details` | Next action, terse hints | `src/tui/view.ts`, readiness failure hints; authentication failure |
| `Sign in · ↑/↓ select · Enter continue · Esc back` | `Sign in · ↑↓ select · Enter continue · Esc back` | Terse hints | `src/tui/view.ts`, sign-in chooser |

The callback entry remains available behind `Tab more options`; the target names the action that reveals it. The outcome target reports brief observed results and duration, with diagnostics available in details. Status limits apply to status text, while command descriptions and action hints use the same terse voice.

## Banned patterns

Each line is a JavaScript regular-expression source followed by two spaces, `#` and its reason and scope. Use multiline matching for the anchored diff-header patterns. “Primary view” excludes Ctrl+I details; “all UI text” includes details. Before examples and this contributor guide are reference material rather than UI text.

```text
\[built-in\]  # All UI text: describe the command without an implementation tag.
\b[a-z]\d+:   # Primary view: hide short tool-call IDs.
\bcall_[A-Za-z0-9]+  # Primary view: hide provider tool-call IDs.
unattributed  # Primary view: move attribution caveats to Ctrl+I details.
not a (test-suite )?guarantee  # Primary view: move evidence caveats to Ctrl+I details.
^diff --git   # Primary view: show a file label rather than a raw diff header.
^index [0-9a-f]{7,}\.\.  # Primary view: hide raw Git object metadata.
^(---|\+\+\+) [abiw]/  # Primary view: hide raw diff path headers.
\bi/\S+ w/\S+  # Primary view: hide Git index and working-tree prefixes.
exit 0 / \d+ nonzero  # Primary view: move exit-code tallies to Ctrl+I details.
\b1 (files|paths|commands|changes|results|tools|lines)\b  # All UI text: use singular nouns for one.
\b1 changed paths\b  # All UI text: use a singular noun through an adjective.
\w!(\s|$)  # All UI text: end sentences without an exclamation mark; the ! status glyph is allowed.
```

## Reviewer checklist

Copy this checklist into a PR that changes user-visible text.

- [ ] List each changed string and its TUI or CLI surface in the PR.
- [ ] Keep every status to six words or fewer; check the text before ` · `.
- [ ] Give every state its next action, including keys or commands for empty, waiting, failed and blocked states.
- [ ] Use calm, terse English and sentence case; retain Thai and other Unicode input.
- [ ] Keep internal identifiers in details, with only the listed session and branch exceptions.
- [ ] Put evidence and caveats behind Ctrl+I details or in docs; check every banned pattern at its stated scope.
- [ ] Pair every status color with a glyph or word, including without color.
- [ ] Check singular and plural counts against their nouns.
- [ ] Update screen-catalog goldens with `bun run screens:update` (#135) and review them in the [gallery](screen-catalog.md#review-the-gallery-and-pr-diff).
- [ ] Check narrow widths so statuses and next actions remain visible.
