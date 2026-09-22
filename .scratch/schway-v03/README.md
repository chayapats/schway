# Schway v0.1 audit and v0.2–v0.3 ticket proposal

Prepared 2026-09-22 against revision `875055e` (package version `0.1.0`).

**Publication status:** All 26 issues have been published to GitHub as #33–#58 with the ready-for-agent label and 33 native blocking edges. The user requested fully self-contained descriptions; each issue embeds current behavior, prerequisite contracts, required decisions, boundaries, verification scenarios and acceptance criteria.

## v0.1 verdict

The required capability set in specification section 89 is implemented, but **v0.1 is not fully verified green**:

- `bun run typecheck`: passed.
- `bun test`: **348 passed, 3 failed, 351 total, 35 files**, 9.54 seconds.
- Focused `bun test tests/cli-process.test.ts`: **5 passed, 3 failed**, reproducing the failures independently.
- The three failures expect missing Anthropic credentials or a missing compatible base URL, but receive a missing compatible-provider API-key error.
- The subprocess test helper strips two credential environment variables but inherits the user's home/configuration. This machine has an existing global compatible-provider configuration with a base URL and required auth; the normal CLI correctly loads it. Defaults in the implementation still select Anthropic. Thus the test fixtures are not isolated from personal configuration. Draft 01 addresses this newly observed defect.
- Several exported functions/types lack the one-line contract TSDoc required by AGENTS.md. Confirmed examples include the canonical conversation types, workspace type/resolver, Git-root resolver, credential types and redaction function. Draft 02 addresses this standards gap; this is not a claim that all documentation has been exhaustively audited.
- Real-provider Schway-development dogfood remains **pending in the recorded evidence** of existing [issue #16](https://github.com/chayapats/schway/issues/16). No new paid/live dogfood was run during this audit. A closed issue is not proof of that check passing.

The 348 passing tests include packaging/install, architecture boundaries, native/compatible protocol fixtures, real-loop coding workflow, tool semantics, cancellation/retries, save/resume and compaction. Passing scripted tests prove harness behavior, not real-model coding quality or an extended human TUI dogfood run.

## Evidence map for section 89

| Requirement | Current evidence |
|---|---|
| Bun/TypeScript and single package | Version 0.1.0, lockfile, installed tarball test, typecheck |
| Schway-owned loop and streaming | Agent-loop tests and normalized streaming adapter fixtures |
| Anthropic/OpenAI/OpenAI-compatible | Three selected-provider adapters and protocol/real-loop fixture suites |
| Seven core tools and bounded output | Temporary-filesystem, search, shell and real-loop coding tests |
| Parallel scheduling | Parallel reads, exclusive barriers, source-order persistence, failure/cancellation tests |
| OpenTUI and headless modes | Renderer-free controller tests, installed CLI help, headless text/JSON and architecture checks |
| Basic config and API keys | Precedence, validation and redaction tests; process-fixture isolation defect noted above |
| Workspace/Git-root and AGENTS.md | Workspace, canonical path and scoped-instruction tests |
| Versioned JSONL save/resume | Persistence, interrupted history, metadata and no-replay tests |
| Compaction | Manual, pressure, overflow and resumed-context tests |
| Cancellation/retries | Shared cancellation, tool settlement and bounded transport retry tests |
| Basic model catalog | Known/unknown models and explicit budget override tests |
| Deterministic tests | Broad coverage exists; full suite currently fails three personal-config-sensitive assertions |

Architectural checks pass for core/provider/TUI separation, selected-provider lazy loading and headless exclusion of OpenTUI. SDK automatic retry disabling is covered by provider fixtures. This is a targeted milestone-readiness audit, not a line-by-line code or security review.

## Deduplication and scope

At audit time GitHub has exactly the existing issues #1–#16, all closed, with no open pull requests. Their completed capabilities are reused, not reopened or recreated.

- Existing model selection, effective-config display, session listing/resume and compaction are foundations, not new tickets.
- Existing parent identifiers and extraRoots metadata are foundations; branch operations and contextual-root management are new behavior.
- Existing runtime events/tool registry are reused; extension registration, observer isolation and intervention hooks are new behavior.
- Drafts 01–02 are new observed gaps, not duplicates of completed feature work.
- The incomplete dogfood check remains referenced to #16; the final milestone verification carries its evidence forward.
- Server, MCP, subagents, permission/sandbox frameworks, automatic Git commits and package-manager development remain outside the requested milestones.

## Published issues

1. **[#33: Isolate CLI process tests from personal configuration](https://github.com/chayapats/schway/issues/33)** — v0.1 follow-up
   - Blocked by: None.

2. **[#34: Document exported function and type contracts](https://github.com/chayapats/schway/issues/34)** — v0.1 follow-up
   - Blocked by: None.

3. **[#35: Discover and invoke project and global Agent Skills](https://github.com/chayapats/schway/issues/35)** — v0.2
   - Blocked by: None.

4. **[#36: Activate skills from model requests with a defined lifecycle](https://github.com/chayapats/schway/issues/36)** — v0.2
   - Blocked by: #35.

5. **[#37: Run tools from explicitly enabled local TypeScript extensions](https://github.com/chayapats/schway/issues/37)** — v0.2
   - Blocked by: None.

6. **[#38: Add extension commands and isolated runtime observers](https://github.com/chayapats/schway/issues/38)** — v0.2
   - Blocked by: #37.

7. **[#39: Contribute prompt context and intercept model requests](https://github.com/chayapats/schway/issues/39)** — v0.2
   - Blocked by: #37.

8. **[#40: Intercept tool execution with validated extension hooks](https://github.com/chayapats/schway/issues/40)** — v0.2
   - Blocked by: #37.

9. **[#41: Load skills and extensions from configured npm manifests](https://github.com/chayapats/schway/issues/41)** — v0.2
   - Blocked by: #35, #37.

10. **[#42: Add contextual workspace roots from CLI and TUI](https://github.com/chayapats/schway/issues/42)** — v0.2
   - Blocked by: #35.

11. **[#43: Fork and resume branches within durable sessions](https://github.com/chayapats/schway/issues/43)** — v0.2
   - Blocked by: None.

12. **[#44: Improve interactive model selection and configuration editing](https://github.com/chayapats/schway/issues/44)** — v0.2
   - Blocked by: None.

13. **[#45: Dogfood the external Matt-style skills package](https://github.com/chayapats/schway/issues/45)** — v0.2
   - Blocked by: #36, #41.

14. **[#46: Store and manage API keys in the OS credential store](https://github.com/chayapats/schway/issues/46)** — v0.3
   - Blocked by: None.

15. **[#47: Select named OpenAI-compatible provider profiles](https://github.com/chayapats/schway/issues/47)** — v0.3
   - Blocked by: None.

16. **[#48: Control provider reasoning from CLI and TUI](https://github.com/chayapats/schway/issues/48)** — v0.3
   - Blocked by: None.

17. **[#49: Prove a Codex subscription integration compatible with Schway's loop](https://github.com/chayapats/schway/issues/49)** — v0.3
   - Blocked by: None.

18. **[#50: Log in with ChatGPT and run the Schway coding loop](https://github.com/chayapats/schway/issues/50)** — v0.3
   - Blocked by: #46, #49.

19. **[#51: Browse and switch conversation branches in the TUI](https://github.com/chayapats/schway/issues/51)** — v0.3
   - Blocked by: #43.

20. **[#52: Inspect Git changes with on-demand and snapshot tracking](https://github.com/chayapats/schway/issues/52)** — v0.3
   - Blocked by: None.

21. **[#53: Write opt-in structured diagnostic logs](https://github.com/chayapats/schway/issues/53)** — v0.3
   - Blocked by: None.

22. **[#54: Diagnose installation and configured capabilities with doctor](https://github.com/chayapats/schway/issues/54)** — v0.3
   - Blocked by: #41, #46, #47, #50.

23. **[#55: Run opt-in live provider smoke tests](https://github.com/chayapats/schway/issues/55)** — v0.3
   - Blocked by: #50.

24. **[#56: Run a graded coding eval and record provider usage](https://github.com/chayapats/schway/issues/56)** — v0.3
   - Blocked by: None.

25. **[#57: Expand coding evals to daily-driver regression scenarios](https://github.com/chayapats/schway/issues/57)** — v0.3
   - Blocked by: #56.

26. **[#58: Verify the installable v0.2–v0.3 daily-driver workflow](https://github.com/chayapats/schway/issues/58)** — v0.3 release gate
   - Blocked by: #33, #34, #38, #39, #40, #42, #44, #45, #48, #51, #52, #53, #54, #55, #57.

## Subscription integration gate

The feasibility task is [#49](https://github.com/chayapats/schway/issues/49); the implementation task is [#50](https://github.com/chayapats/schway/issues/50). Current official authentication/App Server documentation does not, by itself, establish a supported model-only subscription transport for a separate Schway-owned loop. The feasibility task must put its complete verified handoff directly into #50. Until then, #50 explicitly carries a pending entry condition. A wrapper delegating the whole agent loop does not satisfy the specification.

## Scope and evidence

Publication creates planning work only. Product code was not changed and the v0.1 failures were not fixed during ticket authoring. Existing issues #1–#16 were not modified or reopened. The pending historical real dogfood check is described directly in the milestone verification issue rather than duplicated as another implementation ticket.

The publication manifest and per-issue local copies preserve the exact authored requirements. The verification report records read-back checks of issue bodies, labels and native blocking edges. Ordinary implementation work can start on issues without open blockers; prioritize #33 and #34 to clear the observed v0.1 gaps.
