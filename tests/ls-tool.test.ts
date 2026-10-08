import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_LS_BYTES, lsTool } from "../src/tools/ls.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("ls declares parallel execution", () => {
  expect(lsTool.execution).toBe("parallel");
  expect(lsTool.name).toBe("ls");
});

test("ls includes nested entries only when depth is greater than 1", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src", "tools"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "src", "tools", "ls.ts"), "export {}\n");
    const shallow = await lsTool.execute({ path: "src", depth: 1 }, contextFor(dir));
    expect(shallow.content).toBe("src/app.ts\nsrc/tools/");
    expect(shallow.content.includes("ls.ts")).toBe(false);

    const deep = await lsTool.execute({ path: "src", depth: 2 }, contextFor(dir));
    expect(deep.content).toBe("src/app.ts\nsrc/tools/\nsrc/tools/ls.ts");
    expect(deep.details).toMatchObject({ depth: 2, truncated: false });
  });
});

test("ls treats an empty directory as an ordinary result", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "empty"));
    const result = await lsTool.execute({ path: "empty" }, contextFor(dir));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("(empty directory)");
    expect(result.details).toMatchObject({ entryCount: 0, truncated: false });
  });
});

test("ls lists paths that contain spaces", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "my dir"));
    await writeFile(join(dir, "my dir", "a file.txt"), "ok\n");
    const result = await lsTool.execute({ path: "my dir" }, contextFor(dir));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("my dir/a file.txt");
  });
});

test("ls resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "app.ts"), "wrong-file\n");
    const nested = join(dir, "src");
    const result = await lsTool.execute({ path: "." }, contextFor(dir, nested));
    expect(result.content).toBe("app.ts\nsrc/");
  });
});

test("ls supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "outside");
    await mkdir(nested);
    await writeFile(join(nested, "note.txt"), "hi\n");
    const result = await lsTool.execute({ path: nested }, contextFor(dir));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("note.txt");
  });
});

test("ls keeps the listing when a nested directory is unreadable", async () => {
  await withTempDir(async (dir) => {
    const locked = join(dir, "src", "secret");
    await mkdir(locked, { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(locked, "hidden.ts"), "export {}\n");
    await chmod(locked, 0);
    try {
      const result = await lsTool.execute(
        { path: "src", depth: 2 },
        contextFor(dir),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("src/app.ts\nsrc/secret/");
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

test("ls reports a model-visible error for a missing path", async () => {
  await withTempDir(async (dir) => {
    const result = await lsTool.execute({ path: "missing" }, contextFor(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: missing");
  });
});

test("ls reports a model-visible error when the path is a file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hi\n");
    const result = await lsTool.execute({ path: "note.txt" }, contextFor(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Path is a file: note.txt");
  });
});

test("ls bounds oversized output and says how to narrow", async () => {
  await withTempDir(async (dir) => {
    const name = `entry-${"x".repeat(200)}.txt`;
    for (let index = 0; index < 300; index++) {
      await writeFile(join(dir, `${index}-${name}`), "\n");
    }
    const result = await lsTool.execute({}, contextFor(dir));
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_LS_BYTES + 160);
    expect(result.content).toContain("truncated");
    expect(result.content).toContain("more specific path");
    expect(result.details).toMatchObject({ truncated: true });
  });
});

test("ls aborts an in-flight listing", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      lsTool.execute({}, { ...contextFor(dir), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("ls lists a directory at depth 1 without recursing", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "README.md"), "hello\n");
    const result = await lsTool.execute({}, await contextFor(dir));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("README.md\nsrc/");
    expect(result.content.includes("app.ts")).toBe(false);
    expect(result.details).toMatchObject({
      truncated: false,
      depth: 1,
    });
  });
});

test("ls bounds non-ASCII entries by UTF-8 bytes and says how to narrow", async () => {
  await withTempDir(async (dir) => {
    // 300 names of about 85 UTF-16 units (under the old cap in total) but about 245 UTF-8 bytes each.
    const name = `${"ไฟล์".repeat(20)}.txt`;
    for (let index = 0; index < 300; index++) {
      await writeFile(join(dir, `${index}-${name}`), "\n");
    }
    const result = await lsTool.execute({}, contextFor(dir));
    const [body, notice] = result.content.split("\n... truncated: ");
    expect(utf8ByteLength(body!)).toBeLessThanOrEqual(MAX_LS_BYTES);
    expect(body!.length).toBeLessThan(MAX_LS_BYTES / 2);
    expect(notice).toBe("output limited. Use a more specific path or lower depth.");
    expect(result.details).toMatchObject({ truncated: true });
    expect((result.details as { entryCount: number }).entryCount).toBeLessThan(300);
  });
});
