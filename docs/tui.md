# Conversation interface

Schway uses one conversation column with a persistent multiline editor. The screen
is divided into color blocks: a top bar names the workspace and checked-out Git
branch; the conversation sits on the canvas; the composer is a raised block; the
status bar below it carries the state pill, model, reasoning preference, and context
meter; key hints sit on the last row. `/session` reveals session IDs, the conversation branch, and attached
workspace paths. A conversation branch is distinct from a Git branch.

The status pill follows the active operation's runtime events: `PREPARING`,
`WAITING` for the provider, `STREAMING` a response, `TOOLS n`, `RETRY a/b`,
`COMPACTING`, `CANCEL REQUESTED` and `STOPPING`; otherwise it reads `READY`,
`CHECKING` (connection check), `NOT CONNECTED` (the neutral no-model state) or
`ATTENTION` (a failure needs you). It is the only saturated block on screen: filled accent while working, warning while stopping,
error when attention is needed, a quiet green tint when ready, and a muted tint
with `○` when not connected. The not-connected status bar shows only its pill.
Active operations show elapsed time; provider retry countdowns use the reported delay and attempt. Quiet providers
and tools remain in their current phase with elapsed time, without an estimated
percentage or a hang warning. The activity row above the composer describes the
current work; parallel tools share a compact count and name summary. The context
meter shows the estimated share of known capacity (`ctx ━━━━ 19%`), or the token
estimate (`ctx ~132`) when capacity is unknown; `/context` explains it. At narrow
widths the pill, `Esc stops` and the context estimate take priority; the route,
reasoning chip and then the model name are shortened first.

Streamed assistant text is a preview until the provider finishes the attempt. A
retry keeps an abandoned preview visibly marked as incomplete, then replaces it
when the next attempt starts. Once an answer is accepted, the visible text comes
from the saved assistant record, so reopening the session shows the same answer.
Retry progress uses one changing status row and the footer countdown. If retries
run out or you cancel, any remaining preview is marked “Incomplete response · not
saved”; completed tool results remain in the session.

## First launch and readiness

A fresh install shows two lines: **Not connected**, then **Sign in to choose a
model · Alt+L**. Its hint row reads **Alt+L sign in · / commands**; narrow widths
keep the sign-in action. Enter leaves an ordinary draft and its cursor unchanged
until a model is active.

Once a model is selected, an empty conversation identifies the workspace,
effective model and auth route, then offers the relevant action: **Alt+L connect**, **Alt+M choose/repair model**,
**Ctrl+R retry locked credential storage**, or **type a task**. **Ctrl+I** opens
failure details; its hint appears only when those details exist. The ready screen
does not add a recurring welcome or restored-choice message to the transcript; `/config` retains setting provenance and `/model forget`
clears remembered interactive choices.

The selected connection is checked after the editor opens. While a catalog or
credential check is pending, you can type, paste and resize; **Esc** cancels the
check. Setup actions wait for that check to finish or be cancelled. No browser or
model inference is started by opening the screen. An explicit broken selection
stays selected until you repair it; startup does not switch billing routes.
Explicit and remembered ChatGPT subscription models are checked against the account
catalog. API routes are labelled **configured, unverified**: initialization does not
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

After an accepted turn settles, the activity line shows `✓ Done`, `✗ Failed`,
`− Cancelled`, or `◌ Limit`, then changed files and known line counts, observed
command results, elapsed time, and **Alt+R review**. Failed turns also offer
**Ctrl+I details**. For example:

```text
✓ Done · 1 file +1 −1 · 2 commands ok · 14s · Alt+R review
✗ Failed · 2 files +8 −3 · 1 command failed · Alt+R review · Ctrl+I details
```

Counts include successful file-tool changes and paths detected as changed by shell
commands, extension tools, or other processes. Created writes and edits contribute
known additions and removals; overwritten writes have no line counts. Commands can
be `ok`, `failed`, or `stopped`. Counts cover the whole turn even though only the
latest 50 commands are retained. A completed model turn can contain a failed check.
At narrow widths, elapsed time drops first, then commands, then files; the outcome
and actions stay until the terminal is too narrow even for those.

**Alt+R** or `/changes review` opens `Review · turn N`, numbered by user messages on
the active conversation branch. The left column lists this turn's files, with `›`
marking the selection and line counts or a `shell` badge. The right column shows
the selected file's current, numbered diff: removals use old line numbers, additions
and context use new line numbers. Colors and ASCII `-`/`+` signs distinguish changes.
Below 80 terminal columns, the file list stacks above the diff. Binary, deleted,
renamed, and truncated previews have short explanations instead of Git metadata.
Shell files begin with `changed by shell · not undoable`.

Up/Down selects files; PageUp/PageDown scrolls the diff. **Ctrl+I** swaps the diff for
turn details; Ctrl+I again or Esc returns to the diff. Esc from the diff restores the
same conversation position, unsent draft, and cursor. After a failed turn, Ctrl+I in
the conversation appends the same details, including any recovery diagnostics.
Details contain tool counts, whole-turn exit-zero/nonzero/unknown totals, and the
retained commands without tool-call IDs. **Alt+I** still inspects individual tools.
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
authorship. Exit codes are observed command results, not a test-suite guarantee.
Failure, cancellation, and conversation branching leave completed filesystem
effects in place. Review does not commit, undo, or restore files. Only the latest
turn pair is retained, and switching a session or branch clears it. Fresh and resumed
sessions show `No turn to review yet`; saved tool results remain in the conversation.

## Color roles

The Voltage palette pairs calm canvases with color blocks for each zone.

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#0e1117` | `#f7f7f4` | Main canvas |
| Surface | `#161b24` | `#ecedea` | Top bar, user messages, composer, code bodies, status bar |
| Surface 2 | `#1e2430` | `#e1e3df` | Tool trays, code headers, pickers, model chip |
| Text | `#e6eaf0` | `#1d232c` | Conversation and errors' content |
| Muted | `#8b95a7` | `#545e6c` | Metadata, hints, tool details |
| Border | `#2c3444` | `#c5c9cf` | Key chips, search highlight |
| Accent | `#7cc4ff` | `#0a5894` | Working pill, focus bar, selection, read tools |
| Success | `#8fd19e` | `#19612f` | Ready pill, completed tools, added lines |
| Warning | `#f0c674` | `#7a5000` | Stopping pill, edit tools, cancelled tools |
| Error | `#f79d9d` | `#a61f16` | Attention pill, error blocks, removed lines |
| Code / Violet | `#c0acff` | `#6a3fb0` | Inline code, keywords, reasoning chip, shell tools |
| Cyan | `#5ee7ff` | `#065e74` | Types in code, other tools, logo gradient start |
| Bolt | `#ffd84a` | `#b27b00` | The ⚡ mark and splash sparks |

Tints mix a semantic color into Surface 2 (22% dark, 12% light) for pills, diff
rows and selected picker rows; only body text or that same semantic color is drawn
on a tint. Every text role meets a 4.5:1 contrast ratio on the canvas, both
surfaces and every tint it is used on.
Symbols and labels retain meaning without color. Nonempty `NO_COLOR` maps semantic
accents to the text color. This is a monochrome TUI, not a plain-text output mode;
use `-p` for headless text.

Code blocks use a small built-in lexer (keywords, strings, numbers, comments,
types, calls) instead of downloaded parsers; copying still returns the exact code.

## Motion and startup splash

An interactive launch opens with a 2 second splash: the SCHWAY wordmark appears
as a ghost, a lightning bolt crosses and ignites it, the screen flashes, the logo
settles into its cyan-to-violet gradient while the tagline types in, then collapses
like a CRT into one spark that flies into the top bar's ⚡ and reveals the
interface. Startup keeps going underneath: the editor already has focus, and any
key, paste or click skips the splash **and is still delivered** (the first typed
character lands in the draft). The timeline starts at the first painted frame and
holds across startup stalls, so no phase is skipped on a slow start. `--resume`
launches, terminals smaller than 57×16, and reduced or disabled motion skip it.

While working, the pill and tool rows show a braille spinner, the pill and
activity text carry a moving highlight, a streamed answer ends in a blinking `▍`
(never inside an open code fence), a finished tool row flashes green, the pill
cross-fades between states and pickers slide up from the composer. Motion is
decorative: text, layout and keys never depend on it, and the animation timer only
runs while something is moving.

`SCHWAY_MOTION=full|reduced|off` selects the level. `reduced` keeps spinners and a
steady caret but removes the splash, highlights, flashes, caret blink and slides;
`off` also replaces spinners with a static `●` and drops the caret. `NO_COLOR` or `TERM=dumb` default to `reduced`.

The default is automatic terminal light/dark detection, then `COLORFGBG`, then
dark. In `/config` (Alt+P), select **appearance** and choose **Reset (inherit)**,
`auto`, `dark`, or `light`. Tab selects session, user or project scope; Enter
previews and a second Enter saves. User and project choices survive restart.
`auto` follows terminal detection; Reset removes only the selected scope's
override. `/theme auto|dark|light` changes the session appearance through the
same preferences when configuration is available. A valid
`SCHWAY_THEME=dark|light` in the launch environment overrides every saved or
session appearance choice; preferences show its effective source and the saved
choice beneath it. Schway does not edit terminal, shell or window-manager settings.

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
| Dismiss suggestions | Esc |
| Forget remembered workspace choice | `/model forget` (or `/model reset`); reveals inherited explicit config/defaults without deleting credentials |
| Preferences | `/config` or Alt+P; Up/Down field, Left/Right value/reset, Tab/Shift+Tab scope, Enter preview then confirm, Esc cancel/back; PageUp/PageDown scroll details |
| Model picker | `/model` or Alt+M; Up/Down skips headers, Enter uses a model or starts sign-in, Ctrl+R retries a failed account catalog, Esc goes back |
| Sign-in chooser | `/login` or Alt+L; ↑↓ select, Enter, Tab more options, Esc back |
| Tool details | Ctrl+O toggles expandable results; click a heading or press Enter in Alt+I inspection to toggle one; small inline diffs stay visible |
| Review turn changes and command evidence | Alt+R or `/changes review`; Up/Down selects a file, PageUp/PageDown scrolls, Esc restores the draft and reading position |
| Inspect results and code | Alt+I enters inspection; Up/Down or Tab moves between results and fenced code blocks; Enter expands or collapses one expandable tool result; C copies the selected item; Esc returns to the draft |
| Find in this conversation | Ctrl+F; type a literal query, Up/Down for previous/next, Enter to keep the result in view, Esc to restore the old position |
| Scroll | PageUp/PageDown or mouse wheel |
| Follow latest | Ctrl+End or click the new-activity hint |
| Recover stale terminal cells | Ctrl+L; preserves the draft and scroll position |
| Cancel | Esc or Ctrl+C during a turn when no text is selected |
| Quit | `/quit`, Ctrl+C while idle with no selection, or Ctrl+D with empty input |

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
| Preferences | Up/Down field, Left/Right value, Tab scope, Enter preview/confirm, Esc back |
| Model, sessions, sign-in | Up/Down selection, Enter select, Esc back; model Ctrl+R retries catalog |
| Credential, callback, approval | Masked entry or external wait, Enter only on entry, Esc cancel |
| Branch tree, change review | Up/Down selection, Enter branch choice, Esc back; review uses PageUp/PageDown |
| Help, command completion, search, inspection | Panel-specific navigation, Enter chosen action, Esc restores composer |

Open preferences from the task composer. If another panel is open, Escape returns
to the task before Alt+P; preferences likewise keep ownership of input until closed
(or their explicit model-picker action is selected). Repeated Alt+P preserves the
current preference selection and preview.

Preferences show effective values, their origins, and separately saved lower values.
Session edits disappear on restart; workspace memory, user config and project
config are distinct explicit scopes, explained before confirmation. Project scope
writes only after the second Enter. Credential material is excluded; model-route
selection is a separate action that activates and remembers a successful choice.
Textual `/config set`, `/config reset` and `/config show` remain available.

The conversation follows new output until you scroll back. Streaming then keeps
your reading position; Ctrl+End resumes following. Wheel input over non-scrollable
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
“Cancel requested” immediately, then “Stopping” while active work settles.
Running tools and other owned work may
still need to settle. Completed output and tool results remain visible; `READY`
returns only after settlement, and cancellation does not undo completed effects.

Enter releases a prompt only after its user record is saved. Missing credentials,
busy operations, and rejected commands keep the text and cursor in the editor
so you can repair the cause and press Enter again. A model
failure after the saved user record is a failed turn in the conversation; it does
not restore the prompt as a new draft. Prompt recall records accepted ordinary
prompts only. Long commands release the editor when their preparation succeeds
and execution starts; their later completion leaves any newer draft intact.

When a provider step fails, the error row gives the available recovery keys for
that operation. Alt+L opens sign-in after an authentication failure, Alt+M opens
model selection after an unavailable-model failure, Ctrl+I shows optional
redacted diagnostics, and Esc dismisses the controls while keeping the editor.
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
The model picker groups choices in a fixed order: ChatGPT subscription, Grok
subscription, OpenAI API key, xAI API key, then the configured OpenAI-compatible
endpoint and named profiles in config order. Each endpoint header shows only its
host and port. Model rows lead with their ID, followed by compact context capacity,
reasoning support and a checkmark for the active model. The active model is
highlighted when the picker opens; it does not move within its group.

Search ignores case and matches model IDs, provider/model IDs and group labels
using exact, prefix, substring and subsequence matches. Headers are informational;
Up/Down skips them. A disconnected route has one `Sign in · Enter` row and no
model rows. Sign-in returns to the same query with the route's first matching
model highlighted, without applying a picker choice. Esc returns to the sign-in
row; during custom endpoint setup, Esc from key entry returns to the typed URL
first. The model and settings stay unchanged when setup is cancelled before saving.
A failed model list shows `list unavailable` once on its header, with fallback
choices still selectable. Ctrl+R is offered only for an empty, offline or failed
account catalog. The detail line counts selectable rows and shows full context
and output budgets without naming the route.

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

Inspection highlights one tool result or fenced code block and keeps the draft
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

## Discover commands and skills

Type `/` to browse commands in a fixed order: `/model`, `/new`, `/sessions`,
`/changes`, `/compact`, then the remaining built-ins. User-invokable project and
global skills, including user-only skills, follow under **Skills**, then active
extension commands under **Extensions**. Empty groups have no header. Extension
rows show their package name, or the module filename for `--extension` modules.
Descriptions share one column; long names are clipped, while Tab inserts the full
name. `/delete-session` comes last, uses warning color and ends with `· deletes`,
including without color. `/logout` stays with ordinary built-ins.

Type after `/` to search a flat list with case-insensitive fuzzy matching. Exact
names rank first, then prefixes, word starts after a hyphen, substrings and other
subsequences. Ties keep the fixed order. Clearing the search restores the groups
and selects the first command. In Alt+H help, names rank before matches in
descriptions or sources such as `project skill`, `global skill` and `user-only`.

`!` marks a collision or unavailable action in the Skills group. Rename conflicting skills or
extensions before invoking either meaning of the name. Metadata refreshes when
browsing reopens, and submission rechecks collisions. Removing or disabling a
highlighted choice clears its selection: press an arrow before completing again.

Use Up/Down to select and wrap, Tab to insert, and Escape to dismiss. Arrows skip
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

**Alt+H** opens searchable ephemeral help while retaining your task and cursor;
`/help` opens the same surface. Search names, descriptions, or sources. Escape
restores the task and viewport. Tab previews the selected command within help,
so Escape still restores the task. Enter transfers that preview to the composer;
press Enter again to submit it. Help does not append repeated command lists to the transcript.
Skill browsing reads bounded frontmatter; full body validation happens on invocation.

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

Ordinary drafts checkpoint after 500 ms idle. A draft-only session appears as
**Unsent draft** in recent work; **Alt+B**, `/sessions`, or `schway --resume <id>`
restores it into that conversation without sending it. The recovery notice offers
**Alt+D discard**. Accepted input clears its checkpoint, while a newer composed
draft remains intact. Credential entry, callback entry and auth commands never
become draft checkpoints; checkpointing pauses throughout credential surfaces.

Quit attempts a checkpoint of the latest editor text in an isolated writer with a
500 ms deadline, then restores the terminal even if storage stalls.
The final message distinguishes a completed checkpoint from a save failure and
prints a resume command for saved sessions. During an active tool, exit requests
cancellation without waiting indefinitely; it does not claim the tool settled or
its filesystem effects were undone. After a forced kill, only the last completed
checkpoint is promised. See [retention, deletion and storage limits](sessions.md#unsent-draft-checkpoints).

Test coverage for this guide: [release verification](release-verification.md#tui).
