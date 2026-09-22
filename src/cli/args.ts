import type { ConfigLayer } from "../config/config.ts";

/** Usage synopsis printed for help and invalid command-line arguments. */
export const USAGE =
  "Usage: schway [-p <prompt>] [--json] [--provider <name>] [--model <id>] [--api-key <key>] [--resume <session-id>] [--base-url <url>] [--header <name:value>] [--body <json>] [--auth <mode>] [--max-turns <n>] [--max-output <n>] [--context-window <n>] [--max-concurrent-tools <n>] [--env-file <path>] [--extension <local-module>] [--add-dir <directory>]";

/** Built-in provider families selectable for headless or interactive CLI runs. */
export type CliProvider = "anthropic" | "openai" | "openai-compatible";

/** Authentication mode for OpenAI-compatible endpoints. */
export type CliAuthMode = "required" | "optional" | "none";

/** Parsed CLI options for headless or interactive runs, with `resume` identifying a session rather than a path. */
export interface CliArgs {
  prompt?: string;
  json: boolean;
  provider?: CliProvider;
  model?: string;
  apiKey?: string;
  resume?: string;
  help: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: CliAuthMode;
  maxTurns?: number;
  maxConcurrentTools?: number;
  contextWindow?: number;
  maxOutput?: number;
  envFiles?: string[];
  extensions?: string[];
  addDirs?: string[];
}

/** Parse argv. Unknown options and missing flag values return an error. */
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
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --base-url" };
      }
      i++;
      args.baseUrl = value;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      args.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg === "--header") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --header" };
      }
      i++;
      const header = parseHeader(value);
      if ("error" in header) {
        return header;
      }
      args.headers = { ...args.headers, [header.name]: header.value };
      continue;
    }
    if (arg.startsWith("--header=")) {
      const header = parseHeader(arg.slice("--header=".length));
      if ("error" in header) {
        return header;
      }
      args.headers = { ...args.headers, [header.name]: header.value };
      continue;
    }
    if (arg === "--body") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --body" };
      }
      i++;
      const body = parseExtraBody(value);
      if ("error" in body) {
        return body;
      }
      args.extraBody = body.fields;
      continue;
    }
    if (arg.startsWith("--body=")) {
      const body = parseExtraBody(arg.slice("--body=".length));
      if ("error" in body) {
        return body;
      }
      args.extraBody = body.fields;
      continue;
    }
    if (arg === "--auth") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --auth" };
      }
      i++;
      const auth = parseAuth(value);
      if (typeof auth === "object") {
        return auth;
      }
      args.auth = auth;
      continue;
    }
    if (arg.startsWith("--auth=")) {
      const auth = parseAuth(arg.slice("--auth=".length));
      if (typeof auth === "object") {
        return auth;
      }
      args.auth = auth;
      continue;
    }
    const intFlag = parseIntegerFlag(arg, argv, i);
    if (intFlag !== undefined) {
      if ("error" in intFlag) {
        return intFlag;
      }
      i = intFlag.index;
      assignIntegerFlag(args, intFlag.name, intFlag.value);
      continue;
    }
    if (arg === "--add-dir" || arg.startsWith("--add-dir=")) {
      const equals = arg.startsWith("--add-dir=");
      const value = equals ? arg.slice("--add-dir=".length) : argv[i + 1];
      if (!value?.trim() || (!equals && value.startsWith("-"))) return { error: "Missing value for --add-dir" };
      if (!equals) i++;
      args.addDirs = [...(args.addDirs ?? []), value];
      continue;
    }
    if (arg === "--extension" || arg.startsWith("--extension=")) {
      const equals = arg.startsWith("--extension=");
      const value = equals ? arg.slice("--extension=".length) : argv[i + 1];
      if (!value || (!equals && value.startsWith("-"))) {
        return { error: "Missing value for --extension" };
      }
      if (!equals) i++;
      args.extensions = [...(args.extensions ?? []), value];
      continue;
    }
    if (arg === "--env-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --env-file" };
      }
      i++;
      args.envFiles = [...(args.envFiles ?? []), value];
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (value.length === 0) {
        return { error: "Missing value for --env-file" };
      }
      args.envFiles = [...(args.envFiles ?? []), value];
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    }
    return { error: `Unexpected argument: ${arg}` };
  }

  return validateConnectionOptions(args);
}

/** Accept the v0.1 provider families, including OpenAI-compatible endpoints. */
function parseProvider(value: string): CliProvider | { error: string } {
  if (
    value === "anthropic" ||
    value === "openai" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  return { error: `Unknown provider: ${value}` };
}

/** Parse `Name:Value` into a single header map entry. */
function parseHeader(
  value: string,
): { name: string; value: string } | { error: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { error: "Invalid --header. Use Name:Value." };
  }
  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (name.length === 0) {
    return { error: "Invalid --header. Use Name:Value." };
  }
  return { name, value: headerValue };
}

/** Parse extra Chat Completions body fields from a JSON object. */
function parseExtraBody(
  value: string,
): { fields: Record<string, unknown> } | { error: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { error: "Invalid --body. Expected a JSON object." };
    }
    return { fields: parsed as Record<string, unknown> };
  } catch {
    return { error: "Invalid --body. Expected a JSON object." };
  }
}

/** Accept required, optional, or none authentication for compatible endpoints. */
function parseAuth(value: string): CliAuthMode | { error: string } {
  if (value === "required" || value === "optional" || value === "none") {
    return value;
  }
  return {
    error: `Unknown auth mode: ${value}. Use required, optional, or none.`,
  };
}

/**
 * Connection flags with an explicit non-compatible provider are invalid.
 * Missing baseUrl is checked after config merge so project config can supply it.
 */
function validateConnectionOptions(
  args: CliArgs,
): { args: CliArgs } | { error: string } {
  const hasConnection =
    args.baseUrl !== undefined ||
    args.headers !== undefined ||
    args.extraBody !== undefined ||
    args.auth !== undefined;
  if (
    hasConnection &&
    args.provider !== undefined &&
    args.provider !== "openai-compatible"
  ) {
    return {
      error:
        "OpenAI-compatible connection options require --provider openai-compatible",
    };
  }
  return { args };
}

/** Map explicitly provided CLI flags onto a config overlay. Omitted flags stay unset. */
export function cliOverridesFromArgs(args: CliArgs): ConfigLayer {
  const layer: ConfigLayer = {};
  if (args.provider !== undefined) {
    layer.provider = args.provider;
  }
  if (args.model !== undefined) {
    layer.model = args.model;
  }
  if (args.maxTurns !== undefined) {
    layer.maxTurns = args.maxTurns;
  }
  if (args.maxConcurrentTools !== undefined) {
    layer.maxConcurrentTools = args.maxConcurrentTools;
  }
  if (args.contextWindow !== undefined) {
    layer.contextWindow = args.contextWindow;
  }
  if (args.maxOutput !== undefined) {
    layer.maxOutput = args.maxOutput;
  }
  if (args.baseUrl !== undefined) {
    layer.baseUrl = args.baseUrl;
  }
  if (args.headers !== undefined) {
    layer.headers = args.headers;
  }
  if (args.extraBody !== undefined) {
    layer.extraBody = args.extraBody;
  }
  if (args.auth !== undefined) {
    layer.auth = args.auth;
  }
  return layer;
}

const INTEGER_FLAGS = {
  "--max-turns": "maxTurns",
  "--max-output": "maxOutput",
  "--context-window": "contextWindow",
  "--max-concurrent-tools": "maxConcurrentTools",
} as const;

type IntegerFlagName = (typeof INTEGER_FLAGS)[keyof typeof INTEGER_FLAGS];

/** Parse `--flag <n>` or `--flag=n` as a positive integer, or undefined if not a known flag. */
function parseIntegerFlag(
  arg: string,
  argv: readonly string[],
  index: number,
):
  | { name: IntegerFlagName; value: number; index: number }
  | { error: string }
  | undefined {
  for (const [flag, name] of Object.entries(INTEGER_FLAGS) as Array<
    [keyof typeof INTEGER_FLAGS, IntegerFlagName]
  >) {
    if (arg === flag) {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("-")) {
        return { error: `Missing value for ${flag}` };
      }
      const value = parsePositiveInt(flag, raw);
      if (typeof value === "object") {
        return value;
      }
      return { name, value, index: index + 1 };
    }
    if (arg.startsWith(`${flag}=`)) {
      const raw = arg.slice(`${flag}=`.length);
      const value = parsePositiveInt(flag, raw);
      if (typeof value === "object") {
        return value;
      }
      return { name, value, index };
    }
  }
  return undefined;
}

/** Assign a parsed integer CLI flag onto the args object. */
function assignIntegerFlag(
  args: CliArgs,
  name: IntegerFlagName,
  value: number,
): void {
  args[name] = value;
}

/** Reject zero, negatives, and non-integers for bounded numeric flags. */
function parsePositiveInt(
  flag: string,
  raw: string,
): number | { error: string } {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return {
      error: `Invalid value for ${flag}: expected a positive integer`,
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return {
      error: `Invalid value for ${flag}: expected a positive integer`,
    };
  }
  return value;
}
