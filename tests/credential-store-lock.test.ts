import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { credentialStoreLockDir, withCredentialStoreLock } from "../src/auth/store-lock.ts";
import { effectiveStore, isCredentialWriteRefused } from "../src/host/auth-routes.ts";

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
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  // Second contender waits while the first holds the lock.
  expect(order).toEqual(["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(["first-start", "first-end", "second"]);
});

test("a wedged holder degrades to unserialized progress instead of hanging", async () => {
  mkdirSync(credentialStoreLockDir(), { mode: 0o700, recursive: true });
  const startedAt = Date.now();
  // No owner file and no live holder can be proven: after the bounded wait
  // the waiter proceeds rather than hanging forever.
  await withCredentialStoreLock(async () => {}, { timeoutMs: 100 });
  expect(Date.now() - startedAt).toBeLessThan(5000);
  rmSync(credentialStoreLockDir(), { recursive: true, force: true });
});

test("a dead owner is collected without waiting out the timeout", async () => {
  const dir = credentialStoreLockDir();
  mkdirSync(dir, { mode: 0o700, recursive: true });
  // A fabricated owner with a PID that cannot exist proves stopped ownership.
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ host: hostname(), pid: 2147483647 }));
  const startedAt = Date.now();
  await withCredentialStoreLock(async () => {}, { timeoutMs: 5000 });
  expect(Date.now() - startedAt).toBeLessThan(2000);
  rmSync(dir, { recursive: true, force: true });
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

