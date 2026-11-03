import { version } from "../../package.json";
import { hasSentRenewals, sentRenewalsSettled } from "../auth/renewals.ts";
import { parseVersionCommand } from "./version.ts";
import type { CliIo } from "./runtime.ts";

export type { CliIo, CliWriter } from "./runtime.ts";

/** Resolve standalone discovery and version commands before loading application setup or runtime. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === "sessions") return (await import("./sessions.ts")).runSessionsCommand(argv.slice(1), io);
  if (argv[0] === "models") return (await import("./models.ts")).runModelsCommand(argv, { ...io, store: io.credentialStore });
  const versionCommand = parseVersionCommand(argv);
  if (versionCommand) {
    if ("error" in versionCommand) {
      io.stderr.write(`${versionCommand.error}\n`);
      return 1;
    }
    io.stdout.write(versionCommand.help ? (await import("./help.ts")).formatHelp() : `schway ${version}\n`);
    return 0;
  }
  const runtime = await import("./runtime.ts");
  return runtime.runCli(argv, io);
}

/** Shown while the CLI waits, before exiting, for a renewed sign-in whose request already left. */
export const SAVING_RENEWED_SIGN_IN = "Saving the renewed sign-in… · Ctrl+C quit without saving";
/** Shown when the user quits before a renewed sign-in was saved. */
export const RENEWED_SIGN_IN_NOT_SAVED = "Quit before the renewed sign-in was saved. If the next command is rejected, sign in again in interactive mode with /login.";

/** Process entrypoint for the `schway` binary. */
async function main(): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  let quit: (() => void) | undefined;
  const abort = () => {
    controller.abort();
  };
  const interrupt = () => {
    interrupts++;
    controller.abort();
    quit?.();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", abort);
  try {
    const code = await runCli(process.argv.slice(2), {
      stdout: { write: (chunk) => void process.stdout.write(chunk) },
      stderr: { write: (chunk) => void process.stderr.write(chunk) },
      env: process.env,
      cwd: process.cwd(),
      terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      signal: controller.signal,
    });
    // A renewal whose request already left may have rotated the refresh token at the provider; exiting before it
    // is stored would force a new sign-in. Its refresher bounds the wait, and Ctrl+C quits without saving.
    if (!hasSentRenewals()) return code;
    const quitting = (): number => {
      process.stderr.write(`${RENEWED_SIGN_IN_NOT_SAVED}\n`);
      return 130;
    };
    if (interrupts >= 2) return quitting();
    process.stderr.write(`${SAVING_RENEWED_SIGN_IN}\n`);
    const quitRequested = new Promise<"quit">(resolve => { quit = () => resolve("quit"); });
    return await Promise.race([sentRenewalsSettled().then(() => "saved" as const), quitRequested]) === "quit" ? quitting() : code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", abort);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
