import type { TuiSnapshot } from "./controller-types.ts";

/** Views that can take the keyboard from the conversation; each is set while that view is open. */
export interface InputOwners {
  /** The open panel mode, or "" when the conversation owns the body. */
  panel: string;
  /** The slash-command palette is browsing completions for a `/` draft. */
  slashBrowsing: boolean;
  /** A transcript block or tool result is selected for inspection. */
  inspection: boolean;
  /** F2 details are open over the conversation. */
  details: boolean;
  /** The long-block reader is open. */
  reader: boolean;
  /** A tool approval request is waiting. */
  toolApproval: boolean;
}

/** Whether any panel, palette, inspection, reader, open details or approval owns the keys, so background card and example hints must hide. */
export function surfaceOwnsInput(owners: InputOwners): boolean {
  return !!owners.panel || owners.slashBrowsing || owners.inspection || owners.details || owners.reader || owners.toolApproval;
}

/** The empty-conversation card's key-hint lines for this readiness, or none while another surface owns the keys. */
export function readinessCardActions(snapshot: Pick<TuiSnapshot, "readiness" | "recovery">, owned: boolean): string[] {
  if (owned) return [];
  if (snapshot.readiness === "not-connected") return ["Connect a provider · Alt+L sign in"];
  const action = snapshot.readiness === "loading" ? "Checking connection · Type a task · Esc cancel"
    : snapshot.readiness === "ready" ? "Type a task · Enter send"
    : snapshot.readiness === "connect" ? "Connect to continue · Alt+L sign in"
    : snapshot.readiness === "choose-model" ? "Choose a model · Alt+M browse models"
    : snapshot.recovery?.category === "credential-store" ? "Unlock credential storage · Ctrl+R retry"
    : "Repair connection · Alt+M choose model";
  return snapshot.recovery?.actions.includes("details") ? [action, "F2 details · Esc keep editing"] : [action];
}

/** Which outcome-strip keys act now; the strip names each key only while it does. */
export interface OutcomeStripActions {
  /** Alt+R opens review. */
  review: boolean;
  /** F2 opens a failed turn's details. */
  details: boolean;
}

/** Decide Alt+R review and F2 details separately: panels and the reader own both, while open details or a pending connection check ignore only F2. */
export function outcomeStripActions(state: { panel: string; reader: boolean; details: boolean; loading: boolean }): OutcomeStripActions {
  const review = !state.panel && !state.reader;
  return { review, details: review && !state.details && !state.loading };
}
