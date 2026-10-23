---
status: accepted
scope: ENG03 host tool policy
---

# Keep the host tool registry exact with hosted lookup off

ENG03 implements `schway.host.tool-policy/v1` for FR-08/17 and NFR-01/02/09/10, refining the implemented ENG01/ENG02/ENG04 seams and S02 #393. It does not certify a production Jit bridge, filesystem sandbox, account support or provider search expansion.

Host tools use `policy: "exact"` with `hostedLookup: "off"`. Any other policy, a missing lookup flag, or malformed/duplicate/unsupported definitions fail at `createHost` before any session or model call. An empty registry advertises zero function tools; a narrow registry exposes only admitted definitions. Unknown model calls settle as explicit `Unknown tool` errors without execution. No `bash`/`write`/`edit`/`web_fetch`/`activate_skill` appears via loop startup, extensions, context preparation, retry, overflow recovery or reopened sessions.

The agent loop gains an `exactTools` flag that the host always sets; the CLI omits it and preserves its existing built-in registry and activation behavior. An explicitly admitted `activate_skill` is rebound per session to the current context manager, so the same discovery policy still governs direct and restored activation and strict hosts still deny it without running host-supplied code. Before-model hooks may only select an unchanged subset of admitted tools; hosted entries cannot be seen or set through hooks and are attached after hooks only when the session permits them. Before-tool replacements are revalidated and approval (`read-only`/`ask`) applies to the effective post-hook arguments, but approval is documented as distinct from isolation. The trusted host owns resource-scoped connector implementations.

Provider-hosted lookup is forced off for the Jit MVP profile. Ordinary requests, transport retries, pressure/overflow recovery, explicit compaction and replay carry no hosted entries when off, even where an allowlist fixture would otherwise admit them. Request builders and adapters only send what the request carries. Unsupported restrictions fail before inference rather than silently downgrading.

Relative tool paths retain Schway canonical primary-workspace-root semantics; no independent Jit path model or alternative executor is introduced. Public consumer fixtures exercise forbidden built-ins, hook-mutated calls and reopened sessions; protocol fixtures inspect selected-provider bodies to prove hosted search stays absent. Deterministic checks use scripted models and fixtures with no paid inference.
