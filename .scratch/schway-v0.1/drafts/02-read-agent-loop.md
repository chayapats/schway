# 02: Let the agent inspect files and continue from tool results

## What to build

A headless prompt can cause Schway to read a workspace file, feed the result back to the model, and produce a grounded answer across multiple model/tool rounds. This establishes the working tool-call path used by all later tools. Scope: specification sections 8–9, 18–19, 26–28, 30, 33, 80–83.

## Acceptance criteria

- [ ] The Anthropic adapter assembles streamed tool calls completely before execution; the loop executes calls, appends one matching result per accepted call, and continues until a final answer or explicit turn bound.
- [ ] Built-in definitions expose JSON Schema authored with TypeBox, compile validators once at registration, and validate model arguments before execution. Unsupported schemas fail early with actionable errors.
- [ ] Invalid arguments, unknown tools, and filesystem failures produce model-visible tool errors without losing sibling results or crashing the process.
- [ ] `read` supports relative and absolute paths, offset/limit, line numbers, bounded output, and usable continuation information. Relative paths resolve from the primary workspace root.
- [ ] Tool results separate bounded model-facing content from structured details; runtime events identify tool start, completion, and errors for either presentation mode.
- [ ] Calls declare parallel or exclusive execution. Sequential execution is acceptable until ticket 06; basic AbortSignal propagation prevents new calls after cancellation and yields cancellation results for accepted calls.
- [ ] Real-loop tests with a scripted model and temporary files cover text-only, one tool, multiple calls, several rounds, bounded-loop termination, malformed arguments, missing files, and oversized reads. Anthropic fixtures cover the tool request/result round trip.

## Blocked by

- 01: Stream a headless conversation through Schway's own agent loop.
