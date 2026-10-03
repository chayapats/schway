import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { readTool } from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { writeTool } from "../src/tools/write.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("write creates a nonexistent file", async () => {
  await withTempDir(async (dir) => {
    const ctx = contextFor(dir);
    const written = await writeTool.execute(
      { path: "note.txt", content: "hello-created\n" },
      ctx,
    );
    expect(written.isError).toBeUndefined();
    expect(written.details).toMatchObject({ path: "note.txt", created: true });
    const read = await readTool.execute({ path: "note.txt" }, ctx);
    expect(read.isError).toBeUndefined();
    expect(read.content).toContain("hello-created");
  });
});

test("write fully replaces an existing file", async () => {
  await withTempDir(async (dir) => {
    const ctx = contextFor(dir);
    await writeTool.execute({ path: "note.txt", content: "old\n" }, ctx);
    const written = await writeTool.execute(
      { path: "note.txt", content: "new-content\n" },
      ctx,
    );
    expect(written.isError).toBeUndefined();
    expect(written.details).toMatchObject({ created: false });
    const read = await readTool.execute({ path: "note.txt" }, ctx);
    expect(read.content).toContain("new-content");
    expect(read.content.includes("old")).toBe(false);
  });
});

test.skipIf(process.platform === "win32")("write preserves a write-only destination without adding a read-access requirement", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "private"); await writeFile(path, "before"); await chmod(path, 0o200);
    try {
      const result = await writeTool.execute({ path: "private", content: "after" }, contextFor(dir));
      expect(result.isError).toBeUndefined(); expect((await stat(path)).mode & 0o777).toBe(0o200);
      await chmod(path, 0o600); expect(await readFile(path, "utf8")).toBe("after");
    } finally { await chmod(path, 0o600); }
  });
});

test("write replaces a dangling symlink with a newly created regular file", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "link"), absent = join(dir, "absent");
    await symlink(absent, path);
    const result = await writeTool.execute({ path: "link", content: "replacement" }, contextFor(dir));
    expect(result.isError).toBeUndefined(); expect(result.details).toMatchObject({ created: true });
    expect((await lstat(path)).isFile()).toBe(true); expect(await readFile(path, "utf8")).toBe("replacement");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o666 & ~process.umask());
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

for (const kind of ["fifo", "socket"] as const) {
  test.skipIf(process.platform === "win32")(`write replaces an existing ${kind} without reading it or copying its special-file permissions`, async () => {
    await withTempDir(async dir => {
      const path = join(dir, "special"), server = kind === "socket" ? createServer() : undefined;
      if (server) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
      else expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      try {
        await chmod(path, 0o600);
        const result = await writeTool.execute({ path: "special", content: "replacement" }, contextFor(dir));
        expect(result.isError).toBeUndefined(); expect(result.details).toMatchObject({ created: false });
        expect((await lstat(path)).isFile()).toBe(true); expect(await readFile(path, "utf8")).toBe("replacement");
        expect((await stat(path)).mode & 0o777).toBe(0o666 & ~process.umask());
      } finally { if (server) await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  });
}

test.each([
  ["", 0],
  ["one line", 1],
  ["one\ntwo\nthree\n", 3],
])("write reports the actual content line count for %j", async (content, lineCount) => {
  await withTempDir(async (dir) => {
    const input = { path: "note.txt", content: content as string };
    const ctx = contextFor(dir);
    for (const created of [true, false]) {
      const result = await writeTool.execute(input, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.details).toMatchObject({ created, lineCount });
      expect(result.content).toBe("Wrote note.txt");
      expect(await readFile(join(dir, "note.txt"), "utf8")).toBe(content);
    }
  });
});

test("write declares exclusive execution", () => {
  expect(writeTool.execution).toBe("exclusive");
  expect(writeTool.name).toBe("write");
});

test("write resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    const nested = join(dir, "src");
    const ctx = contextFor(dir, nested);
    await writeTool.execute({ path: "note.txt", content: "from-root\n" }, ctx);
    const fromRoot = await readTool.execute({ path: "note.txt" }, ctx);
    expect(fromRoot.content).toContain("from-root");
    const launchFile = await readTool.execute(
      { path: join(nested, "note.txt") },
      ctx,
    );
    expect(launchFile.isError).toBe(true);
  });
});

test("write supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const absolute = join(dir, "abs.txt");
    const ctx = contextFor(dir);
    await writeTool.execute({ path: absolute, content: "from-absolute\n" }, ctx);
    const read = await readTool.execute({ path: absolute }, ctx);
    expect(read.content).toContain("from-absolute");
  });
});

test("write creates parent directories for a nested path", async () => {
  await withTempDir(async (dir) => {
    const ctx = contextFor(dir);
    const written = await writeTool.execute(
      { path: "src/app.ts", content: "export {}\n" },
      ctx,
    );
    expect(written.isError).toBeUndefined();
    const read = await readTool.execute({ path: "src/app.ts" }, ctx);
    expect(read.content).toContain("export {}");
  });
});

test("write reports a model-visible error when the path is a directory", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "folder"));
    const result = await writeTool.execute(
      { path: "folder", content: "nope\n" },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Path is a directory: folder");
  });
});

test("write aborts before mutating the filesystem", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeTool.execute({ path: "note.txt", content: "nope\n" }, {
        ...contextFor(dir),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const read = await readTool.execute({ path: "note.txt" }, contextFor(dir));
    expect(read.isError).toBe(true);
  });
});
