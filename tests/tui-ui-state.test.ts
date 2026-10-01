import { expect, test } from "bun:test";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSplashSeenVersion, recordSplashSeenVersion } from "../src/tui/ui-state.ts";
import { withTempDir } from "./helpers.ts";

test("splash state round-trips exact versions with no temporary files left behind", async () => {
  await withTempDir(async home => {
    expect(await readSplashSeenVersion(home)).toBeUndefined();
    await recordSplashSeenVersion(home, "1.2.3");
    expect(await readSplashSeenVersion(home)).toBe("1.2.3");
    expect(await Bun.file(join(home, ".schway/ui-state.json")).json()).toEqual({ splashSeenVersion: "1.2.3" });
    await recordSplashSeenVersion(home, "1.2.2");
    expect(await readSplashSeenVersion(home)).toBe("1.2.2");
    expect(await readdir(join(home, ".schway"))).toEqual(["ui-state.json"]);
  });
});

test("malformed, missing or unreadable splash state is unseen and write failures are harmless", async () => {
  await withTempDir(async home => {
    await mkdir(join(home, ".schway"));
    const path = join(home, ".schway/ui-state.json");
    for (const value of ["not JSON", "null", "[]", "{}", '{"splashSeenVersion":12}', '{"splashSeenVersion":""}']) {
      await writeFile(path, value);
      expect(await readSplashSeenVersion(home)).toBeUndefined();
    }
    await chmod(join(home, ".schway"), 0o500);
    try { await expect(recordSplashSeenVersion(home, "1.2.3")).resolves.toBeUndefined(); }
    finally { await chmod(join(home, ".schway"), 0o700); }
    // This fails even under root, unlike permission-only fixtures.
    const blockedHome = join(home, "blocked");
    await mkdir(blockedHome);
    await writeFile(join(blockedHome, ".schway"), "not a directory");
    expect(await readSplashSeenVersion(blockedHome)).toBeUndefined();
    await expect(recordSplashSeenVersion(blockedHome, "1.2.3")).resolves.toBeUndefined();
  });
});
