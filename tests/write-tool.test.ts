import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
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

test("write guidance recommends edit for targeted changes", () => {
  expect(writeTool.description.toLowerCase()).toContain("edit");
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
