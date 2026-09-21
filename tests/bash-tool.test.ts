import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bashTool, MAX_BASH_CHARS } from "../src/tools/bash.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

test("bash declares exclusive execution", () => {
  expect(bashTool.execution).toBe("exclusive");
  expect(bashTool.name).toBe("bash");
});

test("bash runs a command in a fresh shell at the workspace root", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "marker.txt"), "root-marker\n");
    const result = await bashTool.execute(
      { command: "cat marker.txt" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("root-marker");
    expect(result.details).toMatchObject({
      exitCode: 0,
      cwd: dir,
      truncated: false,
    });
  });
});

test("bash treats a non-zero exit as ordinary result data", async () => {
  await withTempDir(async (dir) => {
    const result = await bashTool.execute(
      { command: "echo failed-out; echo failed-err >&2; exit 7" },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Exit code: 7");
    expect(result.content).toContain("failed-out");
    expect(result.content).toContain("failed-err");
    expect(result.details).toMatchObject({
      exitCode: 7,
      stdout: expect.stringContaining("failed-out"),
      stderr: expect.stringContaining("failed-err"),
    });
  });
});

test("bash captures mixed stdout and stderr", async () => {
  await withTempDir(async (dir) => {
    const chunks: Array<{ stream: string; text: string }> = [];
    const result = await bashTool.execute(
      { command: "echo out-line; echo err-line >&2" },
      {
        ...contextFor(dir),
        onOutput(chunk) {
          chunks.push(chunk);
        },
      },
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("out-line"),
      stderr: expect.stringContaining("err-line"),
    });
    expect(chunks.some((chunk) => chunk.stream === "stdout" && chunk.text.includes("out-line"))).toBe(
      true,
    );
    expect(chunks.some((chunk) => chunk.stream === "stderr" && chunk.text.includes("err-line"))).toBe(
      true,
    );
  });
});

test("bash runs in an explicit working directory resolved from the workspace root", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "here.txt"), "from-src\n");
    await writeFile(join(dir, "here.txt"), "from-root\n");
    const result = await bashTool.execute(
      { command: "cat here.txt", cwd: "src" },
      contextFor(dir, join(dir, "src")),
    );
    expect(result.content).toContain("from-src");
    expect(result.content.includes("from-root")).toBe(false);
    expect(result.details).toMatchObject({ cwd: join(dir, "src") });
  });
});

test("bash defaults to the workspace root rather than launch cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "marker.txt"), "at-root\n");
    const result = await bashTool.execute(
      { command: "cat marker.txt" },
      contextFor(dir, join(dir, "nested")),
    );
    expect(result.content).toContain("at-root");
  });
});

test("changing directory inside a command does not affect later commands", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "root.txt"), "still-root\n");
    const ctx = contextFor(dir);
    const first = await bashTool.execute(
      { command: "cd sub && pwd" },
      ctx,
    );
    expect(first.isError).toBeUndefined();
    const second = await bashTool.execute(
      { command: "cat root.txt && pwd" },
      ctx,
    );
    expect(second.content).toContain("still-root");
    expect(second.details).toMatchObject({ cwd: dir, exitCode: 0 });
  });
});

test("bash bounds oversized output and spills the full log to a temp file", async () => {
  await withTempDir(async (dir) => {
    const extra = 80;
    const result = await bashTool.execute(
      {
        command: `bun -e 'process.stdout.write("x".repeat(${MAX_BASH_CHARS + extra}))'`,
      },
      contextFor(dir),
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      exitCode: 0,
      truncated: true,
    });
    const details = result.details as {
      stdout: string;
      outputPath?: string;
      truncated: boolean;
    };
    expect(details.stdout.length).toBeLessThanOrEqual(MAX_BASH_CHARS);
    expect(result.content).toContain("truncated");
    expect(details.outputPath).toBeDefined();
    const spilled = await readFile(details.outputPath!, "utf8");
    expect(spilled).toContain("x".repeat(MAX_BASH_CHARS + extra));
    expect(result.content).toContain(details.outputPath!);
  });
});

test("bash timeout kills the command and its child processes", async () => {
  await withTempDir(async (dir) => {
    const marker = join(dir, "ticks.txt");
    const started = Date.now();
    const result = await bashTool.execute(
      {
        command: "while true; do echo tick >> ticks.txt; sleep 0.05; done",
        timeout: 200,
      },
      contextFor(dir),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("timed out");
    expect(result.details).toMatchObject({ timedOut: true });
    const sizeAfter = (await stat(marker).catch(() => ({ size: 0 }))).size;
    await Bun.sleep(250);
    const sizeLater = (await stat(marker).catch(() => ({ size: 0 }))).size;
    expect(sizeLater).toBe(sizeAfter);
  });
});

test("bash cancellation kills the command and throws AbortError", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    const marker = join(dir, "ticks.txt");
    const running = bashTool.execute(
      {
        command:
          "echo start >> ticks.txt; while true; do echo tick >> ticks.txt; sleep 0.05; done",
      },
      { ...contextFor(dir), signal: controller.signal },
    );
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const text = await readFile(marker, "utf8").catch(() => "");
      if (text.includes("start")) {
        break;
      }
      await Bun.sleep(20);
    }
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const sizeAfter = (await stat(marker)).size;
    await Bun.sleep(250);
    const sizeLater = (await stat(marker)).size;
    expect(sizeLater).toBe(sizeAfter);
  });
});

test("bash aborts before starting when the signal is already aborted", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      bashTool.execute(
        { command: "echo should-not-run" },
        { ...contextFor(dir), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
