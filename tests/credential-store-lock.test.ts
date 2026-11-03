import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Subprocess } from "bun";
import { CREDENTIAL_LOCK_FILE_ENV, MAX_LOCK_TIMEOUT_MS, credentialStoreLockPath, validLockTimeoutMs, withCredentialStoreLock } from "../src/auth/store-lock.ts";
import { credentialLockError, credentialStoreError, credentialStoreFailure, isCredentialLockError, preserveRefusal } from "../src/auth/store.ts";
import { effectiveStore, isCredentialWriteRefused } from "../src/host/auth-routes.ts";

const CONTENDER = join(import.meta.dir, "fixtures/credential-store-lock/contender.ts");

// Timing margins. Contenders that must eventually succeed get a 30 s lock
// bound (the fixture default, and MARGIN_LOCK_MS in process) against at most
// a few 50 ms critical sections, and their tests allow 60 s for process
// startup. Machine load can therefore only slow them down, never turn a wait
// into a refusal. Refusal at the real 2 s bound is asserted separately.
const MARGIN_LOCK_MS = 30_000;
const MARGIN_TEST_MS = 60_000;
// Single-mutation child probes face no holder, so a 15 s bound is ample. A
// probe that outlives it by 3 s is killed and reaped, so even a test making
// three such calls ends well inside MARGIN_TEST_MS.
const CHILD_LOCK_MS = 15_000;
const CHILD_KILL_GRACE_MS = 3_000;
/** SQLite's full-path limit for the lock file on this platform (see docs/credentials.md). */
const SQLITE_PATH_LIMIT = process.platform === "darwin" ? 1016 : 504;
/** Root bypasses permission bits, so permission-denied cases cannot be staged as root. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

/** A fixture process reporting `<EVENT> <name>` lines for one Schway-mediated mutation. */
interface Contender {
  readonly child: Subprocess<"ignore", "pipe", "pipe">;
  readonly lines: string[];
  waitFor(match: (line: string) => boolean, timeoutMs?: number): Promise<string>;
}

/** Spawn a lock contender against an isolated home and lock location. */
function spawnContender(role: "hold" | "once", name: string, env: Record<string, string>): Contender {
  const child = Bun.spawn([process.execPath, CONTENDER, role], {
    env: { ...process.env, CONTENDER_NAME: name, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
      for (const wake of waiters.splice(0)) wake();
    }
    for (const wake of waiters.splice(0)) wake();
  })();
  return {
    child,
    lines,
    async waitFor(match, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        if (Date.now() >= deadline || child.exitCode !== null) {
          const stderr = child.exitCode !== null ? await new Response(child.stderr).text() : "";
          throw new Error(`${name} never reported the awaited event: ${JSON.stringify(lines)} ${stderr}`);
        }
        await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), Bun.sleep(25)]);
      }
    },
  };
}

/** SIGKILL a fixture process if it is still running, then wait for the OS to reap it. */
async function kill(contender: Contender | undefined): Promise<void> {
  if (!contender) return;
  if (contender.child.exitCode === null) contender.child.kill("SIGKILL");
  await contender.child.exited;
}

/** Isolated home, lock location and occupancy marker shared by one test's processes. */
interface LockRoot {
  readonly root: string;
  readonly home: string;
  readonly lock: string;
  readonly occupancy: string;
  readonly env: Record<string, string>;
}

let current: LockRoot;
const inheritedOverride = process.env[CREDENTIAL_LOCK_FILE_ENV];

// Every test gets its own rendezvous, so nothing here touches the developer's
// real ~/.schway lock. The override names the default per-user location under
// the isolated home, which keeps earlier lock implementations (that ignore the
// override but honor HOME) on the same path for regression comparison.
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "schway-credential-lock-"));
  const home = join(root, "home");
  mkdirSync(home);
  const lock = join(home, ".schway", "credential-store.lock");
  const occupancy = join(root, "occupied");
  current = { root, home, lock, occupancy, env: { HOME: home, [CREDENTIAL_LOCK_FILE_ENV]: lock, CONTENDER_OCCUPANCY: occupancy } };
  process.env[CREDENTIAL_LOCK_FILE_ENV] = lock;
});

afterEach(() => {
  if (inheritedOverride === undefined) delete process.env[CREDENTIAL_LOCK_FILE_ENV];
  else process.env[CREDENTIAL_LOCK_FILE_ENV] = inheritedOverride;
  rmSync(current.root, { recursive: true, force: true });
});

/** Native store whose backend counts calls and flags any overlapping write via the shared occupancy marker. */
async function occupancyStore(lockTimeoutMs?: number): Promise<{ store: import("../src/auth/store.ts").CredentialStore; calls: () => number; overlaps: () => number }> {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  let calls = 0;
  let overlaps = 0;
  const secrets = {
    get: async () => { calls++; return null; },
    set: async () => {
      calls++;
      let marked = false;
      try { mkdirSync(current.occupancy); marked = true; } catch { overlaps++; }
      await Bun.sleep(50);
      if (marked) rmSync(current.occupancy, { recursive: true });
    },
    delete: async () => { calls++; return false; },
  };
  return { store: createNativeCredentialStore(secrets as never, lockTimeoutMs === undefined ? {} : { lockTimeoutMs }), calls: () => calls, overlaps: () => overlaps };
}

/** Run one guarded attempt, reporting whether its work ran, its rejection (null on success) and the elapsed time. */
async function attempt(timeoutMs: number, operation: "save" | "delete" = "save"): Promise<{ ran: boolean; failure: unknown; message: string; elapsedMs: number }> {
  const startedAt = Date.now();
  let ran = false;
  const failure = await withCredentialStoreLock(async () => { ran = true; }, { timeoutMs, operation }).then(() => null, (error: unknown) => error);
  return { ran, failure, message: String((failure as Error | null)?.message ?? ""), elapsedMs: Date.now() - startedAt };
}

/** Lines reporting a second holder or any removal of the lock path. */
const violations = (lines: readonly string[]) => lines.filter(line => line.startsWith("OVERLAP") || line.startsWith("REMOVE") || line.startsWith("FD-OPEN"));

/** Sorted names of contenders that completed their mutation. */
const doneNames = (lines: readonly string[]) => lines.filter(line => line.startsWith("DONE ")).map(line => line.split(" ")[1]).sort();

/** Expected display of a path in lock messages: the test process's home shortened to `~`. */
const displayed = (text: string) => text.split(homedir() + sep).join(`~${sep}`);

/** Run one mutation in a fixture process whose HOME makes the isolated lock path its default; a child that outlives its bound by CHILD_KILL_GRACE_MS is killed and reaped. */
async function attemptInChild(name: string, lockTimeoutMs: number, env: Record<string, string> = {}): Promise<{ ok: boolean; message: string; elapsedMs: number; lines: string[] }> {
  const contender = spawnContender("once", name, { ...current.env, CONTENDER_HOLD_MS: "0", CONTENDER_LOCK_TIMEOUT_MS: String(lockTimeoutMs), ...env });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = await Promise.race([
    contender.child.exited.then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), lockTimeoutMs + CHILD_KILL_GRACE_MS); }),
  ]);
  clearTimeout(timer);
  if (expired) {
    await kill(contender);
    throw new Error(`${name} hung past its bound and was killed: ${JSON.stringify(contender.lines)}`);
  }
  const outcome = contender.lines.find(line => line.startsWith(`DONE ${name} `) || line.startsWith(`FAILED ${name} `));
  if (outcome === undefined) throw new Error(`${name} reported no outcome: ${JSON.stringify(contender.lines)} ${await new Response(contender.child.stderr).text()}`);
  const detail = JSON.parse(outcome.slice(outcome.indexOf(" {") + 1)) as { message?: string; elapsedMs: number };
  return { ok: outcome.startsWith("DONE "), message: detail.message ?? "", elapsedMs: detail.elapsedMs, lines: contender.lines };
}

test("concurrent stale breakers after a crashed holder never yield two holders", async () => {
  const { env } = current;
  const crashed = spawnContender("hold", "crashed", env);
  let first: Contender | undefined;
  let second: Contender | undefined;
  try {
    await crashed.waitFor(line => line === "ENTERED crashed");
    await kill(crashed);
    // The first contender either takes the released lock at once or, with
    // path-based stale breaking, stalls inside its read-then-remove window.
    first = spawnContender("once", "first", { ...env, CONTENDER_HOLD_MS: "200", CONTENDER_BREAK_DELAY_MS: "1500" });
    await first.waitFor(line => line === "BREAKING first" || line === "ENTERED first");
    // A second contender breaks the same stale owner and acquires inside
    // that window, then holds long enough for the stalled removal to land.
    second = spawnContender("once", "second", { ...env, CONTENDER_HOLD_MS: "2500" });
    const [firstExit, secondExit] = await Promise.all([first.child.exited, second.child.exited]);
    const lines = [...first.lines, ...second.lines];
    expect(lines.filter(line => line.startsWith("OVERLAP"))).toEqual([]);
    // No contender ever removes the lock path: there is no stale breaking.
    expect(lines.filter(line => line.startsWith("REMOVE"))).toEqual([]);
    expect(doneNames(lines)).toEqual(["first", "second"]);
    expect([firstExit, secondExit]).toEqual([0, 0]);
  } finally {
    await kill(crashed);
    await kill(first);
    await kill(second);
  }
}, MARGIN_TEST_MS);

test("contenders in several processes take turns after a crashed holder", async () => {
  const crashed = spawnContender("hold", "crashed", current.env);
  const contenders: Contender[] = [];
  try {
    await crashed.waitFor(line => line === "ENTERED crashed");
    await kill(crashed);
    for (const name of ["a", "b", "c", "d"]) contenders.push(spawnContender("once", name, { ...current.env, CONTENDER_HOLD_MS: "50" }));
    // An in-process Schway mutation contends with the child processes too,
    // started once a child is inside so the two actually race.
    const local = await occupancyStore(MARGIN_LOCK_MS);
    await Promise.any(contenders.map(contender => contender.waitFor(line => line.startsWith("ENTERED"))));
    await local.store.set({ account: "local", label: "Local" }, "value");
    const exits = await Promise.all(contenders.map(contender => contender.child.exited));
    const lines = contenders.flatMap(contender => contender.lines);
    expect(violations(lines)).toEqual([]);
    expect(local.overlaps()).toBe(0);
    expect(local.calls()).toBe(1);
    expect(exits).toEqual([0, 0, 0, 0]);
    expect(doneNames(lines)).toEqual(["a", "b", "c", "d"]);
  } finally {
    await kill(crashed);
    for (const contender of contenders) await kill(contender);
  }
}, MARGIN_TEST_MS);

test("contenders already polling when the holder is SIGKILLed never yield two holders", async () => {
  const holder = spawnContender("hold", "holder", current.env);
  const contenders: Contender[] = [];
  try {
    await holder.waitFor(line => line === "ENTERED holder");
    for (const name of ["a", "b", "c", "d"]) contenders.push(spawnContender("once", name, { ...current.env, CONTENDER_HOLD_MS: "50" }));
    for (const contender of contenders) await contender.waitFor(line => line.startsWith("STARTED"));
    const local = await occupancyStore(MARGIN_LOCK_MS);
    const localSet = local.store.set({ account: "local", label: "Local" }, "value");
    // Every contender is polling against the live holder; let each run many
    // poll rounds, and confirm none got in while the holder was alive.
    await Bun.sleep(300);
    expect(contenders.flatMap(contender => contender.lines).filter(line => line.startsWith("ENTERED"))).toEqual([]);
    expect(local.calls()).toBe(0);
    // The kernel releases the lock at once; all five race for it together.
    await kill(holder);
    await localSet;
    const exits = await Promise.all(contenders.map(contender => contender.child.exited));
    const lines = contenders.flatMap(contender => contender.lines);
    // The shared occupancy marker admits one holder at a time across all five.
    expect(violations(lines)).toEqual([]);
    expect(local.overlaps()).toBe(0);
    expect(local.calls()).toBe(1);
    expect(exits).toEqual([0, 0, 0, 0]);
    expect(doneNames(lines)).toEqual(["a", "b", "c", "d"]);
  } finally {
    await kill(holder);
    for (const contender of contenders) await kill(contender);
  }
}, MARGIN_TEST_MS);

test("a holder in another process blocks mutations until the OS releases it on SIGKILL", async () => {
  const holder = spawnContender("hold", "holder", current.env);
  try {
    await holder.waitFor(line => line === "ENTERED holder");
    const blocked = await attempt(200);
    expect(blocked.ran).toBe(false);
    expect(blocked.message).toBe(credentialStoreError("save"));
    // A real mutation fails closed after its default 2 s bound without backend contact.
    const local = await occupancyStore();
    const refused = await local.store.set({ account: "a", label: "a" }, "late").then(() => null, (error: unknown) => error);
    expect(String((refused as Error)?.message)).toBe(credentialStoreError("save"));
    expect(local.calls()).toBe(0);
    await kill(holder);
    // No stale verdict or removal: the kernel already dropped the dead holder's lock.
    const after = await attempt(5000);
    expect(after.ran).toBe(true);
    expect(after.elapsedMs).toBeLessThan(1000);
    expect(statSync(current.lock).isFile()).toBe(true);
  } finally {
    await kill(holder);
  }
}, MARGIN_TEST_MS);

test("concurrent holders serialize through the shared lock", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = withCredentialStoreLock(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = withCredentialStoreLock(async () => {
    order.push("second");
  }, { timeoutMs: MARGIN_LOCK_MS });
  await new Promise(resolve => setTimeout(resolve, 25));
  // Second contender waits while the first holds the lock.
  expect(order).toEqual(["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

test("a holder parked on an unreferenced promise keeps the lock through garbage collection", async () => {
  // Nothing references the holder's pending chain, so only the lock module
  // keeps its connection alive; finalizing it would silently drop the lock.
  let entered = false;
  void withCredentialStoreLock(async () => { entered = true; await new Promise(() => {}); });
  for (let spin = 0; spin < 200 && !entered; spin++) await Bun.sleep(5);
  expect(entered).toBe(true);
  Bun.gc(true);
  await Bun.sleep(50);
  Bun.gc(true);
  const contender = await attempt(200);
  expect(contender.ran).toBe(false);
  expect(contender.message).toBe(credentialStoreError("save"));
});

test("an earlier build's lock directory is never removed, and fails fast only for a provably stopped owner", async () => {
  // Earlier builds only used the default path, so these run in a child whose
  // HOME makes the isolated lock path its default (Bun caches homedir()).
  const legacyMessage = /^Cannot save credential in the OS secure store\. An older Schway's lock folder is at ~\/\.schway\/credential-store\.lock\. Close every older Schway, delete that folder, then retry\. No credential was changed\.$/;
  const owner = (pid: number, host = hostname()) => JSON.stringify({ host, pid, token: crypto.randomUUID() });
  const cases: { name: string; stamp?: () => void; fast: boolean }[] = [
    { name: "stopped", stamp: () => writeFileSync(join(current.lock, "owner.json"), owner(2147483647)), fast: true },
    { name: "live", stamp: () => writeFileSync(join(current.lock, "owner.json"), owner(process.pid)), fast: false },
    { name: "foreign host", stamp: () => writeFileSync(join(current.lock, "owner.json"), owner(2147483647, `not-${hostname()}`)), fast: false },
    { name: "no owner yet", fast: false },
    // An oversized stamp is never parsed, even when it names a stopped owner.
    { name: "oversized", stamp: () => writeFileSync(join(current.lock, "owner.json"), owner(2147483647).padEnd(8192, " ")), fast: false },
    // A FIFO stamp must not block the event loop: without a writer, a plain read never returns.
    ...(process.platform === "win32" ? [] : [{ name: "fifo", stamp: () => { expect(Bun.spawnSync(["mkfifo", join(current.lock, "owner.json")]).exitCode).toBe(0); }, fast: false }]),
  ];
  for (const { name, stamp, fast } of cases) {
    mkdirSync(current.lock, { mode: 0o700, recursive: true });
    stamp?.();
    const result = await attemptInChild(name, fast ? CHILD_LOCK_MS : 300);
    expect({ name, ok: result.ok }).toEqual({ name, ok: false });
    expect(result.message).toMatch(legacyMessage);
    // A stopped owner cannot clear by waiting; an unproven one waits out the bound.
    if (fast) expect({ name, fast: result.elapsedMs < 1000 }).toEqual({ name, fast: true });
    else expect({ name, waited: result.elapsedMs >= 250 }).toEqual({ name, waited: true });
    expect(statSync(current.lock).isDirectory()).toBe(true);
    rmSync(current.lock, { recursive: true, force: true });
  }
  // The older holder releases its directory; the next mutation proceeds.
  expect((await attemptInChild("released", 5000)).ok).toBe(true);
}, MARGIN_TEST_MS);

test("a folder or non-lock file at a chosen lock path is never called an older lock or deletable", async () => {
  const chosen = /^Cannot save credential in the OS secure store\. SCHWAY_CREDENTIAL_LOCK_FILE does not name a Schway lock file\. Set it to a new file path, then retry\. No credential was changed\.$/;
  // A user's own state directory, a data file and a device all stay untouched.
  const state = join(current.root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "keep"), "user data");
  const data = join(current.root, "data.bin");
  writeFileSync(data, "x".repeat(4096));
  for (const path of [state, data, ...(process.platform === "win32" ? [] : ["/dev/null"])]) {
    process.env[CREDENTIAL_LOCK_FILE_ENV] = path;
    const result = await attempt(5000);
    expect({ path, ran: result.ran }).toEqual({ path, ran: false });
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.message).toMatch(chosen);
    expect(isCredentialLockError(result.failure)).toBe(true);
  }
  expect(readFileSync(join(state, "keep"), "utf8")).toBe("user data");
  expect(readFileSync(data, "utf8")).toBe("x".repeat(4096));
});

test("a non-lock file at the default path fails fast and names it deletable", async () => {
  mkdirSync(join(current.home, ".schway"), { recursive: true });
  writeFileSync(current.lock, "x".repeat(4096));
  const result = await attemptInChild("damaged", CHILD_LOCK_MS);
  expect(result.ok).toBe(false);
  expect(result.elapsedMs).toBeLessThan(1000);
  expect(result.message).toBe("Cannot save credential in the OS secure store. The file at ~/.schway/credential-store.lock is not a Schway lock file. With no Schway running, delete it, then retry. No credential was changed.");
}, MARGIN_TEST_MS);

test("once the lock file exists, an earlier build can neither acquire nor break it", async () => {
  await withCredentialStoreLock(async () => {});
  const lock = statSync(current.lock);
  expect(lock.isFile()).toBe(true);
  if (process.platform !== "win32") expect(lock.mode & 0o777).toBe(0o600);
  // Earlier builds acquired with mkdir and only removed a lock whose
  // owner.json they could read; a regular file defeats both.
  expect(() => mkdirSync(current.lock, { mode: 0o700 })).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(() => readFileSync(join(current.lock, "owner.json"), "utf8")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  // The inode is permanent: release never removes or replaces it.
  await withCredentialStoreLock(async () => {});
  expect(statSync(current.lock).ino).toBe(lock.ino);
});

test("holding and releasing the lock never writes the file or leaves a side file", async () => {
  await withCredentialStoreLock(async () => {
    // The verification write sits in an uncommitted transaction with an in-memory journal.
    expect(readdirSync(dirname(current.lock))).toEqual(["credential-store.lock"]);
    expect(statSync(current.lock).size).toBe(0);
  });
  expect(readdirSync(dirname(current.lock))).toEqual(["credential-store.lock"]);
  expect(statSync(current.lock).size).toBe(0);
});

test("a read-only connection is refused, even while a read-write holder holds the lock", async () => {
  // The fixture opens every connection read-only, as a sandbox that denies
  // open(O_RDWR) while access(2) succeeds would. Its BEGIN IMMEDIATE would
  // succeed beside the holder; the verification write must refuse it.
  let releaseHolder!: () => void;
  const gate = new Promise<void>(resolve => { releaseHolder = resolve; });
  let entered = false;
  const holder = withCredentialStoreLock(async () => { entered = true; await gate; }, { timeoutMs: MARGIN_LOCK_MS });
  for (let spin = 0; spin < 200 && !entered; spin++) await Bun.sleep(5);
  expect(entered).toBe(true);
  try {
    const readOnly = spawnContender("once", "readonly", { ...current.env, CONTENDER_SQLITE: "readonly", CONTENDER_HOLD_MS: "0" });
    expect(await readOnly.child.exited).toBe(1);
    expect(readOnly.lines.filter(line => line.startsWith("ENTERED") || line.startsWith("OVERLAP") || line.startsWith("FD-OPEN"))).toEqual([]);
    const failed = readOnly.lines.find(line => line.startsWith("FAILED readonly "));
    const { message, elapsedMs } = JSON.parse(failed!.slice("FAILED readonly ".length)) as { message: string; elapsedMs: number };
    expect(message).toBe("Cannot save credential in the OS secure store. Schway cannot write its lock file at ~/.schway/credential-store.lock. Make that location writable for this user, then retry. No credential was changed.");
    expect(elapsedMs).toBeLessThan(1000);
  } finally {
    releaseHolder();
    await holder;
  }
  // Read-only and alone, it is still refused rather than admitted.
  const alone = await attemptInChild("readonly-alone", CHILD_LOCK_MS, { CONTENDER_SQLITE: "readonly" });
  expect(alone.ok).toBe(false);
  expect(alone.message).toMatch(/Schway cannot write its lock file at /);
}, MARGIN_TEST_MS);

test.skipIf(RUNS_AS_ROOT)("a lock file this user cannot write fails fast instead of admitting a second holder", async () => {
  await withCredentialStoreLock(async () => {});
  // SQLite opens it read-only, and a read-only BEGIN IMMEDIATE excludes nobody.
  chmodSync(current.lock, 0o400);
  const result = await attempt(5000);
  expect(result.ran).toBe(false);
  expect(result.elapsedMs).toBeLessThan(1000);
  expect(result.message).toMatch(/^Cannot save credential in the OS secure store\. Schway cannot write its lock file at \S+\. Make that location writable for this user, then retry\. No credential was changed\.$/);
  // A file this user cannot open at all is refused the same way.
  chmodSync(current.lock, 0o000);
  expect((await attempt(5000)).message).toMatch(/Schway cannot write its lock file at /);
});

test.skipIf(RUNS_AS_ROOT)("a lock directory this user cannot write fails fast", async () => {
  const locked = join(current.root, "read-only");
  mkdirSync(locked, { mode: 0o500 });
  process.env[CREDENTIAL_LOCK_FILE_ENV] = join(locked, "credential.lock");
  try {
    const result = await attempt(5000, "delete");
    expect(result.ran).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.message).toMatch(/^Cannot delete credential in the OS secure store\. Schway cannot write its lock file at /);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("a lock file deleted just before the open is retried, not refused", async () => {
  // Deleting the file is a documented recovery step; a save racing it must
  // recreate the file and succeed within its bound.
  const result = await attemptInChild("vanish", CHILD_LOCK_MS, { CONTENDER_SQLITE: "vanish-once" });
  expect(result.lines).toContain("VANISHED vanish");
  expect(result.ok).toBe(true);
  expect(statSync(current.lock).isFile()).toBe(true);
}, MARGIN_TEST_MS);

test("lock paths that waiting cannot fix fail fast with a matching next action", async () => {
  const file = join(current.root, "a-file");
  writeFileSync(file, "");
  const fileLink = join(current.root, "file-link");
  symlinkSync(file, fileLink);
  const dangling = join(current.root, "dangling.lock");
  symlinkSync(join(current.root, "missing-target"), dangling);
  const loop = join(current.root, "loop.lock");
  symlinkSync(loop, loop);
  const danglingDir = join(current.root, "unmounted");
  symlinkSync(join(current.root, "missing-volume", "schway"), danglingDir);
  const loopDir = join(current.root, "loop-dir");
  symlinkSync(loopDir, loopDir);
  // Links whose targets run through a regular file lead nowhere (ENOTDIR).
  const throughFile = join(current.root, "through-file.lock");
  symlinkSync(join(file, "y"), throughFile);
  const parentThroughFile = join(current.root, "parent-through-file");
  symlinkSync(join(file, "sub"), parentThroughFile);
  const long = join(current.root, "x".repeat(300), "credential.lock");
  const parentFile = (at: string) => `${at} is a file, not a folder. Set SCHWAY_CREDENTIAL_LOCK_FILE to a path inside a folder, then retry.`;
  const link = (at: string) => `The symbolic link at ${at} is broken or loops. Fix that link, then retry.`;
  const cases = [
    // A regular file as the direct parent, a deeper ancestor, or behind a link names that file.
    { path: join(file, "credential.lock"), reason: parentFile(file) },
    { path: join(file, "nested", "credential.lock"), reason: parentFile(file) },
    { path: join(fileLink, "credential.lock"), reason: parentFile(fileLink) },
    // A broken or looping link names itself, whether it is the lock path or an ancestor.
    { path: dangling, reason: link(dangling) },
    { path: loop, reason: link(loop) },
    { path: join(danglingDir, "credential.lock"), reason: link(danglingDir) },
    { path: join(danglingDir, "nested", "credential.lock"), reason: link(danglingDir) },
    { path: join(loopDir, "credential.lock"), reason: link(loopDir) },
    { path: throughFile, reason: link(throughFile) },
    { path: join(parentThroughFile, "credential.lock"), reason: link(parentThroughFile) },
    { path: long, reason: `The lock path ${long} is too long. Set SCHWAY_CREDENTIAL_LOCK_FILE to a shorter absolute path, then retry.` },
  ];
  for (const { path, reason } of cases) {
    process.env[CREDENTIAL_LOCK_FILE_ENV] = path;
    const result = await attempt(5000);
    expect({ path, ran: result.ran, fast: result.elapsedMs < 1000 }).toEqual({ path, ran: false, fast: true });
    expect(result.message).toBe(`Cannot save credential in the OS secure store. ${displayed(reason)} No credential was changed.`);
  }
  expect(existsSync(join(current.root, "missing-volume"))).toBe(false);
});

test("a broken link or file in the default lock folder fails fast and names it", async () => {
  const schway = join(current.home, ".schway");
  // A ~/.schway pointing at an unmounted volume.
  symlinkSync(join(current.root, "missing-volume", "schway"), schway);
  const unmounted = await attemptInChild("unmounted", CHILD_LOCK_MS);
  expect(unmounted.ok).toBe(false);
  expect(unmounted.elapsedMs).toBeLessThan(1000);
  expect(unmounted.message).toBe("Cannot save credential in the OS secure store. The symbolic link at ~/.schway is broken or loops. Fix that link, then retry. No credential was changed.");
  rmSync(schway);
  writeFileSync(schway, "");
  const file = await attemptInChild("file", CHILD_LOCK_MS);
  expect(file.ok).toBe(false);
  expect(file.elapsedMs).toBeLessThan(1000);
  expect(file.message).toBe("Cannot save credential in the OS secure store. ~/.schway is a file, not a folder. Move that file, then retry. No credential was changed.");
}, MARGIN_TEST_MS);

test("an override ending in a path separator is refused at once as not a lock file", async () => {
  const state = join(current.root, "state");
  mkdirSync(state);
  // Linux reports EISDIR and macOS ENOENT for these; neither may spin out the bound.
  mkdirSync(current.lock, { recursive: true });
  for (const path of [`${state}${sep}`, `${join(current.root, "missing")}${sep}`, `${current.lock}${sep}`]) {
    process.env[CREDENTIAL_LOCK_FILE_ENV] = path;
    const result = await attempt(5000);
    expect({ path, ran: result.ran, fast: result.elapsedMs < 1000 }).toEqual({ path, ran: false, fast: true });
    expect(result.message).toBe("Cannot save credential in the OS secure store. SCHWAY_CREDENTIAL_LOCK_FILE does not name a Schway lock file. Set it to a new file path, then retry. No credential was changed.");
  }
  expect(existsSync(join(current.root, "missing"))).toBe(false);
  expect(readdirSync(state)).toEqual([]);
});

test("an existing database at a chosen path is refused untouched, including a WAL database", async () => {
  const { Database } = await import("bun:sqlite");
  const snapshot = (directory: string) => Object.fromEntries(readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name)).toString("base64")]));
  for (const mode of ["DELETE", "WAL"]) {
    const directory = join(current.root, `db-${mode}`);
    mkdirSync(directory);
    const path = join(directory, "data.db");
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode = ${mode}; CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('user data')`);
    db.close();
    const before = snapshot(directory);
    if (mode === "WAL") expect([readFileSync(path)[18], readFileSync(path)[19]]).toEqual([2, 2]);
    process.env[CREDENTIAL_LOCK_FILE_ENV] = path;
    const result = await attempt(5000);
    expect({ mode, ran: result.ran, fast: result.elapsedMs < 1000 }).toEqual({ mode, ran: false, fast: true });
    expect(result.message).toMatch(/SCHWAY_CREDENTIAL_LOCK_FILE does not name a Schway lock file\./);
    // Never opened: same bytes, header and side files.
    expect(snapshot(directory)).toEqual(before);
  }
});

test("an empty lock file beside a stray journal still locks and stays empty", async () => {
  mkdirSync(dirname(current.lock), { recursive: true });
  writeFileSync(current.lock, "");
  writeFileSync(`${current.lock}-journal`, Buffer.alloc(2048, 7));
  const result = await attempt(5000);
  expect(result.ran).toBe(true);
  expect(statSync(current.lock).size).toBe(0);
});

test("an override reaching the default location by another spelling is the default, and a lexical match is not", async () => {
  const schway = join(current.home, ".schway");
  const legacyAt = (shown: string) => `Cannot save credential in the OS secure store. An older Schway's lock folder is at ${shown}. Close every older Schway, delete that folder, then retry. No credential was changed.`;
  const chosen = "Cannot save credential in the OS secure store. SCHWAY_CREDENTIAL_LOCK_FILE does not name a Schway lock file. Set it to a new file path, then retry. No credential was changed.";
  // A symbolic-link alias of ~/.schway reaches the default lock folder: it is the default.
  mkdirSync(current.lock, { recursive: true });
  const alias = join(current.root, "alias");
  symlinkSync(schway, alias);
  const aliased = await attemptInChild("alias", 300, { [CREDENTIAL_LOCK_FILE_ENV]: join(alias, "credential-store.lock") });
  expect(aliased.message).toBe(legacyAt(join(alias, "credential-store.lock")));
  // A case variant does too, where the filesystem ignores case.
  const variant = join(schway, "CREDENTIAL-STORE.LOCK");
  if (existsSync(variant)) {
    const cased = await attemptInChild("case", 300, { [CREDENTIAL_LOCK_FILE_ENV]: variant });
    expect(cased.message).toBe(legacyAt("~/.schway/CREDENTIAL-STORE.LOCK"));
  }
  // With ~/.schway a link elsewhere, ~/.schway/../.schway lexically matches the
  // default but physically names a different folder: it is a chosen path.
  rmSync(alias);
  rmSync(schway, { recursive: true, force: true });
  const volume = join(current.root, "volume");
  mkdirSync(join(volume, "schway"), { recursive: true });
  mkdirSync(join(volume, ".schway", "credential-store.lock"), { recursive: true });
  symlinkSync(join(volume, "schway"), schway);
  const dotted = await attemptInChild("dotted", CHILD_LOCK_MS, { [CREDENTIAL_LOCK_FILE_ENV]: `${schway}${sep}..${sep}.schway${sep}credential-store.lock` });
  expect(dotted.message).toBe(chosen);
  expect(dotted.elapsedMs).toBeLessThan(1000);
}, MARGIN_TEST_MS);

test("an open the sandbox denies while access(2) allows it ends the bound as unwritable, without a probe", async () => {
  // Every SQLite open fails with SQLITE_CANTOPEN while access(2) allows the
  // file. Without opening a descriptor, that cannot be told from a transient
  // failure, so it waits out the bound, then names the cannot-write action.
  const result = await attemptInChild("denied", 300, { CONTENDER_SQLITE: "open-denied" });
  expect(result.ok).toBe(false);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
  expect(result.message).toBe("Cannot save credential in the OS secure store. Schway cannot write its lock file at ~/.schway/credential-store.lock. Make that location writable for this user, then retry. No credential was changed.");
  expect(violations(result.lines)).toEqual([]);
}, MARGIN_TEST_MS);

test("descriptor shortages and a one-off open failure are retried within the bound, not refused", async () => {
  // EMFILE on the private temporary create, then one SQLITE_CANTOPEN.
  const create = await attemptInChild("emfile", CHILD_LOCK_MS, { CONTENDER_FS: "emfile-once" });
  expect(create.lines).toContain("EMFILE emfile");
  expect(create.ok).toBe(true);
  const reopened = await attemptInChild("reopened", CHILD_LOCK_MS, { CONTENDER_SQLITE: "cantopen-once" });
  expect(reopened.ok).toBe(true);
  expect(violations([...create.lines, ...reopened.lines])).toEqual([]);
}, MARGIN_TEST_MS);

test("the lock file is created and locked without any descriptor outside SQLite", async () => {
  // A fresh lock file is published by link(2) from a private temporary name,
  // so no descriptor on the lock path itself is ever closed outside SQLite.
  const fresh = await attemptInChild("fresh", CHILD_LOCK_MS);
  expect(fresh.ok).toBe(true);
  expect(violations(fresh.lines)).toEqual([]);
  const lock = statSync(current.lock);
  expect({ size: lock.size, nlink: lock.nlink }).toEqual({ size: 0, nlink: 1 });
  if (process.platform !== "win32") expect(lock.mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(current.lock))).toEqual(["credential-store.lock"]);
  // Without hard links, SQLite itself creates the file.
  rmSync(current.lock);
  const fallback = await attemptInChild("fallback", CHILD_LOCK_MS, { CONTENDER_FS: "no-hardlinks" });
  expect(fallback.lines).toContain("NO-HARDLINK fallback");
  expect(fallback.ok).toBe(true);
  expect(violations(fallback.lines)).toEqual([]);
  expect(statSync(current.lock).size).toBe(0);
  if (process.platform !== "win32") expect(statSync(current.lock).mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(current.lock))).toEqual(["credential-store.lock"]);
}, MARGIN_TEST_MS);

test("a lock path longer than SQLite opens is refused at once, and one at the limit locks", async () => {
  // Build a path of an exact byte length from short-enough components.
  const root = realpathSync(current.root);
  const pathOf = (bytes: number) => {
    let folder = join(root, `len-${bytes}`);
    while (Buffer.byteLength(folder) + 1 + 120 < bytes) folder = join(folder, "d".repeat(100));
    const path = join(folder, "f".repeat(bytes - Buffer.byteLength(folder) - 1));
    expect(Buffer.byteLength(path)).toBe(bytes);
    return path;
  };
  const atLimit = pathOf(SQLITE_PATH_LIMIT);
  process.env[CREDENTIAL_LOCK_FILE_ENV] = atLimit;
  expect((await attempt(5000)).ran).toBe(true);
  const over = pathOf(SQLITE_PATH_LIMIT + 1);
  process.env[CREDENTIAL_LOCK_FILE_ENV] = over;
  const result = await attempt(5000);
  expect({ ran: result.ran, fast: result.elapsedMs < 1000 }).toEqual({ ran: false, fast: true });
  expect(result.message).toBe(`Cannot save credential in the OS secure store. The lock path ${displayed(over)} is too long. Set SCHWAY_CREDENTIAL_LOCK_FILE to a shorter absolute path, then retry. No credential was changed.`);
  expect(existsSync(over)).toBe(false);
});

test("an override spelled exactly as the default stays the default while an older build's folder flickers", async () => {
  // The first stat of the lock path reports it missing, as an older build
  // removing and recreating its folder between two stat calls would.
  mkdirSync(current.lock, { recursive: true });
  const result = await attemptInChild("flap", 300, { CONTENDER_FS: "stat-flap" });
  expect(result.lines).toContain("STAT-FLAP flap");
  expect(result.message).toBe("Cannot save credential in the OS secure store. An older Schway's lock folder is at ~/.schway/credential-store.lock. Close every older Schway, delete that folder, then retry. No credential was changed.");
}, MARGIN_TEST_MS);

test("lock waits must be whole milliseconds within the supported range", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, MAX_LOCK_TIMEOUT_MS + 1]) {
    await expect(withCredentialStoreLock(async () => {}, { timeoutMs })).rejects.toThrow(new RangeError(`timeoutMs must be a whole number of milliseconds from 1 to ${MAX_LOCK_TIMEOUT_MS}.`));
    expect(() => createNativeCredentialStore(undefined, { lockTimeoutMs: timeoutMs })).toThrow(new RangeError(`lockTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_LOCK_TIMEOUT_MS}.`));
  }
  expect(validLockTimeoutMs(1)).toBe(1);
  expect(validLockTimeoutMs(MAX_LOCK_TIMEOUT_MS)).toBe(MAX_LOCK_TIMEOUT_MS);
});

test("the lock file defaults to the per-user Schway home and follows an absolute override", async () => {
  const blank = spawnContender("once", "blank", { ...current.env, [CREDENTIAL_LOCK_FILE_ENV]: " " });
  expect(await blank.child.exited).toBe(0);
  expect(statSync(join(current.home, ".schway", "credential-store.lock")).isFile()).toBe(true);
  rmSync(join(current.home, ".schway"), { recursive: true, force: true });
  const pinned = join(current.root, "pinned", "nested", "credential.lock");
  const overridden = spawnContender("once", "overridden", { ...current.env, [CREDENTIAL_LOCK_FILE_ENV]: pinned });
  expect(await overridden.child.exited).toBe(0);
  expect(statSync(pinned).isFile()).toBe(true);
  expect(existsSync(join(current.home, ".schway", "credential-store.lock"))).toBe(false);
  // In process, the path follows the current environment and home directory.
  process.env[CREDENTIAL_LOCK_FILE_ENV] = pinned;
  expect(credentialStoreLockPath()).toBe(pinned);
  process.env[CREDENTIAL_LOCK_FILE_ENV] = "";
  expect(credentialStoreLockPath()).toBe(join(homedir(), ".schway", "credential-store.lock"));
}, MARGIN_TEST_MS);

test("a relative lock-file override fails closed at once without backend contact", async () => {
  const cwd = process.cwd();
  const scratch = join(current.root, "cwd");
  mkdirSync(scratch);
  process.chdir(scratch);
  try {
    process.env[CREDENTIAL_LOCK_FILE_ENV] = join("relative", "credential.lock");
    expect(credentialStoreLockPath()).toBeNull();
    const local = await occupancyStore();
    const startedAt = Date.now();
    const refused = await local.store.delete({ account: "a", label: "a" }).then(() => null, (error: unknown) => error);
    expect(String((refused as Error)?.message)).toBe("Cannot delete credential in the OS secure store. SCHWAY_CREDENTIAL_LOCK_FILE must be an absolute path. Set an absolute path or unset it, then retry. No credential was changed.");
    // A misconfiguration refuses at once instead of waiting out the bound.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(local.calls()).toBe(0);
    expect(existsSync(join(scratch, "relative"))).toBe(false);
  } finally {
    process.chdir(cwd);
  }
});

test("lock failures keep their next action through store-error sanitizers", async () => {
  const lockFailure = credentialLockError("delete", "Reason. Action.");
  expect(preserveRefusal("delete", lockFailure)).toBe(lockFailure);
  expect(credentialStoreFailure("delete", lockFailure)).toBe(lockFailure.message);
  // Anything else, including native error text, still becomes generic guidance.
  expect(preserveRefusal("save", new Error("native keychain detail")).message).toBe(credentialStoreError("save"));
  expect(credentialStoreFailure("save", new Error("native keychain detail"))).toBe(credentialStoreError("save"));
  // The API-key removal path reports the lock's next action, not the keychain text.
  const { removeStoredCredential } = await import("../src/auth/management.ts");
  const local = await occupancyStore();
  process.env[CREDENTIAL_LOCK_FILE_ENV] = "relative.lock";
  const result = await removeStoredCredential({ provider: "openai", store: local.store, env: {} });
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/^Cannot delete credential in the OS secure store\. SCHWAY_CREDENTIAL_LOCK_FILE must be an absolute path\./);
  expect(local.calls()).toBe(0);
});

test("a mutation racing a held lock fails closed without backend contact", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  const backend = new Map<string, string>();
  let backendCalls = 0;
  const secrets = {
    get: async ({ name }: { service: string; name: string }) => { backendCalls++; return backend.get(name) ?? null; },
    set: async ({ name, value }: { service: string; name: string; value: string }) => { backendCalls++; backend.set(name, value); },
    delete: async ({ name }: { service: string; name: string }) => { backendCalls++; return backend.delete(name); },
  };
  const native = createNativeCredentialStore(secrets as never);
  // Hold the shared lock past the contender's bound from this same process:
  // a second SQLite connection contends exactly like another process would.
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>(resolve => { releaseHolder = resolve; });
  const holder = withCredentialStoreLock(async () => { await holderGate; }, { timeoutMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    const failure = await native.set({ account: "a", label: "a" }, "late").then(
      () => null,
      (error: unknown) => error,
    );
    expect(String((failure as Error)?.message ?? failure)).toMatch(/Cannot save credential/);
    // Failed closed before any backend contact: nothing was written.
    expect(backendCalls).toBe(0);
    expect(backend.size).toBe(0);
  } finally {
    releaseHolder();
    await holder;
  }
});

test("native compare-and-delete rejects on backend failure, false only on mismatch", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  const backend = new Map<string, string>([["a", "v1"]]);
  const flaky = {
    get: async ({ name }: { service: string; name: string }) => {
      if (name === "boom-read") throw new Error("locked");
      return backend.get(name) ?? null;
    },
    set: async ({ name, value }: { service: string; name: string; value: string }) => { backend.set(name, value); },
    delete: async ({ name }: { service: string; name: string }) => {
      if (name === "boom-delete") throw new Error("locked");
      return backend.delete(name);
    },
  };
  const store = createNativeCredentialStore(flaky as never);
  // Proven mismatch reads clean: no removal, explicit false.
  expect(await store.compareAndDelete!({ account: "a", label: "a" }, "other")).toBe(false);
  expect(backend.get("a")).toBe("v1");
  // Backend failures reject with sanitized errors, never a silent false.
  await expect(store.compareAndDelete!({ account: "boom-read", label: "x" }, "v")).rejects.toThrow(/Cannot read credential/);
  backend.set("boom-delete", "v");
  await expect(store.compareAndDelete!({ account: "boom-delete", label: "x" }, "v")).rejects.toThrow(/Cannot delete credential/);
  expect(backend.get("boom-delete")).toBe("v");
});

test("cleanup backend failure propagates as uncertain refusal, not silent success", async () => {
  const { effectiveStore: guarded } = await import("../src/host/auth-routes.ts");
  void guarded;
  const backend = new Map<string, string>();
  let calls = 0;
  const base = {
    get: async (identity: { account: string }) => backend.get(identity.account) ?? null,
    set: async (identity: { account: string }, value: string) => { calls++; backend.set(identity.account, value); },
    delete: async (_identity: { account: string }) => { calls++; throw new Error("keychain unavailable"); },
  };
  const selection = {
    route: "grok" as const,
    model: "grok-4.7",
    store: base,
    // First set passes pre- and post-write checks; the second set passes
    // pre-write and fails the post-write recheck with a failing cleanup.
    credentialWriteGuard: (() => {
      let n = 0;
      return async () => { n++; if (n >= 4) throw new Error("owner stopped"); };
    })(),
  };
  const store = effectiveStore(selection);
  await store.set({ account: "grok-subscription:xai", label: "x" }, "fresh-token");
  const error = await store.set({ account: "grok-subscription:xai", label: "x" }, "late-token").then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(isCredentialWriteRefused(error)).toBe(true);
  expect((error as { cleanupUncertain?: unknown }).cleanupUncertain).toBe(true);
  // Terminal refusal, explicitly uncertain — never reported as cleanly fenced.
  expect(calls).toBeGreaterThan(0);
});
test("guarded native store removes exactly the late write after terminal", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  const backend = new Map<string, string>();
  const secrets = {
    get: async ({ name }: { service: string; name: string }) => backend.get(name) ?? null,
    set: async ({ name, value }: { service: string; name: string; value: string }) => { backend.set(name, value); },
    delete: async ({ name }: { service: string; name: string }) => backend.delete(name),
  };
  // The production construction path: Schway's own native store (with an
  // injected backend instead of the real keychain) behind the guard.
  const native = createNativeCredentialStore(secrets as never);
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let entered = false;
  const gated: Parameters<typeof effectiveStore>[0]["store"] = {
    get: (identity) => native.get(identity),
    set: async (identity, value) => { entered = true; await writeGate; return native.set(identity, value); },
    delete: (identity) => native.delete(identity),
  };
  let calls = 0;
  const selection = {
    route: "grok" as const,
    model: "grok-4.7",
    store: gated,
    credentialWriteGuard: async () => { calls++; if (calls > 1) throw new Error("owner stopped"); },
  };
  const guarded = effectiveStore(selection);
  const pending = guarded.set({ account: "grok-subscription:xai", label: "x" }, "late-token");
  for (let spin = 0; spin < 200 && !entered; spin++) await new Promise(r => setTimeout(r, 5));
  expect(entered).toBe(true);
  // Terminal lands mid-write; releasing lets the write land, then the
  // post-write recheck removes exactly that late value.
  releaseWrite();
  await expect(pending).rejects.toThrow(/fence/);
  expect(backend.size).toBe(0);
});

test("a late native write over a legitimate value leaves no resurrected credential", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  // A legitimate login sits in the store; the probe's late write overwrites
  // it, then the post-write recheck removes exactly that late value. The
  // overwritten login is unrecoverable (documented residual) — but nothing
  // is resurrected and nothing of the probe's remains.
  const backend = new Map<string, string>([["grok-subscription:xai", "legitimate-login"]]);
  const secrets = {
    get: async ({ name }: { service: string; name: string }) => backend.get(name) ?? null,
    set: async ({ name, value }: { service: string; name: string; value: string }) => { backend.set(name, value); },
    delete: async ({ name }: { service: string; name: string }) => backend.delete(name),
  };
  const native = createNativeCredentialStore(secrets as never);
  let calls = 0;
  const guarded = effectiveStore({
    route: "grok",
    model: "grok-4.7",
    store: native,
    credentialWriteGuard: async () => { calls++; if (calls > 1) throw new Error("owner stopped"); },
  });
  await expect(guarded.set({ account: "grok-subscription:xai", label: "x" }, "late-token")).rejects.toThrow(/fence/);
  expect(backend.size).toBe(0);
});

