import { THINKING_LEVELS } from "../model/model.ts";
import type { ConfigLayer } from "../config/config.ts";
import { removedProviderMessage } from "../config/removed-provider.ts";
import { PROFILE_NAME_PATTERN, isValidProfileName } from "../config/profile-name.ts";

/** Provider families accepted by the CLI without loading a provider adapter. */
export const CLI_PROVIDERS = ["openai", "xai", "openai-compatible"] as const;

/** Reasoning levels accepted by the CLI in increasing strength. */
export const CLI_THINKING_LEVELS = THINKING_LEVELS;

/** OpenAI credential preferences accepted by the CLI. */
export const CLI_OPENAI_AUTH_MODES = ["auto", "codex", "api-key"] as const;

/** xAI credential preferences accepted by the CLI. */
export const CLI_XAI_AUTH_MODES = ["auto", "grok", "api-key"] as const;

/** Authentication policies accepted for compatible endpoints. */
export const CLI_AUTH_MODES = ["required", "optional", "none"] as const;

/** Built-in provider families selectable for headless or interactive CLI runs. */
export type CliProvider = (typeof CLI_PROVIDERS)[number];

/** Authentication mode for OpenAI-compatible endpoints. */
export type CliAuthMode = (typeof CLI_AUTH_MODES)[number];

/** OpenAI credential preference selecting subscription login, API key, or automatic headless-safe choice. */
export type CliOpenAIAuth = (typeof CLI_OPENAI_AUTH_MODES)[number];

/** Provider-independent reasoning level selectable from config and the CLI. */
export type CliThinking = (typeof CLI_THINKING_LEVELS)[number];

/** Parsed CLI options for headless or interactive runs, with `resume` identifying a session rather than a path. */
export interface CliArgs {
  prompt?: string;
  json: boolean;
  debug?: boolean;
  debugFile?: string;
  provider?: CliProvider;
  model?: string;
  profile?: string;
  thinking?: CliThinking;
  apiKey?: string;
  resume?: string;
  branch?: string;
  help: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  auth?: CliAuthMode;
  openaiAuth?: CliOpenAIAuth;
  xaiAuth?: (typeof CLI_XAI_AUTH_MODES)[number];
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
    if (arg === "--debug") {
      args.debug = true;
      continue;
    }
    if (arg === "--debug-file" || arg.startsWith("--debug-file=")) {
      const equals = arg.startsWith("--debug-file=");
      const value = equals ? arg.slice("--debug-file=".length) : argv[i + 1];
      if (!value || (!equals && value.startsWith("-"))) return { error: "Missing value for --debug-file" };
      if (!equals) i++;
      args.debugFile = value;
      args.debug = true;
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
    if (arg === "--branch" || arg.startsWith("--branch=")) {
      const value = arg === "--branch" ? argv[++i] : arg.slice("--branch=".length);
      if (!value || value.startsWith("-")) return { error: "Missing value for --branch" };
      args.branch = value;
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
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --profile" };
      }
      i++;
      const profile = parseProfile(value);
      if (typeof profile === "object") {
        return profile;
      }
      args.profile = profile;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const profile = parseProfile(arg.slice("--profile=".length));
      if (typeof profile === "object") {
        return profile;
      }
      args.profile = profile;
      continue;
    }
    if (arg === "--thinking") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --thinking" };
      }
      i++;
      const thinking = parseThinking(value);
      if (typeof thinking === "object") {
        return thinking;
      }
      args.thinking = thinking;
      continue;
    }
    if (arg.startsWith("--thinking=")) {
      const thinking = parseThinking(arg.slice("--thinking=".length));
      if (typeof thinking === "object") {
        return thinking;
      }
      args.thinking = thinking;
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
    if (arg === "--openai-auth") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "Missing value for --openai-auth" };
      }
      i++;
      const openaiAuth = parseOpenAIAuth(value);
      if (typeof openaiAuth === "object") {
        return openaiAuth;
      }
      args.openaiAuth = openaiAuth;
      continue;
    }
    if (arg.startsWith("--openai-auth=")) {
      const openaiAuth = parseOpenAIAuth(arg.slice("--openai-auth=".length));
      if (typeof openaiAuth === "object") {
        return openaiAuth;
      }
      args.openaiAuth = openaiAuth;
      continue;
    }
    if (arg === "--xai-auth" || arg.startsWith("--xai-auth=")) {
      const value = arg === "--xai-auth" ? argv[++i] : arg.slice("--xai-auth=".length);
      if (value === undefined || value.startsWith("-")) return { error: "Missing value for --xai-auth" };
      if (!CLI_XAI_AUTH_MODES.includes(value as NonNullable<CliArgs["xaiAuth"]>)) return { error: `Unknown xAI auth preference: ${value} · Use auto, grok, or api-key` };
      args.xaiAuth = value as NonNullable<CliArgs["xaiAuth"]>; continue;
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

/** Accept the supported provider families; a removed provider fails with its migration notice. */
function parseProvider(value: string): CliProvider | { error: string } {
  const removed = removedProviderMessage(value);
  if (removed !== undefined) {
    return { error: removed };
  }
  if (CLI_PROVIDERS.includes(value as CliProvider)) {
    return value as CliProvider;
  }
  return { error: `Unknown provider: ${value}` };
}

/** Parse `Name:Value` into a single header map entry. */
function parseHeader(
  value: string,
): { name: string; value: string } | { error: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { error: "Invalid --header · Use Name:Value" };
  }
  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (name.length === 0) {
    return { error: "Invalid --header · Use Name:Value" };
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
      return { error: "Invalid --body · Use a JSON object" };
    }
    return { fields: parsed as Record<string, unknown> };
  } catch {
    return { error: "Invalid --body · Use a JSON object" };
  }
}

/** Accept required, optional, or none authentication for compatible endpoints. */
function parseAuth(value: string): CliAuthMode | { error: string } {
  if (CLI_AUTH_MODES.includes(value as CliAuthMode)) {
    return value as CliAuthMode;
  }
  return {
    error: `Unknown auth mode: ${value} · Use required, optional, or none`,
  };
}

/** Accept the OpenAI credential preference separately from compatible auth modes. */
function parseOpenAIAuth(value: string): CliOpenAIAuth | { error: string } {
  const preference = value.trim().toLowerCase();
  if (CLI_OPENAI_AUTH_MODES.includes(preference as CliOpenAIAuth)) {
    return preference as CliOpenAIAuth;
  }
  return {
    error: `Unknown OpenAI auth preference: ${value} · Use auto, codex, or api-key`,
  };
}

/** Validate a provider-independent thinking level without assuming identical wire semantics. */
function parseThinking(value: string): CliThinking | { error: string } {
  const level = value.trim().toLowerCase();
  if (CLI_THINKING_LEVELS.includes(level as CliThinking)) {
    return level as CliThinking;
  }
  return {
    error: `Unknown thinking level: ${value} · Use off, minimal, low, medium, high, xhigh, max, or ultra`,
  };
}

/** Validate a named compatible profile selection without loading configuration. */
function parseProfile(value: string): string | { error: string } {
  const name = value.trim();
  if (!isValidProfileName(name)) {
    return {
      error: `Invalid profile "${value}". Profile names must match ${PROFILE_NAME_PATTERN}.`,
    };
  }
  return name;
}

/**
 * Connection flags with an explicit non-compatible provider are invalid.
 * Profile selection implies the compatible provider; unknown profiles fail after config merge.
 * Missing baseUrl is checked after config merge so project config can supply it.
 */
function validateConnectionOptions(
  args: CliArgs,
): { args: CliArgs } | { error: string } {
  const hasConnection =
    args.baseUrl !== undefined ||
    args.headers !== undefined ||
    args.extraBody !== undefined ||
    args.auth !== undefined ||
    args.profile !== undefined;
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
  if (args.branch !== undefined && !args.resume && !args.help) return { error: "--branch requires --resume <session-id>" };
  if (args.openaiAuth !== undefined && args.provider !== undefined && args.provider !== "openai") {
    return { error: "OpenAI auth preference requires --provider openai" };
  }
  if (args.xaiAuth !== undefined && args.provider !== undefined && args.provider !== "xai") return { error: "xAI auth preference requires --provider xai" };
  return { args };
}

/** True when explicit CLI flags require the OpenAI-compatible provider after config resolution. */
export function hasCliConnectionOptions(args: CliArgs): boolean {
  return args.baseUrl !== undefined || args.headers !== undefined || args.extraBody !== undefined ||
    args.auth !== undefined || args.profile !== undefined;
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
  if (args.profile !== undefined) {
    layer.profile = args.profile;
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
  if (args.xaiAuth !== undefined) layer.xaiAuth = args.xaiAuth;
  if (args.openaiAuth !== undefined) {
    layer.openaiAuth = args.openaiAuth;
  }
  if (args.thinking !== undefined) {
    layer.thinking = args.thinking;
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
