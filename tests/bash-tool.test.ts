import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bashTool, MAX_BASH_BYTES, type BashDetails } from "../src/tools/bash.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";
import { runBashProbe } from "./fixtures/bash-spawn-failure.ts";

/** Tool context whose workspace root is a temporary directory. */
function contextFor(dir: string, launchCwd = dir): ToolContext {
  return {
    workspace: { root: dir, launchCwd, extraRoots: [] },
  };
}

for (const scenario of ["missing-cwd", "file-cwd", "missing-shell"]) for (const control of ["none", "abort", "timeout"]) test(`bash ${scenario} with ${control} settles as a process-start failure`, async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe(`${scenario}:${control}`, root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false);
    expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ status: "rejected", code: scenario === "file-cwd" ? "ENOTDIR" : "ENOENT", output: [] });
    expect(result).not.toHaveProperty("result");
  });
});

for (const mode of ["spawn-close", "normal", "stream-error", "both-errors", "abort"]) test(`bash ${mode} preserves stream provenance and cleans lifecycle listeners and timers`, async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe(`lifecycle:${mode}`, root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false); expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ timers: 0, abortListeners: 0, childListeners: [], pipeListeners: [0, 0] });
    expect(result.chunks.filter((chunk: { stream: string }) => chunk.stream === "stderr").map((chunk: { text: string }) => chunk.text).join("")).toBe("diagnostic\n");
    expect(result.chunks.filter((chunk: { stream: string }) => chunk.stream === "stdout").map((chunk: { text: string }) => chunk.text).join("")).toBe(mode === "stream-error" || mode === "both-errors" ? "ก🙂" : "ก🙂�");
    if (mode === "normal") expect(result.outcome).toMatchObject({ status: "fulfilled", result: { details: { stdout: "ก🙂�", stderr: "diagnostic\n", exitCode: 0 } } });
    else if (mode === "abort") expect(result.outcome).toMatchObject({ status: "rejected", name: "AbortError" });
    else expect(result.outcome).toMatchObject({ status: "rejected", ...(mode === "stream-error" ? { code: "EIO", samePipeError: true } : { code: "ENOENT", sameSpawnError: true }) });
  });
});

for (const mode of ["exit", "error", "late-error"]) test(`bash process ${mode} drains the remaining pipe before rejecting its original failure`, async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe(`open-pipe:${mode}`, root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false); expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ sameOriginal: true, signals: [...(mode === "late-error" ? ["SIGKILL"] : []), "SIGTERM", "SIGKILL"], destroyed: [true, true], pipeListeners: [0, 0], childListeners: [], abortListeners: 0 });
  });
});

test("normal bash exit preserves buffered Thai and emoji after the drain deadline", async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe("normal-drain", root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false); expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    const stdout = "PREFIX\nBUFFERED TAIL ไทย 😀\n", stderr = "tail written\n";
    expect(result.expired).toBe(false);
    expect(result.bufferedAtExit).toBeGreaterThan(0);
    expect(result.result.details).toMatchObject({ stdout, stderr, exitCode: 0, truncated: false });
    expect(result.result.isError).toBeUndefined();
    for (const [stream, text] of [["stdout", stdout], ["stderr", stderr]]) {
      expect(result.chunks.filter((chunk: { stream: string }) => chunk.stream === stream).map((chunk: { text: string }) => chunk.text).join("")).toBe(text);
    }
  });
});

test("a real pipe failure kills a TERM-ignoring descendant before returning the original error", async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe("real-pipe-error", root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false); expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ sameOriginal: true, expired: false, stable: true, stderrDestroyed: true, pipeListeners: [0, 0] });
    expect(result.before).toBeGreaterThan(0);
  });
});

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
        command: `bun -e 'process.stdout.write("x".repeat(${MAX_BASH_BYTES + extra}))'`,
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
    expect(details.stdout.length).toBeLessThanOrEqual(MAX_BASH_BYTES);
    expect(result.content).toContain("truncated");
    expect(details.outputPath).toBeDefined();
    const spilled = await readFile(details.outputPath!, "utf8");
    expect(spilled).toContain("x".repeat(MAX_BASH_BYTES + extra));
    expect(result.content).toContain(details.outputPath!);
    const spilledInfo = await stat(details.outputPath!);
    expect(spilledInfo.mode & 0o777).toBe(0o600);
  });
});

/** Run a script that writes exactly `stdout` and `stderr`, returning the result and its details. */
async function emit(dir: string, stdout: string, stderr = "") {
  await writeFile(
    join(dir, "emit.js"),
    `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});`,
  );
  const result = await bashTool.execute({ command: "bun emit.js" }, contextFor(dir));
  return { result, details: result.details as BashDetails };
}

/** Assert a bounded stream is a well-formed prefix of its source with no replacement character introduced. */
function expectCleanPrefix(shown: string, source: string): void {
  expect(source.startsWith(shown)).toBe(true);
  expect(shown.isWellFormed()).toBe(true);
  expect(shown.includes("\uFFFD")).toBe(false);
}

test("bash bounds non-ASCII output by UTF-8 bytes and spills the full streams", async () => {
  await withTempDir(async (dir) => {
    // 2,500 repeats: 32,500 UTF-16 units (under the old cap) but 62,500 UTF-8 bytes.
    const stdout = "สวัสดี hello ".repeat(2_500);
    const stderr = "warning: ภาษาไทย\n";
    expect(stdout.length).toBeLessThan(MAX_BASH_BYTES);
    const total = utf8ByteLength(stdout) + utf8ByteLength(stderr);
    expect(total).toBeGreaterThan(MAX_BASH_BYTES);

    const { result, details } = await emit(dir, stdout, stderr);
    expect(result.isError).toBeUndefined();
    expect(details.truncated).toBe(true);
    const shown = utf8ByteLength(details.stdout) + utf8ByteLength(details.stderr);
    expect(shown).toBeLessThanOrEqual(MAX_BASH_BYTES);
    expect(shown).toBeGreaterThan(MAX_BASH_BYTES - 4);
    expect(details.stderr).toBe("");
    expectCleanPrefix(details.stdout, stdout);
    expect(details).toMatchObject({ shownBytes: shown, totalBytes: total });

    expect(result.content).toBe(
      `Exit code: 0\n\nstdout:\n${details.stdout}\n\n[Output truncated: showing ${shown} of ${total} bytes. Full output: ${details.outputPath}. Use read with offset to see the rest.]`,
    );
    expect(await readFile(details.outputPath!, "utf8")).toBe(`stdout:\n${stdout}\nstderr:\n${stderr}\n`);
    expect((await stat(details.outputPath!)).mode & 0o777).toBe(0o600);
  });
});

test("bash keeps exactly the byte budget of ASCII output and truncates one byte more", async () => {
  await withTempDir(async (dir) => {
    const exact = await emit(dir, "x".repeat(MAX_BASH_BYTES));
    expect(exact.details.truncated).toBe(false);
    expect(exact.details.stdout).toHaveLength(MAX_BASH_BYTES);
    expect(exact.details.outputPath).toBeUndefined();
    expect(exact.details.shownBytes).toBeUndefined();
    expect(exact.result.content).not.toContain("Output truncated");

    const over = await emit(dir, "x".repeat(MAX_BASH_BYTES + 1));
    expect(over.details).toMatchObject({ truncated: true, shownBytes: MAX_BASH_BYTES, totalBytes: MAX_BASH_BYTES + 1 });
    expect(over.details.stdout).toHaveLength(MAX_BASH_BYTES);
    expect(over.result.content).toContain(`showing ${MAX_BASH_BYTES} of ${MAX_BASH_BYTES + 1} bytes`);
  });
});

test("bash never splits a code point at the byte budget", async () => {
  await withTempDir(async (dir) => {
    // stdout only: the boundary falls inside a 4-byte emoji, then inside a 3-byte Thai character.
    const emoji = `a${"🙂".repeat(12_500)}`;
    const emojiRun = await emit(dir, emoji);
    expectCleanPrefix(emojiRun.details.stdout, emoji);
    expect(emojiRun.details.stdout).toBe(`a${"🙂".repeat(12_499)}`);
    expect(emojiRun.details.shownBytes).toBe(MAX_BASH_BYTES - 3);

    const thai = `a${"ก".repeat(16_667)}`;
    const thaiRun = await emit(dir, thai);
    expectCleanPrefix(thaiRun.details.stdout, thai);
    expect(thaiRun.details.stdout).toBe(`a${"ก".repeat(16_666)}`);
    expect(thaiRun.details.shownBytes).toBe(MAX_BASH_BYTES - 1);

    // stderr only: the same emoji boundary inside the stream that gets the remaining budget.
    const stderrRun = await emit(dir, "", emoji);
    expect(stderrRun.details.stdout).toBe("");
    expectCleanPrefix(stderrRun.details.stderr, emoji);
    expect(stderrRun.details.stderr).toBe(`a${"🙂".repeat(12_499)}`);

    // stdout exactly fills the budget, so stderr that starts with an emoji is dropped whole.
    const full = `${"ก".repeat(16_666)}ab`;
    expect(utf8ByteLength(full)).toBe(MAX_BASH_BYTES);
    const fullRun = await emit(dir, full, "🙂 tail");
    expect(fullRun.details.stdout).toBe(full);
    expect(fullRun.details.stderr).toBe("");
    expect(fullRun.details).toMatchObject({ truncated: true, shownBytes: MAX_BASH_BYTES, totalBytes: MAX_BASH_BYTES + 9 });

    for (const run of [emojiRun, thaiRun, stderrRun, fullRun]) {
      expect(run.result.content.isWellFormed()).toBe(true);
      expect(run.result.content.includes("\uFFFD")).toBe(false);
      expect(utf8ByteLength(run.details.stdout) + utf8ByteLength(run.details.stderr)).toBeLessThanOrEqual(MAX_BASH_BYTES);
    }
  });
});

test("bash reaps background children that keep pipes open after the shell exits", async () => {
  await withTempDir(async (dir) => {
    const started = Date.now();
    const result = await bashTool.execute(
      {
        command: "sleep 30 & echo started; exit 0",
        timeout: 200,
      },
      contextFor(dir),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.content).toContain("started");
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
