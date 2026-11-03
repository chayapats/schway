// Run one Schway SQLite lock site in its own process and report stdout lines.
// argv: <site> <role>. Sites: `history` (session-evidence deletion), `undo`
// (shell attribution), `memory` (interactive choice), `preferences` (a pin) and
// `preferences-read`. Roles:
// - `once` runs one operation and reports `DONE` or `FAILED {code,message,elapsedMs}`.
// - `gc` parks one operation inside its lock on a promise nothing references,
//   forces garbage collection, then runs a contender in this process and
//   reports the contender's outcome. Not available for preferences, which
//   holds its connection only inside one synchronous call.
// FIXTURE_HOME is the isolated home; FIXTURE_WORKSPACE the memory workspace.
// FIXTURE_WAIT_MS sets the history lock wait (default 1000).
// FIXTURE_SQLITE=readonly opens every SQLite connection read-only, as a
// sandbox that denies open(O_RDWR) while access(2) allows it would;
// `cantopen-after:<ms>` fails every SQLite open with SQLITE_CANTOPEN once the
// operation has run that long, while access(2) still allows the file.
// `DONE` reports the favorites a preferences read returned.
// Any successful descriptor open of a lock file or the preferences database
// outside SQLite is reported as `FD-OPEN <path>`.
import { mock } from "bun:test";
import * as sqlite from "bun:sqlite";
import * as filesystem from "node:fs";
import * as promises from "node:fs/promises";

const site = process.argv[2] ?? "";
const role = process.argv[3] ?? "once";
const home = process.env.FIXTURE_HOME ?? "";
const workspace = process.env.FIXTURE_WORKSPACE ?? "";
const waitMs = Number(process.env.FIXTURE_WAIT_MS ?? "1000");
const real = { ...filesystem };
const realPromises = { ...promises };
/** Write one synchronous protocol line. */
const say = (line: string) => real.writeSync(1, `${line}\n`);
/** Lock files and the preferences database, which only SQLite may hold a descriptor on. */
const watched = (path: unknown) => /\.lock$|model-preferences\.sqlite$/.test(String(path));

let entered = false;
let parked = false;
/** A promise nothing references, so only the lock module can keep the holder's connection alive. */
const park = (): Promise<never> => {
  entered = true;
  say("ENTERED");
  return new Promise<never>(() => {});
};

mock.module("node:fs", () => ({
  ...real,
  openSync: (...args: Parameters<typeof real.openSync>) => {
    const fd = real.openSync(...args);
    if (watched(args[0])) say(`FD-OPEN ${String(args[0])}`);
    return fd;
  },
}));
mock.module("node:fs/promises", () => ({
  ...realPromises,
  open: async (...args: Parameters<typeof realPromises.open>) => {
    const file = await realPromises.open(...args);
    if (watched(args[0])) say(`FD-OPEN ${String(args[0])}`);
    return file;
  },
  // The first undo session removal parks inside the undo lock.
  rm: (...args: Parameters<typeof realPromises.rm>) => {
    if (role === "gc" && site === "undo" && !parked && String(args[0]).includes("/.schway/undo/")) { parked = true; return park(); }
    return realPromises.rm(...args);
  },
  // The first workspace record publication parks inside the memory lock.
  rename: (...args: Parameters<typeof realPromises.rename>) => {
    if (role === "gc" && site === "memory" && !parked && String(args[1]).includes("/.schway/interactive/")) { parked = true; return park(); }
    return realPromises.rename(...args);
  },
}));
const sqliteFault = process.env.FIXTURE_SQLITE ?? "";
const cantOpenAfterMs = /^cantopen-after:(\d+)$/.exec(sqliteFault)?.[1];
/** When the measured operation began; open faults are timed from here. */
let operationStartedAt = Number.POSITIVE_INFINITY;
if (sqliteFault) {
  const RealDatabase = sqlite.Database;
  /** Database that applies the requested connection fault before opening. */
  class FaultyDatabase extends RealDatabase {
    constructor(path: string, options?: ConstructorParameters<typeof RealDatabase>[1]) {
      if (cantOpenAfterMs !== undefined && Date.now() - operationStartedAt >= Number(cantOpenAfterMs)) {
        throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
      }
      super(path, sqliteFault === "readonly" ? { readonly: true } : options);
    }
  }
  mock.module("bun:sqlite", () => ({ ...sqlite, Database: FaultyDatabase }));
}

const { deleteHistorySession } = await import("../../../src/history/store.ts");
const { openUndoStore, deleteUndoSession } = await import("../../../src/undo/store.ts");
const { InteractiveMemory } = await import("../../../src/config/interactive-memory.ts");
const { ModelPreferences } = await import("../../../src/config/model-preferences.ts");

const turn = { sessionId: "session", turnId: "turn", turnNumber: 1 };
const choice = { provider: "openai" as const, model: "gpt-5.4", openaiAuth: "api-key" as const };
const identity = "a".repeat(64);

/** One mutation at the selected site; `ENTERED` marks history work running inside the lock. */
async function operation(): Promise<unknown> {
  switch (site) {
    case "history": return deleteHistorySession({ home, sessionId: "session", lockWaitMs: waitMs }, async () => { say("ENTERED"); });
    case "undo": return openUndoStore({ home }).recordShell(turn, { detection: "unavailable" });
    case "memory": return (await InteractiveMemory.load(home, workspace)).write(choice);
    case "preferences": return new ModelPreferences(home).pin(identity, true);
    case "preferences-read": return new ModelPreferences(home).read();
  }
  throw new Error(`Unknown site ${site}`);
}

/** Start one operation that parks inside the lock and is never awaited or referenced. */
async function startParked(): Promise<void> {
  switch (site) {
    case "history": void deleteHistorySession({ home, sessionId: "parked", lockWaitMs: waitMs }, park); return;
    case "undo":
      real.mkdirSync(`${home}/.schway/undo/parked`, { recursive: true });
      void deleteUndoSession({ home, sessionId: "parked" });
      return;
    case "memory": void (await InteractiveMemory.load(home, workspace)).write(choice); return;
  }
  throw new Error(`No parked holder for ${site}`);
}

if (role === "gc") {
  await startParked();
  for (let spin = 0; spin < 400 && !entered; spin++) await Bun.sleep(5);
  if (!entered) { say("FAILED {\"message\":\"parked holder never entered\"}"); process.exit(1); }
  // Churn allocations across timer ticks so no stale stack slot still points
  // at the parked frame; without a pin, its connection is then finalized.
  for (let round = 0; round < 10; round++) {
    void Array.from({ length: 10_000 }, (_, index) => ({ index }));
    await new Promise(resolve => setTimeout(resolve, 10));
    Bun.gc(true);
  }
}
const startedAt = Date.now();
operationStartedAt = startedAt;
try {
  const result = await operation() as { favorites?: unknown } | undefined;
  say(`DONE ${JSON.stringify({ elapsedMs: Date.now() - startedAt, ...(site === "preferences-read" ? { favorites: result?.favorites } : {}) })}`);
  process.exit(0);
} catch (error) {
  const { code, message } = error as { code?: unknown; message?: unknown };
  say(`FAILED ${JSON.stringify({ code: code === undefined ? undefined : String(code), message: String(message ?? error), elapsedMs: Date.now() - startedAt })}`);
  process.exit(1);
}
