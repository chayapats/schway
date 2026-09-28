import { mock } from "bun:test";
import * as fs from "node:fs";

// Pause the real checkpoint caller after its temporary file is durable but
// before replacement. The parent SIGKILL exercises startup recovery after death.
let syncs = 0;
let writes = 0;
const sync = fs.fsyncSync;
const write = fs.writeFileSync;
const failure = process.argv[3];
mock.module("node:fs", () => ({ ...fs, writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
  if (++writes === 2 && failure) throw Object.assign(new Error(failure), { code: failure });
  return write(...args);
}), fsyncSync(fd: number) {
  sync(fd);
  if (++syncs === 2) {
    process.stdout.write("replacement-ready\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
} }));
const { openDraftStore } = await import("./store.ts");
try { openDraftStore(JSON.parse(process.argv[2]!)).save("incomplete replacement", 1); }
catch (error) { process.stdout.write(`save-failed:${(error as Error).message}\n`); }
