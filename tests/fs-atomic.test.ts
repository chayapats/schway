import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileChangedError, observeFile, observeFileTarget, writeFileAtomically } from "../src/tools/fs.ts";
import { withTempDir } from "./helpers.ts";

for (const layout of ["shared-parent", "shared-ancestor", "private-ancestor", "sticky-parent"] as const) {
  test.skipIf(process.platform === "win32")(`staging respects actual path access in a ${layout} layout`, async () => {
    await withTempDir(async root => {
      await chmod(root, layout === "private-ancestor" ? 0o700 : 0o755);
      const shared = join(root, "shared"); await mkdir(shared);
      await chmod(shared, layout === "sticky-parent" ? 0o1777 : 0o777);
      const parent = layout === "shared-ancestor" ? join(shared, "private") : shared;
      if (parent !== shared) await mkdir(parent, { mode: 0o700 });
      const path = join(parent, "target"); await writeFile(path, "original", { mode: 0o600 });
      let prepared = false;
      const pending = writeFileAtomically(path, "saved bytes", undefined, async () => { prepared = true; }, { mode: 0o644 });
      const allowed = layout === "private-ancestor" || layout === "sticky-parent";
      if (allowed) await pending;
      else await expect(pending).rejects.toThrow("another user can replace temporary paths");
      expect(prepared).toBe(allowed);
      expect(await readFile(path, "utf8")).toBe(allowed ? "saved bytes" : "original");
      expect((await stat(path)).mode & 0o777).toBe(allowed ? 0o644 : 0o600);
      expect(await readdir(parent)).toEqual(["target"]);
    });
  });
}

for (const point of ["unsafe-parent", "after-mkdir", "after-chmod"] as const) {
  test.skipIf(process.platform === "win32")(`a staging symlink substitution at ${point} never changes outside bytes or modes`, async () => {
    await withTempDir(async root => {
      const script = `
        import { mock } from "bun:test";
        const fs = await import("node:fs/promises"), realMkdir = fs.mkdir, realChmod = fs.chmod, realOpen = fs.open;
        const root = ${JSON.stringify(root)}, point = ${JSON.stringify(point)};
        const parent = root + "/workspace", outside = root + "/outside", target = parent + "/target";
        await fs.chmod(root, 0o755); await realMkdir(parent); await realMkdir(outside);
        await realChmod(parent, point === "unsafe-parent" ? 0o777 : 0o755); await realChmod(outside, 0o755);
        await fs.writeFile(outside + "/keep", "unrelated"); await fs.writeFile(target, "original", { mode: 0o600 });
        let swapped = false;
        const swap = async path => { await fs.rename(path, path + ".moved"); await fs.symlink(outside, path); swapped = true; };
        mock.module("node:fs/promises", () => ({ ...fs,
          mkdir: async (path, ...args) => { const result = await realMkdir(path, ...args); if (point === "after-mkdir") await swap(path); return result; },
          chmod: async (path, ...args) => { const result = await realChmod(path, ...args); if (point === "after-chmod") await swap(path); return result; },
          open: async (path, ...args) => { if (point === "unsafe-parent") await swap(path.slice(0, path.lastIndexOf("/"))); return realOpen(path, ...args); },
        }));
        const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
        let error;
        try { await writeFileAtomically(target, "saved undo bytes", undefined, undefined, { mode: 0o644 }); }
        catch (failure) { error = failure.message; }
        console.log(JSON.stringify({ error, swapped, original: await fs.readFile(target, "utf8"),
          outside: await fs.readdir(outside), bytes: await fs.readFile(outside + "/keep", "utf8"), mode: (await fs.stat(outside)).mode & 0o777 }));
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(err).toBe(""); expect(code).toBe(0);
        const result = JSON.parse(out);
        expect(result.error).toContain(point === "unsafe-parent" ? "another user can replace temporary paths" : "File changed before replacement");
        expect(result).toMatchObject({ swapped: point !== "unsafe-parent", original: "original", outside: ["keep"], bytes: "unrelated", mode: 0o755 });
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    });
  });
}

test.skipIf(process.platform === "win32")("changing an exposed parent's access during preparation prevents final-mode widening and publication", async () => {
  await withTempDir(async root => {
    await chmod(root, 0o755);
    const parent = join(root, "workspace"); await mkdir(parent, { mode: 0o755 });
    const target = join(parent, "target"); await writeFile(target, "original", { mode: 0o600 });
    async function* changing() { yield "saved bytes"; await chmod(parent, 0o777); }
    await expect(writeFileAtomically(target, changing(), undefined, undefined, { mode: 0o644 })).rejects.toBeInstanceOf(FileChangedError);
    expect(await readFile(target, "utf8")).toBe("original");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(parent)).toEqual(["target"]);
  });
});

for (const outcome of ["changed", "cancelled", "published"] as const) test(`completed restore bytes stay private before publication (${outcome})`, async () => {
  await withTempDir(async root => {
    const path = join(root, "target");
    await writeFile(path, "current private bytes", { mode: 0o600 });
    const observed = await observeFile(path);
    const abort = new AbortController();
    let preparedInode: number | undefined;
    const pending = writeFileAtomically(path, "saved public bytes", abort.signal, async () => {
      const entries = (await readdir(root)).filter(name => name !== "target");
      expect(entries).toHaveLength(1);
      const staging = join(root, entries[0]!);
      expect((await lstat(staging)).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect((await stat(staging)).mode & 0o777).toBe(0o700);
      const files = await readdir(staging);
      expect(files).toHaveLength(1);
      const temporary = join(staging, files[0]!);
      expect(await readFile(temporary, "utf8")).toBe("saved public bytes");
      const info = await stat(temporary);
      preparedInode = info.ino;
      if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o644);
      expect(info.dev).toBe((await stat(path)).dev);
      expect(await readFile(path, "utf8")).toBe("current private bytes");
      if (outcome === "changed") {
        if (process.platform === "win32") await writeFile(path, "later bytes");
        else await chmod(path, 0o640);
      }
      if (outcome === "cancelled") abort.abort();
    }, { observed, mode: 0o644 });
    if (outcome === "changed") await expect(pending).rejects.toBeInstanceOf(FileChangedError);
    else if (outcome === "cancelled") await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    else { await pending; expect((await stat(path)).ino).toBe(preparedInode!); }
    expect(await readFile(path, "utf8")).toBe(outcome === "published" ? "saved public bytes" : outcome === "changed" && process.platform === "win32" ? "later bytes" : "current private bytes");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(outcome === "changed" ? 0o640 : outcome === "cancelled" ? 0o600 : 0o644);
    expect(await readdir(root)).toEqual(["target"]);
  });
});

test("a partial temporary write is exclusive and private, and cancellation removes it without publishing", async () => {
  await withTempDir(async root => {
    const path = join(root, "private");
    await writeFile(path, "original"); await chmod(path, 0o600);
    const abort = new AbortController();
    let inspected = false;
    async function* partial() {
      yield "private partial content";
      const names = (await readdir(root)).filter(name => name.endsWith(".tmp"));
      expect(names).toHaveLength(1);
      const staging = join(root, names[0]!);
      if (process.platform !== "win32") expect((await stat(staging)).mode & 0o777).toBe(0o700);
      const files = await readdir(staging);
      expect(files).toHaveLength(1);
      const temp = join(staging, files[0]!);
      expect(await readFile(temp, "utf8")).toBe("private partial content");
      if (process.platform !== "win32") expect((await stat(temp)).mode & 0o777).toBe(0o600);
      await expect(open(temp, "wx", 0o666)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path, "utf8")).toBe("original");
      inspected = true; abort.abort();
      yield "never published";
    }
    await expect(writeFileAtomically(path, partial(), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(inspected).toBe(true); expect(await readdir(root)).toEqual(["private"]);
    expect(await readFile(path, "utf8")).toBe("original"); if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

for (const race of ["chmod", "replace", "symlink", "delete", "save", "create"] as const) {
  test.skipIf(process.platform === "win32" && race === "chmod")(`atomic replacement rejects an observed ${race} race without overwriting the later target`, async () => {
    await withTempDir(async root => {
      const path = join(root, "target"), other = join(root, "other");
      if (race !== "create") { await writeFile(path, "before"); await chmod(path, 0o755); }
      await writeFile(other, "different"); await chmod(other, 0o600);
      const observed = await observeFile(path);
      await expect(writeFileAtomically(path, "agent", undefined, async () => {
        if (race === "chmod") await chmod(path, 0o600);
        if (race === "replace") await rename(other, path);
        if (race === "symlink") { await unlink(path); await symlink(other, path); }
        if (race === "delete") await unlink(path);
        if (race === "save" || race === "create") await writeFile(path, "later");
      }, { observed })).rejects.toBeInstanceOf(FileChangedError);
      expect((await readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
      if (race === "delete") await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        expect(await readFile(path, "utf8")).toBe(race === "chmod" ? "before" : race === "save" || race === "create" ? "later" : "different");
        if (process.platform !== "win32" && ["chmod", "replace", "symlink"].includes(race)) expect((await stat(path)).mode & 0o777).toBe(0o600);
        if (race === "symlink") expect((await lstat(path)).isSymbolicLink()).toBe(true);
      }
    });
  });
}

for (const race of ["link-replaced", "referent-created"] as const) {
  test(`dangling-link replacement rejects a ${race} race while retaining the new target`, async () => {
    await withTempDir(async root => {
      const path = join(root, "link"), target = join(root, "absent"); await symlink(target, path);
      const observed = await observeFileTarget(path);
      expect(observed?.entry.isSymbolicLink()).toBe(true); expect(observed?.target).toBeNull();
      await expect(writeFileAtomically(path, "agent", undefined, async () => {
        if (race === "link-replaced") { await unlink(path); await writeFile(path, "later", { mode: 0o600 }); }
        else await writeFile(target, "later", { mode: 0o600 });
      }, { observed })).rejects.toBeInstanceOf(FileChangedError);
      expect(await readFile(path, "utf8")).toBe("later"); if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(path)).isSymbolicLink()).toBe(race === "referent-created");
      expect((await readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
    });
  });
}

test("failed temporary writes and cancellation at the final check retain the original bytes and mode", async () => {
  await withTempDir(async root => {
    const path = join(root, "target"); await writeFile(path, "original"); await chmod(path, 0o640);
    async function* failing() { yield "partial"; throw new Error("Disk full fixture"); }
    await expect(writeFileAtomically(path, failing())).rejects.toThrow("Disk full fixture");
    const abort = new AbortController();
    await expect(writeFileAtomically(path, "new", abort.signal, async () => { abort.abort(); })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(root)).toEqual(["target"]); expect(await readFile(path, "utf8")).toBe("original");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o640);
  });
});

for (const kind of ["file", "directory", "symlink"] as const) test(`exclusive staging refuses an occupied ${kind} and never deletes unrelated entries`, async () => {
  await withTempDir(async root => {
    const script = `
      const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      const { mkdir, writeFile, readFile, symlink, stat } = await import("node:fs/promises");
      const target = ${JSON.stringify(join(root, "target"))};
      const id = "11111111-1111-4111-8111-111111111111";
      const kind = ${JSON.stringify(kind)}, staging = target + "." + id + ".tmp";
      crypto.randomUUID = () => id;
      await writeFile(target, "original");
      if (kind === "directory") { await mkdir(staging, { mode: 0o755 }); await writeFile(staging + "/keep", "unrelated"); }
      else if (kind === "symlink") { await writeFile(target + ".other", "unrelated"); await symlink(target + ".other", staging); }
      else await writeFile(staging, "unrelated");
      const mode = (await stat(staging)).mode;
      try { await writeFileAtomically(target, "agent"); throw new Error("Expected EEXIST"); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      console.log(JSON.stringify([await readFile(target, "utf8"), await readFile(kind === "directory" ? staging + "/keep" : staging, "utf8"), (await stat(staging)).mode === mode]));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual(["original", "unrelated", true]);
  });
});

for (const point of ["before-open", "after-rename", "cleanup-failure"] as const) test(`staging cleanup retains unrelated entries and private abandoned bytes at ${point}`, async () => {
  await withTempDir(async root => {
    const script = `
      import { mock } from "bun:test";
      import { dirname } from "node:path";
      const fs = await import("node:fs/promises"), realOpen = fs.open, realRename = fs.rename, realUnlink = fs.unlink;
      const target = ${JSON.stringify(join(root, "target"))}, point = ${JSON.stringify(point)};
      await fs.writeFile(target, "original", { mode: 0o600 });
      let temporary;
      mock.module("node:fs/promises", () => ({ ...fs,
        open: async (path, ...args) => {
          temporary = path;
          if (point === "before-open") await fs.writeFile(path, "unrelated");
          return realOpen(path, ...args);
        },
        rename: async (source, destination) => {
          await realRename(source, destination);
          if (point === "after-rename") await fs.writeFile(source, "unrelated");
        },
        unlink: async path => {
          if (point === "cleanup-failure" && path === temporary) throw Object.assign(new Error("Cleanup denied"), { code: "EACCES" });
          return realUnlink(path);
        },
      }));
      const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      let failure;
      try { await writeFileAtomically(target, "prepared", undefined, async () => {
        if (point === "cleanup-failure") throw new Error("Validation rejected");
      }, { mode: 0o644 }); }
      catch (error) { failure = error.code ?? error.message; }
      console.log(JSON.stringify({ failure, target: await fs.readFile(target, "utf8"),
        retained: await fs.readFile(temporary, "utf8"), directoryMode: (await fs.stat(dirname(temporary))).mode & 0o777,
        fileMode: (await fs.stat(temporary)).mode & 0o777 }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(err).toBe(""); expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        ...(point === "after-rename" ? {} : { failure: point === "before-open" ? "EEXIST" : "Validation rejected" }),
        target: point === "after-rename" ? "prepared" : "original",
        retained: point === "cleanup-failure" ? "prepared" : "unrelated",
        ...(process.platform !== "win32" ? { directoryMode: 0o700 } : {}),
        ...(process.platform !== "win32" && point === "cleanup-failure" ? { fileMode: 0o644 } : {}),
      });
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  });
});

test("process death after final chmod leaves saved bytes inside private staging without publishing", async () => {
  await withTempDir(async root => {
    const path = join(root, "target"); await writeFile(path, "original", { mode: 0o600 });
    const script = `
      const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      await writeFileAtomically(${JSON.stringify(path)}, "saved bytes", undefined, async () => {
        console.log("PREPARED"); await Bun.sleep(60_000);
      }, { mode: 0o644 });
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const reader = child.stdout.getReader(), error = new Response(child.stderr).text();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toBe("PREPARED\n");
      child.kill("SIGKILL"); await child.exited; expect(await error).toBe("");
      const entries = (await readdir(root)).filter(name => name !== "target"); expect(entries).toHaveLength(1);
      const staging = join(root, entries[0]!); if (process.platform !== "win32") expect((await stat(staging)).mode & 0o777).toBe(0o700);
      const files = await readdir(staging); expect(files).toHaveLength(1);
      const temporary = join(staging, files[0]!);
      if (process.platform !== "win32") expect((await stat(temporary)).mode & 0o777).toBe(0o644); expect(await readFile(temporary, "utf8")).toBe("saved bytes");
      expect(await readFile(path, "utf8")).toBe("original"); if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; reader.releaseLock(); }
  });
});

test.skipIf(process.platform === "win32")("restrictive umask preserves existing modes exactly and keeps fresh-file defaults", async () => {
  await withTempDir(async root => {
    const script = `
      import { chmod, stat, writeFile } from "node:fs/promises";
      const { writeTool } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/write.ts"))});
      const { editTool } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/edit.ts"))});
      process.umask(0o077); const root = ${JSON.stringify(root)};
      const ctx = { workspace: { root, launchCwd: root, extraRoots: [] } }, results = [];
      for (const mode of [0o755, 0o600, 0o640]) for (const tool of [writeTool, editTool]) {
        const path = root + "/file"; await writeFile(path, "before"); await chmod(path, mode);
        const result = await tool.execute(tool.name === "edit" ? { path, edits: [{ oldText: "before", newText: "after" }] } : { path, content: "after" }, ctx);
        if (result.isError) throw new Error(result.content); results.push((await stat(path)).mode & 0o777);
      }
      await writeTool.execute({ path: "fresh", content: "fresh" }, ctx); results.push((await stat(root + "/fresh")).mode & 0o777);
      console.log(JSON.stringify(results));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual([0o755, 0o755, 0o600, 0o600, 0o640, 0o640, 0o600]);
  });
});

test.skipIf(process.platform === "win32")("private staging retains inherited directory setgid without publishing privileged file bits", async () => {
  await withTempDir(async root => {
    await chmod(root, 0o2700);
    // Linux inherits directory setgid; other filesystems may inherit only the group.
    const probe = join(root, "inheritance-probe");
    await mkdir(probe, { mode: 0o700 });
    const inheritedMode = (await stat(probe)).mode & 0o2777;
    await rmdir(probe);
    const path = join(root, "fresh");
    await writeFileAtomically(path, "fresh", undefined, async () => {
      const entries = await readdir(root); expect(entries).toHaveLength(1);
      const staging = join(root, entries[0]!);
      expect((await stat(staging)).mode & 0o2777).toBe(inheritedMode);
      const files = await readdir(staging); expect(files).toHaveLength(1);
      expect((await stat(join(staging, files[0]!))).gid).toBe((await stat(root)).gid);
    }, { mode: 0o640 });
    expect((await stat(path)).mode & 0o7777).toBe(0o640);
    expect(await readdir(root)).toEqual(["fresh"]);
  });
});

test.skipIf(process.platform === "win32")("owner-stripping umask cannot block staging and still governs fresh-file defaults", async () => {
  await withTempDir(async root => {
    const script = `
      import { stat, writeFile } from "node:fs/promises";
      const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      const path = ${JSON.stringify(join(root, "target"))};
      await writeFile(path, "before", { mode: 0o640 });
      process.umask(0o777);
      await writeFileAtomically(path, "after"); await writeFileAtomically(path + ".fresh", "fresh");
      console.log(JSON.stringify([(await stat(path)).mode & 0o777, (await stat(path + ".fresh")).mode & 0o777]));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual([0o640, 0]);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  });
});

test("unsupported permission platforms omit undo modes and skip POSIX chmod without claiming mode fidelity", async () => {
  await withTempDir(async root => {
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises"), realOpen = fs.open;
      const root = ${JSON.stringify(root)}, path = root + "/file";
      await fs.writeFile(path, "before"); await fs.chmod(path, 0o755);
      Object.defineProperty(process, "platform", { value: "win32" });
      mock.module("node:fs/promises", () => ({ ...fs, chmod: async () => { throw new Error("Unexpected directory chmod"); }, open: async (...args) => {
        const handle = await realOpen(...args); handle.chmod = async () => { throw new Error("Unexpected POSIX chmod"); }; return handle;
      } }));
      const { observeFile, writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      const { openUndoStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/undo/store.ts"))});
      const store = openUndoStore({ home: root }), turn = { sessionId: "session", turnId: "user", turnNumber: 1 };
      await store.capture(turn, path); await writeFileAtomically(path, "after"); await store.settle(turn, path, true);
      const file = (await store.list("session"))[0].files[0];
      console.log(JSON.stringify({ mode: (await observeFile(path)).mode, beforeMode: file.beforeMode, afterMode: file.afterMode, bytes: await fs.readFile(path, "utf8") }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual({ bytes: "after" });
  });
});

test.skipIf(process.platform === "win32")("replacement preserves ordinary bits without copying setuid, setgid, sticky or file-type bits", async () => {
  await withTempDir(async root => {
    const path = join(root, "file"); await writeFile(path, "before"); await chmod(path, 0o7755);
    await writeFileAtomically(path, "after");
    const mode = (await stat(path)).mode;
    expect(mode & 0o7777).toBe(0o755); expect((await stat(path)).isFile()).toBe(true);
  });
});

test.skipIf(process.platform === "win32")("a chmod to unreadable during final content validation is still classified as a changed target", async () => {
  await withTempDir(async root => {
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises"), realRead = fs.readFile;
      const path = ${JSON.stringify(join(root, "file"))}; let armed = false;
      await fs.writeFile(path, "before", { mode: 0o600 });
      mock.module("node:fs/promises", () => ({ ...fs, readFile: async (...args) => {
        if (armed && args[0] === path) { armed = false; await fs.chmod(path, 0o000); }
        return realRead(...args);
      } }));
      const { observeFile, writeFileAtomically, FileChangedError } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      const observed = await observeFile(path); armed = true; let changed = false;
      try { await writeFileAtomically(path, "agent", undefined, undefined, { observed }); }
      catch (error) { changed = error instanceof FileChangedError; }
      const mode = (await fs.stat(path)).mode & 0o777; await fs.chmod(path, 0o600);
      console.log(JSON.stringify({ changed, mode, bytes: await realRead(path, "utf8"), files: await fs.readdir(${JSON.stringify(root)}) }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ changed: true, mode: 0, bytes: "before", files: ["file"] });
  });
});
