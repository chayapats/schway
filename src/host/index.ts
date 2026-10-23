import type { Model } from "../model/model.ts";
import type { ContextSection } from "../context/manager.ts";
import type { AssistantMessage } from "../conversation/types.ts";
import type { ToolDefinition } from "../tools/types.ts";

/** Native conversation blocks and results shared by host-supplied models and tools. */
export type {
  AssistantContent, AssistantMessage, AssistantTelemetry, ConversationItem, ProviderMetadata,
  TextContent, ThinkingContent, ToolCallContent, ToolResult, ToolTelemetry, UserContent, UserMessage,
} from "../conversation/types.ts";
/** Provider-independent model stream, request, reasoning, usage and tool-description contracts. */
export type {
  HostedTool, Model, ModelCallOptions, ModelRequest, ModelStreamEvent, ModelTool, ModelUsage, ThinkingLevel,
} from "../model/model.ts";
/** Named host-supplied context sent separately from durable conversation messages. */
export type { ContextSection } from "../context/manager.ts";
/** Complete discovery controls and explicitly versioned untrusted evidence for host-managed context. */
export type { ContextSourcePolicy, ContextSourceDocument } from "../context/policy.ts";
/** Native tool declarations whose execution remains owned by Schway's scheduler. */
export type {
  JsonSchema, ToolContext, ToolDefinition, ToolEffect, ToolExecutionMode, ToolExecutionResult, ToolOutputChunk,
} from "../tools/types.ts";
/** Canonical primary workspace identity supplied to each selected tool invocation. */
export type { Workspace } from "../workspace/workspace.ts";

/** Static API support only; capability discovery never probes accounts or inference. */
export interface HostCapabilities {
  readonly contract: "schway.host.base/v1";
  readonly features: readonly ["host-supplied-model", "native-result-reference", "explicit-compaction"];
  readonly contextPolicies: readonly ["workspace-discovery", "strict", "controlled"];
  readonly sessionContract: "schway.host.durable-sessions/v1";
  readonly sessionOwnership: "exclusive-local-process-lease";
  readonly contextContract: "schway.host.context-policy/v1";
  readonly extensionDiscovery: "disabled-only";
  readonly toolContract: "schway.host.tool-policy/v1";
  readonly toolPolicies: readonly ["exact"];
  readonly hostedLookup: "disabled-only";
  readonly observedInference: "not-checked";
}

/** Explicit finite bounds for this host's native loop and accepted text input. */
export interface HostLimits {
  maxTurns: number;
  maxConcurrentTools: number;
  contextWindow: number;
  maxInputChars: number;
}

/** Trusted host composition with exact tool registry and forced hosted-lookup off. */
export interface HostOptions {
  workspaceRoot: string;
  sessionDirectory: string;
  homeDirectory: string;
  context: { policy: "workspace-discovery" | "strict" | "controlled"; systemPrompt: string; sections: readonly ContextSection[];
    discovery?: import("../context/policy.ts").ContextSourcePolicy;
    sources?: readonly import("../context/policy.ts").ContextSourceDocument[] };
  tools: { policy: "exact"; definitions: readonly ToolDefinition[]; hostedLookup: "off" };
  limits: HostLimits;
}

/** A native session and exact selected conversation branch within this host's managed directory. */
export interface HostSessionReference { readonly id: string; readonly branchId: string }

/** An exact persisted native entry, independent of transient model deltas. */
export interface HostEntryReference { readonly session: HostSessionReference; readonly entryId: string }

/** Plain user input accepted durably before the first model request. */
export interface HostInput { text: string }

/** A native terminal observation; completed results include a persisted assistant entry. */
export type HostRunResult =
  | { outcome: "completed"; input: HostEntryReference; result: HostEntryReference; message: AssistantMessage }
  | { outcome: "error" | "cancelled" | "max_turns"; input: HostEntryReference };

/** Native explicit compaction distinguishes a persisted summary reference from an unchanged or unsuccessful attempt. */
export type HostCompactionResult = { outcome: "completed"; result: HostEntryReference }
  | { outcome: "noop" | "error" | "cancelled" };

/** A process-owned native session handle; close is idle-only in the base contract. */
export interface HostSession {
  readonly reference: HostSessionReference;
  /** Persist input, run the native loop and return a durable reference only for committed completion. */
  submit(input: HostInput, model: Model, signal?: AbortSignal): Promise<HostRunResult>;
  /** Compact native history under the same current host policy without discovering an alternative instruction source. */
  compact(model: Model, signal?: AbortSignal): Promise<HostCompactionResult>;
  /** Read one assistant entry from this exact native ancestry without calling models or tools. */
  readResult(reference: HostEntryReference): AssistantMessage;
  /** Release this idle handle; busy handles reject until their submitted run settles. */
  close(): Promise<void>;
}

/** Headless composition of native loop, context and persistence without CLI or provider construction. */
export interface HostRuntime {
  readonly capabilities: HostCapabilities;
  /** Create one native session in the configured managed directory. */
  createSession(): Promise<HostSession>;
  /** Reopen the exact saved native branch within this configured workspace and store. */
  openSession(reference: HostSessionReference): Promise<HostSession>;
  /** Close idle handles and refuse disposal while session creation or a run is in progress. */
  close(): Promise<void>;
}

/** Safe typed host rejection; underlying storage/provider diagnostics remain outside this base surface. */
export class HostError extends Error {
  constructor(readonly code: "invalid-options" | "unsupported-policy" | "invalid-input" | "invalid-reference" |
    "busy" | "conflict" | "closed" | "storage" | "workspace-mismatch" | "result-not-found") {
    super(`Host ${code}`);
    this.name = "HostError";
  }
}

const capabilities: HostCapabilities = Object.freeze({
  contract: "schway.host.base/v1",
  features: Object.freeze(["host-supplied-model", "native-result-reference", "explicit-compaction"] as const),
  contextPolicies: Object.freeze(["workspace-discovery", "strict", "controlled"] as const),
  sessionContract: "schway.host.durable-sessions/v1",
  sessionOwnership: "exclusive-local-process-lease",
  contextContract: "schway.host.context-policy/v1",
  extensionDiscovery: "disabled-only",
  toolContract: "schway.host.tool-policy/v1",
  toolPolicies: Object.freeze(["exact"] as const),
  hostedLookup: "disabled-only",
  observedInference: "not-checked",
});

/** Discover static supported features without loading engine composition, TUI or provider adapters. */
export function hostCapabilities(): HostCapabilities { return capabilities; }

/** Construct a validated host lazily; a supplied model is the only inference route in this base slice. */
export async function createHost(options: HostOptions): Promise<HostRuntime> {
  const { createHostRuntime } = await import("./runtime.ts");
  return createHostRuntime(options);
}
