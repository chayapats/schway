import { version } from "../../package.json";
import { createRenewalExit } from "./renewal-exit.ts";
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

/** Process entrypoint for the `schway` binary. */
async function main(): Promise<number> {
  const controller = new AbortController();
  // A renewal whose request already left may have rotated the refresh token at the provider; exiting before it is
  // stored would force a new sign-in, so the exit waits for it within bounds that signals can shorten.
  const exit = createRenewalExit({ stderr: { write: (chunk) => void process.stderr.write(chunk) }, interactive: process.stdin.isTTY === true });
  const interrupt = () => {
    controller.abort();
    exit.interrupt();
  };
  const terminate = () => {
    controller.abort();
    exit.terminate();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await exit.settle(await runCli(process.argv.slice(2), {
      stdout: { write: (chunk) => void process.stdout.write(chunk) },
      stderr: { write: (chunk) => void process.stderr.write(chunk) },
      env: process.env,
      cwd: process.cwd(),
      terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      signal: controller.signal,
    }));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
