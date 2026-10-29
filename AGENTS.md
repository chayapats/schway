# Schway

- Runtime is Bun and TypeScript. Use `bun test` and `bun run typecheck`.
- Schway owns the agent loop. Provider SDKs are protocol clients only.
- Core modules must not import the TUI or provider wire types as the canonical conversation model.
- Headless execution must not load the TUI.
- Only the selected provider should load.
- Disable SDK automatic retries. Schway will own retry policy.
- Deterministic tests must not require paid model APIs. Use a scripted model and protocol fixtures.
- Tool-relative paths resolve from the primary workspace root (nearest Git root, otherwise launch cwd), canonicalized through real paths.
- Exported functions and types get a one-line TSDoc that states the contract, not the identifier.
- User-visible text (TUI, CLI, errors, `--help`) follows `docs/voice-and-copy.md`; PRs that change it complete that guide’s reviewer checklist.

- User-visible TUI changes must update screen-catalog goldens with `bun run screens:update` and commit them; see `docs/screen-catalog.md`.

## Agent skills

### Issue tracker

GitHub Issues for `chayapats/schway`, via `gh`. See `docs/agents/issue-tracker.md`.

### Issue implementation ownership

Before implementing or taking over a tracked issue, read `docs/agents/parallel-implementation.md`. Use an owned issue worktree and atomic claim; a shared GitHub assignee or `ready-for-agent` label is not ownership.

### PR review and merge

For implementation PRs, complete this loop before merging. In managed-worker mode, the coordinator owns the loop.

1. Review the final diff against its issue before merging. Use independent spec-compliance and correctness reviews, and check each finding against the code before acting on it.
2. Fix every valid finding regardless of severity. Record evidence for findings dismissed as incorrect or already addressed.
3. Rebase onto the current target branch, regenerate affected screen-catalog goldens, and run `bun run typecheck` and the full `bun test` on the final HEAD. Review again any change made after the review.
4. Spend Greptile review credits only as `docs/agents/greptile.md` describes: batch issues into one PR, request one review with `@greptileai`, and skip docs-only PRs.
5. Merge once these conditions hold and existing user/repository authorization permits it. Otherwise preserve the PR and report the remaining blocker.

### Triage labels

Default roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
