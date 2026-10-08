# Screen catalog

The catalog captures the real TUI as terminal text and cell styles, using scripted models and isolated credentials. It records today's layout, including known rendering faults (such as the table blanking tracked in #146). It makes no network requests and requires no model API credentials.

Run `bun test tests/screen-catalog.test.ts` to compare every screen against committed goldens. Plain `bun test` includes this runner. To focus on one screen, use `bun test tests/screen-catalog.test.ts -t "screen first-run"`.

## Add or update a screen

1. Edit the ordered `SCREENS` list in `tests/screen-catalog/screens.ts`. Supply a sentence-case title, one-sentence description, input-driven `drive` function and controller-state `ready` predicate. Update the explicit screen-order assertion in the runner when adding an ID.
2. Add scripted dependencies in `harness.ts` when needed. Each variant gets a fresh renderer at its final dimensions. Prefer mock keyboard input and typed slash commands, such as Alt+S, `/sessions`, `/resume <id>`, `/branch tree` and `/login`. Call a public controller method only for a state with no keyboard route, and say so in a comment.
3. Run `bun run screens:update`. This writes the goldens and ordered index, and prunes obsolete files/directories. Normal test runs never update them.
4. Review and commit the implementation and goldens together.

## Command routing and isolated files

The harness submits typed input through the production `dispatchEditorInput` and `handleSlashCommand`, so every built-in command and every skill invocation (from the command's raw text) runs its real handler. Each screen builds one command context from its own home and workspace root: the live context manager as skill scope, `sessionsDirectory(home)`, settings from a `ConfigEditor` scoped to that home and workspace, an empty environment, the harness's redaction secrets, a no-op quit and a discarding stderr. It never creates models or passes runtime API keys. The runner's fetch guard rejects network access, credentials live in a fake store, and no route opens a browser.

Screens without a temporary home use the placeholder paths `/home/test` and `/project`. A screen or test that runs a command which reads or writes session, skill, config or credential files (`/sessions`, `/resume`, `/new`, `/delete-session`, `/skills`, `/config`, `/login` and `/logout`) must be in the harness's temporary-home set (`disk` in `buildScreen`). Fixture sessions use fixed, non-UUID session, entry and branch IDs, and every `committedAt` is the catalog time, so goldens contain no random IDs or wall-clock timestamps.

## Panel coverage

`src/tui/view.ts` exports `PANEL_MODES`, the closed list of panels the view can show in place of the conversation body, and its `PanelMode` type. A panel string outside the list fails `bun run typecheck`. At capture the runner records each screen's `panelMode()` and the named sub-states in `CATALOG_SUB_STATES` (`harness.ts`): approval with reason entry, approval with an overflowing diff, and the branch tree on an existing branch and after Tab switches to a new fork. The coverage test fails and names each mode or sub-state that no screen shows. A focused run renders the screens it skipped once, so the gate always checks the whole catalog. A new panel needs its `PANEL_MODES` entry and a screen that reaches it.

## Screen invariants

The runner checks four invariants on every screen in `SCREENS` and every variant from `variantsFor`, next to the per-screen assertions. `tests/helpers/screen-invariants.ts` holds the pure checker. At capture the harness records a frame state from the controller snapshot and the view: the panel mode, the pending approval's selected choice and whether a deny reason is being typed, whether the turn is idle, whether F2 details for a failed turn are open and the cause they show, and the focused typing surface with its value, cursor offset and input cell. The checker classifies each frame from that record, not from its screen ID, so a new screen is checked without changes to the checker. A failure names the screen, variant, invariant and offending row.

- **I1 Approval choices.** In the `tool-approval` panel without reason entry, a row outside the composer starts with `› ` and the selected choice label, and some row names `Esc deny`. The composer's own `▌ ›` does not count. A deferred approval behind the reader or inspection is not an approval frame.
- **I2 Recovery cause first.** In F2 details for a failed turn, the first content row after the outcome heading (`✗ Failed`) starts the failure cause. At 20 rows or more the whole cause shows without scrolling; shorter frames show at least its start.
- **I3 No stop action when idle.** When status is not running, no activity shows, readiness is not loading and no sign-in is pending, no row offers `Esc stop` in any verb form, transcript rows included.
- **I4 Visible cursor in a focused input.** When a typing surface has focus (the composer; the find, palette, model, session and branch queries; approval reason entry; endpoint URL, API-key and callback entry), the `cursor` header is visible, on that surface's input row, at the cell of its logical cursor. An empty field puts it on the placeholder's first cell; a masked value puts it after the last mask cell. Cells are measured with `Bun.stringWidth`, so Thai and emoji values map correctly. Review, history, undo, the reader, inspection, sign-in approval and the approval choices have no text field and are exempt.

`tests/screen-invariants.test.ts` gives each invariant passing and failing synthetic frames. To exempt a frame that is correct as shown, add `{ screen, variant?, invariant, reason }` to `SCREEN_INVARIANT_EXEMPTIONS` in the checker module; omit `variant` to cover every variant of the screen. An entry that covers no failure fails the runner, and no entry may cover a frame in `INVARIANT_EVIDENCE_FRAMES`.

## Key chip liveness

Every advertised key chip must act in both key encodings. `tests/hint-liveness.test.ts` runs in the default `bun test`, makes no network requests and uses the scripted model. It probes one variant per screen in `SCREENS`: `dark-80`, or the screen's first variant when it has none (`nocolor-dark-120` for `no-color`). Each state is built with `buildScreen` the way the app runs: Ctrl+C reaches the view (`exitOnCtrlC: false`, no exit signals) and preference screens get an offline settings stub. The test runs every chip under kitty and legacy encoding.

- **What counts as a chip.** A chip is a bold run whose whole text is one `HINT_KEY` token, on a background that differs from the next cell, as `keyHintChunks` paints it on any row: the hint row, status bar, outcome strip, readiness card, transcript error rows and panel hint lines. Every key-led ` · ` segment of the hint row is also a chip. A key followed by ` or ` or a column gap only documents itself, as palette result rows do, and is not a chip. `tests/screen-catalog/chip-inventory.txt` lists each screen's chips. A changed list fails, so a screen whose chips disappear fails visibly. After an intended change, run `SCHWAY_UPDATE_SCREENS=1 bun test tests/hint-liveness.test.ts`.
- **How a chip is pressed.** `chipPresses` in `tests/helpers/chip-liveness.ts` maps each key token to the bytes a terminal sends in each encoding. Unknown chip text fails and names the screen and chip. A two-way chip (`↑↓`, `←→`, `PgUp/PgDn`) acts if either direction acts, and each direction starts from a fresh state. Each press starts from a fresh `buildScreen`, `drive` and `ready`; a state is reused only after a press that changed nothing. Under legacy, a key that sends the same bytes as another key fails as not distinguishable, even if the press changes something: `Ctrl+I` is Tab, `Ctrl+M` is Enter, `Ctrl+H` is Backspace and `Ctrl+[` is Esc.
- **What counts as acting.** After the press, at least one of these changes: the controller snapshot, the char frame, the style spans, the editor text or cursor, an OSC 52 clipboard write, an `openUrl` call or a call to the view's `submit` callback. A change that only shows a failure notice (`Unknown command`, `Nothing to …`, `No … to show`, `Wait for this turn`) does not count. A `send` chip types a Thai and emoji draft into an empty composer first, and acts only if the draft is dispatched, a turn starts or a local command accepts it. A `reload` chip acts only if it requests a reload.

`CHIP_ALLOWLIST` in the test accepts a chip that does not act, as `{ screen, chip, encoding?, reason, note, issue? }`. Prefer a stronger precondition to a new entry. The reasons are:

- `single-item`: the list has one item. The note names, in backticks, a catalog screen (optionally `screen/variant`) where the same chip acts, or a `tests/*.test.ts` file and quoted test name. The test checks that the place exists and that the chip acts there.
- `content-fits`: the content already fits, or the key repeats a state the screen already shows. The note names a proof, as for `single-item`.
- `notice-by-design`: the notice is the intended answer, such as `Alt+I inspect` with nothing to inspect (#275).
- `encoding-limit`: legacy cannot send the key distinctly (`encoding: "legacy"`). This is allowed only when another chip on the same screen reaches the same action in legacy, for example `F2` for `Ctrl+I`.
- `known-defect`: the chip is wrong today. `issue` names the open issue that fixes it, and that fix removes the entry.

An entry whose chip no longer appears, or now acts, fails until it is deleted. An entry without `encoding` that acts in one encoding must name the other.

## Variants

Every screen has dark/light variants at 120, 80 and 50 columns, normally 30 rows. `noColor: true` adds `nocolor-dark-80`; `noColorWidths: true` covers all three widths without color. The no-color screen uses no-color variants throughout. Narrow layout also has 40-column, 20-row variants. Stopped streaming, stopped tool and failed turn scenes include 40-column, 20-row variants in both themes and without color, so normal stops remain distinct from provider failures. Each reachable recovery category has a screen reached through the runtime path users hit: `recovery-auth` (401), `recovery-credential-store` (a secure-store read error), `recovery-model` (404 `model_not_found`), `recovery-offline` and `recovery-rate-limit` (a network failure or 429 that outlasts its retries), `recovery-session-write` (a refused session write) and `failed-turn` for the generic provider failure. `startup-auth`, `startup-credential-store`, `startup-model` and `startup-provider` reopen a saved conversation whose model fails to load, using the fake credential store. These screens cover all three widths without color and add the failed turn's 40-column, 20-row variants; the runner checks that each frame keeps its status, a forward action and `Esc keep editing`, and `tests/tui-recovery-catalog.test.ts` fails when a category has no screen. `model-picker-loading`, `model-picker-offline`, `model-picker-failed` and `model-picker-partial` record discovery while gated, offline, failed and with one route list missing. `compaction-completed`, `compaction-cancelled`, `compaction-failed` and `compaction-noop` record each manual `/compact` outcome through scripted summaries, with Esc pressed during the scripted wait for the cancelled one, and `compaction-in-turn` records automatic compaction while its turn still runs. `retry-rate-limit` records a scripted 429 with `Retry-After` next to the 503 `retry-countdown`. Command and help palette screens add 40-column variants in both themes and without color, where narrow hint rows must keep their Esc exit. The session picker and branch-tree screens add 40-column, 20-row variants in both themes and without color, so the 40/50-column Esc invariant in `tests/journeys-241.test.ts` covers them. `approval-command`, `approval-edit` and `approval-diff-overflow` add 40- and 50-column, 8-row variants in both themes and without color, and `approval-deny-reason` adds the 40-column, 8-row variant; the runner checks that every approval frame marks the selected choice with `›`, names its Enter verb and `Esc deny`, and shows Ctrl+C only in the activity row. The sign-in wait screens (`subscription-sign-in`, `chatgpt-device-approval`, `grok-browser-approval`, `grok-device-approval`), `sign-in-browser-not-opened` and `sign-in-timeout` add 40-column variants in both themes and 40- and 80-column variants without color; the wait screens also add a dark 40-column, 8-row variant where the compact status bar replaces the hint row. `tests/sign-in-wait.test.ts` checks that every wait frame names Esc once, as `Esc cancel sign-in` in the hint row or `Esc cancel` in the compact status bar, and that device steps list the address before the code. Masked credential and callback screens type only part of a fixture value; a runner test scans every golden for the fixture values and for distinctive prefixes and suffixes of the typed text, and requires each masked row to be exactly one bullet per typed character.

## Golden format

Each UTF-8 `.golden` uses LF endings, a final newline and no tabs. Headers appear in this order:

```text
schway-screen 1
screen <id>
title <sentence-case title>
description <one sentence>
variant <theme>-<columns>
size <columns>x<rows>
cursor <x> <y> <visible|hidden>
== text
```

Cursor coordinates retain OpenTUI’s one-based terminal positions; style rows and columns are zero-based. No-color variant IDs have a `nocolor-` prefix. The text section has exactly the declared row count, with trailing spaces removed and leading spaces preserved. `== styles` follows it, then one line for each merged style run:

```text
00 0-4 #e6eaf0 #0e1117 b
```

Rows are zero-padded to two digits, or three above 99 rows. Column ranges are half-open terminal cell positions from captured span widths; Thai combining marks and wide characters do not use JavaScript string lengths. Adjacent equal styles merge. Colors are lowercase `#rrggbb`, `#rrggbbaa` when alpha is not opaque, `default`, or `idx<slot>`. Attribute letters appear in the order `bdiukrhs`: bold, dim, italic, underline, blink, inverse, hidden and strikethrough. `-` means none; hyperlink IDs are masked away.

The parser rejects unknown versions and incorrect row counts. `index.txt` is the authoritative gallery order. Files outside the declared inventory fail normal tests.

## Review the gallery and PR diff

Run `bun run screens:gallery`, then open the printed absolute path in a browser. The output is `.scratch/screen-gallery/index.html`; use `bun run screens:gallery --out <file>` for another destination. The gallery reads only the index and goldens, works offline from `file://`, and displays themes side by side, widths in order, no-color variants last, and a visible cursor outline.

In a pull request, inspect the text-section diff for content/layout changes and style runs for unintended color, attribute or column changes. Open the gallery to compare every affected width and both themes. Golden changes should correspond to the intended UI change; investigate unexpected updates before committing. Failure messages name the file and show at most 60 changed lines.

Include that golden comparison, text/style diff inspection and gallery review evidence in the PR. The PR review and merge loop in `AGENTS.md` applies to every implementation PR.

## Determinism

The harness freezes wall time at `2026-01-15T09:30:00.000Z`, injects fixed animation and activity clocks, disables decorative motion, gates long-running operations until disposal, and isolates theme input from the host environment. Git fixtures use a fixed author, date and `main` branch in a temporary `~/demo` workspace. The complete catalog run ignores global and system Git configuration, including diff prefixes. The review recipe renders its loading panel before awaiting Git, keeping the renderer’s existing scrollbar layout independent of subprocess timing. A fetch guard rejects network access for the entire catalog run.

Future bash-duration (#144) and turn-elapsed (#145) displays must use injectable clocks so catalog goldens remain deterministic. The catalog intentionally records current rendering behavior; rendering fixes should update their affected goldens.
