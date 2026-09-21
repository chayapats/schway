# 03: Create files and apply exact atomic edits

## What to build

An agent can create a file or make targeted changes to an existing file and then read back the result. Failed targeted edits leave the original file untouched and return enough information for the model to correct its next attempt. Scope: specification sections 20–21, 26, 29, 33, 82.

## Acceptance criteria

- [ ] `write` creates a nonexistent file or fully replaces an existing file. Core does not enforce read-before-write; tool guidance recommends `edit` for targeted changes.
- [ ] `edit` accepts multiple exact replacements, each with exactly one match against the original file. Missing, duplicate, or overlapping matches reject the entire operation without partial changes.
- [ ] Successful edits preserve original line endings and BOM; multiple replacements are computed against the original content, including when an earlier replacement would otherwise alter a later match.
- [ ] Both tools use workspace-root-relative or absolute paths and declare exclusive execution. OS/filesystem errors produce bounded tool results.
- [ ] Edit results include structured diff details for presentation without requiring the full diff in model context. Fuzzy replacement and an apply-patch built-in are excluded.
- [ ] Scripted-model tests exercise create/read-back and edit/read-back through the real loop. Temporary-filesystem tests cover unique/duplicate/missing matches, multiple edits, atomic failure, overlaps, CRLF, and BOM preservation.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
