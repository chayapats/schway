# 10: Run coding conversations against OpenAI-compatible endpoints

## What to build

A developer points Schway at a custom OpenAI-compatible endpoint, including an unauthenticated local service, and completes a streamed tool-using conversation. Scope: specification sections 14–16, 63, 66, 73, 79, 83, 89.

## Acceptance criteria

- [ ] A Schway-owned fetch/SSE adapter supports a custom base URL, custom headers, extra request-body parameters, and required, optional, or absent authentication.
- [ ] Provider/model/connection options are selectable through the headless entry point. Unknown model IDs work without catalog registration.
- [ ] Native messages, tool definitions, and results convert to compatible requests; chunked streamed text and tool calls convert back into the shared native conversation/event representation.
- [ ] AbortSignal cancels requests and stream consumption; malformed or truncated SSE, endpoint errors, and authentication failures produce actionable errors without revealing credentials.
- [ ] The adapter performs no hidden retry loop; transport failures can be handled by Schway's shared policy.
- [ ] Fixture/local-server tests exercise split SSE frames, streamed tool arguments, completion, errors, cancellation, custom request options, and each auth mode through a real-loop headless conversation. Normal CI requires no external service.
- [ ] Named provider profiles and subscription authentication are deferred beyond v0.1.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
