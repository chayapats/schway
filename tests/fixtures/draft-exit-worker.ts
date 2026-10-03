import { mock } from "bun:test";
import * as fs from "node:fs";

/** Ref and await a fixture-owned worker, killing it on a bounded deadline and always clearing the watchdog. */
export async function reapDraftCheckpointWorker(worker: Pick<Bun.Subprocess, "ref" | "kill" | "exited">, timeoutMs = 1500): Promise<number> {
  worker.ref();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([worker.exited, new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => {
        try { worker.kill("SIGKILL"); } catch { /* The worker may have just exited. */ }
        reject(new Error("Checkpoint fixture worker did not reap before its deadline"));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(watchdog); }
}

if (import.meta.main) {
  const open = fs.openSync, write = fs.writeFileSync;
  const temporaryDescriptors = new Set<number>();
  mock.module("node:fs", () => ({ ...fs, openSync: ((...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (typeof args[0] === "string" && /\.json\.[a-f0-9-]+\.tmp$/.test(args[0])) temporaryDescriptors.add(fd);
    return fd;
  }), writeFileSync: ((...args: Parameters<typeof write>) => {
    if (typeof args[0] === "number" && temporaryDescriptors.has(args[0])) {
      if (process.env.SCHWAY_DRAFT_FIXTURE === "blocked-exit") { write(process.env.SCHWAY_DRAFT_FIXTURE_MARKER!, "blocked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      throw Object.assign(Error("disk failure fixture"), { code: process.env.SCHWAY_DRAFT_FIXTURE === "permission" ? "EACCES" : "ENOSPC" });
    }
    return write(...args);
  }) }));
  await import("../../src/drafts/exit-worker.ts");
}
