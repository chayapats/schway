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


test("stalled splash reads settle on deadline or abort even when filesystem cancellation is ignored", async () => {
  for (const mode of ["timeout", "abort", "already-aborted"]) {
    const source = `
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      let calls = 0, readSignal;
      mock.module("node:fs/promises", () => ({ ...fs, readFile: (_path, options) => {
        calls++; readSignal = options.signal; return new Promise(() => {});
      } }));
      const { readSplashSeenVersion } = await import(${JSON.stringify(import.meta.resolve("../src/tui/ui-state.ts"))});
      const abort = new AbortController();
      if (${JSON.stringify(mode)} === "already-aborted") abort.abort();
      if (${JSON.stringify(mode)} === "abort") setTimeout(() => abort.abort(), 10);
      const before = performance.now();
      const seen = await readSplashSeenVersion("/fixture-home", abort.signal);
      console.log(JSON.stringify({ unseen: seen === undefined, calls, aborted: readSignal?.aborted, elapsed: performance.now() - before }));
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 1500);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr || "stalled splash read did not release the caller").toBe(0);
      const result = JSON.parse(stdout);
      expect(result.unseen).toBe(true);
      expect(result.elapsed).toBeLessThan(1000);
      expect(result.calls).toBe(mode === "already-aborted" ? 0 : 1);
      if (mode !== "already-aborted") expect(result.aborted).toBe(true);
    } finally { clearTimeout(timeout); }
  }
});
