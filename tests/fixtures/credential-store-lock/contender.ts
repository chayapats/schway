// One Schway-mediated credential mutation per process, reported as stdout lines.
// Roles: `hold` enters the lock and never leaves (the parent SIGKILLs it to model
// a crashed holder); `once` enters, marks a shared occupancy directory, waits
// CONTENDER_HOLD_MS, then leaves. `STARTED` is reported just before the mutation
// begins polling the lock. Any removal of the lock path is reported, and
// CONTENDER_BREAK_DELAY_MS stalls this process's first removal so a contender
// acting on an earlier stale read is preempted inside its read-then-remove window.
// CONTENDER_LOCK_TIMEOUT_MS (default 30 s) widens the native store's 2 s lock
// bound, so machine load turns into a longer wait rather than a refusal.
// `DONE` and `FAILED` report the mutation's own elapsed time, excluding startup.
// CONTENDER_SQLITE injects a connection fault: `readonly` opens every
// connection read-only (as a sandbox that denies open(O_RDWR) would);
// `vanish-once` deletes the lock file just before the first open;
// `open-denied` fails every SQLite open with SQLITE_CANTOPEN while access(2)
// still allows the file (as Landlock can); `cantopen-once` fails only the first.
// CONTENDER_FS injects a filesystem fault: `emfile-once` fails the first
// temporary create with EMFILE; `no-hardlinks` fails every link(2) with EPERM;
// `stat-flap` makes the first stat of the lock path report ENOENT.
// CONTENDER_UMASK (octal) sets the process umask before the mutation.
// Any open(2) of the lock path outside SQLite is reported as `FD-OPEN`.
import { mock } from "bun:test";
import * as sqlite from "bun:sqlite";
import * as filesystem from "node:fs";

const real = { ...filesystem };
const name = process.env.CONTENDER_NAME ?? "contender";
const role = process.argv[2];
const occupancy = process.env.CONTENDER_OCCUPANCY ?? "";
const holdMs = Number(process.env.CONTENDER_HOLD_MS ?? "0");
const breakDelayMs = Number(process.env.CONTENDER_BREAK_DELAY_MS ?? "0");
const lockTimeoutMs = Number(process.env.CONTENDER_LOCK_TIMEOUT_MS ?? "30000");
const sqliteFault = process.env.CONTENDER_SQLITE ?? "";
const fsFault = process.env.CONTENDER_FS ?? "";
/** Write one synchronous protocol line, so a later SIGKILL cannot lose it. */
const say = (event: string, detail = "") => real.writeSync(1, `${event} ${name}${detail ? ` ${detail}` : ""}\n`);

// Lock fixtures never reach the developer's real OS secure store.
Object.defineProperty(Bun, "secrets", {
  value: {
    async get() { return null; },
    async set() { throw new Error("Real secure-store writes are disabled in lock fixtures"); },
    async delete() { throw new Error("Real secure-store deletions are disabled in lock fixtures"); },
  },
});

let stalled = false;
/** Report, and optionally stall, a filesystem removal that targets the lock path. */
function watched<F extends (...args: never[]) => unknown>(remove: F): F {
  return ((...args: Parameters<F>) => {
    if (String(args[0]).endsWith("credential-store.lock")) {
      say("REMOVE");
      if (breakDelayMs > 0 && !stalled) {
        stalled = true;
        say("BREAKING");
        Bun.sleepSync(breakDelayMs);
      }
    }
    return remove(...args);
  }) as F;
}
/** An Error carrying a Node-style errno code. */
const errnoError = (code: string) => Object.assign(new Error(`${code}: injected by the lock fixture`), { code });
let createEmfileUsed = false;
let statFlapped = false;
/** openSync that reports any descriptor on the lock path and injects a temporary-create fault. */
function faultyOpenSync(...args: Parameters<typeof real.openSync>): number {
  const [path] = args;
  if (String(path).endsWith("credential-store.lock")) say("FD-OPEN");
  if (fsFault === "emfile-once" && !createEmfileUsed && /[\\/]\.cl[a-z0-9]{5}$/.test(String(path))) {
    createEmfileUsed = true;
    say("EMFILE");
    throw errnoError("EMFILE");
  }
  return real.openSync(...args);
}
/** linkSync that fails as a filesystem without hard links would. */
function faultyLinkSync(...args: Parameters<typeof real.linkSync>): void {
  if (fsFault === "no-hardlinks") {
    say("NO-HARDLINK");
    throw errnoError("EPERM");
  }
  return real.linkSync(...args);
}
/** statSync whose first call on the lock path reports it missing, as a racing older build could. */
function faultyStatSync(...args: Parameters<typeof real.statSync>): ReturnType<typeof real.statSync> {
  if (fsFault === "stat-flap" && !statFlapped && String(args[0]).endsWith("credential-store.lock")) {
    statFlapped = true;
    say("STAT-FLAP");
    throw errnoError("ENOENT");
  }
  return real.statSync(...args);
}
mock.module("node:fs", () => ({
  ...real,
  openSync: faultyOpenSync,
  linkSync: faultyLinkSync,
  statSync: faultyStatSync,
  rmSync: watched(real.rmSync),
  rmdirSync: watched(real.rmdirSync),
  unlinkSync: watched(real.unlinkSync),
  renameSync: watched(real.renameSync),
}));

if (sqliteFault) {
  const RealDatabase = sqlite.Database;
  let vanished = false;
  let cantOpenUsed = false;
  /** Database that applies the requested connection fault before opening. */
  class FaultyDatabase extends RealDatabase {
    constructor(path: string, options?: ConstructorParameters<typeof RealDatabase>[1]) {
      if (sqliteFault === "vanish-once" && !vanished) {
        vanished = true;
        real.unlinkSync(path);
        say("VANISHED");
      }
      if (sqliteFault === "open-denied" || (sqliteFault === "cantopen-once" && !cantOpenUsed)) {
        cantOpenUsed = true;
        throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
      }
      super(path, sqliteFault === "readonly" ? { readonly: true } : options);
    }
  }
  mock.module("bun:sqlite", () => ({ ...sqlite, Database: FaultyDatabase }));
}

const { createNativeCredentialStore } = await import("../../../src/auth/store.ts");
const backend = {
  async get() { return null; },
  async set() {
    if (role === "hold") {
      say("ENTERED");
      // Stay inside the lock until SIGKILL; the interval keeps the event loop alive.
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    }
    let marked = false;
    try {
      real.mkdirSync(occupancy);
      marked = true;
    } catch {
      say("OVERLAP");
    }
    say("ENTERED");
    await Bun.sleep(holdMs);
    say("EXITED");
    if (marked) real.rmdirSync(occupancy);
  },
  async delete() { return false; },
};

if (process.env.CONTENDER_UMASK) process.umask(Number.parseInt(process.env.CONTENDER_UMASK, 8));
const store = createNativeCredentialStore(backend as never, { lockTimeoutMs });
say("STARTED");
const startedAt = Date.now();
try {
  await store.set({ account: "lock-fixture", label: "Lock fixture" }, "value");
  say("DONE", JSON.stringify({ elapsedMs: Date.now() - startedAt }));
  process.exit(0);
} catch (error) {
  say("FAILED", JSON.stringify({ message: String((error as Error)?.message ?? error), elapsedMs: Date.now() - startedAt }));
  process.exit(1);
}
