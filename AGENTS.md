# Schway

- Runtime is Bun and TypeScript. Use `bun test` and `bun run typecheck`.
- Schway owns the agent loop. Provider SDKs are protocol clients only.
- Core modules must not import the TUI or provider wire types as the canonical conversation model.
- Headless execution must not load the TUI.
- Only the selected provider should load.
- Disable SDK automatic retries. Schway will own retry policy.
- Deterministic tests must not require paid model APIs. Use a scripted model and protocol fixtures.
- Tool-relative paths resolve from the primary workspace root (nearest Git root, otherwise launch cwd), canonicalized through real paths.
