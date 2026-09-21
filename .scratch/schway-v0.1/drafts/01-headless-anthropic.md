# 01: Stream a headless conversation through Schway's own agent loop

## What to build

A developer can install the single Schway package, provide an Anthropic API key, and send a headless prompt that streams a response. This is the first runnable vertical slice, including the Bun/TypeScript setup, native conversation representation, context preparation, provider adapter, and CLI output. Scope: specification sections 5–11, 14–15, 32–33, 63, 65, 71, 73, 79–80, 89, 94.

## Acceptance criteria

- [ ] The npm-compatible package exposes the `schway` command, uses Bun and TypeScript, commits its lockfile, and provides working development and deterministic test commands.
- [ ] `schway -p` streams text from the official Anthropic TypeScript SDK through a Schway-owned agent loop; normal completion ends the process successfully and provider failures produce actionable errors.
- [ ] `--json` streams normalized runtime events as JSONL with diagnostics kept off stdout; it does not expose provider wire types as the core contract.
- [ ] User, assistant, text, thinking, and tool-call content use Schway-native types; opaque provider metadata survives where needed without being interpreted by core modules.
- [ ] A small stable system prompt is assembled separately from changing environment context. The workspace is the nearest Git root or launch directory, canonicalized through real paths, with launch directory retained.
- [ ] Explicit runtime credentials take precedence over environment credentials. Missing credentials cause a non-zero exit without interactive login, secrets are not printed, and automatic project dotenv loading is disabled.
- [ ] Only the selected provider loads; headless execution has no TUI dependency on its startup path. SDK automatic retries are disabled so a later shared retry policy can own retries.
- [ ] A scripted model exercises the real loop and CLI without network access; protocol fixtures verify Anthropic request conversion and chunked text/metadata conversion. Cover non-Git workspaces, launch from a Git subdirectory, missing credentials, and stream failure.

## Blocked by

None (can start immediately).
