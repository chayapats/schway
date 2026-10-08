import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_GREP_BYTES, RIPGREP_MISSING_GUIDANCE, grepTool } from "../src/tools/grep.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import { readTool } from "../src/tools/read.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("grep declares parallel execution", () => {
  expect(grepTool.execution).toBe("parallel");
  expect(grepTool.name).toBe("grep");
});

test("grep returns file and line locations usable with read", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "const alpha = 1;\nconst beta = 2;\n");
    const result = await grepTool.execute(
      { pattern: "beta" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("src/app.ts:2:const beta = 2;");
    expect(result.details).toMatchObject({
      matchCount: 1,
      truncated: false,
    });

    const read = await readTool.execute(
      { path: "src/app.ts", offset: 2, limit: 1 },
      contextFor(dir),
    );
    expect(read.content).toContain("const beta = 2;");
  });
});

test("grep filters files with an optional glob", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "needle\n");
    await writeFile(join(dir, "src", "app.md"), "needle\n");
    const result = await grepTool.execute(
      { pattern: "needle", glob: "*.ts" },
      contextFor(dir),
    );
    expect(result.content).toBe("src/app.ts:1:needle");
    expect(result.content.includes("app.md")).toBe(false);
  });
});

test("grep supports case-insensitive matching", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "Alpha\nbeta\n");
    const sensitive = await grepTool.execute(
      { pattern: "alpha" },
      contextFor(dir),
    );
    expect(sensitive.content).toBe("(no matches)");
    const insensitive = await grepTool.execute(
      { pattern: "alpha", ignoreCase: true },
      contextFor(dir),
    );
    expect(insensitive.content).toBe("note.txt:1:Alpha");
  });
});

test("grep honors maxResults and does not mark an exact fill as truncated", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "a\na\na\n");
    const limited = await grepTool.execute(
      { pattern: "a", maxResults: 2 },
      contextFor(dir),
    );
    expect(limited.content.startsWith("note.txt:1:a\nnote.txt:2:a")).toBe(true);
    expect(limited.content).toContain("truncated");
    expect(limited.content).toContain("Narrow with path, glob, maxResults");
    expect(limited.details).toMatchObject({ matchCount: 2, truncated: true });
    expect(limited.content.includes("note.txt:3:")).toBe(false);

    const exact = await grepTool.execute(
      { pattern: "a", maxResults: 3 },
      contextFor(dir),
    );
    expect(exact.details).toMatchObject({ matchCount: 3, truncated: false });
    expect(exact.content.includes("truncated")).toBe(false);
  });
});

test("grep treats empty matches as an ordinary result", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello\n");
    const result = await grepTool.execute(
      { pattern: "nomatch" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("(no matches)");
    expect(result.details).toMatchObject({ matchCount: 0, truncated: false });
  });
});

test("grep matches paths that contain spaces", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "my dir"));
    await writeFile(join(dir, "my dir", "a file.txt"), "needle here\n");
    const result = await grepTool.execute(
      { pattern: "needle" },
      contextFor(dir),
    );
    expect(result.content).toBe("my dir/a file.txt:1:needle here");
  });
});

test("grep resolves relative paths from the workspace root, not launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "from-src\n");
    await writeFile(join(dir, "app.ts"), "from-root\n");
    const result = await grepTool.execute(
      { pattern: "from-", path: "app.ts" },
      contextFor(dir, join(dir, "src")),
    );
    expect(result.content).toBe("app.ts:1:from-root");
  });
});

test("grep supports absolute paths", async () => {
  await withTempDir(async (dir) => {
    const absolute = join(dir, "abs.txt");
    await writeFile(absolute, "from-absolute\n");
    const result = await grepTool.execute(
      { pattern: "from-absolute", path: absolute },
      contextFor(dir),
    );
    expect(result.content).toContain("from-absolute");
    expect(result.content).toContain(":1:");
  });
});

test("grep reports a model-visible error for a missing path", async () => {
  await withTempDir(async (dir) => {
    const result = await grepTool.execute(
      { pattern: "hello", path: "missing" },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("File not found: missing");
  });
});

test("grep reports a useful error for a malformed pattern", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello\n");
    const result = await grepTool.execute(
      { pattern: "[" },
      contextFor(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("regex");
  });
});

test("grep aborts an in-flight search", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello\n");
    const controller = new AbortController();
    controller.abort();
    await expect(
      grepTool.execute(
        { pattern: "hello" },
        { ...contextFor(dir), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

test("grep reports actionable setup guidance when rg is missing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello\n");
    const script = `
      import { grepTool } from ${JSON.stringify(join(import.meta.dir, "../src/tools/grep.ts"))};
      const result = await grepTool.execute(
        { pattern: "hello" },
        { workspace: { root: ${JSON.stringify(dir)}, launchCwd: ${JSON.stringify(dir)}, extraRoots: [] } },
      );
      console.log(JSON.stringify(result));
    `;
    const emptyBin = join(dir, "empty-bin");
    await mkdir(emptyBin);
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PATH: emptyBin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as {
      isError?: boolean;
      content: string;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toBe(RIPGREP_MISSING_GUIDANCE);
    expect(result.content).toContain("brew install ripgrep");
  });
});

test("grep bounds non-ASCII matches by UTF-8 bytes and says how to narrow", async () => {
  await withTempDir(async (dir) => {
    // 200 matches of about 110 UTF-16 units each fit the old 50,000-unit cap, but are about 66,000 UTF-8 bytes.
    const lines = Array.from({ length: 200 }, (_, index) => `ค้นหา ${"ไ".repeat(100)} ${index}`);
    await writeFile(join(dir, "thai.txt"), `${lines.join("\n")}\n`);
    const result = await grepTool.execute({ pattern: "ค้นหา", maxResults: 200 }, contextFor(dir));
    const [body, notice] = result.content.split("\n... truncated: ");
    expect(utf8ByteLength(body!)).toBeLessThanOrEqual(MAX_GREP_BYTES);
    expect(notice).toBe("stopped early. Narrow with path, glob, maxResults, or a more specific pattern.");
    const details = result.details as { matchCount: number; truncated: boolean };
    expect(details.truncated).toBe(true);
    expect(details.matchCount).toBeLessThan(200);
    expect(body!.split("\n")).toHaveLength(details.matchCount);
  });
});

test("grep cuts an oversized first non-ASCII match on a code-point boundary", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "wide.txt"), `match ${"🙂".repeat(15_000)}\n`);
    const result = await grepTool.execute({ pattern: "match" }, contextFor(dir));
    const [body, notice] = result.content.split("\n... truncated: ");
    expect(body!.startsWith("wide.txt:1:match 🙂")).toBe(true);
    expect(utf8ByteLength(body!)).toBeLessThanOrEqual(MAX_GREP_BYTES);
    expect(utf8ByteLength(body!)).toBeGreaterThan(MAX_GREP_BYTES - 4);
    expect(body!.isWellFormed()).toBe(true);
    expect(notice).toContain("Narrow with path");
    expect(result.details).toMatchObject({ matchCount: 1, truncated: true });
  });
});
