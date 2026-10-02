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

  private constructor(private readonly path: string, private readonly globalPath: string) {}

  /** Read user-owned state using the same canonical primary-workspace identity as execution. */
  static async load(home: string, workspaceRoot: string): Promise<InteractiveMemory> {
    const workspace = await resolveWorkspace(workspaceRoot);
    const key = createHash("sha256").update(workspace.root).digest("hex");
    const directory = join(home, ".schway", "interactive");
    const memory = new InteractiveMemory(join(directory, `${key}.json`), join(directory, "global", "latest.json"));
    try {
      memory.before = await readOptional(memory.path);
      if (memory.before !== undefined) {
        memory.choice = readChoice(memory.before);
      } else {
        const global = await readOptional(memory.globalPath);
        if (global !== undefined) {
          const choice = readChoice(global);
          if (choice && !isPortableChoice(choice)) throw new Error("Invalid global choice");
          memory.choice = choice;
        }
      }
    } catch { memory.problem = "Remembered interactive choice could not be read. Use /model forget to reset it, or choose a model to repair it."; }
    return memory;
  }

  /** Replace this workspace's observed revision and optionally publish an eligible successful choice for new workspaces. */
  async write(choice?: InteractiveChoice, signal?: AbortSignal, share = false): Promise<void> {
    signal?.throwIfAborted();
    if (choice) choice = validateChoice(choice);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(this.path);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    const globalTemporary = `${this.globalPath}.${crypto.randomUUID()}.tmp`;
    let global: Database | undefined;
    try {
      if (await readOptional(this.path) !== this.before) throw new Error("Workspace choice changed · Reopen before choosing again");
      const record: RecordState = { version: 1, revision: crypto.randomUUID(), ...(choice ? { choice } : {}) };
      const text = JSON.stringify(record) + "\n";
      if (share && choice && isPortableChoice(choice)) {
        await mkdir(dirname(this.globalPath), { recursive: true, mode: 0o700 });
        global = acquireLock(this.globalPath);
        await stageRecord(globalTemporary, text);
      }
      await stageRecord(temporary, text);
      signal?.throwIfAborted();
      await rename(temporary, this.path);
      // The workspace rename is the commit point. Adopt its revision even if global publication fails.
      this.before = text;
      this.choice = choice;
      this.problem = undefined;
      if (global) {
        try { await rename(globalTemporary, this.globalPath); }
        catch (cause) { throw new Error("Workspace choice saved · Retry to update new workspaces", { cause }); }
      }
    } finally {
      try { await Promise.all([rm(temporary, { force: true }), ...(global ? [rm(globalTemporary, { force: true })] : [])]); }
      finally { global?.close(); lock.close(); }
    }
  }
}

function readChoice(text: string): InteractiveChoice | undefined {
  const record = JSON.parse(text) as RecordState;
  if (!record || record.version !== 1 || typeof record.revision !== "string") throw new Error("Invalid state");
  return record.choice === undefined ? undefined : validateChoice(record.choice);
}

function acquireLock(path: string): Database {
  const lockPath = `${path}.lock`;
  // Keep the inode, and never open/close an existing lock outside SQLite: POSIX can drop our locks.
  // The OS releases ownership on process exit, including SIGKILL.
  try { closeSync(openSync(lockPath, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const lock = new Database(lockPath);
  try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
  catch { lock.close(); throw new Error("Workspace choice is updating · Retry when finished"); }
  return lock;
}

async function stageRecord(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}

function isPortableChoice(choice: InteractiveChoice): boolean {
  return choice.provider !== "openai-compatible" && (choice.provider !== "xai" || choice.xaiAuth !== undefined);
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
