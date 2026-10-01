import type { ToolEffect } from "../tools/types.ts";

/** User-selected handling of tools that can change state. */
export type ApprovalMode = "auto" | "ask" | "read-only";

/** Approval modes ordered from least to most strict. */
export const APPROVAL_MODES = ["auto", "ask", "read-only"] as const;

/** Default approval mode preserves automatic tool execution. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

/** Return the stricter of two approval modes. */
export function stricterApprovalMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return APPROVAL_MODES.indexOf(a) >= APPROVAL_MODES.indexOf(b) ? a : b;
}

/** Detached final tool arguments and source position presented at the approval boundary. */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  effect: ToolEffect;
  index: number;
}

/** Allow a call or deny it with an optional model-visible explanation. */
export type ApprovalDecision = { kind: "allow" } | { kind: "deny"; reason?: string };

/** Explain why an unattended process cannot approve a mutation. */
export const ASK_HEADLESS_DENIAL = "approval required; headless cannot ask";

/** Supply the current synchronous approval mode at each tool's decision point. */
export interface ApprovalPolicy {
  readonly interactive: boolean;
  /** Read the mode that applies to this call. */
  mode(): ApprovalMode;
  /** Ask for one mutating call, respecting turn cancellation. */
  ask?(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** Explain an interactive mutation denial and its mode-switch action. */
export const READ_ONLY_DENIAL = "Read-only mode: file changes and commands are off. The user can switch modes with Shift+Tab.";

/** Explain a headless mutation denial and its command-line action. */
export const READ_ONLY_HEADLESS_DENIAL = "Read-only mode: this tool changes files or runs commands. Run without --approval read-only to allow it.";
