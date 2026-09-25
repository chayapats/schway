// Copied to an isolated consumer repository with imports rewritten to installed Schway.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureGitSnapshot, compareGitSnapshots, inspectGitStatus } from "../../src/workspace/git.ts";

const root = process.cwd();
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
git("init", "-q");
git("config", "user.email", "fixture@example.test");
git("config", "user.name", "Fixture");
await writeFile(join(root, "tracked.txt"), "original\n");
git("add", "tracked.txt", "installed-git.ts");
git("commit", "-qm", "fixture");
await writeFile(join(root, "tracked.txt"), "pre-existing\n");
const before = await captureGitSnapshot(root);
assert(!("error" in before), "baseline snapshot failed");
await writeFile(join(root, "new.txt"), "new edit\n");
const after = await captureGitSnapshot(root);
assert(!("error" in after), "new snapshot failed");
const comparison = compareGitSnapshots(before, after);
assert(!("error" in comparison), "snapshot comparison failed");
assert(comparison.preExistingUnchanged.includes("tracked.txt"));
assert(comparison.newChanges.includes("new.txt"));
const status = await inspectGitStatus(root);
assert(!("error" in status) && status.isGit && status.dirty);
console.log(JSON.stringify({ status: "passed", preExisting: comparison.preExistingUnchanged, newChanges: comparison.newChanges }));
