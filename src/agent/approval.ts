/** User-selected handling of tools that can change state. */
export type ApprovalMode = "auto" | "read-only";

/** Approval modes ordered from least to most strict. */
export const APPROVAL_MODES = ["auto", "read-only"] as const;

/** Default approval mode preserves automatic tool execution. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

/** Return the stricter of two approval modes. */
export function stricterApprovalMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return APPROVAL_MODES.indexOf(a) >= APPROVAL_MODES.indexOf(b) ? a : b;
}

/** Supply the current synchronous approval mode at each tool's decision point. */
export interface ApprovalPolicy {
  readonly interactive: boolean;
  /** Read the mode that applies to this call. */
  mode(): ApprovalMode;
}

/** Explain an interactive mutation denial and its mode-switch action. */
export const READ_ONLY_DENIAL = "Read-only mode: file changes and commands are off. The user can switch modes with Shift+Tab.";

/** Explain a headless mutation denial and its command-line action. */
export const READ_ONLY_HEADLESS_DENIAL = "Read-only mode: this tool changes files or runs commands. Run without --approval read-only to allow it.";
