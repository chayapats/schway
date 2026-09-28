# Conversation interface

Schway uses one conversation column with a persistent multiline editor. Workspace
context sits at the top; model, reasoning preference, and execution state sit below
the editor. `/session` reveals session IDs, the conversation branch, and attached
workspace paths. A conversation branch is distinct from a Git branch.

The status line follows the active operation's runtime events: preparing context,
waiting for the provider, streaming a response, running tools, waiting to retry,
compacting, and stopping. It shows elapsed time; provider retry countdowns use the
reported delay and attempt. Quiet providers and tools remain in their current phase
with elapsed time, without an estimated percentage or a hang warning. Parallel tools
share a compact count and name summary. At narrow widths the phase and `Esc stops`
take priority in the footer.

Streamed assistant text is a preview until the provider finishes the attempt. A
retry keeps an abandoned preview visibly marked as incomplete, then replaces it
when the next attempt starts. Once an answer is accepted, the visible text comes
from the saved assistant record, so reopening the session shows the same answer.
Retry progress uses one changing status row and the footer countdown. If retries
run out or you cancel, any remaining preview is marked “Incomplete response · not
saved”; completed tool results remain in the session.

## First launch and readiness

An empty conversation identifies the workspace, effective model and auth route,
then offers the relevant action: **Alt+L connect**, **Alt+M choose/repair model**,
**Ctrl+R retry locked credential storage**, or **type a task**. **Ctrl+I** opens
failure details. The ready screen does not add a recurring welcome or restored-choice
message to the transcript; `/config` retains setting provenance and `/model forget`
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

Automated coverage uses the actual renderer's keyboard, paste and resize input,
plus a packed-and-installed executable launched outside the checkout with isolated
HOME, credential storage, terminal and model fixtures. It covers fresh startup,
remembered credentials/model, setup cancellation and activation, one explicit send,
explicit subscription models absent from the fixture account catalog, denied
credential storage, missing profiles/HOME and invalid configuration. Renderer tests additionally delay startup, simulate offline
failure and fence late results after cancellation/disposal. These fixtures do not
verify a human terminal, real OS secure storage, live OAuth or a paid provider;
those checks remain unrun for the final installed-journey gate.

## Returning to recent work

Ordinary launch opens a new conversation. When this workspace has saved work,
**Alt+B resume** appears above the conversation with its task preview. One press
restores that exact session; typing and Enter continue to create new work. The offer
is not a modal choice and never starts a model turn. **Alt+S** or `/sessions` opens
all saved history, including entries that need recovery. Suggestions use committed
activity in the canonical current workspace and ignore empty navigation sessions.
Discovery runs after startup with bounded per-file previews; large collections can
take longer to produce the offer.

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

`tests/recent-startup.test.ts` exercises actual interactive startup in isolated
subprocesses with renderer keyboard, paste and resize: new/reopen, one-action
resume, explicit branch/auth/model, changed config over remembered billing,
credential repair, deleted/corrupt suggestions, and repeated navigation. Existing
interactive-memory tests cover missing profiles. These are deterministic model and
credential fixtures; live OAuth, real provider and human-terminal verification
remain unrun. Durable cross-process draft recovery is a separate slice.

## Turn outcomes and change review

After an accepted turn settles, the activity line reports **completed**, **failed**,
**cancelled**, or **limit** separately from the model's answer. Command counts report
observed exit zero, nonzero, and unknown results across the entire turn, even when
only the latest 50 command details are retained. A completed model turn can contain
a failed check. These are command results, not a claim that a test suite passed;
model prose and command invocation alone provide no verification evidence.

**Alt+R** or `/changes review` opens a read-only panel with the latest turn's tool
counts and up to 50 command results, identified by call ID and command. **Alt+I**
inspects individual tool results in the conversation. Up/Down selects from at most
50 current changed file paths, including files inside new untracked directories;
PageUp/PageDown scrolls details. Selected names are literal paths, including glob
characters and Git pathspec syntax. Each diff is bounded,
with explicit truncation, deleted-file content, rename metadata, or a binary-content
explanation. Esc restores the same conversation position, unsent draft, and cursor.
`/changes status` and `/changes diff -- <path>` remain available as textual commands.

The default on-demand mode reads Git only when review is requested. Current
working-tree changes are **unattributed** and may include prior or concurrent edits.
If snapshot mode was explicitly enabled before the turn, review additionally shows
its retained before/after comparison: prior dirt, newly observed paths, paths changed
further, and resolved dirt. Those observations are not proof of exclusive Schway
authorship; the current diff can also contain later edits. No-change, non-Git,
tracking-off, and unavailable-attribution states are explicit. Review does not enable
snapshots, commit, undo, or restore files. Failure, cancellation, and conversation
branching leave completed filesystem effects in place. Turn summaries are transient;
old/resumed sessions still expose their saved tool results and current Git review.

Automated verification covers the actual loop/controller with successful edits and
command exits, failed checks, cancellation and model failure after edits, pre-existing
snapshot dirt, concurrent on-demand edits, read-only/no-change and non-Git workspaces.
A real renderer fixture uses keyboard, paste, and resize input to navigate bounded
text, deleted, renamed and binary diffs, then restores the draft, cursor and scroll.
These deterministic fixtures use isolated workspaces and injected credentials; live
providers, OAuth, real credential storage and a human terminal journey remain unrun.

## Color roles

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#15181e` | `#fafaf8` | Main canvas |
| Surface | `#20252e` | `#eeefed` | User messages, code, pickers |
| Text | `#e2e6ec` | `#242a33` | Conversation and errors' content |
| Muted | `#a7b0be` | `#566170` | Metadata, hints, tool details |
| Border | `#4a5565` | `#9ba3ad` | Composer and separators |
| Accent | `#83bfff` | `#075985` | Selection, input marker, running |
| Success | `#91c99a` | `#166534` | Completed tools, added lines |
| Warning | `#e6c078` | `#854d0e` | Cancelled tools, notices needing attention |
| Error | `#f29b9b` | `#b91c1c` | Failures, removed lines |
| Code | `#cfb9ed` | `#6b3890` | Inline code and code blocks |

All text tokens meet a 4.5:1 contrast ratio on both built-in backgrounds; borders
are decorative. Symbols and labels retain meaning without color. Nonempty
`NO_COLOR` maps semantic accents to the text color. This is a monochrome TUI,
not a plain-text output mode; use `-p` for headless text.

The default is automatic terminal light/dark detection, then `COLORFGBG`, then
dark. `/theme auto`, `/theme dark`, and `/theme light` apply to the current session.
Set `SCHWAY_THEME=light` or `SCHWAY_THEME=dark` in the launch environment to choose
a default across sessions. Schway does not edit the terminal's configuration.

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
| Model and route picker | `/model` or Alt+M; Up/Down, Enter to apply or connect, Ctrl+R to retry a failed account catalog, Esc to cancel |
| Sign-in chooser | `/login`; Up/Down, Enter, Esc |
| Tool details | Ctrl+O toggles all; click a heading to toggle one |
| Review turn changes and command evidence | Alt+R or `/changes review`; Up/Down selects a file, PageUp/PageDown scrolls, Esc restores the draft and reading position |
| Inspect results and code | Alt+I enters inspection; Up/Down or Tab moves between results and fenced code blocks; Enter expands or collapses one tool result; C copies the selected item; Esc returns to the draft |
| Find in this conversation | Ctrl+F; type a literal query, Up/Down for previous/next, Enter to keep the result in view, Esc to restore the old position |
| Scroll | PageUp/PageDown or mouse wheel |
| Follow latest | Ctrl+End or click the new-activity hint |
| Recover stale terminal cells | Ctrl+L; preserves the draft and scroll position |
| Cancel | Esc or Ctrl+C during a turn when no text is selected |
| Quit | `/quit`, Ctrl+C while idle with no selection, or Ctrl+D with empty input |

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
still need to settle. Completed output and tool results remain visible; “Ready”
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
The model picker lists usable routes first. ChatGPT subscription and OpenAI API
key are separate choices even when they advertise the same model ID. The footer
shows the active route. API-key and endpoint labels mean credentials are
configured; they do not mean the remote service accepted them. Subscription
model rows appear only after account catalog discovery. An unknown OpenAI API
model ID can be typed with fallback budgets, while an unknown subscription ID
cannot be sent. A missing credential row opens its connection action, then
returns to the same search and highlight after a successful save. Connection
cancellation leaves the model unchanged. An empty, offline, or failed ChatGPT
catalog shows a retry action; it never substitutes API-key billing for a
subscription choice. Explicit CLI and configuration preferences remain visible
until the user selects a different route. Successful picker choices apply to the
current session and are remembered for later interactive launches in the same
canonical workspace, below explicit CLI and configuration preferences.
Headless launches do not automatically consume this memory.

Prompt recall excludes slash commands. API keys and pasted browser callbacks
use separate masked entries that intercept keyboard and paste events; neither
enters the ordinary draft, prompt recall or conversation. Device approval codes
appear only while the approval panel is open.

Successful tools show a compact target/status summary. Running tools show a short
tail; errors and cancellations retain a bounded preview even when collapsed.
Expansion reveals the controller's bounded output, including edit hunks with both
signs and colors. It does not remove the existing output limits. Markdown blocks
use the local parser and native terminal widgets; fenced code is presented in a
distinct surface and color without downloading syntax parsers.

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

## Offline preview and checks

From a development checkout:

```sh
bun tests/fixtures/tui-demo.ts
# Long streamed Markdown for mouse/PageUp/PageDown and resize checks:
bun tests/fixtures/tui-demo.ts --scroll
```

Type a task to run the scripted read/edit/check demonstration. A second task waits
for cancellation so Esc can be checked. Everything runs in a temporary workspace
and home directory, removed on exit. No model API or stored credentials are used.

```sh
bun test tests/tui-view.test.ts
bun test tests/tui-activity.test.ts
bun run typecheck
```

The route, connection, catalog, profile, keyboard, paste, and resize checks in
this repository use isolated credentials and scripted or protocol fixtures.
They verify the local interaction and request path. They do not establish live
OAuth approval, remote account entitlement, or success in a human terminal;
those checks remain for the installed-journey gate.

Renderer tests exercise real keyboard/paste events, Markdown, output disclosure,
draft preservation, scroll anchoring, theme changes, Unicode, and resizing. Tests
assert behavior and a few stable layout landmarks, not snapshots of every cell.


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

The preference journeys are covered by real renderer keyboard, paste, resize and
isolated persisted-state fixtures in `tests/tui-view.test.ts`: scoped save/reset,
restart, CLI shadowing, file/memory conflicts, malformed files, unavailable models,
staging cancellation, secret exclusion and draft/cursor restoration. Live provider,
OAuth and human-terminal preference checks have not been run; they remain for the
installed-journey gate.

## Discover commands and skills

Type `/` to browse built-ins, active extension commands, and user-invokable
project/global skills, including user-only skills. Rows identify their source;
`!` marks a collision or unavailable action. Rename conflicting skills or
extensions before invoking either meaning of the name. Metadata refreshes when
browsing reopens, and submission rechecks collisions. Removing or disabling a
highlighted choice clears its selection: press an arrow before completing again.

Use Up/Down to select, Tab to insert, and Escape to dismiss. Completion never
executes an action. `/thinking ` suggests only validated current model levels
(and `reset`); subscription levels require advertised account metadata.
`/theme ` offers appearance choices; `/login ` and `/logout ` offer public
connection names, never keys or callback payloads. Enter explicitly submits;
rejected or busy commands remain in the editor for correction.

**Alt+H** opens searchable ephemeral help while retaining your task and cursor;
`/help` opens the same surface. Search names, descriptions, or sources. Escape
restores the task and viewport. Tab previews the selected command within help,
so Escape still restores the task. Enter transfers that preview to the composer;
press Enter again to submit it. Help does not append repeated command lists to the transcript.
Skill browsing reads bounded frontmatter; full body validation happens on invocation.

Automated coverage uses isolated credentials, controller/dispatcher fixtures,
actual renderer keyboard/paste/resize at 44×18, and fresh-process metadata/SDK
loading checks. Human terminal use, real OAuth, and live provider journeys were
not run for this slice and remain part of the installed-journey gate.

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

Implemented behavior is verified by isolated scripted controller/loop tests for
pressure, overflow, manual summary, incomplete streams, cancellation, persistence
failure, unknown usage, capacity changes, branch isolation and disk resume. A
real JSONL fault fixture verifies that restoring storage still leaves the old
handle fenced, and the actual `/resume` dispatcher reloads it before compaction
can succeed without losing original records.
Renderer keyboard/paste/resize fixtures invoke `/context`, retain a future draft
during real tool execution at 44×18, and keep the composer usable at 24×8.
These fixtures do not establish live-provider, OAuth, or human-terminal success;
those checks remain unrun for the installed-journey gate.

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

Verified with isolated scripted-model dispatcher and renderer tests: 106 sessions,
search/paging, workspace roots/subdirectories/symlinks, branch and attachment
resume, interrupted/legacy/corrupt/deleted files, keyboard/paste/resize and cancel, cross-workspace draft/viewport round trips,
late resume cancellation, bounded previews and auth-command exclusion. Draft
preservation here is in memory; this picker does not add persistent per-session
draft recovery. Human
terminal and live-provider journeys remain unrun; fixtures do not certify them.
