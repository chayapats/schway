import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_FIND_BYTES, findTool } from "../src/tools/find.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("find declares parallel execution", () => {
  expect(findTool.execution).toBe("parallel");
  expect(findTool.name).toBe("find");
});

test("find discovers files matching a glob pattern", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "src", "app.md"), "# docs\n");
    await writeFile(join(dir, "README.md"), "hello\n");
    const result = await findTool.execute(
      { pattern: "**/*.ts" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("src/app.ts");
    expect(result.content.includes("app.md")).toBe(false);
    expect(result.details).toMatchObject({
      truncated: false,
      fileCount: 1,
    });
  });
});

test("find scopes discovery to an optional search path", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "pkg"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "pkg", "lib.ts"), "export {}\n");
    const result = await findTool.execute(
      { pattern: "**/*.ts", path: "src" },
      contextFor(dir),
    );
    expect(result.content).toBe("src/app.ts");
    expect(result.content.includes("pkg")).toBe(false);
  });
});

test("find treats empty matches as an ordinary result", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "readme.md"), "hello\n");
    const result = await findTool.execute(
      { pattern: "**/*.ts" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("(no matching files)");
    expect(result.details).toMatchObject({ fileCount: 0, truncated: false });
  });
});

test("find matches paths that contain spaces", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "my dir"));
    await writeFile(join(dir, "my dir", "a file.ts"), "export {}\n");
    const result = await findTool.execute(
      { pattern: "**/*.ts" },
      contextFor(dir),
    );
    expect(result.content).toBe("my dir/a file.ts");
  });
});

test("find resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "export {}\n");
    await writeFile(join(dir, "app.ts"), "wrong-file\n");
    const result = await findTool.execute(
      { pattern: "*.ts", path: "." },
      contextFor(dir, join(dir, "src")),
    );
    expect(result.content).toContain("app.ts");
    expect(result.content.includes("src/app.ts")).toBe(false);
  });
});

test("find supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "outside");
    await mkdir(nested);
    await writeFile(join(nested, "lib.ts"), "export {}\n");
    const result = await findTool.execute(
      { pattern: "**/*.ts", path: nested },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("lib.ts");
  });
});

test("find reports a model-visible error for a missing path", async () => {
  await withTempDir(async (dir) => {
    const result = await findTool.execute(
      { pattern: "**/*.ts", path: "missing" },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: missing");
  });
});

test("find bounds oversized output and says how to narrow", async () => {
  await withTempDir(async (dir) => {
    const name = `file-${"x".repeat(200)}.ts`;
    for (let index = 0; index < 300; index++) {
      await writeFile(join(dir, `${index}-${name}`), "export {}\n");
    }
    const result = await findTool.execute(
      { pattern: "**/*.ts" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(MAX_FIND_BYTES + 160);
    expect(result.content).toContain("truncated");
    expect(result.content).toContain("more specific pattern or path");
    expect(result.details).toMatchObject({ truncated: true });
  });
});

test("find aborts an in-flight search", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "app.ts"), "export {}\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      findTool.execute(
        { pattern: "**/*.ts" },
        { ...contextFor(dir), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("find bounds non-ASCII paths by UTF-8 bytes and says how to narrow", async () => {
  await withTempDir(async (dir) => {
    // 300 names of about 85 UTF-16 units (under the old cap in total) but about 245 UTF-8 bytes each.
    const name = `${"ไฟล์".repeat(20)}.ts`;
    for (let index = 0; index < 300; index++) {
      await writeFile(join(dir, `${index}-${name}`), "export {}\n");
    }
    const result = await findTool.execute({ pattern: "**/*.ts" }, contextFor(dir));
    const [body, notice] = result.content.split("\n... truncated: ");
    expect(utf8ByteLength(body!)).toBeLessThanOrEqual(MAX_FIND_BYTES);
    expect(body!.length).toBeLessThan(MAX_FIND_BYTES / 2);
    expect(notice).toBe("too many files. Narrow with a more specific pattern or path.");
    expect(result.details).toMatchObject({ truncated: true });
    expect((result.details as { fileCount: number }).fileCount).toBeLessThan(300);
  });
});
