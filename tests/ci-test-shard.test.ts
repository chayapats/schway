import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assignShards, defaultWeight, loadTimings, SHARD_COUNT, shardFiles, testFiles, TIMINGS_PATH, type TestTimings } from "../scripts/ci/test-shard.ts";
import { mergeTimings, parseJunit } from "../scripts/ci/test-timings.ts";
import { withTempDir } from "./helpers.ts";

const files = Array.from({ length: 40 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
const timings: TestTimings = Object.fromEntries(files.slice(0, 30).map((file, i) => [file, (i * 37) % 23 + 0.5]));

function loads(shards: string[][], weights: TestTimings): number[] {
  const fallback = defaultWeight(weights);
  return shards.map(shard => shard.reduce((sum, file) => sum + (weights[file] ?? fallback), 0));
}

test("every file lands in exactly one shard for any shard count", () => {
  for (const total of [1, 2, 3, 8, 13, 41, 64]) {
    const shards = assignShards(files, total, timings);
    expect(shards).toHaveLength(total);
    const all = shards.flat();
    expect(all).toHaveLength(files.length);
    expect(new Set(all)).toEqual(new Set(files));
    for (const shard of shards) expect(shard).toEqual([...shard].sort());
    expect(shards.map((_, index) => shardFiles(files, index, total, timings))).toEqual(shards);
  }
});

test("assignment ignores input order and duplicate entries", () => {
  const shuffled = [...files].reverse();
  shuffled.splice(5, 0, files[3]!, files[3]!);
  expect(assignShards(shuffled, 8, timings)).toEqual(assignShards(files, 8, timings));
  expect(assignShards(files, 8, timings)).toEqual(assignShards(files, 8, { ...timings }));
});

test("one heavy file gets a shard to itself and the rest balance around it", () => {
  const weights: TestTimings = { "tests/heavy.test.ts": 100, ...Object.fromEntries(files.map(file => [file, 5])) };
  const shards = assignShards([...files, "tests/heavy.test.ts"], 4, weights);
  expect(shards.find(shard => shard.includes("tests/heavy.test.ts"))).toEqual(["tests/heavy.test.ts"]);
  expect(loads(shards, weights).sort((a, b) => a - b)).toEqual([65, 65, 70, 100]);
});

test("the greedy pack keeps the slowest shard close to the even split", () => {
  const shards = assignShards(files, 8, timings);
  const totals = loads(shards, timings);
  const even = totals.reduce((a, b) => a + b, 0) / 8;
  const heaviest = Math.max(...files.map(file => timings[file] ?? defaultWeight(timings)));
  // Longest-processing-time greedy never exceeds the even split by more than one file.
  expect(Math.max(...totals)).toBeLessThanOrEqual(even + heaviest);
  expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.5);
});

test("files missing from the table get a conservative default weight", () => {
  expect(defaultWeight({})).toBe(1);
  expect(defaultWeight({ a: 0.1, b: 0.2 })).toBe(1);
  const spread = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, i + 1]));
  expect(defaultWeight(spread)).toBe(10);
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, i + 1]));
  expect(defaultWeight(wide)).toBe(91);
  // With no timings at all, the assignment still splits by count.
  const counts = assignShards(files, 8).map(shard => shard.length);
  expect(counts).toEqual(Array(8).fill(5));
  // An unknown file is weighed like the slow known file, so it doesn't pile onto the light shard.
  const known: TestTimings = { "tests/a.test.ts": 1, "tests/b.test.ts": 1, "tests/c.test.ts": 1, "tests/d.test.ts": 9 };
  expect(defaultWeight(known)).toBe(9);
  const shards = assignShards(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/new.test.ts"], 2, known);
  expect(shards).toEqual([["tests/a.test.ts", "tests/c.test.ts", "tests/d.test.ts"], ["tests/b.test.ts", "tests/new.test.ts"]]);
});

test("invalid shard requests are rejected", () => {
  for (const [index, total] of [[0, 0], [8, 8], [-1, 8], [0.5, 8], [0, Number.NaN], [Number.NaN, 8]] as const) {
    expect(() => shardFiles(files, index, total, timings)).toThrow("invalid shard");
  }
});

test("JUnit reports become a sorted table of the slowest file time per report", () => {
  const x64 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" time="9.5">
  <testsuite name="tests/b.test.ts" file="tests/b.test.ts" tests="2" time="4.01" hostname="x">
    <testsuite name="nested describe" file="tests/b.test.ts" tests="1" time="3">
      <testcase name="case" time="3" file="tests/b.test.ts" />
    </testsuite>
  </testsuite>
  <testsuite name="tests/a &amp; b.test.ts" file="tests/a &amp; b.test.ts" tests="1" time="0.04" hostname="x" />
  <testsuite name="tests/gone.test.ts" file="tests/gone.test.ts" tests="1" time="2" hostname="x" />
</testsuites>`;
  const arm64 = `<testsuites><testsuite name="tests/b.test.ts" file="tests/b.test.ts" time="3.5"></testsuite>
<testsuite name="tests/c.test.ts" file="tests/c.test.ts" time="not-a-number"></testsuite></testsuites>`;
  const first = parseJunit(x64);
  expect([...first]).toEqual([["tests/b.test.ts", 4.01], ["tests/a & b.test.ts", 0.04], ["tests/gone.test.ts", 2]]);
  const merged = mergeTimings([first, parseJunit(arm64)], ["tests/a & b.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
  expect(merged).toEqual({ "tests/a & b.test.ts": 0.1, "tests/b.test.ts": 4.1 });
  expect(Object.keys(merged)).toEqual(["tests/a & b.test.ts", "tests/b.test.ts"]);
});

test("the checked-in timing table loads as non-negative seconds in sorted order", async () => {
  const table = await loadTimings(TIMINGS_PATH);
  expect(Object.keys(table).length).toBeGreaterThan(0);
  expect(Object.keys(table)).toEqual(Object.keys(table).sort());
  for (const [file, seconds] of Object.entries(table)) {
    expect(file).toMatch(/\.test\.tsx?$/);
    expect(seconds).toBeGreaterThanOrEqual(0);
  }
  await withTempDir(async dir => {
    expect(await loadTimings(join(dir, "missing.json"))).toEqual({});
    await writeFile(join(dir, "mixed.json"), JSON.stringify({ "a.test.ts": 2, "b.test.ts": -1, "c.test.ts": "3" }));
    expect(await loadTimings(join(dir, "mixed.json"))).toEqual({ "a.test.ts": 2 });
    await writeFile(join(dir, "list.json"), "[]");
    await expect(loadTimings(join(dir, "list.json"))).rejects.toThrow("must be a JSON object");
  });
});

test("tracked test discovery lists only tracked test files in sorted order", async () => {
  await withTempDir(async dir => {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q");
    await mkdir(join(dir, "tests/nested"), { recursive: true });
    for (const file of ["tests/z.test.ts", "tests/nested/a.test.tsx", "tests/helper.ts", "tests/untracked.test.ts"]) await writeFile(join(dir, file), "");
    git("add", "tests/z.test.ts", "tests/nested/a.test.tsx", "tests/helper.ts");
    expect(testFiles(dir)).toEqual(["tests/nested/a.test.tsx", "tests/z.test.ts"]);
  });
});

test("the CI matrix lists exactly SHARD_COUNT shards and every step fails on a broken shard list", async () => {
  type Step = { name?: string; run?: string };
  type Workflow = { defaults?: { run?: { shell?: string } }; jobs: Record<string, { strategy?: { matrix?: Record<string, unknown> }; steps: Step[] }> };
  const workflow = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "../.github/workflows/checks.yml")).text()) as Workflow;
  const tests = workflow.jobs.tests!;
  expect(tests.strategy?.matrix?.shard).toEqual(Array.from({ length: SHARD_COUNT }, (_, index) => index));
  // GitHub's `bash` shell runs with pipefail, so a failing test-shard.ts can't hide behind `tee`.
  expect(workflow.defaults?.run?.shell).toBe("bash");
  const list = tests.steps.find(step => step.run?.includes("scripts/ci/test-shard.ts"))!.run!;
  // The count comes from SHARD_COUNT alone, and an empty list fails before bun test would run everything.
  expect(list).toMatch(/scripts\/ci\/test-shard\.ts \$\{\{ matrix\.shard \}\} \|/);
  expect(list).toContain('test -s "$RUNNER_TEMP/shard-files.txt"');
  // Every shard of the real table's files gets work; the table lists the tracked files without needing Git.
  const table = await loadTimings();
  for (let index = 0; index < SHARD_COUNT; index++) expect(shardFiles(Object.keys(table), index, SHARD_COUNT, table).length).toBeGreaterThan(0);
});

test("the container job fails a run that crashed, exited early or skipped test files", async () => {
  await withTempDir(async dir => {
    const check = async (log: string, expected = "229") => {
      await writeFile(join(dir, "bun-test.log"), log);
      const result = Bun.spawnSync(["bash", join(import.meta.dir, "../scripts/ci/no-git-container.sh"), "--check-summary", join(dir, "bun-test.log"), expected],
        { stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
    };
    // A nested run's summary comes first; the last summary is the suite's.
    const finished = await check("Ran 1 test across 1 file. [1ms]\n 5385 pass\n 642 fail\nRan 6027 tests across 229 files. [721.21s]\n");
    expect(finished).toEqual({ code: 0, output: "bun test ran 6027 tests across 229 files (expected at least 229).\n" });
    expect((await check(" 0 pass\nRan 0 tests across 0 files. [1ms]\n")).output).toContain("ran 0 tests across 0 files; expected at least 229 files");
    expect((await check("Ran 5000 tests across 200 files. [1ms]\n")).code).toBe(1);
    expect((await check("Ran 6027 tests across 229 files. [1s]\nRan 1 test across 1 file. [1ms]\n")).code).toBe(1);
    const crashed = await check("tests/a.test.ts:\nSegmentation fault\n");
    expect(crashed.code).toBe(1);
    expect(crashed.output).toContain("printed no final summary");
    expect((await check("Ran 1 test across 1 file.\n", "0")).code).toBe(2);
  });
});
