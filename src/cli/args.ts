export const USAGE =
  'Usage: schway -p <prompt> [--json] [--api-key <key>] [--resume <session-id>]';

export interface CliArgs {
  prompt?: string;
  json: boolean;
  apiKey?: string;
  resume?: string;
  help: boolean;
}

export function parseArgs(
  argv: readonly string[],
): { args: CliArgs } | { error: string } {
  const args: CliArgs = { json: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "-p") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing prompt for -p" };
      }
      i++;
      args.prompt = value;
      continue;
    }
    if (arg.startsWith("-p=")) {
      args.prompt = arg.slice(3);
      continue;
    }
    if (arg === "--api-key") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --api-key" };
      }
      i++;
      args.apiKey = value;
      continue;
    }
    if (arg.startsWith("--api-key=")) {
      args.apiKey = arg.slice("--api-key=".length);
      continue;
    }
    if (arg === "--resume") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --resume" };
      }
      i++;
      args.resume = value;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      args.resume = arg.slice("--resume=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    }
    return { error: `Unexpected argument: ${arg}` };
  }

  return { args };
}
