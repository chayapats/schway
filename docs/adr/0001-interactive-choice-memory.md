# Keep remembered interactive choices separate from explicit configuration

The user approved remembering the last successfully activated interactive model/auth choice per canonical primary workspace, below explicit user/project/CLI configuration and above built-in defaults. This keeps project work continuous without having one project's choice change another project, silently writing project configuration, or changing deterministic headless behavior; headless execution does not automatically consume this memory, and existing explicit credential/billing precedence remains authoritative.

Credential persistence, remembered model selection, and durable conversation history are separate state. Explicit resume resolves the resumed workspace's current effective settings rather than silently restoring an old billing route from conversation history. These are accepted product decisions for the experience-polish implementation; this record does not claim the behavior has already shipped.
