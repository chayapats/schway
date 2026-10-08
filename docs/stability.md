# Stability policy

These are Schway’s compatibility promises for 1.0 and later releases.

## Session JSONL

Session migration is forward only. Every release reads every earlier session
format, including formats 1–3 written by unpublished 0.1–0.3 builds. A migration
appends records, such as `session_format`; it never rewrites or deletes earlier
lines. Older releases are not required to read files upgraded by a newer release.

The same forward compatibility promise covers the undo pre-image store format:
every release reads pre-images written by any earlier release. Retention settings
may remove expired pre-images; compatibility does not disable retention.

The optional turn history sidecar (`~/.schway/history`) evolves the same way:
forward-only and append-only. Releases read every earlier sidecar version and
never rewrite saved history lines; a session without a sidecar stays readable.

Published-version fixtures enforce ordinary discovery and resume, selected-branch
history, compaction summaries, undo notes and append-only persistence. Synthetic
legacy tests continue to cover the unpublished formats.

## Config

A deprecated key keeps working and warns until the next major version, when it
may be removed. Warnings appear as a TUI notice, on headless stderr (including
with `--json`) and in `doctor`. See [configuration](configuration.md), including
the deprecated-key list and replacement precedence.

## Extension API

Semver applies to the extension API. Only exports of `schway/extensions`, defined
by `src/extensions/index.ts`, are public. `./extensions` is the only key in
`package.json` `exports`. Deep imports such as `schway/src/...` are private and
may change in any release.

Adding a member to an exported union such as `ExtensionEvent` or
`ConversationItem`, or adding a new optional field, is a minor change. Removing
or renaming a member, or making a field required, is a major change.

## Core tool semantics

The core tools are `read`, `write`, `edit`, `bash`, `web_fetch`, `grep`, `find`
and `ls`. Any change to their meaning needs a major version. Semantic changes include:

- Renaming or removing a tool or parameter.
- Changing a parameter’s meaning.
- Changing path resolution: tool-relative paths resolve from the primary workspace
  root (the nearest Git root, otherwise launch cwd), canonicalized through real paths.
- Changing the declared effect: reads only or can change state.
- Changing when a call is an error.
- Editing a core tool’s model-facing description text.
- Changing output bounds, such as the 50,000-byte cap or the `web_fetch`
  deadlines, raw-body cap, 32 KiB output cap and redirect limit.

## Changelog

Every published version has a `CHANGELOG.md` entry. Breaking changes and
deprecations get their own sections, `### Breaking` and `### Deprecations`.
