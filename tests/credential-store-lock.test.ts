import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { CREDENTIAL_LOCK_FILE_ENV, credentialStoreLockPath, withCredentialStoreLock } from "../src/auth/store-lock.ts";
import { effectiveStore, isCredentialWriteRefused } from "../src/host/auth-routes.ts";

const CONTENDER = join(import.meta.dir, "fixtures/credential-store-lock/contender.ts");

/** A fixture process reporting `<EVENT> <name>` lines for one Schway-mediated mutation. */
interface Contender {
  readonly child: Subprocess<"ignore", "pipe", "pipe">;
  readonly lines: string[];
  waitFor(match: (line: string) => boolean, timeoutMs?: number): Promise<string>;
}

/** Spawn a lock contender against an isolated home and lock location. */
function spawnContender(role: "hold" | "once", name: string, env: Record<string, string>): Contender {
  const child = Bun.spawn([process.execPath, CONTENDER, role], {
    env: { ...process.env, CONTENDER_NAME: name, ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
      for (const wake of waiters.splice(0)) wake();
    }
    for (const wake of waiters.splice(0)) wake();
  })();
  return {
    child,
    lines,
    async waitFor(match, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        if (Date.now() >= deadline || child.exitCode !== null) {
          const stderr = child.exitCode !== null ? await new Response(child.stderr).text() : "";
          throw new Error(`${name} never reported the awaited event: ${JSON.stringify(lines)} ${stderr}`);
        }
        await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), Bun.sleep(25)]);
      }
    },
  };
}

/** SIGKILL a fixture process if it is still running, then wait for the OS to reap it. */
async function kill(contender: Contender | undefined): Promise<void> {
  if (!contender) return;
  if (contender.child.exitCode === null) contender.child.kill("SIGKILL");
  await contender.child.exited;
}

/** Isolated home, lock location and occupancy marker shared by one test's processes. */
interface LockRoot {
  readonly root: string;
  readonly home: string;
  readonly lock: string;
  readonly occupancy: string;
  readonly env: Record<string, string>;
}

let current: LockRoot;
const inheritedOverride = process.env[CREDENTIAL_LOCK_FILE_ENV];

// Every test gets its own rendezvous, so nothing here touches the developer's
// real ~/.schway lock. The override names the default per-user location under
// the isolated home, which keeps earlier lock implementations (that ignore the
// override but honor HOME) on the same path for regression comparison.
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "schway-credential-lock-"));
  const home = join(root, "home");
  mkdirSync(home);
  const lock = join(home, ".schway", "credential-store.lock");
  const occupancy = join(root, "occupied");
  current = { root, home, lock, occupancy, env: { HOME: home, [CREDENTIAL_LOCK_FILE_ENV]: lock, CONTENDER_OCCUPANCY: occupancy } };
  process.env[CREDENTIAL_LOCK_FILE_ENV] = lock;
});

afterEach(() => {
  if (inheritedOverride === undefined) delete process.env[CREDENTIAL_LOCK_FILE_ENV];
  else process.env[CREDENTIAL_LOCK_FILE_ENV] = inheritedOverride;
  rmSync(current.root, { recursive: true, force: true });
});

/** Native store whose backend counts calls and flags any overlapping write via the shared occupancy marker. */
async function occupancyStore(): Promise<{ store: import("../src/auth/store.ts").CredentialStore; calls: () => number; overlaps: () => number }> {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  let calls = 0;
  let overlaps = 0;
  const secrets = {
    get: async () => { calls++; return null; },
    set: async () => {
      calls++;
      let marked = false;
      try { mkdirSync(current.occupancy); marked = true; } catch { overlaps++; }
      await Bun.sleep(50);
      if (marked) rmSync(current.occupancy, { recursive: true });
    },
    delete: async () => { calls++; return false; },
  };
  return { store: createNativeCredentialStore(secrets as never), calls: () => calls, overlaps: () => overlaps };
}

/** Run one guarded attempt, reporting whether its work ran, its rejection (null on success) and the elapsed time. */
async function attempt(timeoutMs: number): Promise<{ ran: boolean; failure: unknown; elapsedMs: number }> {
  const startedAt = Date.now();
  let ran = false;
  const failure = await withCredentialStoreLock(async () => { ran = true; }, { timeoutMs }).then(() => null, (error: unknown) => error);
  return { ran, failure, elapsedMs: Date.now() - startedAt };
}

test("concurrent stale breakers after a crashed holder never yield two holders", async () => {
  const { env } = current;
  const crashed = spawnContender("hold", "crashed", env);
  let first: Contender | undefined;
  let second: Contender | undefined;
  try {
    await crashed.waitFor(line => line === "ENTERED crashed");
    await kill(crashed);
    // The first contender either takes the released lock at once or, with
    // path-based stale breaking, stalls inside its read-then-remove window.
    first = spawnContender("once", "first", { ...env, CONTENDER_HOLD_MS: "200", CONTENDER_BREAK_DELAY_MS: "1500" });
    await first.waitFor(line => line === "BREAKING first" || line === "ENTERED first");
    // A second contender breaks the same stale owner and acquires inside
    // that window, then holds long enough for the stalled removal to land.
    second = spawnContender("once", "second", { ...env, CONTENDER_HOLD_MS: "2500" });
    const [firstExit, secondExit] = await Promise.all([first.child.exited, second.child.exited]);
    const lines = [...first.lines, ...second.lines];
    expect(lines.filter(line => line.startsWith("OVERLAP"))).toEqual([]);
    // No contender ever removes the lock path: there is no stale breaking.
    expect(lines.filter(line => line.startsWith("REMOVE"))).toEqual([]);
    expect(lines).toContain("DONE first");
    expect(lines).toContain("DONE second");
    expect([firstExit, secondExit]).toEqual([0, 0]);
  } finally {
    await kill(crashed);
    await kill(first);
    await kill(second);
  }
}, 20_000);

test("contenders in several processes take turns after a crashed holder", async () => {
  const crashed = spawnContender("hold", "crashed", current.env);
  const contenders: Contender[] = [];
  try {
    await crashed.waitFor(line => line === "ENTERED crashed");
    await kill(crashed);
    for (const name of ["a", "b", "c", "d"]) contenders.push(spawnContender("once", name, { ...current.env, CONTENDER_HOLD_MS: "50" }));
    // An in-process Schway mutation contends with the child processes too.
    const local = await occupancyStore();
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000 && !contenders.some(contender => contender.lines.some(line => line.startsWith("ENTERED")))) await Bun.sleep(5);
    await local.store.set({ account: "local", label: "Local" }, "value");
    const exits = await Promise.all(contenders.map(contender => contender.child.exited));
    const lines = contenders.flatMap(contender => contender.lines);
    expect(lines.filter(line => line.startsWith("OVERLAP") || line.startsWith("REMOVE"))).toEqual([]);
    expect(local.overlaps()).toBe(0);
    expect(local.calls()).toBe(1);
    expect(exits).toEqual([0, 0, 0, 0]);
    expect(lines.filter(line => line.startsWith("DONE")).sort()).toEqual(["DONE a", "DONE b", "DONE c", "DONE d"]);
  } finally {
    await kill(crashed);
    for (const contender of contenders) await kill(contender);
  }
}, 20_000);

test("a holder in another process blocks mutations until the OS releases it on SIGKILL", async () => {
  const holder = spawnContender("hold", "holder", current.env);
  try {
    await holder.waitFor(line => line === "ENTERED holder");
    const blocked = await attempt(200);
    expect(blocked.ran).toBe(false);
    expect(String((blocked.failure as Error)?.message)).toMatch(/^Cannot save credential in the OS secure store\./);
    // A real mutation fails closed after its bounded wait without backend contact.
    const local = await occupancyStore();
    const refused = await local.store.set({ account: "a", label: "a" }, "late").then(() => null, (error: unknown) => error);
    expect(String((refused as Error)?.message)).toMatch(/^Cannot save credential in the OS secure store\./);
    expect(local.calls()).toBe(0);
    await kill(holder);
    // No stale verdict or removal: the kernel already dropped the dead holder's lock.
    const after = await attempt(5000);
    expect(after.ran).toBe(true);
    expect(after.elapsedMs).toBeLessThan(1000);
    expect(statSync(current.lock).isFile()).toBe(true);
  } finally {
    await kill(holder);
  }
}, 20_000);

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

test("an earlier release's lock directory is honored for the bounded wait and never removed", async () => {
  // Earlier releases used a directory at this path. Neither a missing owner
  // nor a provably stopped one lets a contender remove it by path.
  for (const owner of [undefined, { host: hostname(), pid: 2147483647, token: crypto.randomUUID() }]) {
    mkdirSync(current.lock, { mode: 0o700, recursive: true });
    if (owner) writeFileSync(join(current.lock, "owner.json"), JSON.stringify(owner));
    const result = await attempt(100);
    expect(result.ran).toBe(false);
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(String((result.failure as Error)?.message)).toMatch(/^Cannot save credential in the OS secure store\./);
    expect(statSync(current.lock).isDirectory()).toBe(true);
    if (owner) expect(JSON.parse(readFileSync(join(current.lock, "owner.json"), "utf8"))).toEqual(owner);
    // The older holder releases its directory; the next mutation proceeds.
    rmSync(current.lock, { recursive: true, force: true });
    const next = await attempt(1000);
    expect(next.ran).toBe(true);
    rmSync(current.lock, { force: true });
  }
});

test("once the lock file exists, an earlier release can neither acquire nor break it", async () => {
  await withCredentialStoreLock(async () => {});
  const lock = statSync(current.lock);
  expect(lock.isFile()).toBe(true);
  if (process.platform !== "win32") expect(lock.mode & 0o777).toBe(0o600);
  // Earlier releases acquired with mkdir and only removed a lock whose
  // owner.json they could read; a regular file defeats both.
  expect(() => mkdirSync(current.lock, { mode: 0o700 })).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(() => readFileSync(join(current.lock, "owner.json"), "utf8")).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  // The inode is permanent: release never removes or replaces it.
  await withCredentialStoreLock(async () => {});
  expect(statSync(current.lock).ino).toBe(lock.ino);
});

test("the lock file defaults to the per-user Schway home and follows an absolute override", async () => {
  const blank = spawnContender("once", "blank", { ...current.env, [CREDENTIAL_LOCK_FILE_ENV]: " " });
  expect(await blank.child.exited).toBe(0);
  expect(statSync(join(current.home, ".schway", "credential-store.lock")).isFile()).toBe(true);
  rmSync(join(current.home, ".schway"), { recursive: true, force: true });
  const pinned = join(current.root, "pinned", "nested", "credential.lock");
  const overridden = spawnContender("once", "overridden", { ...current.env, [CREDENTIAL_LOCK_FILE_ENV]: pinned });
  expect(await overridden.child.exited).toBe(0);
  expect(statSync(pinned).isFile()).toBe(true);
  expect(existsSync(join(current.home, ".schway", "credential-store.lock"))).toBe(false);
  expect(credentialStoreLockPath({ HOME: current.home, [CREDENTIAL_LOCK_FILE_ENV]: pinned })).toBe(pinned);
  expect(credentialStoreLockPath({ [CREDENTIAL_LOCK_FILE_ENV]: "" })).toEndWith(join(".schway", "credential-store.lock"));
}, 20_000);

test("a relative lock-file override fails closed without backend contact", async () => {
  const cwd = process.cwd();
  const scratch = join(current.root, "cwd");
  mkdirSync(scratch);
  process.chdir(scratch);
  try {
    process.env[CREDENTIAL_LOCK_FILE_ENV] = join("relative", "credential.lock");
    expect(credentialStoreLockPath()).toBeNull();
    const local = await occupancyStore();
    const startedAt = Date.now();
    const refused = await local.store.delete({ account: "a", label: "a" }).then(() => null, (error: unknown) => error);
    expect(String((refused as Error)?.message)).toMatch(/^Cannot delete credential in the OS secure store\./);
    // A misconfiguration refuses at once instead of waiting out the bound.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(local.calls()).toBe(0);
    expect(existsSync(join(scratch, "relative"))).toBe(false);
  } finally {
    process.chdir(cwd);
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
  // a second SQLite connection contends exactly like another process would.
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
  // Proven mismatch reads clean: no removal, explicit false.
  expect(await store.compareAndDelete!({ account: "a", label: "a" }, "other")).toBe(false);
  expect(backend.get("a")).toBe("v1");
  // Backend failures reject with sanitized errors, never a silent false.
  await expect(store.compareAndDelete!({ account: "boom-read", label: "x" }, "v")).rejects.toThrow(/Cannot read credential/);
  backend.set("boom-delete", "v");
  await expect(store.compareAndDelete!({ account: "boom-delete", label: "x" }, "v")).rejects.toThrow(/Cannot delete credential/);
  expect(backend.get("boom-delete")).toBe("v");
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

