# Screen catalog

The catalog captures the real TUI as terminal text and cell styles, using scripted models and isolated credentials. It records today's layout, including known rendering faults (such as the table blanking tracked in #146). It makes no network requests and requires no model API credentials.

Run `bun test tests/screen-catalog.test.ts` to compare every screen against committed goldens. Plain `bun test` includes this runner. To focus on one screen, use `bun test tests/screen-catalog.test.ts -t "screen first-run"`.

## Add or update a screen

1. Edit the ordered `SCREENS` list in `tests/screen-catalog/screens.ts`. Supply a sentence-case title, one-sentence description, input-driven `drive` function and controller-state `ready` predicate. Update the explicit screen-order assertion in the runner when adding an ID.
2. Add scripted dependencies in `harness.ts` when needed. Each variant gets a fresh renderer at its final dimensions. Prefer mock keyboard input; use public controller methods for states without a keyboard route.
3. Run `bun run screens:update`. This writes the goldens and ordered index, and prunes obsolete files/directories. Normal test runs never update them.
4. Review and commit the implementation and goldens together.

Every screen has dark/light variants at 120, 80 and 50 columns, normally 30 rows. `noColor: true` adds `nocolor-dark-80`. The no-color screen uses no-color variants throughout. Narrow layout also has 40-column, 20-row variants.

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

## Determinism

The harness freezes wall time at `2026-01-15T09:30:00.000Z`, injects fixed animation and activity clocks, disables decorative motion, gates long-running operations until disposal, and isolates theme input from the host environment. Git fixtures use a fixed author, date and `main` branch in a temporary `~/demo` workspace. The complete catalog run ignores global and system Git configuration, including diff prefixes. The review recipe renders its loading panel before awaiting Git, keeping the renderer’s existing scrollbar layout independent of subprocess timing. A fetch guard rejects network access for the entire catalog run.

Future bash-duration (#144) and turn-elapsed (#145) displays must use injectable clocks so catalog goldens remain deterministic. The catalog intentionally records current rendering behavior; rendering fixes should update their affected goldens.
