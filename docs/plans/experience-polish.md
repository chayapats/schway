# Schway experience polish — approved implementation plan

Status: approved by the user on 2026-09-27, including all 20 slices and all three recommended product decisions. Prepared against commit e3752ab plus the current working tree. Published and verified: 20 open GitHub issues, each labeled ready-for-agent, with 24 native blocking relationships. This is implementation-ready planning, not completed implementation.

## Outcome

Make the complete interactive journey understandable and continuous: start → connect → choose → compose → wait → inspect → recover → finish → leave → return. Preserve the existing architecture and explicit headless/billing contracts. This is a polish initiative over existing capabilities, not a new orchestration framework, permission system, web UI, automatic Git rollback, or queued-prompt feature.

## Current baseline

The audited working-tree improvements were integrated in commit `0b237c1`: callback fixes, auth-ranked account model discovery, draft-restoring panels, anchored scroll, clipboard/links, Markdown/tool disclosure, themes, and narrow/Unicode behavior. Reuse them. Current offline evidence: 999 tests and typecheck passed in the preceding implementation turn; these are not live OAuth or real daily-use proof. Existing release verification remains pending despite its tracker issue being closed. Start implementation from a base containing these improvements; do not replace or rebuild them.

Code audit identifies additional gaps: rejected prompts/commands may clear input before acceptance; provisional streamed text may concatenate across retries; operation state is too generic; saved credential and remembered model choice are different concepts; sessions require opaque IDs; exit/reopen does not recover unsent drafts.

## Approved product decisions

- Remember the last successfully activated interactive model/auth choice per canonical workspace, below explicit user/project/CLI settings; headless ignores this memory.
- Ordinary launch starts a new conversation with an obvious recent-session resume action; it does not automatically reactivate old conversation context.
- Recover ordinary unsent drafts per session in user-local storage; exclude credential entry and sensitive auth commands/callbacks; provide discard. Keep only the latest completed checkpoint and clear it after acceptance, discard, or session deletion.
- Resume preserves the existing rule: resolve current effective settings for the resumed workspace, including approved interactive memory, and show the connection/model before the next send. This initiative does not silently restore an old billing route from conversation history.

The user explicitly approved these decisions and the 20-ticket breakdown, and requested detailed acceptance criteria plus tests in every issue. The finalized bodies contain 161 numbered behavior criteria and 122 concrete test scenarios, each with setup/action and observable pass conditions.

See the [domain glossary](../../CONTEXT.md), [interactive-choice decision](../adr/0001-interactive-choice-memory.md), and [draft-recovery decision](../adr/0002-ordinary-draft-recovery.md). These decisions describe target behavior, not a claim that the feature work has shipped.

## Delivery slices

1. **Complete sign-in, reconnect, and logout without losing the task** — A user can connect or repair an account, see which stage succeeded, and return to the task they were preparing. Blocked by: none.

2. **Choose a usable model and its authentication route in one picker** — The user sees usable choices first, knows which auth/billing route each uses, and can connect a missing route then return to their selection. Blocked by: 1.

3. **Restore the last successful interactive model choice on restart** — Reopening Schway restores the intended interactive connection/model instead of making the user configure it again. Blocked by: 2.

4. **Make first launch lead directly to a usable conversation** — A new or returning user can understand readiness and connect/select a model from the initial screen without knowing command syntax. Blocked by: 3.

5. **Change preferences with visible scope and effective values** — A user can inspect/change/reset supported preferences and understand what survives restart without memorizing flags. Blocked by: 3.

6. **Keep composed input until the requested action is accepted** — A rejected send or command never makes the user reconstruct their input. Blocked by: none.

7. **Discover commands and skills without leaving the task** — Typing a command reveals valid actions, descriptions, and relevant arguments without overwhelming the conversation. Blocked by: 6.

8. **Show meaningful activity, waits, and cancellation progress** — During a long task the user can tell what is happening and whether cancellation has been received. Blocked by: none.

9. **Keep streamed answers coherent across retry and recovery** — A recovered request shows a coherent answer rather than concatenating failed and successful attempts. Blocked by: none.

10. **Recover from failures in place without replaying completed work** — A failure explains what happened, what was retained, and the safe next action while keeping the user's task available. Blocked by: 1, 6, 8, 9.

11. **Inspect and copy individual results with the keyboard** — The user can move to one tool result or code block, inspect it, copy useful raw content, and return to the unchanged draft. Blocked by: none.

12. **Find earlier conversation content without losing reading position** — The user can find a previous answer or tool result in the active conversation and resume reading or composing exactly where intended. Blocked by: none.

13. **Make task completion and changed files easy to review** — After a turn, the user sees a compact trustworthy outcome and can inspect the relevant file changes without digging through every tool call. Blocked by: none.

14. **Explain context usage and compaction while preserving continuity** — The user understands why Schway is compacting, whether it worked, and how the task continues without treating it as a lost conversation. Blocked by: 8.

15. **Find and resume recent work by task and workspace** — Users find the conversation they want without copying session IDs. Blocked by: none.

16. **Return to recent work with an explicit, predictable startup path** — A returning user can begin new work or continue recent work without guessing what context or model was restored. Blocked by: 4, 15.

17. **Explore alternate conversation paths without confusing filesystem state** — Users can understand, preview, name, and select an alternate conversation path without manipulating opaque IDs. Blocked by: none.

18. **Leave and reopen without losing the draft or misreporting interrupted work** — Exit and restart preserve the user-approved amount of unfinished input and clearly distinguish saved conversation from interrupted execution. Blocked by: 6.

19. **Keep appearance and essential controls usable across terminals** — A user can keep a preferred appearance and use essential actions reliably with the keyboard on supported terminal sizes. Blocked by: 5.

20. **Verify and track the complete installed daily-use experience** — A dated installed-artifact report establishes which full user journeys actually work and keeps unfinished verification visible. Blocked by: 7, 10, 11, 12, 13, 14, 16, 17, 18, 19.

## Scheduling and granularity

Prioritize failure/data-loss and account continuity: 01, 02, 03, 04, 06, 08, 09, 10, 15, 16, 18. Inspection, discovery, preference, branch, and appearance improvements can proceed independently where the graph permits. A dependency means a required behavioral contract, not simply shared files; resolve shared-file contention through the existing worktree/ownership workflow. There is no evidence requiring a repository-wide prefactor. Local refactoring belongs inside the first complete slice that needs it.

The final verification ticket depends on terminal slices in the graph; their transitive blockers cover all earlier slices. It stays open until required external evidence is observed. Each implementation ticket must demonstrate its complete user path and adverse state, not merely an internal helper test.

## Publication

Publish the approved slices to chayapats/schway with ready-for-agent, in dependency order, and native blocking relationships. Historical parent issues remain unchanged. The publication is verified against each issue body, label, and native blocking edge; implementation ownership is acquired separately when work actually starts.

## Published issue index

| Slice | GitHub issue | Blocked by |
| --- | --- | --- |
| 01 | [#87: Complete sign-in, reconnect, and logout without losing the task](https://github.com/chayapats/schway/issues/87) | None |
| 02 | [#88: Choose a usable model and its authentication route in one picker](https://github.com/chayapats/schway/issues/88) | [#87](https://github.com/chayapats/schway/issues/87) |
| 03 | [#89: Restore the last successful interactive model choice on restart](https://github.com/chayapats/schway/issues/89) | [#88](https://github.com/chayapats/schway/issues/88) |
| 04 | [#90: Make first launch lead directly to a usable conversation](https://github.com/chayapats/schway/issues/90) | [#89](https://github.com/chayapats/schway/issues/89) |
| 05 | [#91: Change preferences with visible scope and effective values](https://github.com/chayapats/schway/issues/91) | [#89](https://github.com/chayapats/schway/issues/89) |
| 06 | [#92: Keep composed input until the requested action is accepted](https://github.com/chayapats/schway/issues/92) | None |
| 07 | [#93: Discover commands and skills without leaving the task](https://github.com/chayapats/schway/issues/93) | [#92](https://github.com/chayapats/schway/issues/92) |
| 08 | [#94: Show meaningful activity, waits, and cancellation progress](https://github.com/chayapats/schway/issues/94) | None |
| 09 | [#95: Keep streamed answers coherent across retry and recovery](https://github.com/chayapats/schway/issues/95) | None |
| 10 | [#96: Recover from failures in place without replaying completed work](https://github.com/chayapats/schway/issues/96) | [#87](https://github.com/chayapats/schway/issues/87), [#92](https://github.com/chayapats/schway/issues/92), [#94](https://github.com/chayapats/schway/issues/94), [#95](https://github.com/chayapats/schway/issues/95) |
| 11 | [#97: Inspect and copy individual results with the keyboard](https://github.com/chayapats/schway/issues/97) | None |
| 12 | [#98: Find earlier conversation content without losing reading position](https://github.com/chayapats/schway/issues/98) | None |
| 13 | [#99: Make task completion and changed files easy to review](https://github.com/chayapats/schway/issues/99) | None |
| 14 | [#100: Explain context usage and compaction while preserving continuity](https://github.com/chayapats/schway/issues/100) | [#94](https://github.com/chayapats/schway/issues/94) |
| 15 | [#101: Find and resume recent work by task and workspace](https://github.com/chayapats/schway/issues/101) | None |
| 16 | [#102: Return to recent work with an explicit, predictable startup path](https://github.com/chayapats/schway/issues/102) | [#90](https://github.com/chayapats/schway/issues/90), [#101](https://github.com/chayapats/schway/issues/101) |
| 17 | [#103: Explore alternate conversation paths without confusing filesystem state](https://github.com/chayapats/schway/issues/103) | None |
| 18 | [#104: Leave and reopen without losing the draft or misreporting interrupted work](https://github.com/chayapats/schway/issues/104) | [#92](https://github.com/chayapats/schway/issues/92) |
| 19 | [#105: Keep appearance and essential controls usable across terminals](https://github.com/chayapats/schway/issues/105) | [#91](https://github.com/chayapats/schway/issues/91) |
| 20 | [#106: Verify and track the complete installed daily-use experience](https://github.com/chayapats/schway/issues/106) | [#93](https://github.com/chayapats/schway/issues/93), [#96](https://github.com/chayapats/schway/issues/96), [#97](https://github.com/chayapats/schway/issues/97), [#98](https://github.com/chayapats/schway/issues/98), [#99](https://github.com/chayapats/schway/issues/99), [#100](https://github.com/chayapats/schway/issues/100), [#102](https://github.com/chayapats/schway/issues/102), [#103](https://github.com/chayapats/schway/issues/103), [#104](https://github.com/chayapats/schway/issues/104), [#105](https://github.com/chayapats/schway/issues/105) |

Initial frontier: [#87](https://github.com/chayapats/schway/issues/87), [#92](https://github.com/chayapats/schway/issues/92), [#94](https://github.com/chayapats/schway/issues/94), [#95](https://github.com/chayapats/schway/issues/95), [#97](https://github.com/chayapats/schway/issues/97), [#98](https://github.com/chayapats/schway/issues/98), [#99](https://github.com/chayapats/schway/issues/99), [#101](https://github.com/chayapats/schway/issues/101), [#103](https://github.com/chayapats/schway/issues/103).

Verification read back every issue body, title, open state, ready-for-agent label, unassigned state, and native blocker list from GitHub. All matched the approved publication artifacts. No historical issue was modified and no implementation claim was made.
