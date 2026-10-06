# Conversation interface

Schway uses one conversation column with a persistent multiline editor. The screen
is divided into color blocks: a top bar names the workspace and checked-out Git
branch; the conversation sits on the canvas; the composer is a raised block; the
status bar below it carries the state pill, model, reasoning preference, and context
meter; key hints sit on the last row. At narrow widths arrow and paging hints drop
first, then trailing actions; the main action, disclosures such as `Tab more
options` and the Esc way out stay. When the status bar already names an Esc
action, the hint row can drop its own. `/session` reveals session IDs, the conversation branch, and attached
workspace paths. A conversation branch is distinct from a Git branch.

The status pill follows the active operation's runtime events: `Preparing`,
`Waiting` for the provider, `Receiving` a response, `N tools`, `Retry · Attempt a/b in Ns`,
`Compacting`, `Stop requested` and `Stopping`; otherwise it reads `Ready`,
`Checking` (connection check), `Not connected` (the neutral no-model state) or
`Attention` (a failure needs you). It is the only saturated block on screen: filled accent while working, warning while stopping,
error when attention is needed, a quiet green tint when ready, and a muted tint
with `○` when not connected. The not-connected status bar shows only its pill.
Active operations show elapsed time, except a provider retry: its pill counts down to the
next attempt in whole seconds rounded up (`Retry · Attempt 2/3 in 2s`, then `now`) and
names that attempt out of the total. The activity row and transcript notice name the
retry's cause and keep `Esc stop`: `Rate limited` (HTTP 429), `Provider unavailable`
(HTTP 5xx) or `Connection lost` (a network failure). The provider's own message stays out of the
primary view; if retries run out, F2 details shows it. Quiet providers
and tools remain in their current phase with elapsed time, without an estimated
percentage or a hang warning. The activity row above the composer describes the
current work; parallel tools share a compact count summary. The context
meter shows the estimated share of known capacity (`ctx ━━━━ 19%`), or the token
estimate (`ctx ~132`) when capacity is unknown; `/context` explains it. At narrow
widths the pill, `Esc stop` and the context estimate take priority; the route,
reasoning chip and then the model name are shortened first.

Streamed assistant text is a preview until the provider finishes the attempt. A
retry keeps an abandoned preview visibly marked as incomplete, then replaces it
when the next attempt starts. Once an answer is accepted, the visible text comes
from the saved assistant record, so reopening the session shows the same answer.
Retry progress uses one changing status row and the footer countdown. If retries
run out or you cancel, any remaining preview is marked “Incomplete response · not
saved”; completed tool results remain in the session.

## Interactive usage

```bash
schway
schway --resume <session-id>
```

Running without `-p` opens the OpenTUI terminal conversation. It uses the same
agent loop, sessions, and runtime events as headless mode. The TUI is lazy-loaded;
headless runs never initialize it.

```text
/new - start a new session
/clear - start a new conversation (same as /new)
/sessions - list saved sessions
/resume <id> - resume a saved session
/branch list - show branch IDs, heads, and complete-turn fork points
/branch fork <entry-id> [name] - create and select a conversation branch
/branch switch <branch-id> - continue an existing conversation branch
/add-dir <directory> - attach project context while idle
/model - open the model/profile picker
/theme [auto|dark|light] - change appearance for this session
/session - show session, branch, and workspace details
/help - search commands and keyboard actions (Alt+H)
/quit - quit schway
```

The conversation renders Markdown with readable code blocks and tables. Successful
tool results collapse to a summary; **Ctrl+O** expands all results, and clicking a
tool heading toggles that result. Errors keep a preview visible. **Enter** sends;
**Shift+Enter** or **Ctrl+J** adds a newline. Pasted multiline text stays in the
editor until submitted. **Up/Down** recalls prompts at the editor's first/last
visual row. Type **/** for command suggestions and **Tab** to complete a selection.
**Alt+M** opens model selection while keeping your draft. **PageUp/PageDown** scroll
the conversation; **Ctrl+End** returns to the latest message.

Appearance follows the terminal's light/dark mode when available. `/theme` overrides
it for the current session; set `SCHWAY_THEME=dark` or `SCHWAY_THEME=light` for a
launch preference. A nonempty `NO_COLOR` disables semantic colors. Interactive
launches show a skippable lightning splash the first time each version runs, then
a nonblocking bolt accent. Set `ui.splash` to `always`, `first-run` (default), or
`never` in preferences; `never` suppresses both. `SCHWAY_MOTION=reduced` or
`SCHWAY_MOTION=off` also suppresses startup effects and reduces other animation.
See [color roles](#color-roles) and [motion and startup splash](#motion-and-startup-splash) for the palette, motion and offline preview.

Esc stops the running turn through the shared AbortSignal path and returns to
the input editor. Ctrl+C cancels when running and quits when idle. Quitting
restores the terminal and releases resources. Resume rebuilds history from the
saved JSONL without replaying old tool effects. Missing credentials and runtime failures appear as actionable errors. Interactive
`/login` and `/logout` manage API keys and ChatGPT subscription credentials. Successful
`/login codex` selects the subscription and an available model for this session without
editing saved preferences. `/model` fetches that account's model and thinking capabilities
instead of showing static OpenAI guesses, and `/thinking` shows the model's default and supported levels;
see [credentials](credentials.md) and
[subscription login](configuration.md#chatgpt-subscription-codex-oauth).

## First launch and readiness

A fresh install shows two lines: **Not connected**, then **Connect a provider · Alt+L**. Its hint row reads **Alt+L sign in · / commands**; narrow widths
keep the sign-in action. Enter leaves an ordinary draft and its cursor unchanged
until a model is active.

Once a model is selected, an empty conversation identifies the workspace,
effective model and auth route, then offers the relevant action: **Alt+L connect**, **Alt+M choose/repair model**,
**Ctrl+R retry locked credential storage**, or **type a task**. **F2** opens
failure details; its hint appears only when those details exist. The ready screen
does not add a recurring welcome or restored-choice message to the transcript; `/config` retains setting provenance and `/model forget`
clears remembered interactive choices.

A ready, empty conversation with an empty composer also lists up to three fixed
examples under **Try a task**. They are plain text: type or paste one, or write
your own task in any language. Examples disappear as soon as you type, once the
conversation has messages, or while a panel or search owns the screen. They never
replace connection, loading, recovery, approval, saved-draft, recent-work or
restored-workspace guidance. Shorter or narrower terminals show fewer whole
examples, or none, so the next action and composer stay visible. Showing them
does not inspect the project or start a model or command.

The selected connection is checked after the editor opens. While a catalog or
credential check is pending, you can type, paste and resize; **Esc** cancels the
check. Setup actions wait for that check to finish or be cancelled. No browser or
model inference is started by opening the screen. An explicit broken selection
stays selected until you repair it; startup does not switch billing routes.
Explicit and remembered ChatGPT subscription models are checked against the account
catalog. For API routes, initialization does not
probe the provider or reject custom model IDs absent from Schway's built-in catalog.
Sending is available once local initialization completes; the first explicit task
may still reveal a remote authentication or model error.

Type your task before connecting if useful. The login/model panels temporarily
own their input and restore the task and cursor after cancellation or activation.
Completing setup never sends the task: press **Enter** in the task editor when
ready. Multiline paste stays one task. Missing HOME, malformed configuration,
unknown profiles or unwritable session storage can instead cause an actionable
startup exit before the terminal opens. Headless execution keeps its existing
configuration and credential path and does not read interactive choice memory.

## Returning to recent work

Use `/clear` or `/new` to start a new conversation with empty model conversation
context. Both keep your login, selected model and settings. The previous session
remains available through `/sessions` or `/resume`; file edits stay in place.
Ordinary unsent drafts stay with their original session and return when you resume
it. Run either command after the current turn finishes, or press Esc to stop it first.

Ordinary launch opens a new conversation. When this workspace has saved work,
**Alt+B resume** appears above the conversation with its task preview. One press
restores that exact session; typing and Enter continue to create new work. The offer
is not a modal choice and never starts a model turn. **Alt+S** or `/sessions` opens
all saved history, including entries that need recovery. Suggestions use committed
activity in the canonical current workspace and ignore empty navigation sessions.
Discovery runs after startup with bounded per-file previews; large collections can
take longer to produce the offer. If the read window cannot establish whether a
large history contains work (for example, a large first message without cached
metadata), the workspace history remains eligible with **preview unavailable** and
**resume validates history** labels. This is an unverified candidate, not proof of
meaningful work; explicit activation validates its contents and leaves new work
usable on failure. Known-empty histories remain excluded.

Explicit `--resume <id> --branch <id>` takes precedence and suppresses the offer.
After a restore, a compact summary identifies the workspace, conversation branch,
and current connection/model before sending. `/session` and `/config` show full
identity and setting provenance when the terminal is too narrow. Current explicit
config/CLI values and workspace interactive memory determine the connection; saved
conversation history never restores an old billing route. Missing access retains
its selected route and can be repaired with **Alt+L** or **Alt+M**.

If the suggested file disappears or becomes unreadable, the current conversation
and task text stay available. Use `/sessions` for recoverable history or send new
work; Schway does not silently substitute another session. Opening/dismissing
navigation or leaving an untouched new conversation creates no JSONL file. The
first durable conversation mutation persists its header and records together.
Drafts kept while switching conversations remain associated with their original
session; returning to new work does not paste an older session's draft into it.

## Turn outcomes and change review

Shell rows distinguish running a tool from the command's observed exit. A
completed command shows `✓ BASH … Exit 0` or `! BASH … Exit 1` (with its actual
nonzero code). The outcome and disclosure control stay visible before a long
command, duration or decoration, including at 40 columns and with `NO_COLOR`.
Click the disclosure or use **Ctrl+O** to inspect the bounded command output.

Cancellation or a signal without an exit code shows `− Stopped`. A timeout shows
`! Timed out`, and a tool or harness error shows `! Tool error`. Missing or invalid
exit details show `− No exit observed`, even if the output says “all tests passed”.
Saved shell rows without structured exit evidence also use this neutral label;
their original output remains inspectable. Nonzero outcomes never flash success.
`Exit 0` reports only the process result: it does not establish that tests ran or
that a requested change was verified. Tool execution status, model-visible errors,
headless events and whole-turn command totals retain their existing meaning.

After an accepted turn settles, the activity line shows `✓ Done`, `✗ Failed`,
`− Stopped`, or `◌ Limit`, then changed files and known line counts, observed
command results, elapsed time, and **Alt+R review**. Failed turns also offer
**F2 details**. For example:

```text
✓ Done · 1 file +1 −1 · 2 commands ok · 14s · Alt+R review
✗ Failed · 2 files +8 −3 · 1 command failed · Alt+R review · F2 details
```

While a panel or the reader is open, those keys belong to it, so the line keeps
the outcome and counts but drops **Alt+R review** and **F2 details**. While F2
details are open, F2 does nothing, so the line drops **F2 details** and keeps
**Alt+R review**, which still opens review.

Counts include successful file-tool changes and paths detected as changed by shell
commands, extension tools, or other processes. Created writes and edits contribute
known additions and removals; overwritten writes have no line counts. Commands can
be `ok`, `failed`, or `stopped`. Counts cover the whole turn even though only the
latest 50 commands are retained. A completed model turn can contain a failed check.
At narrow widths, elapsed time drops first, then commands, then files; the outcome
and actions stay until the terminal is too narrow even for those.

**Alt+R** or `/changes review` opens `Review · turn N`, numbered by user messages on
the active conversation branch. Review shows two scopes, each with its own label:

- **`Files from turn N`** is turn evidence: the paths observed during that turn,
  with `›` marking the selection. Line counts beside a path are the turn's observed file-tool
  edits and stay with the turn list. Repeated edits add up, so they can exceed the
  net current diff. A blank count, or `?` for one side, is unknown. Paths seen only
  by the turn's Git snapshots show `detected`.
- **`Current diff · <path>`** is what Git shows for that path now. It is read when
  review opens, when you select a file and when you press **Ctrl+R** to reload. It
  does not update live, so it can include earlier turns, later turns or edits made
  outside Schway.

The current diff names each comparison it shows: `Unstaged · index → worktree`,
`Staged · HEAD → index` (`Staged · empty tree → index` before the first commit) and
`Untracked · current file`. Removals use old line numbers; additions and context use
new line numbers. Colors and ASCII `-`/`+` signs distinguish changes. Below 80
terminal columns, the file list stacks above the diff and both labels stay visible.
Binary, deleted, renamed and truncated previews have short explanations instead of
Git metadata. Detected paths begin with `Found by Git snapshot · not undoable`.

A listed path keeps its turn record even when Git no longer has a diff for it. The
current diff then explains why: `No current changes · file matches HEAD`, `File not
found · nothing to compare`, `Ignored by Git · content not shown`, `Outside the Git
repository · no diff`, or `Current diff unavailable · Ctrl+R reload`. A renamed path
shows the rename. Review never swaps the turn list for other working-tree files.
With change tracking off or outside Git, the turn list remains and the current diff
says why Git content is unavailable; off mode reads no Git state.

Up/Down selects files; PageUp/PageDown scrolls the diff; **Ctrl+R** reloads the
current diff without changing the turn list or counts. While a read is pending the
pane shows `Loading current diff…` instead of earlier content, and a result that
arrives after you select another file, close review or switch session is discarded.
**F2** swaps the diff for turn details, titled `Turn N details`; F2 again or Esc
returns to the diff. Esc from the diff goes back to the same conversation position,
unsent draft, and cursor. After a failed turn, F2 in the conversation appends the
same turn details, including any recovery diagnostics; review Details also add the
review scope notes.
Details contain tool counts, whole-turn exit-zero/nonzero/unknown totals, and the
retained commands without tool-call IDs. When a turn has no tool results and no
commands, those lines become `No tool results or commands.` When a failed turn
retained diagnostics, its details put `Failure details: …` right after the
outcome, so the cause starts on F2's first screen, even at narrow widths; the
counts, commands and evidence notes follow. **Alt+I** still inspects individual tools.
Selected filenames are literal paths, including glob characters and Git pathspec
syntax. `/changes status` and `/changes diff -- <path>` remain available.

The default `on-demand` mode and `snapshot` mode capture paths and hashes before and
after each accepted turn, without retaining file content. Untouched pre-existing
dirt is excluded from the turn list. Shell detection subtracts successful edit/write
paths from the observed changes; it is not proof of who made the remaining changes.
Details explain unavailable detection in non-Git workspaces, off mode, or capture
failures, and expose the latest before/after comparison.

Review is read-only. Current content is unattributed and may include earlier,
concurrent, or later external edits; snapshots do not prove exclusive Schway
authorship. A `detected` path changed between the turn's snapshots without a matching
file-tool record; it does not show which command or process changed it. Review does
not store historical file contents, so it cannot show an exact patch for one turn. Exit codes are observed command results, not a test-suite guarantee.
Failure, cancellation, and conversation branching leave completed filesystem
effects in place. Review does not commit, undo, or restore files. Only the latest
turn pair is retained, and switching a session or branch clears it; saved tool
results remain in the conversation.

### Current changes after resume

When no live turn record is held — after a restart, resume, session or branch
switch, or before the first turn — **Alt+R** and `/changes review` open
`Review · current changes` instead. Its file list, **`Current working tree`**, is
what Git reports as changed now in the active workspace, each path marked
`staged`, `unstaged`, `partly staged`, `untracked`, `deleted`, `renamed` or
`conflict`. It is not the resumed turn's patch: it can include edits from earlier
turns or outside Schway and omits changes since committed or reverted. Only the
selected file's current diff is read, with the same comparison labels, selection,
**Ctrl+R** reload and stale-result handling as turn review.

**F2** opens `Current changes details`, which starts with `Previous turn details
unavailable` and names the workspace and branch read. Schway does not rebuild line
counts, hashes, elapsed time, exit codes or authorship from saved conversation text.
After resume, review reads the resumed session's workspace, not the directory
Schway was launched from.

The list shows at most 50 paths, like `/changes status`; a longer list adds
`First 50 of N · F2 details` to the heading. Each state names its next step:
`No current changes · Esc back` for a clean tree, `Not a Git workspace · Esc back`
when no repository encloses the workspace, `Workspace unavailable · Ctrl+R reload`
when the directory is missing, `Current changes unavailable · Ctrl+R reload` with
Git's reason when Git cannot read the repository (for example dubious ownership or
a missing `git` binary), and `No workspace active · Esc back`. `/changes status`
and `/changes diff` report a missing directory the same way:
`Workspace unavailable · Restore <path>, then run /changes again`. With
`git.changeTracking` set to `off`, review says so and reads no Git state. Details
then describe only what was read. Opening review never calls the model, adds a
turn, writes the session, stages content or changes files or refs.

### Turn history

`/history` opens a read-only timeline of accepted turns on the selected
conversation branch, newest first. Each row shows the turn number, its recorded
outcome (`✓ Done`, `✗ Failed`, `− Stopped`, `◌ Limit reached`, `! Incomplete`),
the recorded start time in UTC and active duration when known, file and command
counts, and a short task excerpt. Below 100 columns the time drops its year and
`UTC` and counts use `cmd`/`cmds`; below 60 columns each turn takes two lines.
A turn whose latest attempt saved no outcome shows `Counts unknown` and
`Time unknown`; a turn with an unfinished attempt shows lower bounds such as
`2+ files` and `1.2s + unknown`. Unknown counts are never shown as zero. Turns without saved evidence, such as those from
before history was recorded, say `○ Details unavailable`; a turn whose evidence
could not be saved in this run says `! Not saved`. Fifty turns are shown at a
time; moving below the last row reveals the next page.

Up/Down selects a turn and Enter opens its saved evidence: observed files with
file-tool line counts or `detected` for snapshot paths, command summaries with the
exit each one showed, and the turn's undo state. Undo is never offered from the
timeline: a turn shows its durable undo outcome, `Undo available · /undo previews
this turn` when `/undo` would target it, which turn `/undo` previews instead, or
`Undo unavailable · pre-images not kept` after pruning. It uses the same target
selection and per-file check as `/undo`, so a target whose files all changed since
says `Every file changed since · nothing to undo`, exactly as `/undo` would. When `/undo` would
instead open its read-only `Nothing to undo in turn N` panel, because saved undo data is incomplete,
a saved copy is missing, a file can't be read or changes without saved undo stay, the turn says
`Nothing to undo · /undo shows why`. A completed turn or an
`Exit 0` row is not proof that tests passed.

In a turn, Up/Down selects an observed file and Enter shows its
`Current diff`, labelled `Current content · not turn N's patch`. It is read from
Git on request, honors `git.changeTracking`, and can include earlier, later or
external edits. **F2** toggles evidence notes: each attempt's mode, workspace,
outcome and Git capture state, exit tallies, truncation and authorship caveats.
Esc steps back from the current diff to the turn, from the turn to the same list
row, then closes history and restores the draft. Opening history never calls the
model, reads Git, writes files or changes the session. See
[turn history sidecar](sessions.md#turn-history-sidecar) for storage and limits.

## Color roles

The Voltage palette pairs calm canvases with color blocks for each zone.

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#0e1117` | `#f7f7f4` | Main canvas |
| Surface | `#161b24` | `#ecedea` | Top bar, user messages, composer, code bodies, status bar |
| Surface 2 | `#1e2430` | `#e1e3df` | Tool trays, code headers, pickers, model chip |
| Text | `#e6eaf0` | `#1d232c` | Conversation and errors' content |
| Muted | `#8b95a7` | `#545e6c` | Metadata, hints, tool details, stopped outcomes and tools |
| Border | `#2c3444` | `#c5c9cf` | Key chips, search highlight |
| Accent | `#7cc4ff` | `#0a5894` | Working pill, focus bar, selection, read tools |
| Success | `#8fd19e` | `#19612f` | Ready pill, completed tools, added lines |
| Warning | `#f0c674` | `#7a5000` | Stopping pill, edit tools, turn limits |
| Error | `#f79d9d` | `#a61f16` | Attention pill, error blocks, removed lines |
| Code / Violet | `#c0acff` | `#6a3fb0` | Inline code, keywords, reasoning chip, shell tools |
| Cyan | `#5ee7ff` | `#065e74` | Types in code, other tools, logo gradient start |
| Bolt | `#ffd84a` | `#b27b00` | The ⚡ mark and splash sparks |

Tints mix a semantic color into Surface 2 (22% dark, 12% light) for pills, diff
rows and selected picker rows. Text keeps its role on every fill, but its color is
measured against the composed background it sits on: selection and focus tints,
diff rows, the search highlight (including Markdown tables in a highlighted
answer), status pills mid-fade and the completion flash.
A role below 4.5:1 there moves to the nearest shade that reaches it, so muted
metadata stays quieter than body text. Roles already readable keep their palette
color. Every text role therefore meets 4.5:1 on the canvas, both surfaces and every
fill it is drawn on. `tests/tui-contrast.test.ts` measures each role on each fill
and every text style run in the committed screen catalog.

Decorative marks carry no information and are exempt; that test lists them:
raised-surface half-block edges, rules and dividers (including Markdown `---`
rules), the empty cells of the context meter, whose percentage beside it carries
the value, the user and error left bars, and the top-bar ⚡. Selection keeps
its `›` marker and diffs keep `+`/`-`, so meaning never depends on color, bold or dim.
Symbols and labels retain meaning without color. Nonempty `NO_COLOR` maps semantic
accents to the text color and chooses readable gray shades on selection fills.
This is a monochrome TUI, not a plain-text output mode; use `-p` for headless text.
Ratios cover colors Schway resolves itself. Terminal-default, indexed or remapped
palette colors cannot be measured, so inspect them in the terminal.

Code blocks use a small built-in lexer (keywords, strings, numbers, comments,
types, calls) instead of downloaded parsers; copying still returns the exact code.

## Motion and startup splash

The first eligible interactive launch of each installed version opens with a
2 second lightning splash. The SCHWAY wordmark appears as a ghost, ignites and
settles into its gradient, then collapses into the top bar's ⚡. Startup keeps
going underneath: the editor already has focus, and a key, paste or click skips
the overlay. Typed and pasted text reaches the draft. The timeline starts at the
first painted frame and holds across startup stalls.

Later launches use a bolt-only accent lasting at most 300 ms. It adds no overlay
and never blocks typing, pasting or panel clicks. `--resume` also uses the accent;
terminals smaller than 57×16 fall back to it when a full splash was requested.

In Alt+P preferences, select **Welcome screen** and choose **Reset (inherit)**,
**Always**, **First launch** (the default), or **Never**. Session, user and project scopes
are supported. Startup effects are chosen once when the UI opens; save a user or
project override to change future launches. For example:

```text
/config set ui {"splash":"never"} --scope user
```

`never` disables both startup effects. Reduced or disabled motion also suppresses
both, regardless of the saved splash preference. The interactive UI records
`{"splashSeenVersion":"<version>"}` in `~/.schway/ui-state.json` only when a full
splash has painted and is removed, including input skips. A new version, upgrade
or downgrade, gets the full first-run splash again. A missing, unreadable or
malformed state file counts as unseen. Version reads are needed only for eligible
first-run launches, stop waiting after 100 ms or cancellation, and treat a timeout
as unseen. Writes are atomic and best-effort, with no
startup error or transcript notice on failure. Accent-only and gated launches
write nothing, so the next eligible launch still gets the full splash. Headless
runs and CLI subcommands never read or write this file.

The top bar preserves the repository folder when shortening a workspace path.
It abbreviates home to `~`, removes whole middle segments with `/…/`, then drops
the prefix to `…/<folder>` if needed, then shows just the whole folder when that
is the only form that fits. A branch can use all remaining columns; it
is clipped only after the path reaches its shortest whole-folder form, and is
hidden below 40 columns. Only after hiding the branch may an oversized final
folder be clipped. Resizing wider restores the longer path and branch.

While working, the pill and tool rows show a braille spinner, the pill and
activity text carry a moving highlight, a streamed answer ends in a blinking `▍`
(never inside an open code fence), a finished tool row flashes green, the pill
cross-fades between states and pickers slide up from the composer. Motion is
decorative: text, layout and keys never depend on it, and the animation timer only
runs while something is moving.

`SCHWAY_MOTION=full|reduced|off` selects the level. `reduced` keeps spinners and a
steady caret but removes both startup effects, highlights, flashes, caret blink and slides;
`off` also replaces spinners with a static `●` and drops the caret. `NO_COLOR` or `TERM=dumb` default to `reduced`.

The default is automatic terminal light/dark detection, then `COLORFGBG`, then
dark. In `/config` (Alt+P), select **Appearance** and choose **Reset (inherit)**,
**Automatic**, `dark`, or `light`. Tab selects session, user or project scope; Enter
previews and a second Enter saves. User and project choices survive restart.
`auto` follows terminal detection; Reset removes only the selected scope's
override. `/theme auto|dark|light` changes the session appearance through the
same preferences when configuration is available. A valid
`SCHWAY_THEME=dark|light` in the launch environment overrides every saved or
session appearance choice; preferences show its effective source and the saved
choice beneath it. Schway does not edit terminal, shell or window-manager settings.

## Undo

`/undo` previews the most recent eligible turn's `edit` and `write` changes on
the selected conversation branch. The panel shows files in first-change order:
`restore` replaces an edited file with its original bytes, `delete` removes a
created file, and `changed since · skip` protects later edits. The counts and
numbered diff describe current content changing back to the original content.
Binary content shows `Binary file · restore only` without line counts.

Up/Down selects a file; PageUp/PageDown scrolls its diff. Enter rechecks every
file's hash immediately before restoring or deleting it. Esc cancels without
changing files and restores the composer draft and cursor. Resize preserves
selection and keeps action text visible by shortening paths first.

A successful undo appends one durable result and model-visible note; it keeps
conversation history and the selected branch. Files changed after the preview
are skipped. Failed operations remain in a result panel until **Esc back** leaves it;
Enter does not retry them. Empty parent directories remain. A turn already undone
on any conversation branch cannot be undone again. If every file changed since,
no undo record is written and the turn remains available.

Undo data survives restart, including file changes from a headless `-p` turn
resumed interactively. Undo covers `edit` and `write` only. It does not revert
shell or extension tool effects, or restore modes or directories. `/undo` accepts no arguments and waits until a running turn
settles like other interactive commands.

Running `/undo` again walks back to the next older eligible turn. Cancelling a
preview leaves that candidate available. When the target is not the latest turn
on the branch, the heading reads `Undo older turn N`, and the panel lists newer
paths that stay as they are before Enter applies anything. Shell-only turns,
turns without file-tool changes, and pruned turns are never selected. A partial
undo consumes the turn, including skipped files; an older turn still checks each
file's current hash before writing.

Paths seen by change detection without a saved copy follow the file-tool rows
with `no saved undo`, or `turn N · no saved undo` when they come from a newer
turn. A note such as `1 change without saved undo stays` counts them. These rows
are read-only: selecting one explains that undo leaves the file as it is, Enter
never touches it and no result counts it as reverted. Being seen during a turn
does not prove which tool changed a path. Shell detection covers only the
primary workspace root; file-tool edits under attached roots remain undoable.

When nothing can be undone, `/undo` names the reason:

| Message | Meaning |
| --- | --- |
| `No saved undo for these changes · Alt+R review · Esc back` | A read-only list of paths seen without saved copies on this branch. |
| `Nothing to undo in turn N · Alt+R review · Esc back` | No saved file can be restored; per-file reasons and other paths stay listed. |
| `Nothing to undo · every file changed since` | Every saved file changed since and nothing else is known. |
| `Change detection unavailable · F2 details` | No saved file changes, and other changes can't be listed. Files may still have changed. |
| `No saved undo data · F2 details` | A turn has no undo data. Retention may have removed it, or it was never saved. |
| `Nothing to undo` | No saved changes remain on this branch. |

Per-file badges distinguish `changed since · skip`, `no saved copy · skip`,
`undo data incomplete · skip` and `can't read · skip`. Schway never reports undo
data as expired, because a missing manifest can't show whether retention removed
it. When a considered turn has no undo data, the panel adds a note such as
`No saved undo data for turn 3`, both before an older undo and in the read-only
list. If Enter reverts nothing because a copy is unavailable rather than changed,
the result stays open with `Nothing to undo in turn N · Esc back`. The saved undo
result records such files as not reverted, and the model is told they could not
be reverted, never that they changed.

**Alt+R** in any undo panel opens `Review · current changes`, the current diff for
each listed workspace path, including after restart. The list is titled
`Files from undo panel` and the diff `Current diff · <path>`; no row carries a
`detected` badge or a source note, because the undo panel does not say which tool
or process changed a path. Up/Down selects a file and **Ctrl+R** rereads Git for
the same paths. F2 details say what review read: with change tracking off,
outside Git or when Git fails, they say no current Git diff was read instead of
describing Git reads. In a session that cannot save, `/undo` and `/history` point
to `/new start fresh · /sessions browse`, like the hint row.
Esc goes back to the same undo panel; Esc again cancels the offered undo, or goes
back from a result, and the draft returns. Reviewing, selecting and
closing never write files, Git, the session or undo data. Undo never runs inverse
shell commands, `git reset` or `git checkout`.

Undo works outside Git. The preview shows `Shell changes can't be detected here`
above the selected file when the workspace is not in Git, change tracking is off,
status capture failed, or the turn came from headless execution or an older
manifest. File-tool undo still works in each case. `Later changes can't be
detected here` marks newer turns with the same limit.

## Interaction

| Action | Control |
| --- | --- |
| Submit | Enter |
| Newline | Ctrl+J, or Shift+Enter when reported by the terminal |
| Paste | Multiline text remains a draft until Enter |
| Copy conversation text | Drag to select and release to copy automatically; Ctrl+C copies an existing selection |
| Open a web link | Click its label or URL; dragging selects instead of opening |
| Recall prompt | Up/Down at first/last visual row; up to 100 prompts in memory |
| Complete command | Type `/`, Up/Down to select, Tab to insert |
| Hide suggestions | Esc keep editing |
| Forget remembered workspace choice | `/model forget` (or `/model reset`); reveals inherited explicit config/defaults without deleting credentials |
| Preferences | `/config` or Alt+P; Up/Down row, Enter open Model/Connections/Advanced, Left/Right value/reset, Tab/Shift+Tab scope, Enter preview then confirm, Esc cancel/back; PageUp/PageDown scroll details |
| Model picker | `/model` or Alt+M; Up/Down selects, Enter uses or opens, Ctrl+P pins/unpins, F2 shows details, Ctrl+R retries discovery, Esc goes back |
| Sign-in chooser | `/login` or Alt+L; ↑↓ select, Enter, Tab more options, Esc back |
| Tool details | Ctrl+O toggles expandable results; click a heading or press Enter in Alt+I inspection to toggle one; small inline diffs stay visible |
| Review turn or current changes and command evidence | Alt+R or `/changes review`; Up/Down selects a file, PageUp/PageDown scrolls, Ctrl+R reloads the current diff, Esc back to the draft and reading position |
| Undo a turn's file edits | `/undo`; Up/Down selects, PageUp/PageDown scrolls, Enter applies, Esc cancel before Enter, Esc back from a result |
| Browse turn history | `/history`; Up/Down selects a turn or observed file, Enter opens a turn or its current diff, F2 toggles evidence notes, PageUp/PageDown scrolls, Esc back one level at a time to the draft |
| Inspect results, code and tables | Alt+I enters inspection without copying; Up/Down or Tab selects a result, code block or table; C copies the highlighted item; Enter copies selected code or table source, or toggles an expandable tool result; R reads selected code or a table; Esc back to the draft |
| Read code or a table | R in inspection; Up/Down and PgUp/PgDn scroll, Home/End jump, Left/Right pan unwrapped code or step table columns, W wraps code, C copies the source, Ctrl+F finds in the block, Esc back to the same inspection target |
| Find in this conversation | Ctrl+F; type a literal query, Up/Down for previous/next, Enter to keep the result in view, Esc restore the old position |
| Scroll | PageUp/PageDown or mouse wheel |
| Follow latest | Ctrl+End or click the new-activity hint |
| Recover stale terminal cells | Ctrl+L; preserves the draft and scroll position |
| Stop | Esc or Ctrl+C during a turn when no text is selected |
| Quit | `/quit`, Ctrl+C while idle with no selection, or Ctrl+D with empty input |

Code headers show **Alt+I inspect** until selected. Inspection returns to a
still-valid previous target; otherwise it starts with the first block or result
in view, or the nearest one when none is visible. The selected code or table header shows
**›** and **R read · C copy · Esc back**, including without color. Opening inspection
never copies. If a selection needs to scroll or repaint, `Showing selection · C
copy again` asks for another explicit C; it does not queue a copy.

Copy uses the selected block's sanitized text with its original Unicode and
newlines, without headers, wrapping or focus markers. Bounded tool previews keep
their truncation notice. `Copied code` means the terminal copy request was
accepted; clipboard failures leave the selection and draft available for native
terminal selection. Enter on a tool result only toggles its expandable output.
**Esc back** brings back the draft, cursor and prior reading position. A replaced or removed
target cannot be copied under its old highlight; session and branch changes
clear the selection.

The keyboard contract for the panels present in this version is: the composer
owns ordinary text; opening a panel preserves its draft and cursor; the active
panel owns its navigation keys; Enter acts on the highlighted choice only; Esc
returns one level toward the composer without submitting the draft. Login
approval waits for the external result, so Enter does not claim to approve it.
Credential and callback entry mask their text. Resizing reflows the active
panel without changing its selection or operation. At 24×8 and 32×12,
preferences put the selected field and value choice above longer guidance,
clipping long display values so both controls remain visible. Ctrl+L
re-enters the renderer and keeps conversation, draft and
reading position.

| Panel | Navigation and action |
| --- | --- |
| Preferences | Up/Down field, Left/Right value, Tab scope, Enter preview/confirm, Esc cancel a preview, otherwise Esc back |
| Model, sessions, sign-in | Up/Down selection, Enter select, Esc back; model Ctrl+P pins/unpins, F2 shows details, Ctrl+R retries discovery |
| Tool approval | Up/Down choose; Enter allow once, allow for session, add reason or deny with reason, as the hint names; Esc deny; PageUp/PageDown scroll; Ctrl+C cancel turn |
| Credential, callback, device approval | Masked entry or external wait, Enter only on entry, Esc cancel |
| Branch tree, change review | Up/Down selection, Enter branch choice, Esc back; review uses PageUp/PageDown and Ctrl+R reload |
| Help, search | Panel-specific navigation, Enter chosen action, Esc restore the draft or position |
| Command completion | Up/Down select, Tab complete, Esc keep editing |
| Inspection | Up/Down select, Enter chosen action, Esc back to the composer |
| Reader | Up/Down, PgUp/PgDn, Home/End scroll; Left/Right pan; W wrap code; C copy source; Ctrl+F find; Esc back to inspection |

Open preferences from the task composer. If another panel is open, Escape returns
to the task before Alt+P; preferences likewise keep ownership of input until closed
(or their Model or Connections action is selected). Repeated Alt+P preserves the
current preference selection and preview.

Basic preferences show effective values and the value saved in the selected scope; Advanced includes origins and separately saved lower values.
Session edits disappear on restart; workspace memory, user config and project
config are distinct explicit scopes, explained before confirmation. Project scope
writes only after the second Enter. Credential material is excluded; model-route
selection is a separate action that activates and remembers a successful choice.
The basic list shows Model, Thinking, Connections, Appearance, Track file changes and Welcome screen together. Basic cycles This session, All workspaces and This project as save scopes. Advanced also offers remembered workspace choice/reset alongside limits, profile/access overrides and saved-layer details; Escape returns to Basic. Model and Connections work before a model is active, and appearance can be changed before login.

Textual `/config set`, `/config reset` and `/config show` remain available.

The conversation follows new output until you scroll back. Streaming then keeps
your reading position; Ctrl+End resumes following. If the conversation was
following when a panel, inspection, the reader, search or F2 details opened,
Esc returns to following and shows any output that arrived meanwhile. Wheel input over non-scrollable
chrome, including the footer, also scrolls the conversation. The multiline editor
retains its own scrolling. The transcript has a fixed-width viewport so starting
to overflow does not introduce a scrollbar and rewrap earlier messages.

Ctrl+F searches the selected conversation branch locally and shows the current
match and count. Search is literal and ignores case; it follows logical text
across terminal wraps, including Unicode. It searches redacted, bounded display
text: collapsed successful tools expose their summary, and expanding tools with
Ctrl+O before searching includes their bounded output. Other branches and bytes
past a truncation marker are outside the search. The status says when a very
large search is limited. The search field replaces the composer temporarily;
the draft and cursor return when search closes. Esc restores the original
reading position, while Enter keeps the selected result in view. New streaming
output updates the count without moving the current result. Ctrl+End explicitly
closes search and follows the latest output again.

After an accepted prompt clears, you can type or paste a future draft during the
current turn. Enter does not queue it while work is active; the draft stays in the
editor until you send it after settlement. Pressing Esc or Ctrl+C shows
“Stop requested” immediately, then “Stopping” while active work settles.
Running tools and other owned work may
still need to settle. Completed output and tool results remain visible; `Ready`
returns only after settlement, and cancellation does not undo completed effects.

Once cleanup finishes, the prior turn shows a muted `− Stopped` outcome and one
`Stopped · Completed results kept` notice, with **Ctrl+R continue** and **Esc keep editing**.
Only unfinished streamed assistant text is marked incomplete. Completed tool
results and file changes remain available through **Alt+I** inspection and **Alt+R**
review. Repeated Esc while stopping does not start another cancellation or send a
task. A provider, cleanup or session-write failure still shows its error recovery;
pressing Esc later does not turn that failure into a normal stop.

Continue explicitly resumes the accepted turn without adding a user message or
repeating completed tools. It preserves unrelated type-ahead text, its selection
and cursor. Esc keeps that draft for editing; Enter sends it only when you choose.
While inspecting a stopped result, the first Esc returns focus and the prior
reading position to the composer, leaving Continue available. A second Esc can
dismiss the recovery controls. Session or branch replacement expires those controls.

Enter releases a prompt only after its user record is saved. Missing credentials,
busy operations, and rejected commands keep the text and cursor in the editor
so you can repair the cause and press Enter again. A model
failure after the saved user record is a failed turn in the conversation; it does
not restore the prompt as a new draft. Prompt recall records accepted ordinary
prompts only. Long commands release the editor when their preparation succeeds
and execution starts; their later completion leaves any newer draft intact.

While a turn runs, the composer accepts an unsent draft for your next task.
Schway has no task queue: the placeholder reads `Draft your next task…` and the
hint row reads `Wait, then Enter sends · Esc stop` (`Working · Esc stop` when
the row is too narrow). Enter during work keeps the draft, selection and cursor
and shows `Still working · Wait, then Enter sends` while the status row keeps
Esc stop available. It never adds a user message or arranges an automatic send.
Slash and extension commands keep their own busy messages and stay unrun. When
the turn completes, stops or fails, the draft remains in the editor until you
press Enter again. After a completed or stopped turn the hint returns to Enter
send; after a failure it leads with that failure's recovery keys, such as
Ctrl+R continue or Alt+L connect. When the session cannot save another turn,
the hint leads with `/new start fresh · /sessions browse` instead of Enter send.

When a provider step fails, the error row gives the available recovery keys for
that operation. Alt+L opens sign-in after an authentication failure, Alt+M opens
model selection after an unavailable-model failure, F2 shows optional
redacted diagnostics, and **Esc keep editing** hides the controls while keeping the editor.
For an accepted turn, Ctrl+R continues from saved conversation progress when
offered. It does not submit the original user message again or rerun saved tool
calls. Authentication and model failures offer continuation only after their
repair activates a usable route. A session-write failure disables continuation:
visible output remains available, but a tool result may not have been saved.
Recovery controls expire when the active session, branch, or model identity
changes. Provider retries are limited to a single model step; Schway never
automatically retries the whole user task.

If the OS credential store is locked, the recovery row offers Ctrl+R to retry
credential access after you unlock it. The draft stays in the editor and is sent
only when you press Enter. A credential-store failure during an accepted turn
requires the same repair before Ctrl+R can continue its saved progress.
A session-write failure fences that session from accepting more turns because
the file may contain a partial write. Keep the visible evidence and open a new
or repaired session before sending another draft.

Selection is copied through the terminal's OSC 52 clipboard protocol. This works
with Kitty's clipboard support, including text selected from scrolled output.
Selecting in the editor does not automatically overwrite the clipboard. Ctrl+C
copies and clears an existing selection before it can cancel a turn or quit.
Web links carry terminal hyperlink metadata and ordinary clicks use the system
browser launcher. Long URLs retain their complete destinations when clicked,
including wrapped authentication links that exceed the native hyperlink limit.

Short terminals hide secondary chrome and reserve space for the editor and model
picker. At 24×8, the model picker and status remain inside the screen. These layout
and primary-scroll conventions follow the alternate-screen approach described in
[Pi's TUI documentation](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md),
using [OpenTUI's native ScrollBox](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/ScrollBox.ts)
for clipping, wheel handling and sticky scroll state.

Esc first closes an open sign-in, model or branch picker or command suggestion
list. The underlying prompt and cursor are restored after a picker closes.
The model picker opens with at most eight model rows: the current choice, user-wide
favorites, then recent successful choices, deduplicated by exact model, auth route,
endpoint and profile identity. Only connected routes appear. With no favorites or
history, it offers a small provider-supported selection. Readable names lead each
row, followed by its subscription or API route; endpoint labels show host and port,
and profiles include their name. ✓ marks the current choice and ★ marks a favorite.
Ctrl+P pins or unpins the highlighted model. Pins and recents survive restart and
are shared across workspaces; disconnected favorites stay saved but hidden.

Search immediately covers the complete connected catalog, including models outside
the shortlist. It ignores case and matches readable names, exact model IDs,
provider/model IDs and route labels using exact, prefix, substring and subsequence
matches. Up/Down selects a row. Enter uses a model, opens **Browse all models**, or
opens **Connect a provider**. Browse shows all connected models; Esc returns to the
shortlist before closing. Connect reveals routes and configured endpoint/profile
targets. Cancelling connection restores the target and query; Esc from custom
endpoint key entry first returns to the typed URL. A successful connection returns
to matching models without replacing an already selected model.

F2 reveals the exact ID and context/output budgets. Ctrl+R retries failed
catalog or access discovery. Reopening can display cached lists while access is
checked, and search and pinning remain available during refresh. A disappearing
highlight cannot silently select another billing route. Pins and recents store
bounded model IDs and hashed route identities, never endpoint URLs or credentials.

The footer shows the active route. Configured API-key and endpoint access does
not prove a remote service accepts requests. Subscription model rows appear after
account discovery; an unknown subscription ID cannot be sent. Unknown API model
IDs can be typed with fallback budgets. Explicit CLI and configuration preferences
remain visible until a different choice succeeds. Successful picker choices apply
to the current session and are remembered for later interactive launches in the
same canonical workspace, below explicit CLI and configuration preferences.
Headless launches do not automatically consume this memory.

Prompt recall excludes slash commands. API keys and pasted browser callbacks
use separate masked entries that intercept keyboard and paste events; neither
enters the ordinary draft, prompt recall or conversation. Device approval codes
appear only while the approval panel is open.

Successful built-in tools show a result summary beside their target: line, match
or entry counts, edit additions and removals, write creation or replacement counts,
and shell exit code with duration. Partial reads show their range; truncated search
and listing results show a `+` count and `truncated`. Summaries give way to long
targets at narrow widths.

Small successful edits and newly created files show numbered diff rows beneath the
heading, with explicit `+` and `-` signs and success/error colors. The default limit
is 12 changed rows; [ui.inlineDiffLines](configuration.md#inline-file-diffs) controls
it, and `0` disables inline diffs. Inline diffs have no disclosure marker and stay
visible when clicked or when Enter or Ctrl+O is pressed. Larger diffs expand to the
same numbered format with existing output bounds. Overwritten files show their line
count without a diff. Resumed edits show counts from saved arguments but no diff rows.

Running tools show a short tail. Failed tools start expanded; toggling one collapses
it to a six-line preview with an expansion hint. Ctrl+O expands all results; leaving
that mode clears individual toggles and restores expanded failures. Cancelled tools
retain their bounded preview. Expansion keeps the existing output limits. Markdown blocks
use the local parser and native terminal widgets; fenced code is presented in a
distinct surface and color without downloading syntax parsers.
Wide tables wrap cell text within the terminal width, breaking words when needed
without truncating them. Code blocks also wrap long lines. Resizing changes only
their display layout; copying keeps the original unwrapped code text, without fences.
Notices arriving during an answer do not finalize its still-streaming Markdown.

Inspection highlights one tool result, fenced code block or table and keeps the draft
and cursor in place. C copies the selected result or code body through OSC 52,
without borders, heading text, or Markdown fences. Code copy uses the rendered
Markdown code body, including code inside lists and quotes and an unfinished
streamed fence; Markdown may normalize its surrounding indentation and final
newline. The copied text is the redacted transcript representation. If a result
was truncated for display,
the copied text includes that truncation marker and a notice identifies it as
a bounded preview; the complete result remains in the session file. If OSC 52
is unavailable, Schway reports the failure and leaves the selection and draft
intact. New streamed rows and tool completion keep the selected item and the
reader's scroll position.

### Read long code and wide tables

Top-level tables get a header strip like code blocks, with **Alt+I inspect**.
Adding tables to inspection keeps every existing tool and code target in the
same relative order; tables join in rendered order. A selected table copies its
original sanitized Markdown, including pipes, empty cells and links, with C or
Enter. Nested tables inside lists and quotes are not inspection targets.

Press **R** on selected code or a table to open the reader. It uses the
transcript and composer area and shows `Read code` or `Read table`, the visible
lines and, when panned, the column. The compact transcript stays the default,
and the draft, cursor and transcript position return unchanged on Esc.

- Code starts unwrapped. Left/Right pan by half a screen; `‹` and `›` mark
  clipped edges. **W** wraps long lines; wrapping, resizing and panning keep the
  same source line at the top. Line numbers are presentation only.
- Tables show aligned columns with ` │ ` between cells. The header and its
  separator stay pinned when there is room, Left/Right step one column, and the
  title reports `Columns 2–5 of 8`. The label `Aligned columns · C copies
  Markdown source` marks that the copy keeps the original Markdown. Extra cells
  beyond the header stay visible; no column is hidden.
- **C** copies the canonical source: exact sanitized code with its line
  endings, or the table's Markdown. Line numbers, clip markers, hints, wrap
  breaks and search highlights never enter the copy. A copy is reported only
  when the terminal accepted the request; on failure the reader stays open at
  the same position.
- **Ctrl+F** searches the captured block with the conversation search's
  Unicode folding. Up/Down move between matches, Enter keeps the result in view
  and Esc restores the previous position. A match near the end shows the last
  full page, so the body never ends in blank rows. Reader search never adds rows to the
  conversation search or changes history.
- Opening a block that is still streaming captures a snapshot labelled
  `Snapshot · Esc back`. The conversation keeps streaming behind it; closing
  and pressing R again refreshes the snapshot.
- Sources longer than 8,000,000 characters are capped at a whole character.
  The reader shows `Showing first 8,000,000 characters`, and a copy of that
  part reports `Copied partial source`.

If a tool approval arrives while reading, it waits; the reader shows
`◌ Approval waiting · Esc back to request`, the find row names the same Esc
action, and navigation, copy and resize never answer it. Esc leaves the reader and opens the existing approval prompt
without approving or denying. After the request is handled, the reader never
reopens on its own: press **Alt+I** then **R** on the same target to return to
the saved snapshot, position and search. Session and branch changes discard the
reader.

## Discover commands and skills

Type `/` to browse commands in a fixed order: `/model`, `/new`, `/clear`, `/sessions`,
`/changes`, `/undo`, `/history`, `/compact`, then the remaining built-ins. User-invokable project and
global skills, including user-only skills, follow under **Skills**, then active
extension commands under **Extensions**. Empty groups have no header. Extension
rows show their package name, or the module filename for `--extension` modules.
Descriptions share one column; long names are clipped, while Tab inserts the full
name. `/delete-session` comes last, uses warning color and ends with `· deletes`,
including without color. `/logout` stays with ordinary built-ins.

Type after `/` to search a flat list with case-insensitive fuzzy matching. Exact
names rank first, then prefixes, word starts after a hyphen, substrings and other
subsequences. Ties keep the fixed order. Clearing the search restores the groups
and selects the first command. Alt+H help ranks differently; see
[search commands and keyboard actions](#search-commands-and-keyboard-actions).

`!` marks a collision or unavailable action in the Skills group. Rename conflicting skills or
extensions before invoking either meaning of the name. Metadata refreshes when
browsing reopens, and submission rechecks collisions. Removing or disabling a
highlighted choice clears its selection: press an arrow before completing again.

Use Up/Down to select and wrap, Tab to insert, and **Esc keep editing** to hide the list. Arrows skip
group headers and unavailable rows; Tab never inserts them. Completion never
executes an action. `/thinking ` suggests only validated current model levels
(and `reset`); subscription levels require advertised account metadata. OpenRouter
uses endpoint-scoped model metadata for the same choices in `/thinking` and
preferences, including `minimal` when supported. `/thinking` and `/config`
distinguish an advertised provider default from an explicit effort or `off`;
mandatory reasoning models never offer `off`. An unavailable catalog leaves the
provider default usable, but an explicit effort requires verified support.
`/theme ` offers appearance choices; `/login ` and `/logout ` offer public
connection names, never keys or callback payloads. Enter explicitly submits;
rejected or busy commands remain in the editor for correction.

Skill browsing reads bounded frontmatter; full body validation happens on invocation.

### Search commands and keyboard actions

**Alt+H** opens a searchable palette while retaining your task, cursor and
reading position; `/help` opens the same palette when idle. Alt+H also works
while a turn runs; opening or leaving the palette never cancels work. The
palette lists commands, skills and extension commands, then a **Keyboard**
group of built-in keyboard actions, then `/delete-session` under
**Destructive**. Help does not append command lists to the transcript.

Search matches command names, descriptions and sources, and each keyboard
action's label, description, keys and curated intents such as `newline`,
`line break`, `copy`, `approval`, `mode`, `shortcuts`, `details` and `review`.
Exact key spellings such as `ctrl+j`, `shift+tab`, `f2` or `alt+r` find their
action. Ranking is deterministic: exact matches first, then prefixes, word
starts, substrings and subsequences, with names and keys ahead of descriptions
at the same quality. Ties keep the catalogue order. Unavailable entries and
collisions stay in the results with `!` and their reason; an action ID or alias
never claims a slash name. A new search selects the best match, and refreshes
that do not change the query keep the selected entry.

| Row | Tab | Enter |
| --- | --- | --- |
| Command, skill or extension | Preview its insertion in the search field | Insert it (or the preview) into the composer and close; nothing runs |
| Keyboard action | Nothing | Show its exact keys, prerequisites and current availability |

Commands run only after you press Enter again in the ordinary composer, with
the usual collision checks, busy-turn restrictions and `/delete-session`
requirements. Keyboard guidance never performs its action, including copying,
changing mode, cancelling or inserting a newline. In guidance, Esc returns to
the same search and selection; in results, Esc restores the original draft,
cursor and reading position. Without matches the palette shows
`No matches · Esc restore`. The search field is one line:
Shift+Enter and Ctrl+J never add a line to the query.

Keyboard rows show their keys and label; the selected row's description or
unavailable reason appears beneath the results so it stays readable at narrow
widths and without color. While a turn runs, actions that need an idle
composer, such as change review and details, are marked unavailable, and a
note reminds you to send commands after the turn settles. When the composer
cannot send (a failed turn or a session that cannot save), reasons name the keys
the hint row leads with instead of Enter send; the Alt+I notice does the same. When a tool approval
is waiting behind the palette, **Esc back to request** leaves it to show the request. Credential
and approval prompts keep their own input; the palette cannot open over them,
and its search text is never saved as a draft.

## Context and conversation continuity

The context line estimates the selected branch's conversation plus its active
summary in tokens. It excludes system instructions, tool definitions and provider
overhead; it is not a complete request size, billing total, or task completion
percentage. The selected model appears separately in the footer. Capacity comes
from an explicit limit, catalog or advertised account metadata; unknown models
show unknown capacity even though the runtime uses a conservative fallback.
Reasoning support alone does not establish context capacity.

Use `/context` to inspect the estimate's scope, selected model, last reported turn
request usage and active summary. Missing input/output usage remains unknown,
including after resume. Reported usage is separate from the local estimate and
is not a billing total. Inspection never sends a model request, compacts history,
changes branches or writes a session record.

Automatic context pressure, provider overflow and manual `/compact` show their
reason in the activity area. Completion, no-op, cancellation and failure are
reported separately. A successful summary keeps every original conversation
record; the transcript marks where recent model context begins, while older rows
remain searchable and inspectable. `/branch tree` browses ancestry; only the
selected branch's summary is active. Resume reconstructs that same boundary.

If compaction fails or is cancelled, the previous durable history remains valid.
For a model failure, check the connection before retrying `/compact`, or select a
model with more context using `/model`. After a session-storage failure, repair
storage and run the displayed `/resume <session-id>` command before retrying
`/compact`. Restoring storage alone does not reopen a session handle fenced after
a failed write. A no-op can mean there are no older turns
to summarize or the model produced no usable summary. Incomplete summary streams
are failures and are never committed as successful summaries. Pressure failures
preserve the existing loop policy; overflow without freed context stops with a
recovery explanation instead of retrying forever.

## Recent sessions

Use `/sessions` or **Alt+S** to browse saved work. Alt+S keeps your multiline
editor draft. Type a task, workspace or ID to search; arrows preview the selected
row, PgUp/PgDn move eight results, and Enter explicitly resumes. Escape restores
the draft, focus and reading position. Successful resume restores the destination
conversation’s in-memory draft and reading position, or an empty editor at the
latest message on its first visit. Returning to the source restores its draft;
commands and credential-entry values are not cached. Previewing does not switch the model,
workspace or session, repair files, execute tools, or advance activity.

The default scope is the current canonical workspace. Ctrl+W switches to all
workspaces, including unknown/corrupt files for recovery. Rows show a bounded task
preview, committed activity time (or “activity unknown”), workspace, state and a
current-session marker. The selected activity has its own line so long task
previews do not hide it, including at narrow terminal sizes. No provider generates titles. Saved auth commands and
callback payloads are excluded from task previews.

Discovery reads at most 100 files per request and 64 KiB per transcript, plus
2 KiB metadata. “Partial results” means search and ordering cover only the loaded
batch; Ctrl+L loads another 100 and reorders the accumulated results. Large files
show a partial-preview state and are fully validated only on explicit resume.
Older history without activity metadata uses creation time for ordering and
truthfully displays unknown activity. Empty, legacy and corrupt files are retained;
restore an unavailable directory or repair a corrupt file outside Schway, then
reopen the picker. A failed resume retains the current conversation and draft.

Draft preservation here is in memory; this picker does not add persistent per-session
draft recovery.

## Alternate conversation paths

`/branch tree` opens a preview browser. Arrow keys select numbered, named existing paths; `●` means active and `›` means preview. Duplicate labels still select exact branch identities. Enter continues the selected existing path. Tab chooses a separate new-fork action at a complete turn; type a name and press Enter. Tab returns to existing paths. Escape returns to the ordinary draft, cursor and reading position. See [session branching](sessions.md#browsing-branches-in-the-tui).

The confirmation controls explain that files and Git remain unchanged. Switching history neither undoes edits nor replays tools. While work runs, preview remains available but activation is refused. Failed activation retains the previous path. The list pages through large branch sets and truncates previews; exact IDs remain supported by explicit commands.

## Leaving and recovering unfinished input

Ordinary drafts save after 500 ms idle. **Draft saved · Alt+D discard** confirms
the current text; editing it removes that notice until the new text is saved.
A draft-only session appears as **Unsent draft** in recent work; **Alt+B**,
`/sessions`, or `schway --resume <id>` restores it into that conversation without
sending it. **Draft restored · Alt+D discard** appears when the text is back in the
composer. Accepted input clears the saved text while a newer draft remains intact.

If saving fails, **Draft not saved · Select text, Ctrl+C copy** keeps the editable
text available. Select the text before pressing **Ctrl+C**; without a selection,
Ctrl+C keeps its ordinary stop or quit action. A narrow terminal puts the status
and selection/copy action on separate lines. Failed discard keeps the text and
shows **Draft cleanup failed · Alt+D retry**. Credential entry, callback entry and
auth commands are never saved as drafts; saving pauses throughout credential
surfaces.

Quit attempts to save the latest editor text in an isolated writer with a 500 ms
deadline, then restores the terminal even if storage stalls. **Draft saved.**
confirms success. Failure or timeout warns that your latest text may not be saved;
a resume command is printed for saved sessions. During an active tool, exit
requests cancellation without waiting indefinitely; it does not claim the tool
settled or its filesystem effects were undone. After a forced kill, only the last
completed save is recoverable. See [retention, deletion and storage limits](sessions.md#unsent-draft-checkpoints).

Test coverage for this guide: [release verification](release-verification.md#tui).

## Approval mode

The footer always shows the effective mode: **◆ Auto**, **◆ Ask**, or **◆ Read-only**, including before sign-in, during work and after resuming a session. Press **Shift+Tab** in the ordinary composer to cycle `auto` → `ask` → `read-only` → `auto`, including while a turn runs. The **Shift+Tab change mode** hint appears when that shortcut is available. At narrow widths, the mode and urgent action take priority over model/context information. Failed tool rows expand the denial reason.

Open **Alt+P preferences** for the mode meanings; **PageUp/PageDown** scrolls the explanation. Auto runs tools without asking, Ask asks before tools that need approval, and Read-only allows read-only tools. Existing tool restrictions and session allowances still apply. A mode change affects calls that have not reached their approval decision; it does not undo or relabel an already authorized operation.

Shift+Tab retains its existing scope, inspection, or completion behavior while those views are open; it does not switch modes in panels or search. Launch with `schway --approval ask` or `schway --approval read-only` to start in that mode. The process choice survives new/resumed sessions and model changes without writing config or interactive memory.


In **Ask** mode, read-only tools run without a prompt. A mutating tool opens an `Allow <tool>? · ask mode` panel after `beforeTool` hooks and argument validation. Bash shows the full command; edit and write show the target path, line counts and a numbered diff; other tools show their final arguments as indented JSON. Known secrets are masked. PageUp/PageDown scroll the preview; resizing reflows it.

Use Up/Down to choose **Allow once**, **Allow <tool> for this session**, or **Deny with reason…**, then Enter. The hint row names what Enter does for the selected choice: `↑↓ choose · Enter allow once · Esc deny`, then `Enter allow for session` or `Enter add reason` as the selection moves, plus `PgUp/PgDn scroll` only while the preview overflows. Narrow rows drop the navigation keys first and keep `Esc deny` and the Enter verb. Below 14 rows, where the hint row is hidden, the status bar shows the same `Enter <verb> · Esc deny` action. Ctrl+C appears once, in the `Approval required · Ctrl+C cancel turn` activity row from 10 rows.

The approval panel takes the composer's rows while it waits. Its heading, at least the first preview row and the selected choice (marked `›`) always fit, from 8 rows up. On short terminals the panel gives up its blank rows first, then the choices that are not selected, then preview rows down to one; a lone choice shows its position, such as `› Allow once  (1 of 3)`. Enter never acts on a choice the panel cannot show.

Allow once applies only to the current call. A session allowance applies to later ask-mode calls with the same tool name; it never overrides read-only mode and survives cycling back to ask. Successful session switches through `/new`, `/resume`, `/sessions` or Alt+B clear every allowance. Allowances are not saved across processes.

Esc denies the current call without stopping the turn. **Deny with reason…** opens an entry with `Why? The agent will see this…` and the hint `Enter deny with reason · Esc deny`; Enter submits the trimmed reason, including an empty denial, and Esc denies without the typed reason. The model receives `Denied by the user.` or `Denied by the user: <reason>`. Reason text stays out of prompt history, composer drafts and draft checkpoints. Every exit restores the draft and cursor saved before the panel opened. **Ctrl+C** cancels the whole turn, including queued calls; **Shift+Tab** is ignored while the approval prompt is open.

Requests appear one at a time in assistant-message order. If another panel, search or inspection is open, it remains open while approval waits. The warning-colored **Approval** pill and `Esc back to request` hint show how to reach the request; leaving that view opens the approval prompt immediately. The status bar names that view's own Esc action, and Ctrl+C stays in the activity row. The code and table reader shows the same `Esc back to request` and keeps its position for an explicit Alt+I then R return.

### Details keyboard compatibility

**F2** opens available Details; **Ctrl+I** remains an alias when the terminal reports
it distinctly. Esc returns to the previous view, selection and scroll position.
Legacy terminals can report Ctrl+I as the same Tab byte (`0x09`), so Tab keeps
its completion and navigation behavior. No terminal setting is required for F2.

Decoder-to-view tests exercise SS3 `ESC O Q`, CSI `ESC [ 12 ~`, Linux-console
`ESC [ [ B` and CSI `ESC [ Q` F2 sequences, plus Kitty F2 and distinct Ctrl+I
press/release events and modifyOtherKeys Ctrl+I. These tests use OpenTUI
0.5.11’s input decoder; they do not claim testing of every terminal emulator.
