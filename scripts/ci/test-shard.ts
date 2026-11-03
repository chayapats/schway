import { join } from "node:path";

/** Seconds each tracked test file took in CI, keyed by repository-relative path. */
export type TestTimings = Readonly<Record<string, number>>;

/** Shards per architecture in CI; `.github/workflows/checks.yml` lists one matrix entry per shard. */
export const SHARD_COUNT = 4;

/** Checked-in timing table that `test-timings.ts` regenerates from CI JUnit reports. */
export const TIMINGS_PATH = join(import.meta.dir, "test-timings.json");

/** Lists every tracked test file that `bun test` discovers, in sorted order; each file belongs to exactly one shard. */
export function testFiles(root = "."): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.test.ts", "*.test.tsx"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  return listed.stdout.toString().split("\0").filter(Boolean).sort();
}

/** Reads the timing table, keeping only finite non-negative weights; a missing file yields an empty table. */
export async function loadTimings(path = TIMINGS_PATH): Promise<TestTimings> {
  const file = Bun.file(path);
  if (!await file.exists()) return {};
  const parsed: unknown = await file.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} must be a JSON object of seconds`);
  return Object.fromEntries(Object.entries(parsed).filter(([, seconds]) => typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0));
}

/** Weight for a file absent from the table: the 90th-percentile known weight, never below one second. */
export function defaultWeight(timings: TestTimings): number {
  const known = Object.values(timings).sort((a, b) => a - b);
  if (known.length === 0) return 1;
  return Math.max(1, known[Math.min(known.length - 1, Math.floor(known.length * 0.9))]!);
}

/**
 * Splits files into `total` shards by deterministic greedy bin-packing: heaviest file first, each to the
 * lightest shard so far, ties broken by path and then by lowest shard index. Every file lands in exactly
 * one shard, and each shard lists its files in sorted order.
 */
export function assignShards(files: readonly string[], total: number, timings: TestTimings = {}): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error("invalid shard count");
  const fallback = defaultWeight(timings);
  const weight = (file: string) => Object.hasOwn(timings, file) ? timings[file]! : fallback;
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
  for (const file of ordered) {
    let target = shards[0]!;
    for (const shard of shards) if (shard.load < target.load) target = shard;
    target.files.push(file);
    target.load += weight(file);
  }
  return shards.map(shard => shard.files.sort());
}

/** Selects one zero-based shard of the duration-balanced assignment. */
export function shardFiles(files: readonly string[], index: number, total: number, timings: TestTimings = {}): string[] {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("invalid shard");
  return assignShards(files, total, timings)[index]!;
}

if (import.meta.main) {
  const [index, total = SHARD_COUNT] = process.argv.slice(2).map(Number);
  const files = shardFiles(testFiles(), index!, total, await loadTimings());
  if (files.length === 0) throw new Error(`Shard ${index} of ${total} has no test files.`);
  // The leading ./ makes bun treat each entry as a path, not a substring filter.
  console.log(files.map(file => `./${file}`).join("\n"));
}
