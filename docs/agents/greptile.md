# Greptile review budget

Greptile reviews this repo for free under its open-source program, with 100 credits a month. Spend them where a review finds bugs.

`greptile.json` turns off automatic reviews (`"skipReview": "AUTOMATIC"` and `"autoReview": []`), so opening a PR or pushing to one spends nothing. It also tells Greptile to ignore Markdown, `docs/`, screen-catalog goldens, images and lockfiles. Greptile reads it from the PR's source branch, so branches made before it landed still use the dashboard settings. If a new PR still gets an automatic review, turn off automatic reviews in the Greptile dashboard too.

## When to request a review

- **Batch issues.** Put several related issues on one branch and one PR. List a `Closes #<issue>` line for each. Ask for one Greptile review when the whole batch is ready, not once per issue.
- **Request it once, on a finished diff.** Finish local tests, `bun run typecheck` and the independent reviews first. Then comment `@greptileai` on the PR. Don't request a review for a draft or a half-done batch.
- **Skip docs-only changes.** Don't request a review for a PR that only changes Markdown, `docs/`, goldens, images or other non-code files.
- **Skip small, low-risk fixes.** Leave typo fixes, copy tweaks and version bumps to the normal review loop.
- **Re-review rarely.** After fixing Greptile's findings, request a second review only if the fixes changed behavior in a way local tests and reviews can't cover. Use a scoped request such as `@greptileai check the retry change in src/…`.

Greptile is one input to the review loop in `AGENTS.md`. Check each finding against the code like any other review finding; a missing Greptile review doesn't block a merge.

## Batching with parallel implementation

The `implement-parallel` coordinator can collect independent issue branches on one batch branch. Integrate them there serially, run the full checks on the batch HEAD, then open one PR for the batch. Keep each issue claim until the batch PR merges.
