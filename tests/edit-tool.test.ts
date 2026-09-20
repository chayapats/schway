import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("edit declares exclusive execution", () => {
  expect(editTool.execution).toBe("exclusive");
  expect(editTool.name).toBe("edit");
});

test("edit replaces a unique match", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha beta\n");
    const ctx = contextFor(dir);
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "alpha", newText: "gamma" }],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Edited note.txt (1 replacement)");
    expect(result.details).toMatchObject({
      path: "note.txt",
      hunks: [{ startLine: 1, oldText: "alpha", newText: "gamma" }],
    });
    const read = await readTool.execute({ path: "note.txt" }, ctx);
    expect(read.content).toContain("gamma beta");
    expect(read.content.includes("alpha")).toBe(false);
  });
});

test("edit rejects a duplicate match and leaves the file untouched", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "foo foo\n");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "foo", newText: "bar" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("matched more than once");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("foo foo\n");
  });
});

test("edit rejects a missing match and leaves the file untouched", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "foo\n");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "missing", newText: "bar" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("foo\n");
  });
});

test("edit applies multiple replacements against the original content", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha beta\n");
    const ctx = contextFor(dir);
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [
          { oldText: "alpha", newText: "beta" },
          { oldText: "beta", newText: "gamma" },
        ],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Edited note.txt (2 replacements)");
    const read = await readTool.execute({ path: "note.txt" }, ctx);
    expect(read.content).toContain("beta gamma");
  });
});

test("edit is atomic: one failed replacement writes nothing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha beta\n");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "missing", newText: "nope" },
        ],
      },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Edit 2 of 2");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("alpha beta\n");
  });
});

test("edit allows adjacent replacements", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "abcdef\n");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [
          { oldText: "abc", newText: "xxx" },
          { oldText: "def", newText: "yyy" },
        ],
      },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("xxxyyy\n");
  });
});

test("edit rejects overlapping replacements and leaves the file untouched", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "abcdef\n");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [
          { oldText: "abc", newText: "x" },
          { oldText: "cde", newText: "y" },
        ],
      },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("overlap");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("abcdef\n");
  });
});

test("edit preserves CRLF line endings", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), Buffer.from("a\r\nb\r\n"));
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "b", newText: "c" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(dir, "note.txt"))).toEqual(
      Buffer.from("a\r\nc\r\n"),
    );
  });
});

test("edit preserves a UTF-8 BOM", async () => {
  await withTempDir(async (dir) => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(join(dir, "note.txt"), Buffer.concat([bom, Buffer.from("hello\n")]));
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "hello", newText: "world" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    const bytes = await readFile(join(dir, "note.txt"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe("\uFEFFworld\n");
  });
});

test("edit resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "note.txt"), "root-file\n");
    await writeFile(join(dir, "src", "note.txt"), "nested-file\n");
    const nested = join(dir, "src");
    const result = await editTool.execute(
      {
        path: "note.txt",
        edits: [{ oldText: "root-file", newText: "changed-root" }],
      },
      contextFor(dir, nested),
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("changed-root\n");
    expect(await readFile(join(dir, "src", "note.txt"), "utf8")).toBe(
      "nested-file\n",
    );
  });
});

test("edit supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const absolute = join(dir, "abs.txt");
    await writeFile(absolute, "from-absolute\n");
    const result = await editTool.execute(
      {
        path: absolute,
        edits: [{ oldText: "from-absolute", newText: "edited-absolute" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(absolute, "utf8")).toBe("edited-absolute\n");
  });
});

test("edit aborts before mutating the filesystem", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "keep\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      editTool.execute(
        {
          path: "note.txt",
          edits: [{ oldText: "keep", newText: "changed" }],
        },
        { ...contextFor(dir), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("keep\n");
  });
});

test("edit reports a model-visible error for a missing file", async () => {
  await withTempDir(async (dir) => {
    const result = await editTool.execute(
      {
        path: "missing.txt",
        edits: [{ oldText: "a", newText: "b" }],
      },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: missing.txt");
  });
});
