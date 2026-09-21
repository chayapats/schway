export const USAGE =
  'Usage: schway -p <prompt> [--json] [--provider <name>] [--model <id>] [--api-key <key>] [--resume <session-id>]';

/** Built-in provider families selectable from the headless CLI. */
export type CliProvider = "anthropic" | "openai";

/** Headless flags. `resume` is a session id, not a file path. */
export interface CliArgs {
  prompt?: string;
  json: boolean;
  provider: CliProvider;
  model?: string;
  apiKey?: string;
  resume?: string;
  help: boolean;
}

/** Parse argv. Unknown options and missing flag values return an error. */
export function parseArgs(
  argv: readonly string[],
): { args: CliArgs } | { error: string } {
  const args: CliArgs = { json: false, help: false, provider: "anthropic" };

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
    if (arg === "--provider") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --provider" };
      }
      i++;
      const provider = parseProvider(value);
      if (typeof provider === "object") {
        return provider;
      }
      args.provider = provider;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      const provider = parseProvider(arg.slice("--provider=".length));
      if (typeof provider === "object") {
        return provider;
      }
      args.provider = provider;
      continue;
    }
    if (arg === "--model") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --model" };
      }
      i++;
      args.model = value;
      continue;
    }
    if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    }
    return { error: `Unexpected argument: ${arg}` };
  }

  return { args };
}

/** Accept only the v0.1 native provider families. */
function parseProvider(value: string): CliProvider | { error: string } {
  if (value === "anthropic" || value === "openai") {
    return value;
  }
  return { error: `Unknown provider: ${value}` };
}
