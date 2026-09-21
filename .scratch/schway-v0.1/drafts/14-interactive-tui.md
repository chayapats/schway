# 14: Use Schway interactively through OpenTUI

## What to build

Running Schway without a headless prompt opens an interactive terminal conversation where a developer enters successive prompts, watches streaming responses and tool activity, cancels a turn, and resumes saved work. Scope: specification sections 69–73, 79, 84, 89.

## Acceptance criteria

- [ ] Use OpenTUI core directly without React or Solid. The TUI consumes the same runtime events and agent/session interfaces as headless mode; core modules never import the renderer.
- [ ] Provide an input editor, streaming Markdown/text, tool-call running/completed/error state, bounded tool results, current model/session information, and clear running/idle/error status.
- [ ] Cancellation stops the active turn through the shared cancellation path and returns control to the input editor; quitting restores the terminal and releases resources.
- [ ] Support new-session, list-sessions, resume, help, and quit interactions sufficient to start and continue work. Resume shows reconstructed conversation history without replaying old tool effects.
- [ ] Missing credentials and runtime failures appear as actionable UI errors; the UI does not introduce an interactive subscription login flow.
- [ ] TUI initialization is lazy and absent from headless execution.
- [ ] Controller/state tests using the real loop and scripted model cover successive prompts, streamed tool output, errors, cancellation, new/resumed sessions, and terminal cleanup; include a focused manual terminal smoke check instead of per-cell snapshots.

## Blocked by

- 12: Cancel and retry runs without corrupting session state.
