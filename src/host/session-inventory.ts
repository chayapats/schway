import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HostError, type HostSessionReference } from "./index.ts";

/** Metadata for management of one native identity; the stable main branch never selects saved work for execution. */
export interface HostSessionInventoryEntry {
  readonly reference: HostSessionReference;
  readonly state: "active" | "retired" | "deleted";
}

/** Limit returned metadata entries in lexical order within one store and canonical primary workspace. */
export interface HostSessionInventoryOptions {
  readonly limit?: number;
  readonly after?: string;
}

/** An advisory metadata page whose cursor resumes after its last returned workspace identity. */
export interface HostSessionInventoryPage {
  readonly sessions: readonly HostSessionInventoryEntry[];
  readonly next?: string;
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read a bounded first metadata record without following aliases, loading history or repairing files. */
async function metadata(path: string): Promise<Record<string, unknown> | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new HostError("conflict");
    throw new HostError("storage");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new HostError("conflict");
    const bytes = Buffer.alloc(8192);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const end = text.indexOf("\n");
    if (end < 0 && bytesRead === bytes.length) throw new HostError("storage");
    const value: unknown = JSON.parse(end < 0 ? text : text.slice(0, end));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostError("storage");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError("storage");
  } finally { await file.close(); }
}

/** Enumerate management metadata without acquiring execution authority or touching conversation records. @internal */
export async function managedSessionInventory(directory: string, workspaceRoot: string, options: HostSessionInventoryOptions = {}): Promise<HostSessionInventoryPage> {
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["limit", "after"].includes(key)) ||
      (options.after !== undefined && (typeof options.after !== "string" || !idPattern.test(options.after)))) throw new HostError("invalid-input");
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HostError("invalid-input");
  let names: string[];
  try { names = await readdir(directory); } catch { throw new HostError("storage"); }
  const ids = [...new Set(names.flatMap(name => {
    const match = /^(.+)(?:\.jsonl|\.host-retired)$/.exec(name);
    return match && idPattern.test(match[1]!) ? [match[1]!] : [];
  }))].filter(id => options.after === undefined || id > options.after).sort();
  const sessions: HostSessionInventoryEntry[] = [];
  let more = false;
  // Scan through foreign ranges internally; no foreign UUID may escape through a cursor.
  for (const id of ids) {
    const header = await metadata(join(directory, `${id}.jsonl`));
    const retired = await metadata(join(directory, `${id}.host-retired`));
    if (header && (header.type !== "session" || header.id !== id || !Number.isSafeInteger(header.version) ||
        (header.version as number) < 1 || (header.version as number) > 4 || typeof header.workspaceRoot !== "string" ||
        !Array.isArray(header.extraRoots))) throw new HostError("storage");
    if (retired && (retired.version !== 1 || retired.id !== id || typeof retired.workspaceRoot !== "string")) throw new HostError("storage");
    if (header && retired && header.workspaceRoot !== retired.workspaceRoot) throw new HostError("conflict");
    if ((header ?? retired)?.workspaceRoot !== workspaceRoot) continue;
    if (header && (header.extraRoots as unknown[]).length) continue;
    if (sessions.length === limit) { more = true; break; }
    sessions.push(Object.freeze({ reference: Object.freeze({ id, branchId: "main" }), state: retired ? header ? "retired" : "deleted" : "active" }));
  }
  return Object.freeze({ sessions: Object.freeze(sessions), ...(more ? { next: sessions.at(-1)!.reference.id } : {}) });
}
