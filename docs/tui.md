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
| Model and route picker | `/model` or Alt+M; Up/Down, Enter to apply or connect, Ctrl+R to retry a failed account catalog, Esc to cancel |
| Sign-in chooser | `/login`; Up/Down, Enter, Esc |
| Tool details | Ctrl+O toggles all; click a heading to toggle one |
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

After an accepted prompt clears, you can type or paste a future draft during the
current turn. Enter does not queue it while work is active; the draft stays in the
editor until you send it after settlement. Pressing Esc or Ctrl+C shows
“Cancel requested” immediately, then “Stopping” while active work settles.
Running tools and other owned work may
still need to settle. Completed output and tool results remain visible; “Ready”
returns only after settlement, and cancellation does not undo completed effects.

Enter releases a prompt only after its user record is saved. Missing credentials,
busy operations, rejected commands, and session write failures keep the text and
cursor in the editor so you can repair the cause and press Enter again. A model
failure after the saved user record is a failed turn in the conversation; it does
not restore the prompt as a new draft. Prompt recall records accepted ordinary
prompts only. Long commands release the editor when their preparation succeeds
and execution starts; their later completion leaves any newer draft intact.

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
until the user selects a different route. Picker choices apply to the current
session; cross-launch workspace preference persistence is a separate slice.

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
