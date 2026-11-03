import { hasSentRenewals, sentRenewalsSettled } from "../auth/renewals.ts";

/** Status while the CLI waits, before exiting, for a renewed sign-in whose request already left. */
export const SAVING_RENEWED_SIGN_IN = "Saving the renewed sign-in…";
/** Hint beside that status when stdin is a terminal, so Ctrl+C can reach the process. */
export const SAVING_RENEWED_SIGN_IN_HINT = "Ctrl+C quit without saving";
/** Notice when the CLI exits before a renewed sign-in was saved. */
export const RENEWED_SIGN_IN_NOT_SAVED = "Renewed sign-in not saved · /login sign in again if the next command is rejected";

/** Longest exit wait: the 30-second refresh ceiling, the 2-second credential-lock wait, and a margin for the read and write. */
export const RENEWAL_EXIT_LIMIT_MS = 35_000;
/** Longest exit wait once SIGTERM arrives, inside common container shutdown grace periods. */
export const RENEWAL_TERMINATE_LIMIT_MS = 5_000;

/** Bounds and outputs for the wait before exit; the renewal seams exist for deterministic tests. */
export interface RenewalExitOptions {
  readonly stderr: { write(text: string): void };
  /** Whether stdin is a terminal, so the Ctrl+C hint is shown. */
  readonly interactive: boolean;
  readonly limitMs?: number;
  readonly terminateLimitMs?: number;
  readonly renewals?: { pending(): boolean; settled(): Promise<boolean> };
}

/** Signal handling around the wait for renewals that already left; `settle` returns the exit status to use. */
export interface RenewalExit {
  /** Record a SIGINT: during the wait, quit at once without saving. */
  interrupt(): void;
  /** Record a SIGTERM: during the wait, cap it at the termination limit; a second one quits at once. */
  terminate(): void;
  /** Wait, bounded, for renewals that already left, then return the status to exit with. */
  settle(code: number): Promise<number>;
}

/** Create the exit wait for one CLI process. */
export function createRenewalExit(options: RenewalExitOptions): RenewalExit {
  let interrupts = 0, terminations = 0;
  let onSignal: ((kind: "interrupt" | "terminate") => void) | undefined;
  return {
    interrupt() { interrupts++; onSignal?.("interrupt"); },
    terminate() { terminations++; onSignal?.("terminate"); },
    async settle(code) {
      const renewals = options.renewals ?? { pending: hasSentRenewals, settled: sentRenewalsSettled };
      if (!renewals.pending()) return code;
      const notSaved = (status: number): number => { options.stderr.write(`${RENEWED_SIGN_IN_NOT_SAVED}\n`); return status; };
      // Two interrupts or two terminations before the wait mean the user already asked to quit.
      if (interrupts >= 2) return notSaved(130);
      if (terminations >= 2) return notSaved(143);
      options.stderr.write(`${options.interactive ? `${SAVING_RENEWED_SIGN_IN} · ${SAVING_RENEWED_SIGN_IN_HINT}` : SAVING_RENEWED_SIGN_IN}\n`);
      return new Promise<number>(resolve => {
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        let done = false;
        const finish = (status: number, saved: boolean): void => {
          if (done) return;
          done = true;
          for (const timer of timers) clearTimeout(timer);
          onSignal = undefined;
          resolve(saved ? status : notSaved(status));
        };
        const capAfterTermination = () => { timers.push(setTimeout(() => finish(143, false), options.terminateLimitMs ?? RENEWAL_TERMINATE_LIMIT_MS)); };
        // A store write that never returns cannot hold the process: the limit exits with the command's own status.
        timers.push(setTimeout(() => finish(code, false), options.limitMs ?? RENEWAL_EXIT_LIMIT_MS));
        if (terminations) capAfterTermination();
        onSignal = kind => {
          if (kind === "interrupt") finish(130, false);
          else if (terminations >= 2) finish(143, false);
          else capAfterTermination();
        };
        renewals.settled().then(saved => finish(code, saved), () => finish(code, false));
      });
    },
  };
}
