import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteUndoSession, openUndoStore, pruneUndoStore, undoStoreSize } from "../src/undo/store.ts";
import { withTempDir } from "./helpers.ts";

/** Pause a real child at an I/O seam while retaining its store operation ownership. */
async function pausedOperation(home: string, operation: "prune" | "capture", fail = false) {
  const script = `
    import { mock } from "bun:test";
    const fs = await import("node:fs/promises");
    const realRead = fs.readFile, realWrite = fs.writeFile;
    const home = ${JSON.stringify(home)}, operation = ${JSON.stringify(operation)};
    let paused = false;
    const pause = async () => {
      if (paused) return; paused = true;
      console.log("PAUSED");
      for await (const chunk of Bun.stdin.stream()) break;
      if (${fail}) throw new Error("Injected storage failure");
    };
    mock.module("node:fs/promises", () => ({ ...fs,
      readFile: async (...args) => {
        const bytes = await realRead(...args);
        if (operation === "prune" && String(args[0]).endsWith("seed.json")) await pause();
        return bytes;
      },
      writeFile: async (...args) => {
        await realWrite(...args);
        if (operation === "capture" && String(args[0]).includes("blobs") && String(args[0]).endsWith(".tmp")) await pause();
      },
    }));
    const { openUndoStore, pruneUndoStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/undo/store.ts"))});
    try {
      if (operation === "prune") await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1000000 });
      else await openUndoStore({ home }).capture({ sessionId: "session", turnId: "new", turnNumber: 2 }, home + "/new-file");
      console.log("DONE");
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value), first.done ? await new Response(child.stderr).text() : "").toContain("PAUSED");
  } catch (error) { child.kill(); await child.exited; throw error; }
  reader.releaseLock();
  const error = new Response(child.stderr).text();
  return { child, error, release() { child.stdin.write("continue"); child.stdin.end(); }, async stop() { child.kill(); await child.exited; } };
}

test("pruning excludes concurrent manifest publication and a retried turn keeps its referenced blob", async () => {
  await withTempDir(async home => {
    const store = openUndoStore({ home });
    await store.recordShell({ sessionId: "session", turnId: "seed", turnNumber: 1 }, { detection: "unavailable" });
    const bytes = "blob B", hash = Bun.CryptoHasher.hash("sha256", bytes, "hex");
    await writeFile(join(home, "new-file"), bytes);
    const blobs = join(home, ".schway", "undo", "session", "blobs"); await mkdir(blobs);
    await writeFile(join(blobs, hash), bytes);
    const paused = await pausedOperation(home, "prune");
    try {
      const script = `
        const { openUndoStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/undo/store.ts"))});
        try {
          await openUndoStore({ home: ${JSON.stringify(home)} }).capture({ sessionId: "session", turnId: "new", turnNumber: 2 }, ${JSON.stringify(join(home, "new-file"))});
          process.exitCode = 2;
        } catch (error) { console.log(error.message); }
      `;
      const contender = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([contender.exited, new Response(contender.stdout).text()]);
      expect(code).toBe(0); expect(output).toContain("Undo store is updating");
      paused.release(); expect(await paused.child.exited, await paused.error).toBe(0);
      await store.capture({ sessionId: "session", turnId: "new", turnNumber: 2 }, join(home, "new-file"));
      const manifest = (await store.list("session")).find(m => m.turnId === "new")!;
      expect((await store.blob("session", manifest.files[0]!.before!.sha256)).toString()).toBe(bytes);
      await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1000000 });
      expect((await store.blob("session", hash)).toString()).toBe(bytes);
    } finally { await paused.stop(); }
  });
});

test("in-flight blob publication excludes pruning and every other store mutation", async () => {
  await withTempDir(async home => {
    const store = openUndoStore({ home });
    const seed = { sessionId: "session", turnId: "seed", turnNumber: 1 };
    const path = join(home, "new-file"); await writeFile(path, "original");
    await store.capture(seed, path);
    const lockPath = join(home, ".schway", "undo.lock");
    const inode = (await stat(lockPath)).ino;
    const paused = await pausedOperation(home, "capture");
    try {
      const operations = [
        () => pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1 }),
        () => store.capture({ ...seed, turnId: "contender" }, path),
        () => store.settle(seed, path, true),
        () => store.recordShell(seed, { detection: "unavailable" }),
        () => deleteUndoSession({ home, sessionId: "session" }),
      ];
      for (const operation of operations) await expect(operation()).rejects.toThrow("Undo store is updating");
      // A failed contender must not release the holder's lock in this or another process.
      await expect(pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1 })).rejects.toThrow("Undo store is updating");
      paused.release(); expect(await paused.child.exited, await paused.error).toBe(0);
      await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1000000 });
      const manifests = await store.list("session"); expect(manifests).toHaveLength(2);
      for (const manifest of manifests) expect((await store.blob("session", manifest.files[0]!.before!.sha256)).toString()).toBe("original");
      const manifestBytes = await Promise.all(manifests.map(m => stat(join(home, ".schway", "undo", "session", "turns", m.turnId + ".json"))));
      expect(await undoStoreSize({ home })).toBe(manifestBytes.reduce((sum, entry) => sum + entry.size, 0) + "original".length);
      expect((await stat(lockPath)).ino).toBe(inode);
      await deleteUndoSession({ home, sessionId: "session" });
      expect((await stat(lockPath)).ino).toBe(inode);
      expect(await undoStoreSize({ home })).toBe(0);
    } finally { await paused.stop(); }
  });
});

for (const operation of ["prune", "capture"] as const) for (const crash of [false, true]) {
  test(`${operation} ${crash ? "process death" : "I/O exception"} releases ownership for later publication and pruning`, async () => {
    await withTempDir(async home => {
      const store = openUndoStore({ home });
      await store.recordShell({ sessionId: "session", turnId: "seed", turnNumber: 1 }, { detection: "unavailable" });
      const path = join(home, "new-file"); await writeFile(path, "durable");
      const paused = await pausedOperation(home, operation, !crash);
      try {
        if (crash) await paused.stop();
        else { paused.release(); expect(await paused.child.exited).toBe(1); expect(await paused.error).toContain("Injected storage failure"); }
        await store.capture({ sessionId: "session", turnId: "retry", turnNumber: 2 }, path);
        await pruneUndoStore({ home, maxAgeDays: 30, maxSizeBytes: 1000000 });
        const manifest = (await store.list("session")).find(m => m.turnId === "retry")!;
        expect((await store.blob("session", manifest.files[0]!.before!.sha256)).toString()).toBe("durable");
      } finally { await paused.stop(); }
    });
  });
}

test("empty-directory cleanup cannot recursively delete content arriving before removal", async () => {
  await withTempDir(async home => {
    const directory = join(home, ".schway", "undo", "session", "blobs"); await mkdir(directory, { recursive: true });
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises"), directory = ${JSON.stringify(directory)};
      const realRemove = fs.rmdir;
      mock.module("node:fs/promises", () => ({ ...fs, rmdir: async path => {
        if (path === directory) await fs.writeFile(directory + "/arrived", "keep");
        return realRemove(path);
      } }));
      const { pruneUndoStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/undo/store.ts"))});
      await pruneUndoStore({ home: ${JSON.stringify(home)}, maxAgeDays: 30, maxSizeBytes: 1 });
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, error).toBe(0); expect(await readFile(join(directory, "arrived"), "utf8")).toBe("keep");
  });
});
