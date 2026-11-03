/** Lists every tracked test file that `bun test` discovers, in sorted order; each file belongs to exactly one shard. */
export function testFiles(root = "."): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.test.ts", "*.test.tsx"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim()}`);
  return listed.stdout.toString().split("\0").filter(Boolean).sort();
}

/** Selects one zero-based shard round-robin, which spreads each suite family across runners. */
export function shardFiles(files: readonly string[], index: number, total: number): string[] {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("invalid shard");
  return files.filter((_, position) => position % total === index);
}

if (import.meta.main) {
  const [index, total] = process.argv.slice(2).map(Number);
  // The leading ./ makes bun treat each entry as a path, not a substring filter.
  console.log(shardFiles(testFiles(), index!, total!).map(file => `./${file}`).join("\n"));
}
