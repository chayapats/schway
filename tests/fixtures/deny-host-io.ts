import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as os from "node:os";

/** Preload: while `globalThis.denyHostIo` is set, every node:fs, node:child_process, node:os and Bun process/file call records its name and throws. */
const state = globalThis as unknown as { denyHostIo?: boolean; deniedCalls: string[] };
state.deniedCalls = [];
const guard = <T extends object>(name: string, target: T): T => new Proxy(target, {
  apply(fn, self, args) {
    if (state.denyHostIo) { state.deniedCalls.push(name); throw new Error(`Forbidden host call: ${name}`); }
    return Reflect.apply(fn as (...args: unknown[]) => unknown, self, args);
  },
  construct(fn, args, newTarget) {
    if (state.denyHostIo) { state.deniedCalls.push(name); throw new Error(`Forbidden host call: ${name}`); }
    return Reflect.construct(fn as new (...args: unknown[]) => object, args, newTarget);
  },
});
const block = (prefix: string, module: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(module).map(([key, value]) => {
  if (typeof value === "function") return [key, guard(`${prefix}.${key}`, value)];
  if (value && typeof value === "object" && key === "promises") return [key, block(`${prefix}.promises`, value as Record<string, unknown>)];
  return [key, value];
}));
mock.module("node:fs", () => block("fs", fs));
mock.module("node:fs/promises", () => block("fs/promises", promises));
mock.module("node:child_process", () => block("child_process", childProcess));
mock.module("node:os", () => block("os", os));
const bun = Bun as unknown as Record<string, unknown>;
for (const name of ["spawn", "spawnSync", "which", "file", "write"]) bun[name] = guard(`Bun.${name}`, bun[name] as object);
for (const name of ["scan", "scanSync"] as const) {
  const original = Bun.Glob.prototype[name];
  Bun.Glob.prototype[name] = guard(`Bun.Glob.${name}`, original) as never;
}
