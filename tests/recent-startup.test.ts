import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

for (const scenario of ["new", "resume", "explicit", "repair", "preferences", "missing", "corrupt", "large", "partial-corrupt"]) {
  test(`actual interactive startup and terminal input: ${scenario}`, async () => {
    await withTempDir(async home => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/recent-startup.ts"), home, scenario], {
        cwd: home, env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 15_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        expect(stdout).toContain(`RECENT_STARTUP_OK ${scenario}`);
      } finally { clearTimeout(timeout); }
    });
  }, 20_000);
}
