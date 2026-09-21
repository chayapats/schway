# 16: Verify the installable v0.1 coding workflow

## What to build

A developer can install the packaged v0.1 build and use its documented interactive or headless workflow to locate code, edit it, run tests, and resume work. Verify the integrated milestone with observable filesystem and test outcomes, including a focused Schway-development dogfood check. This is a release-readiness ticket, not authorization to publish a package. Scope: specification sections 5, 7, 18, 80–84, 89, 94, 96.

## Acceptance criteria

- [ ] A clean temporary installation of the packaged single npm-compatible artifact exposes a working Schway executable with all seven core tools, the three provider families, and interactive/headless entry points.
- [ ] Setup and usage documentation covers Bun prerequisites, API-key setup, provider selection, basic config, workspace paths, tool output limits, save/resume, compaction, and cancellation for v0.1.
- [ ] A deterministic end-to-end coding task uses search/read, write/edit, bash, parallel reads with exclusive barriers, project instructions, session save/resume, and compaction; success is checked from actual files and command exit results.
- [ ] Protocol fixtures verify the shared coding workflow across Anthropic, native OpenAI, and OpenAI-compatible adapters. CI runs the appropriate type checks and deterministic tests without paid APIs or stored user credentials.
- [ ] Exercise the installed headless text/JSON modes and interactive controller, verify orderly cancellation/retry recovery, and confirm runtime JSONL is distinct from durable session JSONL.
- [ ] Run a focused opt-in manual dogfood task against Schway itself with available credentials, recording observable changes and test results rather than only the model's success claim. If credentials are unavailable, report this release check as pending; do not claim it passed.
- [ ] Check the v0.1 required list against the delivered behavior. Skills/extensions, branching features, subscription login, secure credential storage, doctor/debug tooling, server/MCP/subagents, and the later coding-eval/live-provider suites are not added to this milestone.
- [ ] Preparing and validating the release artifact does not publish it to a registry or create an external release automatically.

## Blocked by

- 05: Locate code with bounded grep, find, and ls tools.
- 06: Execute parallel-safe tools around exclusive barriers.
- 08: Apply project instructions with scoped dynamic context.
- 15: Inspect edits and control models and compaction in the TUI.
