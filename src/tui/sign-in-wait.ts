import type { LoginApproval } from "./controller-types.ts";

/** Subscription provider named by an active sign-in target, never inferred from approval data. */
export type SignInProvider = "ChatGPT" | "Grok";

/** The hint row's only Esc phrase while a sign-in waits: Esc aborts the sign-in and saves nothing. */
export const SIGN_IN_WAIT_HINT = "Esc cancel sign-in";
/** Compact status-bar action that names Esc when the hint row is hidden during a sign-in wait. */
export const SIGN_IN_WAIT_COMPACT_ACTION = "Esc cancel";
/** Hint while secure storage saves a credential; a submitted write cannot be cancelled, so no key is named. */
export const SIGN_IN_SAVING_HINT = "Wait for secure storage";
/** Hint after Esc cancelled a sign-in that has not yet stopped; Esc has nothing more to cancel. */
export const SIGN_IN_CANCELLING_HINT = "Wait for sign-in to stop";
/** Key-free composer text while the wait panel owns input. */
export const SIGN_IN_COMPOSER_TEXT = "Typing resumes after sign-in";
/** Key-free composer text while the sign-in chooser owns input; Esc gives the draft back without signing in. */
export const SIGN_IN_CHOOSER_COMPOSER_TEXT = "Choosing sign-in";
/** Primary transcript status after a browser launcher failure; the authorization link is the line above. */
export const BROWSER_NOT_OPENED = "Browser didn't open · Open the link above";
/** Primary status for any subscription sign-in timeout; F2 details keep the provider's recovery text. */
export const SIGN_IN_TIMED_OUT = "Sign-in timed out · Alt+L sign in · F2 details";

/** One wait-panel row and its semantic tone. */
export interface SignInWaitRow { text: string; tone: "accent" | "text" | "muted" }

/** Name the provider in the wait panel's single heading. */
export function signInHeading(provider: SignInProvider): string {
  return `Sign in to ${provider}`;
}

/** Shorten an HTTPS verification URI to the address a user types. */
export function deviceAddress(verificationUri: string): string {
  return verificationUri.replace(/^https:\/\//, "").replace(/\/$/, "");
}

/** Build the device approval from a ChatGPT `Enter this code at <url>: <code>` progress message, or nothing for other messages. */
export function codexDeviceApproval(message: string): Extract<LoginApproval, { kind: "device" }> | undefined {
  const match = /^Enter this code at (.*?): (.+)$/.exec(message.trim());
  return match ? { kind: "device", verificationUri: match[1]!, userCode: match[2]! } : undefined;
}

/**
 * Order the wait panel: the provider heading, then either the browser instruction or the numbered device
 * steps (address before code, each with its verb), then a glyph status that keeps its meaning without color.
 * `status` is the controller's key-free body text, used before approval data arrives.
 */
export function signInWaitRows(wait: { provider: SignInProvider; saving?: boolean; cancelling?: boolean }, status: string, approval?: LoginApproval): SignInWaitRow[] {
  const heading: SignInWaitRow = { text: signInHeading(wait.provider), tone: "accent" };
  if (wait.saving) return [heading, { text: "◌ Saving sign-in", tone: "muted" }];
  if (wait.cancelling) return [heading, { text: "◌ Cancelling sign-in", tone: "muted" }];
  if (approval?.kind === "device") return [heading,
    { text: `1 Open ${deviceAddress(approval.verificationUri)}`, tone: "text" },
    { text: `2 Enter ${approval.userCode}`, tone: "text" },
    { text: "◌ Waiting for approval", tone: "muted" }];
  if (approval?.kind === "browser" || status === "Approve in your browser") return [heading, { text: "Approve in your browser", tone: "text" }, { text: "◌ Waiting for approval", tone: "muted" }];
  return [heading, { text: `◌ ${status}`, tone: "muted" }];
}

/**
 * Fit wait rows into `budget` terminal rows at `columns`: drop the trailing glyph status first, then the heading,
 * never an instruction or device step, so `Open <address>` and `Enter <code>` stay visible on short terminals.
 */
export function fitSignInWaitRows(rows: readonly SignInWaitRow[], budget: number, columns: number): SignInWaitRow[] {
  const height = (list: readonly SignInWaitRow[]) => list.reduce((sum, row) => sum + Math.max(1, Math.ceil(Bun.stringWidth(row.text) / Math.max(1, columns))), 0);
  let fitted = [...rows];
  const instructions = () => fitted.filter(row => row.tone === "text").length;
  if (height(fitted) > budget && instructions() && fitted.at(-1)?.tone === "muted") fitted = fitted.slice(0, -1);
  if (height(fitted) > budget && instructions() && fitted[0]?.tone === "accent") fitted = fitted.slice(1);
  return fitted;
}

/** Hint row for the chooser while a sign-in waits behind it, or undefined when it is the ordinary chooser. */
export function signInChooserHint(wait: { saving?: boolean; cancelling?: boolean } | undefined, navigation: string): string {
  // A submitted save ignores Enter and Esc; a cancelled sign-in lets Esc go back like any chooser.
  if (wait?.saving) return SIGN_IN_SAVING_HINT;
  return `${navigation} · ${wait && !wait.cancelling ? SIGN_IN_WAIT_HINT : "Esc back"}`;
}

/** Map a provider sign-in timeout to short TUI copy with the full recovery text as details; other failures return nothing. */
export function signInTimeout(message: string): { text: string; details: string } | undefined {
  if (!/^(?:ChatGPT sign-in timed out|Device sign-in timed out|Grok (?:device )?sign-in timed out)/.test(message)) return;
  return { text: SIGN_IN_TIMED_OUT, details: message };
}

/** Recognize a provider's browser-launch failure and extract an authorization link embedded in it. */
export function browserNotOpened(message: string): { link?: string } | undefined {
  if (!message.startsWith("The browser could not be opened automatically")) return;
  const link = /\bOpen (https?:\/\/\S+)\s*$/.exec(message)?.[1];
  return link ? { link } : {};
}
