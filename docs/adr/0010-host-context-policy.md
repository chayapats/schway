---
status: accepted
scope: ENG02 host context-source policy
---

# Keep host source permissions in the native context manager

ENG02 implements `schway.host.context-policy/v1` for FR-02/16/17 and NFR-01/02/10. These engineering choices refine the implemented ENG01 seam and S02 #393. They do not certify a production Jit bridge, filesystem sandbox, account support or the later exact-registry/lifecycle capabilities.

Host context chooses explicit `workspace-discovery`, all-off `strict`, or complete `controlled` discovery flags. Workspace/home AGENTS, skills metadata, activation and package-backed skill admission have separate controls. Extensions remain disabled-only: requesting executable extension discovery fails before inference. This advertises a restriction the host actually enforces, rather than claiming an unimplemented extension-composition API. Discovery-disabled plus activation-enabled is an unsupported combination; metadata-only skills are supported. Ordinary CLI construction omits this policy and preserves its existing prompt, skill, package and compaction behavior.

Trusted operator prompt/sections are separate from explicitly versioned source documents. Sources are framed as untrusted JSON evidence with request provenance `source`; native summaries carry `summary`, not operator provenance. The current requested policy is copied at host creation, never inferred from source/model/history text. Source text can still be semantically adversarial: these boundaries enforce discovery/execution admission and provenance, not semantic prompt-injection immunity. A trusted supplied model/tool can execute arbitrary code and is not a sandboxed plugin.

The native context manager owns the policy for ordinary preparation, direct/restored activation and pressure/manual/overflow summaries. Disabled packages pass an explicit empty package set through metadata and activation; an activation cannot rediscover excluded configuration later. The engine does not inject its activation tool when the manager disallows it, and a directly registered activation tool is still refused by the same manager. ENG03 owns the full exact registry contract.

Managed summaries receive the same current operator instructions and policy-filtered source sections; their summarization instruction is additional trusted engine guidance. The CLI summary path is unchanged. `HostSession.compact` is a narrow native compaction operation with the same policy, idle/busy checks and durable reference. It exposes completed/noop/error/cancelled, rather than asking Jit to run a second context loop or edit native history.

Reopen always reconstructs native context from the current host snapshot. It does not restore a prior discovery configuration. Existing history/tool results/summaries remain untrusted conversation evidence; model text cannot reinstate old AGENTS, skills or code-loading permissions. Current restrictions apply to weaker historical sessions and fresh sessions alike. Native session format is unchanged; source retirement/deletion/forget semantics remain later tickets.

Host inputs have finite source counts, identity lengths and total instruction/source characters. Unsupported/malformed policies and forged source authority fail startup. Public consumer fixtures exercise direct/reopened runs, malicious workspace/home/parents/config/package modules, skill attempts, pressure/overflow/manual compaction and transport retry. Controlled-profile tests prove independent permitted sources and package-off activation, while existing CLI/extension/context/compaction compatibility cases retain defaults. No paid inference or installation state is used.
