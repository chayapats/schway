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

- User-visible TUI changes must update screen-catalog goldens with `bun run screens:update` and commit them; see `docs/screen-catalog.md`.

## Agent skills

### Issue tracker

GitHub Issues for `chayapats/schway`, via `gh`. See `docs/agents/issue-tracker.md`.

### Issue implementation ownership

Before implementing or taking over a tracked issue, read `docs/agents/parallel-implementation.md`. Use an owned issue worktree and atomic claim; a shared GitHub assignee or `ready-for-agent` label is not ownership.

### Triage labels

Default roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
