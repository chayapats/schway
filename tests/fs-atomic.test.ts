import { expect, test } from "bun:test";
import { chmod, lstat, open, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileChangedError, observeFile, writeFileAtomically } from "../src/tools/fs.ts";
import { withTempDir } from "./helpers.ts";

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
      const temp = join(root, names[0]!);
      expect(await readFile(temp, "utf8")).toBe("private partial content");
      expect((await stat(temp)).mode & 0o777).toBe(0o600);
      await expect(open(temp, "wx", 0o666)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path, "utf8")).toBe("original");
      inspected = true; abort.abort();
      yield "never published";
    }
    await expect(writeFileAtomically(path, partial(), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(inspected).toBe(true); expect(await readdir(root)).toEqual(["private"]);
    expect(await readFile(path, "utf8")).toBe("original"); expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

for (const race of ["chmod", "replace", "symlink", "delete", "save", "create"] as const) {
  test(`atomic replacement rejects an observed ${race} race without overwriting the later target`, async () => {
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
        if (["chmod", "replace", "symlink"].includes(race)) expect((await stat(path)).mode & 0o777).toBe(0o600);
        if (race === "symlink") expect((await lstat(path)).isSymbolicLink()).toBe(true);
      }
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
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });
});

test("exclusive creation refuses an occupied temporary name and never deletes the unrelated file", async () => {
  await withTempDir(async root => {
    const script = `
      const { writeFileAtomically } = await import(${JSON.stringify(join(import.meta.dir, "../src/tools/fs.ts"))});
      const { writeFile, readFile } = await import("node:fs/promises");
      const target = ${JSON.stringify(join(root, "target"))};
      const id = "11111111-1111-4111-8111-111111111111";
      crypto.randomUUID = () => id;
      await writeFile(target, "original"); await writeFile(target + "." + id + ".tmp", "unrelated");
      try { await writeFileAtomically(target, "agent"); throw new Error("Expected EEXIST"); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      console.log(JSON.stringify([await readFile(target, "utf8"), await readFile(target + "." + id + ".tmp", "utf8")]));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toEqual(["original", "unrelated"]);
  });
});

test("restrictive umask preserves existing modes exactly and keeps fresh-file defaults", async () => {
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

test("unsupported permission platforms omit undo modes and skip POSIX chmod without claiming mode fidelity", async () => {
  await withTempDir(async root => {
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises"), realOpen = fs.open;
      const root = ${JSON.stringify(root)}, path = root + "/file";
      await fs.writeFile(path, "before"); await fs.chmod(path, 0o755);
      Object.defineProperty(process, "platform", { value: "win32" });
      mock.module("node:fs/promises", () => ({ ...fs, open: async (...args) => {
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

test("replacement preserves ordinary bits without copying setuid, setgid, sticky or file-type bits", async () => {
  await withTempDir(async root => {
    const path = join(root, "file"); await writeFile(path, "before"); await chmod(path, 0o7755);
    await writeFileAtomically(path, "after");
    const mode = (await stat(path)).mode;
    expect(mode & 0o7777).toBe(0o755); expect((await stat(path)).isFile()).toBe(true);
  });
});
