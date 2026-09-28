import { mock } from "bun:test";
import * as fs from "node:fs";

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
