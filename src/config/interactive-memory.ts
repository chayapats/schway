import { Database } from "bun:sqlite";
import { openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfigObject, type ResolvedSettings } from "./config.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";

/** A secret-free, indivisible interactive selection; endpoint details remain in explicit configuration. */
export interface InteractiveChoice {
  provider: ResolvedSettings["provider"];
  model: string;
  openaiAuth?: "codex" | "api-key";
  xaiAuth?: "grok" | "api-key";
  profile?: string;
  thinking?: ResolvedSettings["thinking"];
}

type RecordState = { version: 1; revision: string; choice?: InteractiveChoice };

/** Hold one workspace revision and reject concurrent preference updates instead of overwriting them. */
export class InteractiveMemory {
  private before?: string;
  choice?: InteractiveChoice;
  problem?: string;

  private constructor(private readonly path: string) {}

  /** Read user-owned state using the same canonical primary-workspace identity as execution. */
  static async load(home: string, workspaceRoot: string): Promise<InteractiveMemory> {
    const workspace = await resolveWorkspace(workspaceRoot);
    const key = createHash("sha256").update(workspace.root).digest("hex");
    const memory = new InteractiveMemory(join(home, ".schway", "interactive", `${key}.json`));
    try {
      memory.before = await readOptional(memory.path);
      if (memory.before !== undefined) {
        const record = JSON.parse(memory.before) as RecordState;
        if (record.version !== 1 || typeof record.revision !== "string") throw new Error("Invalid state");
        memory.choice = record.choice === undefined ? undefined : validateChoice(record.choice);
      }
    } catch { memory.problem = "Remembered interactive choice could not be read. Use /model forget to reset it, or choose a model to repair it."; }
    return memory;
  }

  /** Atomically replace or forget this workspace's choice only if its observed revision remains current. */
  async write(choice?: InteractiveChoice, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (choice) validateChoice(choice);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    // SQLite's process lock survives asynchronous file work but is released by the OS on exit.
    // Keep its inode: deleting a lock database would let a contender lock a different file.
    // Never open/close an existing lock inode outside SQLite: POSIX may release this process's locks.
    try { closeSync(openSync(lockPath, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const lock = new Database(lockPath);
    try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
    catch { lock.close(); throw new Error("Interactive memory is being changed by another process. Retry after its update finishes."); }
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      if (await readOptional(this.path) !== this.before) throw new Error("Interactive memory changed in another process. Reopen before choosing again; the newer choice was preserved.");
      const record: RecordState = { version: 1, revision: crypto.randomUUID(), ...(choice ? { choice } : {}) };
      const text = JSON.stringify(record) + "\n";
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      signal?.throwIfAborted();
      await rename(temporary, this.path);
      this.before = text;
      this.choice = choice;
      this.problem = undefined;
    } finally {
      try { await rm(temporary, { force: true }); } finally { lock.close(); }
    }
  }
}

function validateChoice(value: unknown): InteractiveChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid choice");
  const choice = value as InteractiveChoice;
  if (Object.keys(choice).some(key => !["provider", "model", "openaiAuth", "xaiAuth", "profile", "thinking"].includes(key))) throw new Error("Invalid choice fields");
  const parsed = parseConfigObject(choice, "interactive memory");
  if ("error" in parsed || !choice.provider || !choice.model || choice.provider === "openai" && !["codex", "api-key"].includes(choice.openaiAuth ?? "") || choice.provider !== "openai" && choice.openaiAuth !== undefined || choice.profile !== undefined && choice.provider !== "openai-compatible") throw new Error("Invalid choice");
  if (choice.xaiAuth !== undefined && (choice.provider !== "xai" || !["grok", "api-key"].includes(choice.xaiAuth))) throw new Error("Invalid xAI choice");
  return structuredClone(choice);
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
