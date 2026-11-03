// One Schway-mediated credential mutation per process, reported as stdout lines.
// Roles: `hold` enters the lock and never leaves (the parent SIGKILLs it to model
// a crashed holder); `once` enters, marks a shared occupancy directory, waits
// CONTENDER_HOLD_MS, then leaves. Any removal of the lock path is reported, and
// CONTENDER_BREAK_DELAY_MS stalls this process's first removal so a contender
// acting on an earlier stale read is preempted inside its read-then-remove window.
import { mock } from "bun:test";
import * as filesystem from "node:fs";

const real = { ...filesystem };
const name = process.env.CONTENDER_NAME ?? "contender";
const role = process.argv[2];
const occupancy = process.env.CONTENDER_OCCUPANCY ?? "";
const holdMs = Number(process.env.CONTENDER_HOLD_MS ?? "0");
const breakDelayMs = Number(process.env.CONTENDER_BREAK_DELAY_MS ?? "0");
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
mock.module("node:fs", () => ({
  ...real,
  rmSync: watched(real.rmSync),
  rmdirSync: watched(real.rmdirSync),
  unlinkSync: watched(real.unlinkSync),
  renameSync: watched(real.renameSync),
}));

const { createNativeCredentialStore } = await import("../../../src/auth/store.ts");
const backend = {
  async get() { return null; },
  async set() {
    if (role === "hold") {
      say("ENTERED");
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

try {
  await createNativeCredentialStore(backend as never).set({ account: "lock-fixture", label: "Lock fixture" }, "value");
  say("DONE");
  process.exit(0);
} catch (error) {
  say("FAILED", JSON.stringify(String((error as Error)?.message ?? error)));
  process.exit(1);
}
