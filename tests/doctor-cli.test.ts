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

test("real CLI reports both config causes once, keeps streams and help, and never leaks invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-config-cli-")); dirs.push(root);
  const work = join(root, "work"), home = join(root, "home");
  await mkdir(join(work, ".schway"), { recursive: true }); await mkdir(join(home, ".schway"), { recursive: true });
  await writeFile(join(home, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  await writeFile(join(work, ".schway/config.json"), JSON.stringify({ ui: { "private-invalid-token\u001b[31m": "secret-value" } }));
  const invoke = async (argv: string[]) => {
    const child = Bun.spawn([bun, "--no-env-file", "--preload", resolve(import.meta.dir, "fixtures/credential-store-preload.ts"), entry, ...argv], { cwd: work, env: { HOME: home, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const json = await invoke(["doctor", "--json"]), plain = await invoke(["doctor"]), startup = await invoke(["-p", "test"]);
  for (const result of [json, plain, startup]) {
    expect(result.exit).toBe(1);
    for (const value of ["private-invalid-token", "secret-value", "Expected union value", "\u001b", "\\u001b"]) expect(result.stdout + result.stderr).not.toContain(value);
  }
  expect(json.stderr).toBe(""); expect(plain.stderr).toBe(""); expect(startup.stdout).toBe("");
  const report = JSON.parse(json.stdout);
  expect(report.schemaVersion).toBe(1);
  const config = report.checks.filter((item: { id: string; status: string }) => item.id.startsWith("config.") && item.status === "error");
  expect(config.map((item: { id: string }) => item.id)).toEqual(["config.user", "config.project"]);
  for (const item of config) { expect(plain.stdout).toContain(item.summary); expect(startup.stderr).toContain(item.summary); }
  expect(report.checks.some((item: { id: string }) => item.id.startsWith("package."))).toBe(false);
  const help = await invoke(["--help"]), doctorHelp = await invoke(["doctor", "--help"]);
  for (const result of [help, doctorHelp]) { expect(result.exit).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("Invalid config"); }
  expect((await invoke(["doctor", "--unknown-option"])).exit).toBe(2);
});
