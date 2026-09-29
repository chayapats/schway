# Schway

Schway is a coding-agent harness whose users work with models, tools, and durable conversations in a primary workspace.

## Language

**Primary workspace**:
The project identity and default location for a Schway session's work. Attached roots provide additional context without replacing it.
_Avoid_: Current shell directory when referring to the session's workspace.

**Session**:
A durable conversation with its workspace identity and conversation branches. It is distinct from one running Schway process.
_Avoid_: Process, terminal window.

**Conversation branch**:
One selected path through a session's conversation history. It does not represent a Git branch or an earlier filesystem state.
_Avoid_: Git branch, filesystem snapshot.

**Auth route**:
The way a selected provider is accessed and billed, such as a ChatGPT subscription or an OpenAI API key. The same model name can be offered through different auth routes.
_Avoid_: Model when referring to authentication or billing.

**Configured access**:
Locally available credentials or an endpoint policy permitting access without a key. It is not proof that a remote service currently accepts a request.
_Avoid_: Verified access, signed in when only local configuration is known.

**Interactive choice**:
A user's successfully activated provider, auth route or profile, model, and reasoning preference. Remembering that choice is distinct from saving its credentials.
_Avoid_: Login when referring to the selected model/default.

**Composer draft**:
Ordinary user text being prepared for submission but not yet accepted as a conversation turn. Credential entry and sensitive authentication commands are not composer drafts.
_Avoid_: Saved message, accepted turn.

**Accepted turn**:
A submitted task whose user message has been accepted into the durable conversation for execution. A later failure does not make it a new unsent draft.
_Avoid_: Keystroke, attempted send.

**Provisional answer**:
Visible streamed output from a model attempt that has not become the committed assistant response. A failed or replaced attempt is not part of the final answer merely because it was displayed.
_Avoid_: Final answer, committed response.

**Approval mode**:
One of `auto`, `ask` or `read-only`, deciding whether tools that can change state run, ask first or are refused.
_Avoid_: Permission, policy, sandbox.

**Turn undo**:
A user-invoked revert of files changed by `edit` and `write` in one accepted turn. It does not change conversation history.
_Avoid_: Rollback, rewind, checkpoint.

**Screen catalog**:
The named set of TUI states captured as golden span snapshots, from which the design gallery is built.
_Avoid_: Screenshots, visual tests.
