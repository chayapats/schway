import { resolve } from "node:path";
import { cliOverridesFromArgs, hasCliConnectionOptions, parseArgs, type CliArgs } from "./args.ts";
import { projectConfigPath, readConfigLayers, resolveSettings, userConfigPath, type ConfigLayer, type CompatibleProfile, type ParsedConfigLayer } from "../config/config.ts";
import { configDiagnosticSecrets, type ConfigDiagnosticContext } from "../config/diagnostics.ts";
import type { ConfigDeprecation } from "../config/deprecations.ts";
import { applyEnvFiles } from "../config/env-file.ts";
import { discoverModels, heuristicCatalogSecrets, safeCatalogMessage, type CatalogConnection, type CatalogDiscoveryDeps, type ModelCatalog } from "../model/catalog-discovery.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";

/** Catalog-only arguments, without task execution, model selection or session options. */
export interface ModelsArgs extends Pick<CliArgs, "provider" | "profile" | "baseUrl" | "headers" | "auth" | "openaiAuth" | "xaiAuth" | "apiKey" | "envFiles" | "help" | "json"> {
  offline: boolean;
  filter?: string;
}

const VALUE_FLAGS = new Set(["--provider", "--profile", "--base-url", "--header", "--auth", "--openai-auth", "--xai-auth", "--api-key", "--env-file", "--filter"]);

/** Parse the complete models command before any setup or external I/O; errors never echo argument values. */
export function parseModelsCommand(argv: readonly string[]): { args: ModelsArgs } | { error: string } {
  const usage = "Use schway models list --help for catalog options.";
  if (argv[0] !== "models" || (argv[1] !== "list" && argv[1] !== "--help" && argv[1] !== "-h")) return { error: `Expected schway models list. ${usage}` };
  if (argv.length === 2 && argv[1] !== "list") return { args: { help: true, json: false, offline: false } };
  if (argv[1] !== "list") return { error: `Use schway models --help on its own. ${usage}` };
  const connection: string[] = [];
  let offline = false, filter: string | undefined;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (argument === "--offline") { offline = true; continue; }
    if (["--json", "--help", "-h"].includes(argument)) { connection.push(argument); continue; }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unsupported models-list option. ${usage}` };
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("-"))) return { error: `Missing value for ${flag}. ${usage}` };
    if (!value.trim()) return { error: `Supply a nonempty value for ${flag}. ${usage}` };
    if (flag === "--filter") { filter = value; continue; }
    connection.push(`${flag}=${value}`);
  }
  const parsed = parseArgs(connection);
  if ("error" in parsed) return { error: `Invalid connection options. ${usage}` };
  return { args: { ...parsed.args, offline, ...(filter !== undefined ? { filter } : {}) } };
}

/** Explain route selection, output fields and catalog-only operation without loading a provider. */
export const MODELS_HELP = `Usage: schway models list [options]

List models for one connection without sending a prompt.

Options:
  --provider <name>       openai, xai or openai-compatible
  --profile <name>        Select a saved compatible profile
  --openai-auth <route>   auto, codex or api-key
  --xai-auth <route>      auto, grok or api-key
  --base-url <url>        Compatible endpoint base URL
  --auth <mode>           Compatible auth: required, optional or none
  --api-key <key>         Runtime key for the selected API route
  --header <name:value>   Runtime compatible endpoint header; repeatable
  --env-file <path>       Explicit env file; repeatable, later files win
  --offline              Built-in metadata; account access unverified
  --filter <text>         Literal, case-insensitive model ID substring
  --json                 One versioned catalog object, without JSONL
  --help, -h             Show this help

Online discovery has one five-second deadline, including token refresh.
It never switches billing routes after a selected connection fails.
Offline auto leaves the route unresolved and never checks credentials.
Listed IDs do not guarantee live access. Unknown IDs remain accepted by
schway -p <prompt> --model <id>.

JSON: schemaVersion, provider, route, source, status, models and warnings.
Optional profile names the resolved compatible profile. Model rows may
include contextWindow, maxOutput, supportedThinking and recommended;
unreported capability fields are omitted. Provider is null only on an
error before provider resolution; that error uses route unresolved.
Exit codes: 0 complete, 1 partial/error/cancelled, 2 invalid arguments.
`;

function connectionLayer(layer?: ConfigLayer): ConfigLayer | undefined {
  if (!layer) return undefined;
  const projected: ConfigLayer = {};
  for (const key of ["provider", "profile", "baseUrl", "headers", "auth", "openaiAuth", "xaiAuth"] as const) {
    const value = layer[key];
    if (value !== undefined) (projected as Record<string, unknown>)[key] = value;
  }
  if (layer.profiles) {
    projected.profiles = Object.fromEntries(Object.entries(layer.profiles).map(([name, profile]) => {
      const { model: _model, contextWindow: _context, maxOutput: _output, extraBody: _body, ...connection } = profile;
      return [name, connection as CompatibleProfile];
    }));
  }
  return projected;
}

/** Reuse config/profile precedence while ignoring valid execution-only choices and interactive memory. */
export function resolveModelsConnection(input: { user?: ConfigLayer; project?: ConfigLayer; args: ModelsArgs;
  configSources?: { user?: string; project?: string }; diagnosticContext?: ConfigDiagnosticContext;
}): CatalogConnection | { error: string } {
  const cliArgs: CliArgs = { ...input.args };
  const settings = resolveSettings({ user: connectionLayer(input.user), project: connectionLayer(input.project), cli: connectionLayer(cliOverridesFromArgs(cliArgs)),
    configSources: input.configSources, diagnosticContext: input.diagnosticContext });
  if ("error" in settings) return settings;
  if (hasCliConnectionOptions(cliArgs) && settings.provider !== "openai-compatible") return { error: "Connection options require --provider openai-compatible." };
  if (input.args.openaiAuth && settings.provider !== "openai") return { error: "OpenAI auth requires --provider openai." };
  if (input.args.xaiAuth && settings.provider !== "xai") return { error: "xAI auth requires --provider xai." };
  return settings;
}

/** Format exact IDs with observed metadata and explicit source/route information. */
export function formatModelCatalog(catalog: ModelCatalog): string {
  const lines = [`Models · ${catalog.provider ?? "unresolved"} · ${catalog.route} · ${catalog.source} · ${catalog.status}`];
  for (const model of catalog.models) {
    const details = [model.contextWindow !== undefined ? `context ${model.contextWindow}` : undefined,
      model.maxOutput !== undefined ? `max output ${model.maxOutput}` : undefined,
      model.supportedThinking ? `thinking ${model.supportedThinking.join(", ")}` : undefined,
      model.recommended ? "recommended" : undefined].filter(Boolean);
    lines.push(`${model.id}${details.length ? `  ${details.join(" · ")}` : ""}`);
  }
  for (const warning of catalog.warnings) lines.push(warning);
  return `${lines.join("\n")}\n`;
}

/** Inject setup reads and output sinks so the standalone command cannot create execution state. */
export interface ModelsCommandIO extends CatalogDiscoveryDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  configDeprecations?: readonly ConfigDeprecation[];
  /** Validate files normally before returning their layers; pass known secrets to config diagnostics. */
  loadConfig?(context: { env: Record<string, string | undefined>; runtimeApiKey?: string; headers?: Record<string, string>; diagnosticContext: ConfigDiagnosticContext }): Promise<{
    user?: ParsedConfigLayer; project?: ParsedConfigLayer; configSources?: { user?: string; project?: string };
  } | { error: string }>;
  loadEnv?: typeof applyEnvFiles;
}

/** Read ordinary config scopes without execution setup, preserving source provenance and invocation-local secrets. */
async function loadModelsConfig(home: string | undefined, io: ModelsCommandIO, diagnosticContext: ConfigDiagnosticContext) {
  if (!home) return { error: "Configuration unavailable · Set HOME and retry schway models list." };
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try { workspace = await resolveWorkspace(io.cwd); }
  catch { return { error: "Workspace unavailable · Check the launch directory and retry schway models list." }; }
  const layers = await readConfigLayers({ home, workspaceRoot: workspace.root, configDeprecations: io.configDeprecations, diagnosticContext });
  return "error" in layers ? layers : { ...layers, configSources: { user: userConfigPath(home), project: projectConfigPath(workspace.root) } };
}

/** Collect effective environment secrets before config paths can be truncated by diagnostic formatting. */
function rememberDiagnosticEnv(context: ConfigDiagnosticContext, env: Record<string, string | undefined>): void {
  context.env = env;
  (context.secrets ??= []).push(...heuristicCatalogSecrets(env));
  configDiagnosticSecrets(context);
}

/** Resolve one catalog connection with read-only setup, then emit one result without creating execution state. */
export async function runModelsCommand(argv: readonly string[], io: ModelsCommandIO): Promise<0 | 1 | 2> {
  const parsed = parseModelsCommand(argv);
  if ("error" in parsed) { io.stderr.write(`${parsed.error}\n`); return 2; }
  const args = parsed.args;
  if (args.help) { io.stdout.write(MODELS_HELP); return 0; }
  let provider = args.provider ?? null;
  let env = io.env;
  const home = io.env.HOME;
  const diagnosticContext: ConfigDiagnosticContext = { env, observedEnvs: [{ ...env }], secrets: [args.apiKey, ...Object.values(args.headers ?? {})]
    .filter((value): value is string => !!value) };
  rememberDiagnosticEnv(diagnosticContext, env);
  configDiagnosticSecrets(diagnosticContext, [{ apiKey: args.apiKey, headers: args.headers }]);
  try {
    if (args.envFiles?.length) {
      const loaded = await (io.loadEnv ?? applyEnvFiles)(args.envFiles.map(path => resolve(io.cwd, path)), env);
      if ("error" in loaded) throw new Error("Could not read an explicit env file. Check --env-file and retry schway models list.");
      env = loaded;
    }
    rememberDiagnosticEnv(diagnosticContext, env);
    const layers = await (io.loadConfig ? io.loadConfig({ env, runtimeApiKey: args.apiKey, headers: args.headers, diagnosticContext }) : loadModelsConfig(home, io, diagnosticContext));
    if ("error" in layers) throw new Error(layers.error);
    configDiagnosticSecrets(diagnosticContext, [layers.user, layers.project]);
    const warnings = new Set([...(layers.user?.deprecationWarnings ?? []), ...(layers.project?.deprecationWarnings ?? [])].map(warning => warning.message));
    for (const warning of warnings) io.stderr.write(`${safeCatalogMessage(warning, diagnosticContext.secrets)}\n`);
    const connection = resolveModelsConnection({ ...layers, args, diagnosticContext });
    if ("error" in connection) throw new Error(connection.error);
    provider = connection.provider;
    const result = await discoverModels({ ...connection, env, runtimeApiKey: args.apiKey, knownSecrets: diagnosticContext.secrets,
      offline: args.offline, filter: args.filter, signal: io.signal }, io);
    io.stdout.write(args.json ? `${JSON.stringify(result.catalog)}\n` : formatModelCatalog(result.catalog));
    if (result.error) io.stderr.write(`${result.error}\n`);
    else if (result.catalog.status === "partial") for (const warning of result.catalog.warnings) io.stderr.write(`${warning}\n`);
    return result.catalog.status === "complete" ? 0 : 1;
  } catch (error) {
    const message = safeCatalogMessage(error instanceof Error ? error.message : "Could not resolve model discovery settings. Check configuration and retry schway models list.", diagnosticContext.secrets);
    const catalog: ModelCatalog = { schemaVersion: 1, provider, route: "unresolved", source: args.offline ? "builtin" : "remote", status: "error", models: [], warnings: [message] };
    io.stdout.write(args.json ? `${JSON.stringify(catalog)}\n` : formatModelCatalog(catalog));
    io.stderr.write(`${message}\n`);
    return 1;
  }
}
