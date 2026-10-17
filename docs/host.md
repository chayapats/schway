# Embed a native scripted turn

`schway/host` is the semver-governed application-host entry. It composes Schway's existing loop, context preparation, tool scheduler, retries and native JSONL persistence. It does not import the CLI or construct a provider. Discovery and scripted tests need no account or paid request.

This is `schway.host.base/v1` from [ENG01 #395](https://github.com/chayapats/schway/issues/395), one slice of [S02 #393](https://github.com/chayapats/schway/issues/393). It is not yet the strict Jit PR-review profile or production bridge: the only supported policies explicitly opt into workspace instructions/skill discovery and native `activate_skill`. Requesting an unsupported strict/exact policy, including unknown policy fields, fails before input acceptance or inference. Do not silently substitute the base policies for a stricter profile. CLI context defaults are unchanged.

```ts
import { createHost, hostCapabilities, type Model } from "schway/host";

console.log(hostCapabilities()); // Static support; observedInference is "not-checked".
const host = await createHost({
  workspaceRoot: "/absolute/trusted/workspace",
  homeDirectory: "/absolute/trusted/home",
  sessionDirectory: "/absolute/private/managed-sessions",
  context: {
    policy: "workspace-discovery",
    systemPrompt: "You are the host application's analyst.",
    sections: [{ name: "owner-context", content: "Explicit trusted host context" }],
  },
  tools: { policy: "include-skill-activation", definitions: [] },
  limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 },
});
const model: Model = {
  provider: "scripted", id: "example",
  async *stream() {
    yield { type: "message_complete", message: {
      type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Saved answer" }],
    } };
  },
};
const session = await host.createSession();
const run = await session.submit({ text: "Analyze this project" }, model);
if (run.outcome === "completed") {
  const reference = session.reference;
  await session.close();
  const reopened = await host.openSession(reference);
  console.log(reopened.readResult(run.result).content);
  await reopened.close();
}
await host.close();
```

Every path is explicit and absolute. Workspace and home must already be readable directories. The store is created mode 0700 when absent; operators must restrict access to an existing store. Schway owns the native format and append/recovery behavior. The host application must not rewrite JSONL or infer identity from display names.

`submit` accepts nonempty text up to `maxInputChars`, persists a native user entry, then calls the supplied provider-independent `Model` through the native loop. Tool definitions are cloned/validated at startup, use the existing scheduler, and are supplemented with `activate_skill` under the only currently supported policy. No shell/edit/write tools, extensions or provider adapters are registered by host startup. Workspace/home skills and instructions may still be discovered and activated because this base policy explicitly permits them. Provider-hosted lookup is off; the exact registry/review-profile capability remains ENG02/03.

`maxTurns` is an integer 1–100, `maxConcurrentTools` 1–32, `contextWindow` 1–2,000,000 and `maxInputChars` 1–1,000,000. These are validation ceilings, not capacity/performance measurements or hard process deadlines. Native retry policy remains authoritative. A supplied abort signal is cooperative; hard bounds/cancel/disposal contracts are ENG06. The base `close` methods reject `HostError` code `busy` during accepted work or session opening. Await settlement before closing. Close is idempotent; a closed handle cannot submit or read again.

Only `completed` includes a persisted assistant result/reference. `error`, `cancelled` and `max_turns` include the accepted input reference without a final result. Native provisional deltas are not returned as accepted answers. Returned messages are detached copies. `readResult` checks the exact session/branch ancestry and makes no model/tool request. Missing reported usage in native message telemetry remains unknown rather than zero.

The base handle lease prevents simultaneous handles for one canonical store/session **in the same process**. It does not yet implement ENG04's cross-process writer fencing, receipt/reconciliation protocol or full native session lifecycle. Use one host process for a store and do not open it through the CLI/another writer concurrently. Managed retirement/deletion and snapshot/restore are ENG07/08. Supplied models/tools are trusted executable code, not a sandbox. No auth-route construction, credential lifecycle or route availability is certified here; those are ENG05 and opt-in Jit S01 evidence.

Schway completion/persistence is not Jit task acceptance, verified project completion or an atomic commit with Jit's app database. The application owns authorization, job fencing, task decisions and cross-store reconciliation.

## Public API

The checked API report is `api/host.api.md`. Only this inventory and `schway/extensions` are semver-governed; private source/deep imports remain unsupported. Native types below are shared with the extension surface instead of introducing provider wire or TUI contracts.

| Export | Contract |
| --- | --- |
| `AssistantContent` | Native text, reasoning or tool-call block. |
| `AssistantMessage` | Assembled native assistant response. |
| `AssistantTelemetry` | Harness timing and reported model usage. |
| `ContextSection` | Named host/native dynamic context. |
| `ConversationItem` | Provider-independent user, assistant or tool-result record. |
| `createHost` | Validate and lazily compose an explicit host. |
| `HostCapabilities` | Static API features with no inference observation. |
| `hostCapabilities` | Discover support without loading runtime or accounts. |
| `HostedTool` | Native closed hosted-lookup union; host sends none. |
| `HostEntryReference` | Exact native entry in a selected session branch. |
| `HostError` | Safe typed startup/lifecycle/reference rejection. |
| `HostInput` | Bounded plain user text accepted before inference. |
| `HostLimits` | Explicit finite loop/context/input bounds. |
| `HostOptions` | Trusted paths, context, tool policy and limits. |
| `HostRunResult` | Terminal outcome with a durable result only on completion. |
| `HostRuntime` | Create/open/close managed native handles. |
| `HostSession` | Submit and inspect one exact native ancestry. |
| `HostSessionReference` | Stable native session and branch identity. |
| `JsonSchema` | Provider-independent tool input schema. |
| `Model` | Host-supplied normalized model stream. |
| `ModelCallOptions` | Schway-owned model-call settings. |
| `ModelRequest` | Native prompt/context/conversation/tool request. |
| `ModelStreamEvent` | Normalized provisional deltas, usage and completion. |
| `ModelTool` | Provider-independent tool description without execution. |
| `ModelUsage` | Reported counters with honest unknown dimensions. |
| `ProviderMetadata` | Opaque adapter-owned replay data. |
| `TextContent` | Native plain-text block. |
| `ThinkingContent` | Native reasoning block and replay metadata. |
| `ThinkingLevel` | Provider-independent requested reasoning level. |
| `ToolCallContent` | Identified native tool invocation. |
| `ToolContext` | Workspace/cancellation context supplied to tools. |
| `ToolDefinition` | Selected schema, effect, scheduling and execution. |
| `ToolEffect` | Read-only or mutating declaration. |
| `ToolExecutionMode` | Parallel or exclusive scheduler behavior. |
| `ToolExecutionResult` | Bounded model-facing tool output. |
| `ToolOutputChunk` | Native live tool-output chunk. |
| `ToolResult` | Persisted native tool outcome. |
| `ToolTelemetry` | Harness tool timing metadata. |
| `UserContent` | Native user plain-text content. |
| `UserMessage` | Identified persisted user input. |
| `Workspace` | Canonical root/launch/attached-root identity. |

## Validation

`bun test tests/host.test.ts` exercises a disposable external consumer that imports only `schway/host`, executes a scripted native tool round and reopens/continues in a fresh process. Preload sentinels reject provider/TUI initialization and runtime loading during static discovery. Other fixtures cover unsupported policies/options, durable input before inference, write failures, busy handles, cancellation, detached result reads and native terminal outcomes.

Run `bun run typecheck` and full `bun test`. The declaration builder emits both entries; `bun scripts/extension-api-report.ts` checks unchanged extension declarations and `bun scripts/extension-api-report.ts --host` checks the host report. Intentional host API changes use `--host --update`, followed by inventory/declaration tests. No live provider call or human credential setup belongs in these deterministic checks.
