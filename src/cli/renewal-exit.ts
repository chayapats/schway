import { pendingRenewals, type RenewalRoute, type SentRenewal } from "../auth/renewals.ts";

/** Status while the CLI waits, before exiting, for a renewed sign-in whose request already left. */
export const SAVING_RENEWED_SIGN_IN = "Saving the renewed sign-in…";
/** Hint beside that status when stdin is a terminal, so Ctrl+C can reach the process. */
export const SAVING_RENEWED_SIGN_IN_HINT = "Ctrl+C quit without saving";
/** Status of the notice when the CLI exits before a renewed sign-in was saved. */
export const RENEWED_SIGN_IN_NOT_SAVED = "Renewed sign-in not saved";

/** The not-saved notice, naming the sign-in command for each route whose renewal did not store its sign-in. */
export function renewedSignInNotSaved(routes: readonly RenewalRoute[]): string {
  const hints = routes.map(route => `/login ${route === "codex" ? "chatgpt" : "grok"} sign in again if rejected`);
  return [RENEWED_SIGN_IN_NOT_SAVED, ...hints].join(" · ");
}

/** Longest exit wait: the 30-second refresh ceiling, the 2-second credential-lock wait, and a margin for the read and write. */
export const RENEWAL_EXIT_LIMIT_MS = 35_000;
/** Longest exit wait after SIGTERM arrives, measured from the signal, inside common container shutdown grace periods. */
export const RENEWAL_TERMINATE_LIMIT_MS = 5_000;

/** Bounds and outputs for the wait before exit; the renewal seams exist for deterministic tests. */
export interface RenewalExitOptions {
  readonly stderr: { write(text: string): void };
  /** Whether stdin is a terminal, so the Ctrl+C hint is shown. */
  readonly interactive: boolean;
  readonly limitMs?: number;
  readonly terminateLimitMs?: number;
  /** Renewals still settling; defaults to this process's sent renewals. */
  readonly renewals?: () => readonly SentRenewal[];
}

/** Signal handling around the wait for renewals that already left; `settle` returns the exit status to use. */
export interface RenewalExit {
  /** Record a SIGINT: during the wait, quit at once without saving. */
  interrupt(): void;
  /** Record a SIGTERM: the wait ends at the termination limit after the first one; a second one quits at once. */
  terminate(): void;
  /** Wait, bounded, for renewals that already left, then return the status to exit with. */
  settle(code: number): Promise<number>;
}

/** Create the exit wait for one CLI process. */
export function createRenewalExit(options: RenewalExitOptions): RenewalExit {
  const terminateLimitMs = options.terminateLimitMs ?? RENEWAL_TERMINATE_LIMIT_MS;
  let interrupts = 0, terminations = 0, terminatedAt: number | undefined;
  let onSignal: ((kind: "interrupt" | "terminate") => void) | undefined;
  return {
    interrupt() { interrupts++; onSignal?.("interrupt"); },
    terminate() {
      terminations++;
      terminatedAt ??= performance.now();
      onSignal?.("terminate");
    },
    async settle(code) {
      const pending = options.renewals ?? pendingRenewals;
      if (!pending().length) return code;
      // Each watched renewal's outcome, recorded as it settles; renewals sent during the wait are watched too.
      const outcomes = new Map<SentRenewal, boolean | undefined>();
      const watch = (): Promise<boolean>[] => {
        const added: Promise<boolean>[] = [];
        for (const renewal of pending()) {
          if (outcomes.has(renewal)) continue;
          outcomes.set(renewal, undefined);
          added.push(renewal.saved.then(saved => { outcomes.set(renewal, saved); return saved; }, () => { outcomes.set(renewal, false); return false; }));
        }
        return added;
      };
      watch();
      // Named when the wait ends: only routes whose renewal had not stored its sign-in by then.
      const unsavedRoutes = (): RenewalRoute[] => {
        const routes = new Set([...outcomes].filter(([, saved]) => saved !== true).map(([renewal]) => renewal.route));
        return (["codex", "grok"] as const).filter(route => routes.has(route));
      };
      const notSaved = (status: number): number => { options.stderr.write(`${renewedSignInNotSaved(unsavedRoutes())}\n`); return status; };
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
        // Measured from the SIGTERM itself, so slow unwinding before the wait does not extend it.
        const capFromTermination = () => {
          const remaining = Math.max(0, terminatedAt! + terminateLimitMs - performance.now());
          timers.push(setTimeout(() => finish(143, false), remaining));
        };
        // A store write that never returns cannot hold the process: the limit exits with the command's own status.
        timers.push(setTimeout(() => finish(code, false), options.limitMs ?? RENEWAL_EXIT_LIMIT_MS));
        if (terminations) capFromTermination();
        onSignal = kind => {
          if (kind === "interrupt") finish(130, false);
          else if (terminations >= 2) finish(143, false);
          else capFromTermination();
        };
        void (async () => {
          for (let added = [...outcomes.keys()].map(renewal => renewal.saved); added.length; added = watch()) await Promise.allSettled(added);
          finish(code, unsavedRoutes().length === 0);
        })();
      });
    },
  };
}
