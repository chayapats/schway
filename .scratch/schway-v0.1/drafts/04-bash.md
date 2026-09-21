# 04: Run shell commands with streaming bounded results

## What to build

An agent can run a project's tests or other shell commands, observe progress, and use stdout, stderr, and the exit code to decide its next step. Large or long-running commands remain manageable and cancellable. Scope: specification sections 22, 26, 29–30, 33.

## Acceptance criteria

- [ ] `bash` runs each invocation in a fresh shell, defaults to the primary workspace root, accepts an explicit working directory and optional timeout, and declares exclusive execution.
- [ ] Output streams through runtime events while the final model-facing result remains bounded. Complete oversized output is spilled to a temporary file whose location is returned for follow-up inspection.
- [ ] A non-zero command exit is ordinary result data containing stdout, stderr, and exit code; it is not treated as transport failure or automatically rerun.
- [ ] Timeout and cancellation stop the running command and its applicable child processes, release resources, and produce exactly one terminal tool result.
- [ ] Changing directory in a command does not change later tool path resolution or another command's default working directory.
- [ ] Deterministic tests run real temporary shell commands through the agent loop and cover success, failing tests, mixed stdout/stderr, oversized output, timeout, cancellation, and working-directory isolation.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
