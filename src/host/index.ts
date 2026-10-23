import type { Model, ModelUsage } from "../model/model.ts";
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
/** Explicit Grok/Codex route lifecycle with opaque credential references and safe readiness. */
export type {
  HostAuthDescription, HostAuthFetch, HostAuthReadiness, HostAuthRoute, HostAuthRunResult, HostAuthSelection, HostAuthStatusCode, HostCredentialReference, HostCredentialStore,
} from "./auth-routes.ts";
export { checkAuthReadiness, classifyAuthError, containsNoSecrets, createAuthRouteModel, credentialReferenceForRoute, describeAuthRoute } from "./auth-routes.ts";
/** Quiesced native-state snapshot and validated restore for owned managed sessions. */
export type {
  HostSessionSnapshot, HostSnapshotArtifact, HostSnapshotArtifactKind, HostSnapshotOptions, HostSnapshotQuarantineReason,
  HostSnapshotRestoreOptions, HostSnapshotRestoreResult, HostSnapshotSession, HostSnapshotValidation,
} from "./snapshot.ts";
export { SNAPSHOT_CONTRACT, SNAPSHOT_NATIVE_FORMAT_VERSION, MAX_SNAPSHOT_ARTIFACT_BYTES, MAX_SNAPSHOT_SESSIONS, hashSnapshotBytes, validateSnapshotShape } from "./snapshot.ts";
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
  readonly authContract: "schway.host.auth-routes/v1";
  readonly authRoutes: readonly ["codex", "grok"];
  readonly runContract: "schway.host.run-control/v1";
  readonly dataContract: "schway.host.managed-session-data/v1";
  readonly snapshotContract: "schway.host.session-snapshot/v1";
}

/** Explicit finite bounds for this host's native loop and accepted text input. */
export interface HostLimits {
  maxTurns: number;
  maxConcurrentTools: number;
  contextWindow: number;
  maxInputChars: number;
  /** Wall-clock bound for one run including retries and compaction; defaults to 300000. */
  deadlineMs?: number;
  /** Transient provider attempts per model turn including the first; defaults to 3. */
  maxAttempts?: number;
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
  auth?: import("./auth-routes.ts").HostAuthSelection;
}

/** A native session and exact selected conversation branch within this host's managed directory. */
export interface HostSessionReference { readonly id: string; readonly branchId: string }

/** An exact persisted native entry, independent of transient model deltas. */
export interface HostEntryReference { readonly session: HostSessionReference; readonly entryId: string }

/** Plain user input accepted durably before the first model request. */
export interface HostInput { text: string }

/** Selected model identity carried on every terminal run outcome. */
export interface HostModelIdentity {
  readonly provider: string;
  readonly id: string;
}

/** Injectable wall clock so deterministic tests control backoff and deadline waits. */
export interface HostClock {
  /** Return milliseconds since the Unix epoch for retry timestamps and deadlines. */
  now(): number;
  /** Wait the requested milliseconds, rejecting promptly when the supplied signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Return monotonic milliseconds for durations; `now` is used when absent. */
  monotonicNow?(): number;
}

/** Transient progress observation; dropping it never creates durable output. */
export type HostProgressEvent =
  | { type: "delta"; text: string; transient: true }
  | { type: "tool_started"; toolCallId: string; name: string; transient: true }
  | { type: "tool_finished"; toolCallId: string; name: string; status: "success" | "error" | "cancelled"; transient: true }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; message: string; transient: true }
  | { type: "compaction"; stage: "started" | "finished"; reason: string; status?: "completed" | "failed" | "cancelled" | "noop"; transient: true }
  | { type: "usage"; phase: "turn" | "compaction"; usage: ModelUsage; complete: boolean; transient: true };

/** Per-run options carrying cancellation, a fake clock and transient progress. */
export interface HostRunOptions {
  /** Cooperative cancellation for the model, backoff and compaction waits. */
  readonly signal?: AbortSignal;
  /** Injected clock for backoff and deadline waits; defaults to the system clock. */
  readonly clock?: HostClock;
  /** Transient observer; throwing or detaching never duplicates or completes a run. */
  readonly onProgress?: (event: HostProgressEvent) => void;
}

/** One reported usage sample with its completeness flag; null counters were unreported. */
export interface HostRunAttemptUsage {
  readonly phase: "turn" | "compaction";
  readonly usage: ModelUsage;
  readonly complete: boolean;
}

/** Honest run consumption; unknown counters stay null and never read as zero quota. */
export interface HostRunUsage {
  readonly attempts: readonly HostRunAttemptUsage[];
  readonly complete: boolean;
  readonly totalMs: number;
}

/** Sanitized failure detail preserving the effective route, policy and model. */
export interface HostRunError {
  readonly message: string;
  readonly model: HostModelIdentity;
  readonly contextPolicy: "workspace-discovery" | "strict" | "controlled";
  readonly toolPolicy: "exact";
}

/** A native terminal observation; completed results include a persisted assistant entry. */
export type HostRunResult =
  | { outcome: "completed"; input: HostEntryReference; result: HostEntryReference; message: AssistantMessage; usage: HostRunUsage; model: HostModelIdentity }
  | { outcome: "error" | "cancelled" | "max_turns" | "limit_exceeded"; input: HostEntryReference; usage: HostRunUsage; model: HostModelIdentity; error: HostRunError };

/** Native explicit compaction distinguishes a persisted summary reference from an unchanged or unsuccessful attempt. */
export type HostCompactionResult = { outcome: "completed"; result: HostEntryReference; usage: HostRunUsage }
  | { outcome: "noop" | "error" | "cancelled" | "limit_exceeded"; usage: HostRunUsage };

/** A process-owned native session handle; cancel settles work and close releases ownership. */
export interface HostSession {
  readonly reference: HostSessionReference;
  /** Persist input, run the native loop and return a durable reference only for committed completion. */
  submit(input: HostInput, model: Model, signalOrOptions?: AbortSignal | HostRunOptions): Promise<HostRunResult>;
  /** Run the bound Grok/Codex route without caller-supplied credentials; auth failures carry safe status. */
  submitWithRoute(input: HostInput, signalOrOptions?: AbortSignal | HostRunOptions): Promise<import("./auth-routes.ts").HostAuthRunResult>;
  /** Compact native history under the same current host policy without discovering an alternative instruction source. */
  compact(model: Model, signalOrOptions?: AbortSignal | HostRunOptions): Promise<HostCompactionResult>;
  /** Read one assistant entry from this exact native ancestry without calling models or tools. */
  readResult(reference: HostEntryReference): AssistantMessage;
  /** Abort the admitted run and settle cooperative tools; safe to repeat and safe when idle. */
  cancel(): void;
  /** Release this idle handle; busy handles reject with busy instead of aborting. Cancel first, await settlement, then close. */
  close(): Promise<void>;
  /** Retire this idle handle so its context cannot silently reopen; busy handles reject with busy. */
  retire(): Promise<void>;
}

/** Sanitized managed artifact inventory for deletion reporting. */
export type HostDeletedArtifact = "conversation" | "metadata" | "history" | "draft" | "undo" | "lease";

/** Managed native-data deletion outcome; partial never reports success. */
export type HostSessionDeletion =
  | { status: "deleted"; session: HostSessionReference; removed: readonly HostDeletedArtifact[]; nextAction: string }
  | { status: "already-deleted"; session: HostSessionReference; nextAction: string }
  | { status: "partial"; session: HostSessionReference; removed: readonly HostDeletedArtifact[]; remaining: readonly HostDeletedArtifact[]; nextAction: string }
  | { status: "blocked"; session: HostSessionReference; reason: "busy" | "conflict"; nextAction: string };

/** Route-bound host composition; the selected Grok/Codex identity is fixed at creation. */
export interface HostAuthBinding {
  readonly route: import("./auth-routes.ts").HostAuthRoute;
  readonly model: string;
  readonly credential: import("./auth-routes.ts").HostCredentialReference;
  /** Check local store readiness without network or inference; only the selected identity is read. */
  checkReadiness(): Promise<import("./auth-routes.ts").HostAuthReadiness>;
  /** Create only the selected subscription adapter; the unselected route and TUI never load. */
  createModel(): Promise<Model>;
}

/** Headless composition of native loop, context and persistence without CLI or provider construction. */
export interface HostRuntime {
  readonly capabilities: HostCapabilities;
  readonly auth?: HostAuthBinding;
  /** Create one native session in the configured managed directory. */
  createSession(): Promise<HostSession>;
  /** Reopen the exact saved native branch within this configured workspace and store. */
  openSession(reference: HostSessionReference): Promise<HostSession>;
  /** Retire one managed session id across branches so later reopen cannot silently reintroduce it. Ownership verdicts report busy; unreadable stores throw storage. */
  retireSession(reference: HostSessionReference): Promise<void>;
  /** Delete owned native artifacts for one managed session id across branches with honest status. Busy owners and replaced aliases report blocked; unreadable stores and workspace mismatch throw. */
  deleteSession(reference: HostSessionReference): Promise<HostSessionDeletion>;
  /** Capture a coherent snapshot of closed managed sessions under one quiesced lease set. Open or admitted writers reject busy; replaced aliases reject conflict. */
  snapshotSessions(references: readonly HostSessionReference[], options?: import("./snapshot.ts").HostSnapshotOptions): Promise<import("./snapshot.ts").HostSessionSnapshot>;
  /** Validate a snapshot without touching the store; quarantined snapshots must not restore or run. */
  validateSessionSnapshot(snapshot: unknown): import("./snapshot.ts").HostSnapshotValidation;
  /** Restore validated native artifacts into this store without running models or tools. Existing or busy targets quarantine; corrupt sets never partly activate. */
  restoreSessionSnapshot(snapshot: unknown, options?: import("./snapshot.ts").HostSnapshotRestoreOptions): Promise<import("./snapshot.ts").HostSnapshotRestoreResult>;
  /** Close idle handles and refuse disposal while session creation or a run is in progress. Cancel admitted runs first; close never aborts or settles them. */
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
  authContract: "schway.host.auth-routes/v1",
  authRoutes: Object.freeze(["codex", "grok"] as const),
  runContract: "schway.host.run-control/v1",
  dataContract: "schway.host.managed-session-data/v1",
  snapshotContract: "schway.host.session-snapshot/v1",
} as HostCapabilities);

/** Discover static supported features without loading engine composition, TUI or provider adapters. */
export function hostCapabilities(): HostCapabilities { return capabilities; }

/** Construct a validated host lazily; a supplied model is the only inference route in this base slice. */
export async function createHost(options: HostOptions): Promise<HostRuntime> {
  const { createHostRuntime } = await import("./runtime.ts");
  return createHostRuntime(options);
}
