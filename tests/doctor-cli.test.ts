import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const entry = resolve(import.meta.dir, "../src/cli/main.ts");
const installedBin = resolve(import.meta.dir, "../bin/schway");
const bun = process.execPath;
async function run(flags: string[], env: Record<string, string>) {
  const proc = Bun.spawn([bun, "--no-env-file", entry, "doctor", ...flags], { cwd: env.WORK, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}
test("installed entry diagnoses missing backend and unusable storage without TUI or model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-cli-doctor-")); dirs.push(root);
  const work = join(root, "work"), home = join(root, "home"), emptyPath = join(root, "empty-path");
  await mkdir(work); await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(emptyPath);
  await writeFile(join(home, ".schway", "sessions"), "not a directory");
  const result = await run(["--json"], { WORK: work, HOME: home, PATH: emptyPath });
  expect(result.exit).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.schemaVersion).toBe(1);
  expect(report.checks.find((c: { id: string }) => c.id === "search").status).toBe("error");
  expect(report.checks.find((c: { id: string }) => c.id === "sessions").status).toBe("error");
  expect(result.stderr).toBe("");
  expect((await run(["--bad-option"], { WORK: work, HOME: home, PATH: emptyPath })).exit).toBe(2);
});

test("shipped bin dispatches doctor as a standalone command", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-bin-doctor-")); dirs.push(root);
  const work = join(root, "work"), home = join(root, "home"); await mkdir(work); await mkdir(home);
  const proc = Bun.spawn([installedBin, "doctor", "--json", "--provider", "openai-compatible", "--base-url", "http://localhost:11434/v1", "--auth", "none"], { cwd: work, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exit).toBe(0);
  const report = JSON.parse(stdout);
  expect(report.authSource).toBe("none");
  expect(report.checks.find((c: { id: string }) => c.id === "extensions").status).toBe("ok");
});
