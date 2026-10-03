import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildIsolatedCliEnv } from "./helpers.ts";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const entry = resolve(import.meta.dir, "../src/cli/main.ts");
const installedBin = resolve(import.meta.dir, "../bin/schway");
const bun = process.execPath;
async function invoke(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; proc.kill(9); }, 10_000);
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  try {
    const [stdout, stderr, exit] = await output;
    if (timedOut) throw new Error("Doctor subprocess exceeded its deadline");
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(deadline);
    if (proc.exitCode === null) proc.kill(9);
    await proc.exited;
    await output.catch(() => {});
  }
}
async function run(flags: string[], env: Record<string, string>) {
  return invoke([bun, "--no-env-file", "--preload", resolve(import.meta.dir, "fixtures/credential-store-preload.ts"), entry, "doctor", ...flags], env.WORK!, buildIsolatedCliEnv(env.HOME!, env));
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
  const { stdout, stderr, exit } = await invoke([installedBin, "doctor", "--json", "--provider", "openai-compatible", "--base-url", "http://localhost:11434/v1", "--auth", "none", "--model", "local-custom"], work,
    buildIsolatedCliEnv(home, { BUN_OPTIONS: `--preload ${resolve(import.meta.dir, "fixtures/credential-store-preload.ts")}` }));
  expect(exit).toBe(0);
  expect(stderr).toBe("");
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
  const launch = (argv: string[]) => invoke([bun, "--no-env-file", "--preload", resolve(import.meta.dir, "fixtures/credential-store-preload.ts"), entry, ...argv], work, buildIsolatedCliEnv(home));
  const json = await launch(["doctor", "--json"]), plain = await launch(["doctor"]), startup = await launch(["-p", "test"]);
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
  const help = await launch(["--help"]), doctorHelp = await launch(["doctor", "--help"]);
  for (const result of [help, doctorHelp]) { expect(result.exit).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("Invalid config"); }
  expect((await launch(["doctor", "--unknown-option"])).exit).toBe(2);
});

test("real doctor model readiness matches text, JSON and invocation exit statuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-model-doctor-cli-")); dirs.push(root);
  const work = join(root, "work"), home = join(root, "home"); await mkdir(work); await mkdir(home);
  const env = { WORK: work, HOME: home };
  const route = ["--provider", "openai-compatible", "--base-url", "http://127.0.0.1:9/v1", "--auth", "none"];
  for (const model of [undefined, "", " \t ", "ทีม/custom-🧪"]) {
    const configured = Boolean(model?.trim());
    const flags = [...route, ...(model !== undefined ? ["--model", model] : [])];
    const plain = await run(flags, env), json = await run(["--json", ...flags], env);
    expect(plain.exit).toBe(configured ? 0 : 1); expect(json.exit).toBe(plain.exit);
    expect(plain.stderr + json.stderr).toBe("");
    const report = JSON.parse(json.stdout);
    expect(report.schemaVersion).toBe(1);
    const check = report.checks.find((item: { id: string }) => item.id === "model");
    expect(check.status).toBe(configured ? "ok" : "error");
    expect(plain.stdout).toContain(check.summary);
    if (!configured) expect(plain.stdout).toContain(check.remedy);
    expect(report.checks.find((item: { id: string }) => item.id === "auth").status).toBe("ok");
  }
  for (const flags of [["--model"], ["--unknown-option"], ["--resume", "historical"]]) {
    const invalid = await run(flags, env);
    expect(invalid.exit).toBe(2); expect(invalid.stdout).toBe(""); expect(invalid.stderr).toContain("schway doctor --help");
  }
});

test("all doctor auth routes check models without importing providers or memory, refreshing tokens, or writing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-model-doctor-effects-")); dirs.push(root);
  const work = join(root, "work"), home = join(root, "home");
  await mkdir(work); await mkdir(join(home, ".schway/interactive/global"), { recursive: true });
  await writeFile(join(home, ".schway/interactive/global/latest.json"), JSON.stringify({ version: 1, revision: "remembered", choice: { provider: "openai", openaiAuth: "api-key", model: "remembered-model" } }));
  await mkdir(join(home, ".schway/sessions"));
  await writeFile(join(home, ".schway/sessions/historical.jsonl"), '{"model":"historical-model"}\n');
  const preload = join(root, "doctor-preload.ts");
  await writeFile(preload, `
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
const deny = operation => () => { console.error("Forbidden doctor side effect: " + operation); process.exit(90); };
const block = (module, names) => ({ ...module, ...Object.fromEntries(names.map(name => [name, deny(name)])) });
mock.module("node:fs/promises", () => block(promises, ["writeFile", "appendFile", "mkdir", "open", "rm", "rename", "unlink", "chmod", "truncate", "copyFile"]));
mock.module("node:fs", () => block(fs, ["writeFileSync", "appendFileSync", "mkdirSync", "openSync", "createWriteStream", "rmSync", "renameSync", "unlinkSync", "chmodSync", "truncateSync", "copyFileSync"]));
globalThis.fetch = deny("fetch");
for (const name of ["write", "connect", "listen"]) Bun[name] = deny("Bun." + name);
Object.defineProperty(Bun, "secrets", { value: {
  async get({ name }) {
    if (name === "api-key:anthropic") return null;
    if (name === "codex-subscription:chatgpt" || name === "grok-subscription:xai") return JSON.stringify({ accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret", obtainedAt: Date.now(), expiresAt: Date.now() + 30_000 });
    return "fixture-store-key";
  },
  set: deny("credential write"), delete: deny("credential delete"),
} });
await Bun.plugin({ name: "doctor-import-guard", setup(builder) {
  builder.onLoad({ filter: /(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\]|interactive-memory\\.ts$)/ }, deny("provider, TUI or memory import"));
} });
`);
  const env = buildIsolatedCliEnv(home, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
  const snapshot = async () => Promise.all((await readdir(root, { recursive: true })).sort().map(async path => {
    const file = join(root, path), metadata = await stat(file);
    return { path, mode: metadata.mode, mtime: metadata.mtimeMs, bytes: metadata.isFile() ? (await readFile(file)).toString("base64") : undefined };
  }));
  const before = await snapshot();
  for (const route of [
    ["--provider", "openai", "--openai-auth", "api-key"],
    ["--provider", "openai", "--openai-auth", "codex"],
    ["--provider", "openai", "--openai-auth", "auto"],
    ["--provider", "xai", "--xai-auth", "api-key"],
    ["--provider", "xai", "--xai-auth", "grok"],
    ["--provider", "xai", "--xai-auth", "auto"],
    ...["none", "optional", "required"].map(auth => ["--provider", "openai-compatible", "--base-url", "http://127.0.0.1:9/v1", "--auth", auth]),
  ]) for (const model of [undefined, "custom/ทีม-🧪"]) {
    const result = await invoke([bun, "--no-env-file", "--preload", preload, entry, "doctor", "--json", ...route, ...(model ? ["--model", model] : [])], work, env);
    expect(result.exit, result.stderr).toBe(model ? 0 : 1); expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.checks.find((item: { id: string }) => item.id === "model").status).toBe(model ? "ok" : "error");
    const subscription = route.includes("codex") || route.includes("grok") || route.includes("auto");
    expect(report.checks.find((item: { id: string }) => item.id === "auth").status).toBe(subscription ? "warning" : "ok");
    for (const secret of ["fixture-access-secret", "fixture-refresh-secret", "fixture-store-key", "remembered-model", "historical-model"]) expect(result.stdout).not.toContain(secret);
  }
  expect(await snapshot()).toEqual(before);
  // Ensure violations cannot disappear inside doctor's recoverable-error catches.
  for (const code of ["await fetch('http://127.0.0.1:9')", "await Bun.secrets.set({ service: 'schway', name: 'test', value: 'test' })", "await import('node:fs/promises').then(fs => fs.writeFile('forbidden', 'test'))", `await import(${JSON.stringify(resolve(import.meta.dir, "../src/config/interactive-memory.ts"))})`, `await import(${JSON.stringify(resolve(import.meta.dir, "../src/model/providers/xai.ts"))})`, `await import(${JSON.stringify(resolve(import.meta.dir, "../src/tui/app.ts"))})`]) {
    const result = await invoke([bun, "--no-env-file", "--preload", preload, "-e", code], work, env);
    expect(result.exit).toBe(90); expect(result.stderr).toContain("Forbidden doctor side effect");
  }
  expect(await snapshot()).toEqual(before);
}, 60_000);
