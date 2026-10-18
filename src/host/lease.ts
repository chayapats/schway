import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { HostError } from "./index.ts";

/** Exclusive local-filesystem session ownership, retained until idle close or positive stopped-process evidence. */
export interface SessionLease {
  assertOwned(): void;
  release(): void;
}

/** Admit one writer across host processes; uncertain owners and abandoned admission gates remain busy. */
export function acquireSessionLease(directory: string, id: string): SessionLease {
  const path = join(directory, `${id}.host-lease`), gate = `${path}.admission`;
  const owner = { version: 1, host: hostname(), pid: process.pid, token: crypto.randomUUID() };
  const text = JSON.stringify(owner);
  try { mkdirSync(gate, { mode: 0o700 }); }
  catch { throw new HostError("busy"); }
  try {
    try {
      const saved = readFileSync(path, "utf8");
      let previous;
      try { previous = JSON.parse(saved); } catch { throw new HostError("busy"); }
      if (!previous || previous.version !== 1 || previous.host !== owner.host || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new HostError("busy");
      try { process.kill(previous.pid, 0); throw new HostError("busy"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new HostError("busy"); }
      // All admissions hold this gate. ESRCH is positive local stopped-owner evidence,
      // not an age/timeout heuristic; a reused live PID conservatively stays busy.
      unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError("storage");
  } finally { rmdirSync(gate); }
  let released = false;
  const assertOwned = () => {
    try { if (released || readFileSync(path, "utf8") !== text) throw new Error(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostError("storage"); throw new HostError("conflict"); }
  };
  return {
    assertOwned,
    release() {
      if (released) return;
      // Never remove a replacement owner's token or guess the location of a moved store.
      try { if (readFileSync(path, "utf8") === text) unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage"); }
      released = true;
    },
  };
}
