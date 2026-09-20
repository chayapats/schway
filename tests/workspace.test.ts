import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { makeDir, makeSymlink, withTempDir } from "./helpers.ts";

test("non-Git workspace uses the launch directory as root", async () => {
  await withTempDir(async (dir) => {
    const launch = await realpath(dir);
    const workspace = await resolveWorkspace(launch);
    expect(workspace.root).toBe(launch);
    expect(workspace.launchCwd).toBe(launch);
    expect(workspace.extraRoots).toEqual([]);
  });
});

test("launch from a Git subdirectory uses the Git root and keeps launchCwd", async () => {
  await withTempDir(async (dir) => {
    await $`git init`.cwd(dir).quiet();
    const nested = await makeDir(join(dir, "pkg", "src"));
    const workspace = await resolveWorkspace(nested);
    expect(workspace.root).toBe(await realpath(dir));
    expect(workspace.launchCwd).toBe(await realpath(nested));
  });
});

test("workspace paths are canonicalized through real paths", async () => {
  await withTempDir(async (dir) => {
    const real = await makeDir(join(dir, "real-project"));
    await $`git init`.cwd(real).quiet();
    const link = join(dir, "via-link");
    await makeSymlink(real, link);
    const nestedLink = await makeDir(join(link, "src"));
    const workspace = await resolveWorkspace(nestedLink);
    expect(workspace.root).toBe(await realpath(real));
    expect(workspace.launchCwd).toBe(await realpath(nestedLink));
    expect(workspace.root.includes("via-link")).toBe(false);
  });
});
