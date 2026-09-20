import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_READ_LINE_LIMIT,
  MAX_READ_CHARS,
  readTool,
} from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

async function contextFor(dir: string, launchCwd = dir): Promise<ToolContext> {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("read declares parallel execution", () => {
  expect(readTool.execution).toBe("parallel");
  expect(readTool.name).toBe("read");
});

test("read returns line-numbered content for a relative path", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha\nbeta\n");
    const result = await readTool.execute(
      { path: "note.txt" },
      await contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("     1|alpha\n     2|beta");
    expect(result.details).toMatchObject({
      path: "note.txt",
      lineCount: 2,
      truncated: false,
    });
  });
});

test("read resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "app.ts"), "wrong-file\n");
    const nested = join(dir, "src");
    const fromRoot = await readTool.execute(
      { path: "src/app.ts" },
      await contextFor(dir, nested),
    );
    expect(fromRoot.content).toContain("export {}");

    const fromLaunchCwd = await readTool.execute(
      { path: "app.ts" },
      await contextFor(dir, nested),
    );
    expect(fromLaunchCwd.content).toContain("wrong-file");
  });
});

test("read supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const absolute = join(dir, "abs.txt");
    await writeFile(absolute, "from-absolute\n");
    const result = await readTool.execute(
      { path: absolute },
      await contextFor(dir),
    );
    expect(result.content).toContain("from-absolute");
  });
});

test("read applies offset and limit and reports continuation", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "lines.txt"), "a\nb\nc\nd\ne\n");
    const result = await readTool.execute(
      { path: "lines.txt", offset: 2, limit: 2 },
      await contextFor(dir),
    );
    expect(result.content).toBe(
      "     2|b\n     3|c\n... truncated: 2 lines remaining. Use offset=4 to continue.",
    );
    expect(result.details).toMatchObject({
      truncated: true,
      nextOffset: 4,
      startLine: 2,
      endLine: 3,
    });
  });
});

test("read bounds oversized output and includes continuation", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from(
      { length: DEFAULT_READ_LINE_LIMIT + 40 },
      (_, index) => `line-${index + 1}`,
    );
    await writeFile(join(dir, "big.txt"), `${lines.join("\n")}\n`);
    const result = await readTool.execute(
      { path: "big.txt" },
      await contextFor(dir),
    );
    expect(result.content).toContain("line-1");
    expect(result.content.includes(`line-${DEFAULT_READ_LINE_LIMIT + 1}`)).toBe(
      false,
    );
    expect(result.content).toContain(
      `Use offset=${DEFAULT_READ_LINE_LIMIT + 1} to continue.`,
    );
  });
});

test("read truncates a single oversized line", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "huge.txt"), `${"x".repeat(MAX_READ_CHARS + 80)}\n`);
    const result = await readTool.execute(
      { path: "huge.txt" },
      await contextFor(dir),
    );
    expect(result.content.length).toBeLessThanOrEqual(MAX_READ_CHARS + 80);
    expect(result.content).toContain("truncated");
  });
});

test("read aborts an in-flight file read", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readTool.execute({ path: "note.txt" }, {
        ...(await contextFor(dir)),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("read reports a model-visible error for a missing file", async () => {
  await withTempDir(async (dir) => {
    const result = await readTool.execute(
      { path: "missing.txt" },
      await contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: missing.txt");
  });
});
