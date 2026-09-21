export const USAGE =
  "Usage: schway -p <prompt> [--json] [--provider <name>] [--model <id>] [--api-key <key>] [--resume <session-id>] [--base-url <url>] [--header <name:value>] [--body <json>] [--auth <mode>]";

/** Built-in provider families selectable from the headless CLI. */
export type CliProvider = "anthropic" | "openai" | "openai-compatible";

/** Authentication mode for OpenAI-compatible endpoints. */
export type CliAuthMode = "required" | "optional" | "none";

/** Headless flags. `resume` is a session id, not a file path. */
export interface CliArgs {
  prompt?: string;
  json: boolean;
  provider: CliProvider;
  model?: string;
  apiKey?: string;
  resume?: string;
  help: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: CliAuthMode;
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
 * Compatible endpoints need a base URL; connection flags are invalid on
 * other providers.
 */
function validateConnectionOptions(
  args: CliArgs,
): { args: CliArgs } | { error: string } {
  if (args.provider === "openai-compatible") {
    const baseUrl = args.baseUrl?.trim() ?? "";
    if (baseUrl.length === 0) {
      return { error: "Missing --base-url for OpenAI-compatible provider" };
    }
    return { args: { ...args, baseUrl, auth: args.auth ?? "optional" } };
  }
  if (
    args.baseUrl !== undefined ||
    args.headers !== undefined ||
    args.extraBody !== undefined ||
    args.auth !== undefined
  ) {
    return {
      error:
        "OpenAI-compatible connection options require --provider openai-compatible",
    };
  }
  return { args };
}
