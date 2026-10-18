---
status: accepted
scope: ENG01 public host base
---

# Add a narrow public application host entry in slices

ENG01 publishes `schway/host` with a static `hostCapabilities` query and lazy `createHost` composition. `HostRuntime` owns native handles, `HostSession` accepts bounded text using a supplied native `Model`, and `HostEntryReference` identifies persisted native results. Native conversation/model/tool types remain the common language. The existing loop, context manager, retry/scheduler and JSONL implementations continue to own execution and persistence; no CLI wrapper or second engine is introduced.

Semver covers this entry and its checked declaration report alongside `schway/extensions`. Native preparation accepts an optional trusted prompt and explicit context sections, including them in existing budgeting; absent options preserve CLI behavior. Imports and static discovery load no runtime/provider/TUI; scripted composition loads no real provider adapter.

The base contract deliberately advertises only `workspace-discovery` plus `include-skill-activation`. A stricter requested policy fails before inference. ENG02/03 add strict context and exact registry guarantees; ENG04 adds cross-process writer/durable acceptance guarantees; ENG05 adds opaque route lifecycle; ENG06 adds run control; ENG07/08 add managed data lifecycle; ENG09 verifies the released consumer artifact. This decision accepts only the implemented base, not the entire proposed S02 contract or production Jit readiness.

Alternatives were exposing internal helpers wholesale or having Jit wrap the CLI. Both would preserve accidental internals/defaults without a reviewable supported boundary. The selected seam costs explicit declarations, import sentinels and external-consumer fixtures, while keeping behavior changes within the engine's supported surface.

Evidence: `tests/host.test.ts`, `tests/extension-api-report.test.ts`, `api/host.api.md` and unchanged `api/extensions.api.md`. See [ENG01](https://github.com/chayapats/schway/issues/395), [S02](https://github.com/chayapats/schway/issues/393) and [host contracts](../host.md). Discovery is not configured-account verification, and engine persistence is not Jit task acceptance or an app-store atomic commit.
