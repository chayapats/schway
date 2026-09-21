# Schway v0.1 ticket review

Source: the local Schway design and implementation specification, especially section 89 and architectural invariants in section 94.

Target tracker: https://github.com/chayapats/schway

Status: Published and verified. All 16 approved tickets are open GitHub issues with the ready-for-agent label and 23 native blocking relationships. Issue bodies match the approved drafts, with real issue references substituted for draft blockers.

Each implementation ticket includes deterministic checks; there is no separate horizontal schema/API/testing phase. Ticket 16 validates the integrated installable milestone. No product implementation has been started.

| Issue | Ticket | Blocked by |
| --- | --- | --- |
| #1 | [Stream a headless conversation through Schway's own agent loop](https://github.com/chayapats/schway/issues/1) | None |
| #2 | [Let the agent inspect files and continue from tool results](https://github.com/chayapats/schway/issues/2) | [#1](https://github.com/chayapats/schway/issues/1) |
| #3 | [Create files and apply exact atomic edits](https://github.com/chayapats/schway/issues/3) | [#2](https://github.com/chayapats/schway/issues/2) |
| #4 | [Run shell commands with streaming bounded results](https://github.com/chayapats/schway/issues/4) | [#2](https://github.com/chayapats/schway/issues/2) |
| #5 | [Locate code with bounded grep, find, and ls tools](https://github.com/chayapats/schway/issues/5) | [#2](https://github.com/chayapats/schway/issues/2) |
| #6 | [Execute parallel-safe tools around exclusive barriers](https://github.com/chayapats/schway/issues/6) | [#3](https://github.com/chayapats/schway/issues/3) |
| #7 | [Save and resume conversations from versioned JSONL](https://github.com/chayapats/schway/issues/7) | [#2](https://github.com/chayapats/schway/issues/2) |
| #8 | [Apply project instructions with scoped dynamic context](https://github.com/chayapats/schway/issues/8) | [#2](https://github.com/chayapats/schway/issues/2) |
| #9 | [Run coding conversations with the native OpenAI provider](https://github.com/chayapats/schway/issues/9) | [#2](https://github.com/chayapats/schway/issues/2) |
| #10 | [Run coding conversations against OpenAI-compatible endpoints](https://github.com/chayapats/schway/issues/10) | [#2](https://github.com/chayapats/schway/issues/2) |
| #11 | [Select providers and models with validated basic configuration](https://github.com/chayapats/schway/issues/11) | [#9](https://github.com/chayapats/schway/issues/9), [#10](https://github.com/chayapats/schway/issues/10) |
| #12 | [Cancel and retry runs without corrupting session state](https://github.com/chayapats/schway/issues/12) | [#4](https://github.com/chayapats/schway/issues/4), [#7](https://github.com/chayapats/schway/issues/7) |
| #13 | [Continue long coding sessions with durable compaction](https://github.com/chayapats/schway/issues/13) | [#11](https://github.com/chayapats/schway/issues/11), [#12](https://github.com/chayapats/schway/issues/12) |
| #14 | [Use Schway interactively through OpenTUI](https://github.com/chayapats/schway/issues/14) | [#12](https://github.com/chayapats/schway/issues/12) |
| #15 | [Inspect edits and control models and compaction in the TUI](https://github.com/chayapats/schway/issues/15) | [#3](https://github.com/chayapats/schway/issues/3), [#13](https://github.com/chayapats/schway/issues/13), [#14](https://github.com/chayapats/schway/issues/14) |
| #16 | [Verify the installable v0.1 coding workflow](https://github.com/chayapats/schway/issues/16) | [#5](https://github.com/chayapats/schway/issues/5), [#6](https://github.com/chayapats/schway/issues/6), [#8](https://github.com/chayapats/schway/issues/8), [#15](https://github.com/chayapats/schway/issues/15) |

## v0.1 coverage

| Section 89 requirement | Drafts |
| --- | --- |
| Bun/TypeScript and own agent loop | 01, 02 |
| Anthropic/OpenAI/OpenAI-compatible | 01, 02, 09, 10 |
| Streaming and headless mode | 01, 02, 04 |
| All core tools | 02, 03, 04, 05 |
| Parallel scheduling | 06 |
| OpenTUI | 14, 15 |
| Basic config and API-key authentication | 01, 09, 10, 11 |
| Workspace/Git-root detection | 01, 02 |
| AGENTS.md | 08 |
| Versioned JSONL save/resume | 07 |
| Compaction | 13, 15 |
| Cancellation, retries, bounded outputs | 02–07, 12, 13 |
| Basic model catalog | 11 |
| Deterministic tests | Every implementation ticket; integrated validation in 16 |

## Deferred beyond this ticket set

Agent Skills; extension API, hooks and executable extensions; package installation; additional roots; branch creation and session tree UX; Codex/ChatGPT subscription authentication; secure credential storage; named compatible profiles; richer reasoning controls; Git snapshots; doctor/debug features; full live-provider and coding-eval suites; server, MCP, and subagents.

The session format includes identifiers and parent links from the outset, but v0.1 implements linear save/resume only. Runtime events required by the TUI and headless JSON output are included; an extension-facing event/hook API is deferred.

New global performance budgets and a benchmarking project are not added as v0.1 release gates. The final ticket includes a focused manual dogfood check rather than the later full eval suite.
