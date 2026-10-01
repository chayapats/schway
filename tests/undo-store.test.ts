import { expect, test } from "bun:test";
import { readFile, writeFile, chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openUndoStore, pruneUndoStore } from "../src/undo/store.ts";
import { executeToolCall } from "../src/tools/executor.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { writeTool } from "../src/tools/write.ts";
import { withTempDir } from "./helpers.ts";

test("file tools durably capture original bytes and their resulting hash", async () => {
  await withTempDir(async root => {
    const path = join(root, "file.txt");
    await writeFile(path, "before\n");
    const store = openUndoStore({ home: root });
    const turn = { sessionId: "session", turnId: "user", turnNumber: 1 };
    const result = await executeToolCall({ registry: createToolRegistry([editTool, writeTool]),
      workspace: { root, launchCwd: root, extraRoots: [] }, undo: store, undoTurn: turn,
      call: { type: "tool_call", id: "edit", name: "edit", arguments: { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] } } });
    expect(result.status).toBe("success");
    const manifest = (await store.list("session"))[0]!;
    expect((await store.blob("session", manifest.files[0]!.before!.sha256)).toString()).toBe("before\n");
    expect(manifest).toMatchObject({ version: 1, ...turn, files: [{ path, before: { sha256: expect.any(String) }, after: { sha256: expect.any(String) } }] });
    expect(await readFile(path, "utf8")).toBe("after\n");
  });
});


async function fixture(root: string) {
  const store = openUndoStore({ home: root });
  const turn = { sessionId: "session", turnId: "user", turnNumber: 1 };
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const run = (name: string, args: unknown, overrides: Partial<Parameters<typeof executeToolCall>[0]> = {}) => executeToolCall({
    registry: createToolRegistry([editTool, writeTool]), workspace, undo: store, undoTurn: turn,
    call: { type: "tool_call", id: crypto.randomUUID(), name, arguments: args }, ...overrides });
  return { store, turn, workspace, run };
}

test("created files record absence and repeated edits retain only the first pre-image", async () => {
  await withTempDir(async root => {
    const { store, run } = await fixture(root);
    await run("write", { path: "new.txt", content: "created" });
    await writeFile(join(root, "existing.txt"), "first");
    await run("edit", { path: "existing.txt", edits: [{ oldText: "first", newText: "second" }] });
    await run("edit", { path: "existing.txt", edits: [{ oldText: "second", newText: "third" }] });
    const manifest = (await store.list("session"))[0]!;
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]!.before).toBeNull(); expect(manifest.files[0]!.after).toBeDefined();
    expect((await store.blob("session", manifest.files[1]!.before!.sha256)).toString()).toBe("first");
    expect(manifest.files[1]!.after?.sha256).toBe(Bun.CryptoHasher.hash("sha256", "third", "hex"));
  });
});

test("failed edit leaves no entry and capture is durable before execute starts", async () => {
  await withTempDir(async root => {
    const { store, run } = await fixture(root);
    await writeFile(join(root, "file.txt"), "unchanged");
    const failed = await run("edit", { path: "file.txt", edits: [{ oldText: "no match", newText: "replacement" }] });
    expect(failed.status).toBe("error"); expect((await store.list("session"))[0]!.files).toEqual([]);
    let observed = false;
    const registry = createToolRegistry([{ ...writeTool, async execute(input, context) {
      const entry = (await openUndoStore({ home: root }).list("session"))[0]!.files[0]!;
      expect(entry.before).toBeNull(); expect(entry.after).toBeUndefined(); observed = true;
      return writeTool.execute(input as Parameters<typeof writeTool.execute>[0], context);
    } }]);
    await run("write", { path: "new.txt", content: "new" }, { registry }); expect(observed).toBe(true);
  });
});

test("cancelled and thrown calls still hash the bytes left on disk before afterTool hooks", async () => {
  await withTempDir(async root => {
    const { store, run } = await fixture(root);
    const abort = new AbortController();
    const registry = createToolRegistry([{ ...writeTool, async execute() {
      await writeFile(join(root, "partial.txt"), "partial"); abort.abort();
      throw new DOMException("Stopped", "AbortError");
    } }]);
    const result = await run("write", { path: "partial.txt", content: "complete" }, { registry, signal: abort.signal });
    expect(result.status).toBe("cancelled");
    expect((await store.list("session"))[0]!.files[0]!.after?.sha256).toBe(Bun.CryptoHasher.hash("sha256", "partial", "hex"));
    const throwing = createToolRegistry([{ ...writeTool, async execute() {
      await writeFile(join(root, "thrown.txt"), "saved before error"); throw new Error("Write failed afterwards");
    } }]);
    expect((await run("write", { path: "thrown.txt", content: "complete" }, { registry: throwing })).status).toBe("error");
    expect((await store.list("session"))[0]!.files[1]!.after?.sha256).toBe(Bun.CryptoHasher.hash("sha256", "saved before error", "hex"));
  });
});

test("private modes and invalid identities protect undo storage", async () => {
  await withTempDir(async root => {
    const { store, turn, run } = await fixture(root);
    await writeFile(join(root, "file.txt"), "before"); await run("write", { path: "file.txt", content: "after" });
    const manifest = (await store.list("session"))[0]!;
    if (process.platform !== "win32") {
      for (const suffix of ["", "/session", "/session/blobs", "/session/turns"]) expect((await stat(join(root, ".schway/undo" + suffix))).mode & 0o777).toBe(0o700);
      for (const suffix of [`turns/user.json`, `blobs/${manifest.files[0]!.before!.sha256}`]) expect((await stat(join(root, ".schway/undo/session", suffix))).mode & 0o777).toBe(0o600);
    }
    for (const id of ["", ".", "..", "../escape", "nested/name", "/absolute"]) {
      await expect(store.capture({ ...turn, sessionId: id }, join(root, "file.txt"))).rejects.toThrow("Invalid undo id");
      await expect(store.capture({ ...turn, turnId: id }, join(root, "file.txt"))).rejects.toThrow("Invalid undo id");
      await expect(store.list(id)).rejects.toThrow("Invalid undo id");
    }
  });
});

test("unwritable undo storage prevents file-tool execution and leaves bytes unchanged", async () => {
  await withTempDir(async root => {
    const { run } = await fixture(root);
    await writeFile(join(root, "file.txt"), "original");
    const directory = join(root, ".schway/undo/session/turns");
    await mkdir(directory, { recursive: true }); await chmod(directory, 0o500);
    try {
      const result = await run("write", { path: "file.txt", content: "replacement" });
      expect(result.status).toBe("error"); expect(result.result.content).toStartWith("Could not save undo data for file.txt:");
      expect(result.result.content).toEndWith(". The file was not changed.");
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("original");
    } finally { await chmod(directory, 0o700); }
  });
});

test("a repeated change also refuses execution when the manifest can no longer be saved", async () => {
  await withTempDir(async root => {
    const { run } = await fixture(root);
    await run("write", { path: "file.txt", content: "first" });
    const directory = join(root, ".schway/undo/session/turns"); await chmod(directory, 0o500);
    try {
      const result = await run("write", { path: "file.txt", content: "second" });
      expect(result.status).toBe("error"); expect(await readFile(join(root, "file.txt"), "utf8")).toBe("first");
    } finally { await chmod(directory, 0o700); }
  });
});


test("hooks select final paths before capture and see post-change hashes after execution", async () => {
  await withTempDir(async root => {
    const { ExtensionToolHooks } = await import("../src/extensions/tool-hooks.ts");
    const { store, run } = await fixture(root);
    const hooks = new ExtensionToolHooks(new AbortController().signal);
    hooks.beforeTool("fixture", () => ({ arguments: { path: "final.txt", content: "final" } }));
    let seen = false;
    hooks.afterTool("fixture", async () => {
      const manifest = (await store.list("session"))[0]!;
      expect(manifest.files[0]!.path).toBe(join(root, "final.txt"));
      expect(manifest.files[0]!.after?.sha256).toBe(Bun.CryptoHasher.hash("sha256", "final", "hex")); seen = true;
    });
    expect((await run("write", { path: "original.txt", content: "original" }, { toolHooks: hooks })).status).toBe("success");
    expect(seen).toBe(true);
    const denied = new ExtensionToolHooks(new AbortController().signal);
    denied.beforeTool("deny", () => ({ deny: "No changes allowed" }));
    await run("write", { path: "denied.txt", content: "never" }, { toolHooks: denied });
    expect((await store.list("session"))[0]!.files).toHaveLength(1);
  });
});

test("read, shell, skill and extension tool names never capture undo data", async () => {
  await withTempDir(async root => {
    const { run, store } = await fixture(root);
    for (const name of ["bash", "read", "grep", "find", "ls", "activate_skill", "extension_write"]) {
      const registry = createToolRegistry([{ name, description: "Fixture", execution: "exclusive", inputSchema: { type: "object", properties: {} }, async execute() { return { content: "done" }; } }]);
      expect((await run(name, {}, { registry })).status).toBe("success");
    }
    expect(await store.list("session")).toEqual([]);
  });
});


test("capture repairs an incomplete content-addressed blob before changing a file", async () => {
  await withTempDir(async root => {
    const { store, run } = await fixture(root);
    const bytes = "original bytes";
    await writeFile(join(root, "file.txt"), bytes);
    const hash = Bun.CryptoHasher.hash("sha256", bytes, "hex");
    const directory = join(root, ".schway/undo/session/blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, hash), "partial", { mode: 0o600 });
    expect((await run("write", { path: "file.txt", content: "changed" })).status).toBe("success");
    expect((await store.blob("session", hash)).toString()).toBe(bytes);
  });
});

for (const [code, reason] of [["ENOSPC", "No space left on device"], ["UNKNOWN_STORAGE", "File operation failed"]]) {
  test(`undo capture and settlement ${code} failures keep storage internals out of primary tool output`, async () => {
    await withTempDir(async root => {
      const { run, store } = await fixture(root);
      const path = join(root, "file.txt");
      const error = Object.assign(new Error(`${code}: internal storage path /private/undo/blob.tmp`), { code });
      await writeFile(path, "before");
      const blocked = await run("write", { path: "file.txt", content: "after" }, { undo: { ...store, async capture() { throw error; } } });
      expect(blocked.status).toBe("error");
      expect(blocked.result.content).toBe(`Could not save undo data for file.txt: ${reason}. The file was not changed.`);
      expect(await readFile(path, "utf8")).toBe("before");
      expect(blocked.details).toMatchObject({ undoError: error.message });
      const settled = await run("write", { path: "file.txt", content: "after" }, { undo: { ...store, async settle() { throw error; } } });
      expect(settled.status).toBe("error");
      expect(settled.result.content).toBe(`Could not save undo data after changing file.txt: ${reason}`);
      expect(await readFile(path, "utf8")).toBe("after");
      expect(settled.details).toMatchObject({ undoError: error.message });
    });
  });
}


test("pruning expires old turns and collects only unreferenced session blobs", async () => {
  await withTempDir(async home => {
    const store = openUndoStore({ home });
    const path = join(home, "file");
    await writeFile(path, "shared");
    for (const turnId of ["old", "recent"]) {
      await store.capture({ sessionId: "session", turnId, turnNumber: 1 }, path);
      const manifestPath = join(home, ".schway/undo/session/turns", `${turnId}.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.createdAt = turnId === "old" ? "2026-01-01T00:00:00Z" : "2026-01-30T00:00:00Z";
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const orphan = join(home, ".schway/undo/session/blobs", "f".repeat(64));
    await writeFile(orphan, "orphan");
    await pruneUndoStore({ home, maxAgeDays: 14, maxSizeBytes: 100000, now: new Date("2026-02-01T00:00:00Z") });
    expect((await store.list("session")).map(m => m.turnId)).toEqual(["recent"]);
    expect((await store.blob("session", Bun.CryptoHasher.hash("sha256", "shared", "hex"))).toString()).toBe("shared");
    await expect(stat(orphan)).rejects.toThrow();
  });
});


test("size pruning evicts the globally oldest manifest until actual bytes fit before blob collection", async () => {
  await withTempDir(async home => {
    const store = openUndoStore({ home });
    const path = join(home, "file");
    await writeFile(path, "x".repeat(10000));
    await store.capture({ sessionId: "older-session", turnId: "old", turnNumber: 1 }, path);
    await writeFile(path, "small");
    await store.capture({ sessionId: "newer-session", turnId: "new", turnNumber: 1 }, path);
    for (const [session, turn, date] of [["older-session", "old", "2026-01-01"], ["newer-session", "new", "2026-01-02"]]) {
      const manifestPath = join(home, ".schway", "undo", session!, "turns", `${turn}.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.createdAt = `${date}T00:00:00Z`;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    // Both blobs still count in phase two; removing only the oldest manifest reaches this exact budget.
    const maxSizeBytes = 10005 + (await stat(join(home, ".schway", "undo", "newer-session", "turns", "new.json"))).size;
    await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes, now: new Date("2026-01-03T00:00:00Z") });
    expect(await store.list("older-session")).toEqual([]);
    expect((await store.list("newer-session"))[0]?.turnId).toBe("new");
    await expect(stat(join(home, ".schway", "undo", "older-session"))).rejects.toThrow();
    expect((await store.blob("newer-session", Bun.CryptoHasher.hash("sha256", "small", "hex"))).toString()).toBe("small");
  });
});

for (const source of ["orphan", "expired-turn"] as const) {
  test(`size pruning counts a large ${source} blob until all required manifests are deleted`, async () => {
    await withTempDir(async home => {
      const store = openUndoStore({ home }), path = join(home, "file");
      await writeFile(path, "small");
      await store.capture({ sessionId: "recent", turnId: "new", turnNumber: 1 }, path);
      const manifestPath = join(home, ".schway", "undo", "recent", "turns", "new.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.createdAt = "2026-01-30T00:00:00Z";
      await writeFile(manifestPath, JSON.stringify(manifest));
      if (source === "orphan") {
        await writeFile(join(home, ".schway", "undo", "recent", "blobs", "f".repeat(64)), "x".repeat(10000));
      } else {
        await writeFile(path, "x".repeat(10000));
        await store.capture({ sessionId: "expired", turnId: "old", turnNumber: 1 }, path);
        const expiredPath = join(home, ".schway", "undo", "expired", "turns", "old.json");
        const expired = JSON.parse(await readFile(expiredPath, "utf8")); expired.createdAt = "2026-01-01T00:00:00Z";
        await writeFile(expiredPath, JSON.stringify(expired));
      }
      await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1000, now: new Date("2026-02-01T00:00:00Z") });
      expect(await store.list("recent")).toEqual([]);
      expect(await store.list("expired")).toEqual([]);
      // Blob bytes alone exceed the limit after the last manifest: stop eviction, then collect them.
      await expect(stat(join(home, ".schway", "undo", "recent"))).rejects.toThrow();
      await expect(stat(join(home, ".schway", "undo", "expired"))).rejects.toThrow();
    });
  });
}

test("legacy manifests load unavailable shell detection and recovery retains shell attribution", async () => {
  await withTempDir(async home => {
    const store = openUndoStore({ home });
    const turn = { sessionId: "session", turnId: "turn", turnNumber: 1 };
    const path = join(home, "file");
    await writeFile(path, "before"); await store.capture(turn, path);
    const manifestPath = join(home, ".schway", "undo", "session", "turns", "turn.json");
    const legacy = JSON.parse(await readFile(manifestPath, "utf8")); delete legacy.shell;
    await writeFile(manifestPath, JSON.stringify(legacy));
    expect((await store.list("session"))[0]?.shell).toEqual({ detection: "unavailable" });
    await store.recordShell(turn, { detection: "git", paths: [path, join(home, "shell-a")] });
    await store.recordShell(turn, { detection: "git", paths: [join(home, "shell-b")] });
    expect((await store.list("session"))[0]).toMatchObject({ createdAt: legacy.createdAt, shell: { detection: "git", paths: [join(home, "shell-a"), join(home, "shell-b")] } });
    await store.recordShell(turn, { detection: "unavailable" });
    expect((await store.list("session"))[0]).toMatchObject({ createdAt: legacy.createdAt, files: legacy.files, shell: { detection: "unavailable" } });
    await store.recordShell(turn, { detection: "git", paths: [join(home, "shell-c")] });
    expect((await store.list("session"))[0]?.shell).toEqual({ detection: "git", paths: [join(home, "shell-c")] });
  });
});

test("strict age cutoff keeps boundary and incomplete manifests and does not create missing storage", async () => {
  await withTempDir(async home => {
    await pruneUndoStore({ home, maxAgeDays: 14, maxSizeBytes: 1000 });
    await expect(stat(join(home, ".schway"))).rejects.toThrow();
    const store = openUndoStore({ home }); const path = join(home, "file");
    await writeFile(path, "before"); await store.capture({ sessionId: "blobs", turnId: "boundary", turnNumber: 1 }, path);
    const manifestPath = join(home, ".schway", "undo", "blobs", "turns", "boundary.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.createdAt = "2026-01-01T00:00:00Z";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await pruneUndoStore({ home, maxAgeDays: 14, maxSizeBytes: 1000, now: new Date("2026-01-15T00:00:00Z") });
    expect((await store.list("blobs"))[0]?.files[0]?.after).toBeUndefined();
    expect((await store.blob("blobs", manifest.files[0].before.sha256)).toString()).toBe("before");
  });
});
