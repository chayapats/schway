import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inventorySessions, isSafeSessionIdentity, type SessionInventory } from "../session/discovery.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";

/** Validated discovery flags; no runtime, provider, auth, or mutation options are accepted. */
export interface SessionsArguments {
  workspace?: string;
  all: boolean;
  limit: number;
  offset: number;
  preview: boolean;
  json: boolean;
  help: boolean;
}

/** Parse arguments after `sessions`, rejecting usage before any storage or setup work. */
export function parseSessionsArguments(args: readonly string[]): SessionsArguments {
  const result: SessionsArguments = { all: false, limit: 20, offset: 0, preview: false, json: false, help: false };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { ...result, help: true };
  if (args[0] !== "list") throw new Error("Use sessions list · Run schway sessions --help");
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    if (seen.has(flag)) throw new Error("Repeated option · Supply each sessions option once");
    seen.add(flag);
    if (["--all", "--preview", "--json", "--help", "-h"].includes(flag)) {
      if (separator >= 0) throw new Error("Unexpected option value · Run schway sessions --help");
      if (flag === "--all") result.all = true;
      else if (flag === "--preview") result.preview = true;
      else if (flag === "--json") result.json = true;
      else result.help = true;
      continue;
    }
    if (!["--workspace", "--limit", "--offset"].includes(flag)) throw new Error("Unsupported sessions option · Run schway sessions --help");
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || !value.trim() || value.startsWith("--")) throw new Error("Missing option value · Run schway sessions --help");
    if (flag === "--workspace") result.workspace = value;
    else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid page value · Use whole numbers for limit and offset");
      if (flag === "--limit") result.limit = Number(value);
      else result.offset = Number(value);
    }
  }
  if (result.all && result.workspace !== undefined) throw new Error("Conflicting workspace options · Choose --workspace or --all");
  if (result.limit < 1 || result.limit > 100) throw new Error("Invalid limit · Use a whole number from 1 to 100");
  return result;
}

/** Offline command help, including scope, preview limitations, and explicit resume guidance. */
export function sessionsHelp(): string {
  return `Usage: schway sessions list [options]

Browse saved work without resuming or changing it.

  --workspace <path>  Show the canonical workspace containing this directory
  --all               Show saved work across workspaces
  --limit <n>         Show 1–100 sessions (default: 20)
  --offset <n>        Skip matching sessions (default: 0)
  --preview           Include a short task excerpt
  --json              Write one JSON inventory object
  -h, --help          Show this help

Defaults to the launch directory's primary workspace.
Resume explicitly: schway --resume <session-id> -p "<task>"
Supply your configured model and route when starting or resuming work.
Excerpts may contain user-sensitive content; arbitrary secrets are not detected.
Sensitive identifiers are omitted with a partial result. IDs are never changed.
Large histories receive bounded validation; resume performs full validation.
Concurrent changes can move offset pages between invocations.
`;
}

/** Explicit command capabilities; listing uses only HOME, known environment secrets, workspace identity and storage. */
export interface SessionsCommandIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** Run the standalone command module, emitting one inventory and returning 0, 1, or 2 without loading application setup. */
export async function runSessionsCommand(args: readonly string[], io: SessionsCommandIo): Promise<number> {
  let options: SessionsArguments;
  try { options = parseSessionsArguments(args); }
  catch (error) { io.stderr.write(`${(error as Error).message}\n`); return 2; }
  if (options.help) { io.stdout.write(sessionsHelp()); return 0; }
  const env = io.env ?? process.env;
  const secrets = Object.entries(env).flatMap(([name, value]) => /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && value ? [value] : []);
  let result: SessionInventory = { schemaVersion: 1, scope: { all: options.all }, limit: options.limit, offset: options.offset, hasMore: false, status: "error", sessions: [], warnings: [] };
  try {
    if (!env.HOME?.trim()) throw new Error("HOME unavailable · Set HOME to your user directory and retry");
    let workspace: string | undefined;
    if (!options.all) {
      const path = resolve(io.cwd ?? process.cwd(), options.workspace ?? ".");
      try {
        if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
        await access(path, constants.R_OK | constants.X_OK);
        workspace = (await resolveWorkspace(path)).root;
      } catch { throw new Error("Workspace unavailable · Choose an accessible directory with --workspace"); }
    }
    if (workspace && isSafeSessionIdentity(workspace, secrets)) result.scope.workspace = workspace;
    result = await inventorySessions({ home: env.HOME, workspace, all: options.all, limit: options.limit, offset: options.offset, preview: options.preview, secrets, signal: io.signal });
  } catch (error) {
    result.warnings = [(error as Error).message];
  }
  io.stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatSessionInventory(result));
  for (const warning of result.warnings) io.stderr.write(`${warning}\n`);
  return result.status === "complete" ? 0 : 1;
}

/** Format exact IDs and bounded evidence without inserting TUI action hints into machine state. */
export function formatSessionInventory(result: SessionInventory): string {
  if (!result.sessions.length) return result.status === "complete" ? 'No saved work · Run schway -p "<task>" to start\nResume saved work: schway --resume <session-id> -p "<task>"\n' : "";
  const lines = result.sessions.map(row => [row.id, row.activityAt ?? row.createdAt ?? "Unknown time", row.workspaceRoot ?? "Unknown workspace", row.state, ...(row.preview === undefined ? [] : [row.preview])].join(" · "));
  lines.push('Resume saved work: schway --resume <session-id> -p "<task>"');
  return `${lines.join("\n")}\n`;
}
