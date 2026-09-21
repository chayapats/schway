# 05: Locate code with bounded grep, find, and ls tools

## What to build

An agent can inspect a directory, discover files by pattern, search their contents, and read the matching implementation to answer a repository question. Scope: specification sections 23–25, 29, 33, 82.

## Acceptance criteria

- [ ] `grep` supports a pattern, search path, optional glob, case-insensitive matching, and a maximum result count, returning file and location information usable with `read`.
- [ ] `find` offers simplified file-pattern discovery; `ls` offers bounded shallow directory inspection with explicit depth rather than an unbounded recursive dump.
- [ ] All three tools obey workspace path semantics, declare parallel-safe execution, bound model-facing output, and clearly indicate truncation or how to narrow a query.
- [ ] Use an efficient search backend where practical. A clean installation either supplies its required backend or reports actionable setup guidance instead of silently returning incomplete results.
- [ ] Empty matches are ordinary results; malformed patterns and inaccessible paths are useful tool errors.
- [ ] A scripted-model scenario traverses ls/find/grep/read through the real loop. Temporary repositories cover glob filters, case handling, result limits, depth limits, empty results, and paths with spaces.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
