import { version } from "../../package.json";
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
  const abort = () => {
    controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await runCli(process.argv.slice(2), {
      stdout: { write: (chunk) => void process.stdout.write(chunk) },
      stderr: { write: (chunk) => void process.stderr.write(chunk) },
      env: process.env,
      cwd: process.cwd(),
      terminal: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
