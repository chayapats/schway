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

test("a wedged holder fails closed instead of mutating without the lock", async () => {
  mkdirSync(credentialStoreLockDir(), { mode: 0o700, recursive: true });
  try {
    const startedAt = Date.now();
    // No owner can be proven stopped (no owner file at all): after the
    // bounded wait the waiter fails closed with a sanitized store error
    // instead of hanging forever or mutating without the lock.
    let ran = false;
    const failure = await withCredentialStoreLock(async () => { ran = true; }, { timeoutMs: 100 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(ran).toBe(false);
    expect(String((failure as Error)?.message ?? failure)).toMatch(/Cannot (save|read|delete) credential/);
  } finally {
    rmSync(credentialStoreLockDir(), { recursive: true, force: true });
  }
});

test("a dead owner is collected without waiting out the timeout", async () => {
  const dir = credentialStoreLockDir();
  mkdirSync(dir, { mode: 0o700, recursive: true });
  try {
    // A fabricated owner with a PID that cannot exist proves stopped
    // ownership; the token makes the stale read attributable.
    const { randomUUID } = await import("node:crypto");
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ host: hostname(), pid: 2147483647, token: randomUUID() }));
    const startedAt = Date.now();
    await withCredentialStoreLock(async () => {}, { timeoutMs: 5000 });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // the directory mutex is process-agnostic, so this exercises the exact
  // cross-process contention path.
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
    rmSync(credentialStoreLockDir(), { recursive: true, force: true });
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
  try {
    // Proven mismatch reads clean: no removal, explicit false.
    expect(await store.compareAndDelete!({ account: "a", label: "a" }, "other")).toBe(false);
    expect(backend.get("a")).toBe("v1");
    // Backend failures reject with sanitized errors, never a silent false.
    await expect(store.compareAndDelete!({ account: "boom-read", label: "x" }, "v")).rejects.toThrow(/Cannot read credential/);
    backend.set("boom-delete", "v");
    await expect(store.compareAndDelete!({ account: "boom-delete", label: "x" }, "v")).rejects.toThrow(/Cannot delete credential/);
    expect(backend.get("boom-delete")).toBe("v");
  } finally {
    rmSync(credentialStoreLockDir(), { recursive: true, force: true });
  }
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

