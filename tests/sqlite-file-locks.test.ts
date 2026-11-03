import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteHistorySession, HISTORY_STORE_BUSY } from "../src/history/store.ts";
import { openUndoStore, UNDO_STORE_BUSY } from "../src/undo/store.ts";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { ModelPreferences } from "../src/config/model-preferences.ts";
import { proveWritable } from "../src/storage/sqlite-file-lock.ts";

const SITE = join(import.meta.dir, "fixtures/sqlite-file-lock/site.ts");
/** Root bypasses permission bits, so permission-denied cases cannot be staged as root. */
const RUNS_AS_ROOT = process.getuid?.() === 0;
/** Child processes get a generous bound for startup under load; refusals are asserted by elapsed lock time instead. */
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;

type LockSite = "history" | "undo" | "memory";
type Site = LockSite | "preferences" | "preferences-read";
const LOCK_SITES: readonly LockSite[] = ["history", "undo", "memory"];

let root: string;
let home: string;
let workspace: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "schway-sqlite-locks-")));
  home = join(root, "home");
  workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const choice = { provider: "openai" as const, model: "gpt-5.4", openaiAuth: "api-key" as const };
const seedIdentity = "b".repeat(64);
const schway = () => join(home, ".schway");
const memoryDirectory = () => join(schway(), "interactive");

/** Run each site once in this process, creating its lock file or database. */
async function seed(site: Site): Promise<void> {
  if (site === "history") await deleteHistorySession({ home, sessionId: "seed" });
  else if (site === "undo") await openUndoStore({ home }).recordShell({ sessionId: "seed", turnId: "seed", turnNumber: 1 }, { detection: "unavailable" });
  else if (site === "memory") await (await InteractiveMemory.load(home, workspace)).write(choice);
  else new ModelPreferences(home).pin(seedIdentity, true);
}

/** The file whose SQLite write lock the site takes. */
function lockPath(site: Site): string {
  if (site === "history") return join(schway(), "history.lock");
  if (site === "undo") return join(schway(), "undo.lock");
  if (site === "memory") {
    const name = readdirSync(memoryDirectory()).find(entry => entry.endsWith(".json.lock"));
    if (!name) throw new Error("memory lock file was not created");
    return join(memoryDirectory(), name);
  }
  return join(schway(), "model-preferences.sqlite");
}

/** Run one operation of `site` in this process and report its rejection, or null. */
async function attempt(site: Site, opts: { lockWaitMs?: number } = {}): Promise<{ failure: { code?: string; message: string } | null; elapsedMs: number; favorites?: string[] }> {
  const startedAt = Date.now();
  try {
    if (site === "preferences-read") return { failure: null, favorites: new ModelPreferences(home).read().favorites, elapsedMs: Date.now() - startedAt };
    if (site === "history") await deleteHistorySession({ home, sessionId: "session", lockWaitMs: opts.lockWaitMs ?? 1000 });
    else if (site === "undo") await openUndoStore({ home }).recordShell({ sessionId: "session", turnId: "turn", turnNumber: 1 }, { detection: "unavailable" });
    else if (site === "memory") await (await InteractiveMemory.load(home, workspace)).write(choice);
    else new ModelPreferences(home).pin("a".repeat(64), true);
    return { failure: null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { failure: { ...(code === undefined ? {} : { code: String(code) }), message: String(message) }, elapsedMs: Date.now() - startedAt };
  }
}

/** Outcome of one fixture process. */
interface SiteRun {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly elapsedMs: number;
  readonly lines: string[];
  readonly favorites?: string[];
}

/** Run the site fixture in its own process with this test's home and workspace; a child that outlives CHILD_TIMEOUT_MS is killed. */
async function runSite(site: Site, role: "once" | "gc", env: Record<string, string> = {}): Promise<SiteRun> {
  const child = Bun.spawn([process.execPath, SITE, site, role], {
    env: { ...process.env, HOME: home, FIXTURE_HOME: home, FIXTURE_WORKSPACE: workspace, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const lines = stdout.split("\n").filter(Boolean);
  const outcome = lines.find(line => line.startsWith("DONE ") || line.startsWith("FAILED "));
  if (outcome === undefined) throw new Error(`${site} ${role} reported no outcome: ${JSON.stringify(lines)} ${stderr}`);
  const detail = JSON.parse(outcome.slice(outcome.indexOf(" ") + 1)) as { code?: string; message?: string; elapsedMs: number; favorites?: string[] };
  return { ok: outcome.startsWith("DONE "), ...(detail.code === undefined ? {} : { code: detail.code }), message: detail.message ?? "", elapsedMs: detail.elapsedMs, lines,
    ...(detail.favorites === undefined ? {} : { favorites: detail.favorites }) };
}

/** Hold the site's write lock through a separate read-write connection in this process. */
function holdLock(site: Site): Database {
  const holder = new Database(lockPath(site), { readwrite: true, create: false });
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  return holder;
}

/** Lock path as a child process with HOME set to this test's home shows it. */
const shown = (path: string) => `~${path.slice(home.length)}`;
const unwritable = (path: string) => `Schway cannot write its lock file at ${shown(path)}. Make that location writable for this user, then retry.`;

/** Evidence that a refused operation changed nothing at its site. */
function untouched(site: Site, run: { lines?: string[] }): void {
  if (site === "history") expect(run.lines?.includes("ENTERED") ?? false).toBe(false);
  if (site === "undo") expect(readdirSync(join(schway(), "undo"))).toEqual(["seed"]);
  if (site === "memory") expect(readdirSync(memoryDirectory()).filter(entry => !entry.endsWith(".lock"))).toHaveLength(1);
  if (site === "preferences" || site === "preferences-read") expect(new ModelPreferences(home).read().favorites).toEqual([seedIdentity]);
}

test("a read-only connection is refused at every lock site, beside a holder and alone, while a preferences read still reads", async () => {
  for (const site of ["history", "undo", "memory", "preferences", "preferences-read"] as const) {
    await seed(site);
    const path = lockPath(site);
    const record = site === "memory" ? path.slice(0, -".lock".length) : "";
    const recordBefore = record ? readFileSync(record, "utf8") : "";
    // A read-only connection's BEGIN IMMEDIATE takes only a read lock, so it
    // would be admitted beside this holder; each site must refuse it instead.
    const holder = holdLock(site);
    let beside: SiteRun;
    try {
      beside = await runSite(site, "once", { FIXTURE_SQLITE: "readonly", FIXTURE_WAIT_MS: "5000" });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    const alone = await runSite(site, "once", { FIXTURE_SQLITE: "readonly", FIXTURE_WAIT_MS: "5000" });
    for (const run of [beside, alone]) {
      untouched(site, run);
      if (site === "preferences-read") {
        // A read writes nothing, and its shared lock gives a consistent snapshot.
        expect({ ok: run.ok, favorites: run.favorites }).toEqual({ ok: true, favorites: [seedIdentity] });
        continue;
      }
      expect({ site, ok: run.ok }).toEqual({ site, ok: false });
      if (site === "preferences") {
        expect({ site, code: run.code }).toEqual({ site, code: "SQLITE_READONLY" });
      } else {
        expect({ site, code: run.code, message: run.message }).toEqual({ site, code: "LOCK_FILE_UNUSABLE", message: unwritable(path) });
        // Waiting cannot make the connection writable, so even history refuses at once.
        expect({ site, fast: run.elapsedMs < 1000 }).toEqual({ site, fast: true });
      }
    }
    if (site !== "preferences" && site !== "preferences-read") expect(statSync(path).size).toBe(0);
    if (record) expect(readFileSync(record, "utf8")).toBe(recordBefore);
    rmSync(schway(), { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test.skipIf(RUNS_AS_ROOT)("a lock file or database this user cannot write is refused instead of admitting a second holder, while a preferences read still reads", async () => {
  for (const site of ["history", "undo", "memory", "preferences", "preferences-read"] as const) {
    await seed(site);
    const path = lockPath(site);
    // SQLite silently opens an unwritable file read-only.
    chmodSync(path, 0o400);
    const result = await attempt(site, { lockWaitMs: 5000 });
    chmodSync(path, 0o600);
    untouched(site, {});
    if (site === "preferences-read") expect({ failure: result.failure, favorites: result.favorites }).toEqual({ failure: null, favorites: [seedIdentity] });
    else if (site === "preferences") expect({ site, code: result.failure?.code }).toEqual({ site, code: "SQLITE_READONLY" });
    else {
      expect({ site, code: result.failure?.code }).toEqual({ site, code: "LOCK_FILE_UNUSABLE" });
      expect(result.failure?.message).toMatch(/^Schway cannot write its lock file at .+\. Make that location writable for this user, then retry\.$/);
      expect({ site, fast: result.elapsedMs < 1000 }).toEqual({ site, fast: true });
    }
    rmSync(schway(), { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test.skipIf(RUNS_AS_ROOT)("a lock folder this user cannot write keeps its errno code and names the next action", async () => {
  for (const site of LOCK_SITES) {
    // The folder exists, so only creating the lock file needs write access to it.
    const folder = site === "memory" ? memoryDirectory() : schway();
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o500);
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(site, { lockWaitMs: 5000 });
    } finally {
      chmodSync(folder, 0o700);
    }
    // Errno-based wording such as undo's "Permission denied" stays as it was.
    expect({ site, code: result.failure?.code }).toEqual({ site, code: "EACCES" });
    expect(result.failure?.message).toMatch(/^Schway cannot write its lock file at .+\.lock\. Make that location writable for this user, then retry\.$/);
    expect({ site, fast: result.elapsedMs < 1000 }).toEqual({ site, fast: true });
    expect(readdirSync(folder).filter(entry => entry.endsWith(".lock") || entry.startsWith(".cl"))).toEqual([]);
    rmSync(schway(), { recursive: true, force: true });
  }
});

test("a holder parked on an unreferenced promise keeps each lock through garbage collection", async () => {
  // Nothing references the parked operation, so only the lock module keeps
  // its connection alive; finalizing it would drop the lock and admit the contender.
  const expected: Record<LockSite, { code?: string; message?: string }> = {
    history: { code: HISTORY_STORE_BUSY },
    undo: { code: UNDO_STORE_BUSY },
    memory: { message: "Workspace choice is updating · Retry when finished" },
  };
  for (const site of LOCK_SITES) {
    const run = await runSite(site, "gc", { FIXTURE_WAIT_MS: "200" });
    expect(run.lines).toContain("ENTERED");
    expect({ site, ok: run.ok }).toEqual({ site, ok: false });
    if (expected[site].code) expect({ site, code: run.code }).toEqual({ site, code: expected[site].code });
    if (expected[site].message) expect({ site, message: run.message }).toEqual({ site, message: expected[site].message });
    rmSync(schway(), { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test("lock files and the preferences database are created and locked without any descriptor outside SQLite", async () => {
  for (const site of ["history", "undo", "memory", "preferences"] as const) {
    // First a fresh home, then the existing file.
    for (const pass of ["fresh", "existing"]) {
      const run = await runSite(site, "once");
      expect({ site, pass, ok: run.ok, message: run.message }).toEqual({ site, pass, ok: true, message: "" });
      expect({ site, pass, opens: run.lines.filter(line => line.startsWith("FD-OPEN")) }).toEqual({ site, pass, opens: [] });
    }
    const path = lockPath(site);
    if (process.platform !== "win32") expect({ site, mode: statSync(path).mode & 0o777 }).toEqual({ site, mode: 0o600 });
    if (site !== "preferences") {
      // The write probe is never committed and journals in memory.
      expect({ site, size: statSync(path).size }).toEqual({ site, size: 0 });
      const directory = site === "memory" ? memoryDirectory() : schway();
      expect(readdirSync(directory).filter(entry => entry.endsWith("-journal") || entry.startsWith(".cl"))).toEqual([]);
    }
    rmSync(schway(), { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

test("a lock file with content is refused untouched rather than opened", async () => {
  for (const site of LOCK_SITES) {
    await seed(site);
    const path = lockPath(site);
    writeFileSync(path, "not a lock");
    const result = await attempt(site, { lockWaitMs: 5000 });
    expect({ site, code: result.failure?.code }).toEqual({ site, code: "LOCK_FILE_UNUSABLE" });
    expect(result.failure?.message).toMatch(/^The file at .+ is not a Schway lock file\. With no Schway running, delete it, then retry\.$/);
    expect({ site, fast: result.elapsedMs < 1000 }).toEqual({ site, fast: true });
    expect(readFileSync(path, "utf8")).toBe("not a lock");
    rmSync(schway(), { recursive: true, force: true });
  }
});

test("a folder at a lock path is refused untouched and named as a folder", async () => {
  for (const site of LOCK_SITES) {
    await seed(site);
    const path = lockPath(site);
    rmSync(path);
    mkdirSync(join(path, "kept"), { recursive: true });
    const result = await attempt(site, { lockWaitMs: 5000 });
    expect({ site, failure: result.failure }).toEqual({ site, failure: {
      code: "LOCK_FILE_UNUSABLE", message: `${path} is a folder, not a Schway lock file. With no Schway running, delete that folder, then retry.`,
    } });
    expect({ site, fast: result.elapsedMs < 1000 }).toEqual({ site, fast: true });
    expect(readdirSync(path)).toEqual(["kept"]);
    rmSync(schway(), { recursive: true, force: true });
  }
});

test("history contention that ends on a failed open still reports busy, and a failed open alone reports itself", async () => {
  await seed("history");
  const holder = holdLock("history");
  let ended: SiteRun;
  try {
    // Contended for the first 100 ms, then every open fails while access(2) allows the file.
    ended = await runSite("history", "once", { FIXTURE_WAIT_MS: "300", FIXTURE_SQLITE: "cantopen-after:100" });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  // The host maps only the busy code to "blocked"; the failed open must not hide the contention.
  expect({ ok: ended.ok, code: ended.code, message: ended.message }).toEqual({ ok: false, code: HISTORY_STORE_BUSY, message: "History store busy" });
  expect(ended.elapsedMs).toBeGreaterThanOrEqual(250);
  expect(ended.lines.includes("ENTERED")).toBe(false);
  // With no holder, the bound ends with the failure itself, as before.
  const failed = await runSite("history", "once", { FIXTURE_WAIT_MS: "300", FIXTURE_SQLITE: "cantopen-after:0" });
  expect({ ok: failed.ok, code: failed.code }).toEqual({ ok: false, code: "SQLITE_CANTOPEN" });
  expect(failed.lines.includes("ENTERED")).toBe(false);
}, TEST_TIMEOUT_MS);

test("each site keeps its contention behavior: history waits its bound, the others reject at once", async () => {
  for (const site of ["history", "undo", "memory", "preferences", "preferences-read"] as const) {
    await seed(site);
    const holder = holdLock(site);
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt(site, { lockWaitMs: 300 });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    if (site === "history") {
      expect(result.failure?.code).toBe(HISTORY_STORE_BUSY);
      expect(result.failure?.message).toBe("History store busy");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    } else {
      expect({ site, fast: result.elapsedMs < 250 }).toEqual({ site, fast: true });
      if (site === "undo") expect(result.failure).toEqual({ code: UNDO_STORE_BUSY, message: "Undo store busy" });
      else if (site === "memory") expect(result.failure?.message).toBe("Workspace choice is updating · Retry when finished");
      else expect(result.failure?.code).toMatch(/^SQLITE_BUSY/);
    }
    // Released, the same operation succeeds.
    expect({ site, failure: (await attempt(site)).failure }).toEqual({ site, failure: null });
    rmSync(schway(), { recursive: true, force: true });
  }
});

test("the preferences write probe changes nothing on a writable connection and refuses a read-only one", async () => {
  await seed("preferences");
  const path = lockPath("preferences");
  const before = readFileSync(path);
  const writable = new Database(path, { readwrite: true, create: false });
  writable.exec("BEGIN IMMEDIATE");
  proveWritable(writable, "preferences");
  expect(readdirSync(schway()).filter(entry => entry.startsWith("model-preferences"))).toEqual(["model-preferences.sqlite"]);
  writable.exec("COMMIT");
  writable.close();
  expect(Buffer.compare(readFileSync(path), before)).toBe(0);
  const readOnly = new Database(path, { readonly: true });
  readOnly.exec("BEGIN IMMEDIATE");
  expect(() => proveWritable(readOnly, "preferences")).toThrow(expect.objectContaining({ code: "SQLITE_READONLY" }));
  readOnly.exec("ROLLBACK");
  readOnly.close();
  // A read neither probes nor writes.
  expect(new ModelPreferences(home).read().favorites).toEqual([seedIdentity]);
  expect(Buffer.compare(readFileSync(path), before)).toBe(0);
});
