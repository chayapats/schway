# 09: Run coding conversations with the native OpenAI provider

## What to build

A developer selects OpenAI with an API key and uses the same headless coding loop and tools, without introducing OpenAI-specific conversation types into core code. Scope: specification sections 9, 14–16, 63, 66, 73, 79, 83, 89.

## Acceptance criteria

- [ ] The official OpenAI TypeScript SDK translates Schway-native requests into provider requests and streamed text, supported thinking, tool calls, completion, and errors into normalized events.
- [ ] Tool arguments are assembled across stream chunks and tool-result identifiers remain associated correctly across multiple rounds.
- [ ] Opaque provider metadata needed for subsequent requests survives native conversation round trips without leaking provider dependencies into session, tool, or agent modules.
- [ ] API-key resolution is deterministic, missing credentials fail headlessly, the shared AbortSignal reaches provider operations, and SDK automatic retries are disabled.
- [ ] Selecting OpenAI loads its adapter only when needed; a user-supplied model ID is not rejected solely because it is absent from a catalog.
- [ ] Recorded/protocol fixtures cover both request and response conversion, interleaved/chunked tool calls, errors, cancellation, and metadata. A deterministic headless scenario completes a read-tool conversation through the real loop without a paid API.
- [ ] Codex/ChatGPT subscription authentication is excluded from this v0.1 ticket.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
