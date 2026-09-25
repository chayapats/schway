import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/cli/args.ts";
import { diagnosticPath } from "../src/diagnostics/sink.ts";
import { runInteractiveTui } from "../src/tui/app.ts";

test("interactive startup diagnostics are opt-in and never require OpenTUI for pre-render failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "schway-tui-debug-"));
  try {
    for (const enabled of [false, true]) {
      const parsed = parseArgs(["--resume", "missing-session", ...(enabled ? ["--debug"] : [])]);
      if ("error" in parsed) throw new Error(parsed.error);
      const code = await runInteractiveTui({ args: parsed.args, env: { HOME: home }, cwd: home,
        stdout: { write() {} }, stderr: { write() {} } });
      expect(code).toBe(1);
      expect(await Bun.file(diagnosticPath(home)).exists()).toBe(enabled);
    }
    const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; component: string });
    expect(records).toContainEqual(expect.objectContaining({ component: "cli", event: "startup" }));
  } finally { await rm(home, { recursive: true, force: true }); }
});
