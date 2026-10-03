import { expect, test } from "bun:test";
import { chmod, mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { CLI_OPTIONS, formatHelp } from "../src/cli/help.ts";
import { version } from "../package.json";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const entry = join(repo, "src/cli/main.ts");
const mixedError = "Use --version on its own · Run schway --help for options";

/** Capture a real CLI invocation and reap it even if startup stalls. */
async function run(argv: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

test("help takes precedence only when combined with a standalone version flag", async () => {
  await withTempDir(async cwd => {
    for (const flag of ["--version", "-V"]) for (const help of ["--help", "-h"]) {
      for (const args of [[flag, help], [help, flag]]) {
        expect(parseArgs(args)).toEqual({ args: { json: false, help: true, version: true } });
        expect(await run([process.execPath, "--no-env-file", entry, ...args], cwd,
          buildIsolatedCliEnv(cwd, { HOME: undefined }))).toEqual({ stdout: formatHelp(), stderr: "", exitCode: 0 });
      }
    }
  });
});

test("version rejects every task, setup and output option in either order before dispatch", async () => {
  await withTempDir(async cwd => {
    const options = CLI_OPTIONS.filter(option => !option.flags.includes("--help") && !option.flags.includes("--version"));
    const mixes = options.flatMap(option => option.flags.flatMap(flag => option.sample === undefined
      ? [[flag]] : [[flag, option.sample], [`${flag}=${option.sample}`]]));
    mixes.push(["doctor"], ["task"], ["--versoin"], ["-v"], ["--version"], ["-V"], ["--"]);
    for (const flag of ["--version", "-V"]) for (const mix of mixes) {
      for (const args of [[flag, ...mix], [...mix, flag], ["--help", flag, ...mix]]) {
        expect(parseArgs(args), args.join(" ")).toEqual({ error: mixedError });
      }
      const args = [flag, ...mix];
      expect(await run([process.execPath, "--no-env-file", entry, ...args], cwd,
        buildIsolatedCliEnv(cwd))).toEqual({ stdout: "", stderr: `${mixedError}\n`, exitCode: 1 });
    }
    expect(await run([process.execPath, "--no-env-file", entry, "doctor", "--version"], cwd,
      buildIsolatedCliEnv(cwd))).toEqual({ stdout: "", stderr: `${mixedError}\n`, exitCode: 1 });
  });
}, 30_000);

test("lowercase -v and unknown version spellings remain unsupported", async () => {
  await withTempDir(async cwd => {
    for (const flag of ["-v", "--versoin", "--version=1", "-V=1"]) {
      expect(parseArgs([flag])).toEqual({ error: `Unknown option: ${flag}` });
      expect(await run([process.execPath, "--no-env-file", entry, flag], cwd,
        buildIsolatedCliEnv(cwd))).toEqual({ stdout: "", stderr: `Unknown option: ${flag}\nRun 'schway --help' for usage.\n`, exitCode: 1 });
    }
  });
});

for (const flag of ["--version", "-V"]) {
  test(`${flag} parses as a standalone command`, () => {
    expect(parseArgs([flag])).toEqual({ args: { json: false, help: false, version: true } });
  });

  test(`${flag} prints exact package metadata through the real entry without HOME`, async () => {
    await withTempDir(async cwd => {
      expect(await run([process.execPath, "--no-env-file", entry, flag], cwd,
        buildIsolatedCliEnv(cwd, { HOME: undefined }))).toEqual({
        stdout: `schway ${version}\n`, stderr: "", exitCode: 0,
      });
    });
  });
}

test("real version entry does not inspect setup, execute code or contact services", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), cwd = join(root, "work");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(cwd, ".schway"), { recursive: true });
    const config = join(home, ".schway/config.json");
    await Bun.write(config, "{malformed");
    await Bun.write(join(cwd, ".schway/config.json"), "{also malformed");
    await Bun.write(join(cwd, ".env"), "SCHWAY_VERSION_ENV=loaded\n");
    const preload = join(root, "version-preload.ts");
    await Bun.write(preload, `
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as childProcess from "node:child_process";
const deny = (operation) => (...args) => { console.error("Forbidden version side effect: " + operation); process.exit(90); };
if (process.env.SCHWAY_VERSION_ENV) deny("automatic env file loading")();
const block = (module, names) => ({ ...module, ...Object.fromEntries(names.map(name => [name, deny(name)])) });
mock.module("node:fs/promises", () => block(promises, ["access", "readFile", "writeFile", "readdir", "realpath", "stat", "lstat", "mkdir", "open", "rm", "rename", "unlink"]));
mock.module("node:fs", () => block(fs, ["accessSync", "readFileSync", "writeFileSync", "readdirSync", "realpathSync", "statSync", "lstatSync", "mkdirSync", "openSync", "createReadStream", "createWriteStream"]));
mock.module("node:child_process", () => block(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]));
globalThis.fetch = deny("fetch");
const file = Bun.file;
Bun.file = (path, ...args) => typeof path === "number" && path >= 0 && path <= 2 ? file(path, ...args) : deny("Bun.file")();
for (const name of ["write", "spawn", "spawnSync", "connect", "listen"]) Bun[name] = deny("Bun." + name);
Object.defineProperty(Bun, "secrets", { value: Object.fromEntries(["get", "set", "delete"].map(name => [name, deny("credentials." + name)])) });
await Bun.plugin({ name: "version-import-guard", setup(builder) {
  builder.onLoad({ filter: /(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/ }, deny("provider or TUI import"));
} });
`);
    const env = buildIsolatedCliEnv(home, { BUN_OPTIONS: `--preload ${preload}`, PATH: "", FORCE_COLOR: "1" });
    const before = (await readdir(root, { recursive: true })).sort();
    for (const permissions of [0o600, 0o000]) {
      await chmod(config, permissions);
      try {
        for (const args of [["--version"], ["-V"], ["--version", "--debug-file", "created.log"], ["doctor", "--version"], ["--version", "--extension", "./extension.ts"], ["--version", "--env-file", ".env"]]) {
          const result = await run([process.execPath, "--no-env-file", entry, ...args], cwd, env);
          const mixed = args.length > 1 && !args.includes("--help");
          expect(result, args.join(" ")).toEqual({
            stdout: mixed ? "" : args.includes("--help") ? formatHelp() : `schway ${version}\n`,
            stderr: mixed ? `${mixedError}\n` : "", exitCode: mixed ? 1 : 0,
          });
          expect(result.stdout + result.stderr).not.toContain("\x1b");
        }
      } finally { await chmod(config, 0o600); }
    }
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
    expect(await Bun.file(config).text()).toBe("{malformed");
    // Explicit help uses the existing help catalogue, which Bun may transpile-cache.
    expect(await run([process.execPath, "--no-env-file", entry, "--version", "--help"], cwd, env)).toEqual({
      stdout: formatHelp(), stderr: "", exitCode: 0,
    });
    // Prove the subprocess guard catches the forbidden boundaries, including caught errors.
    for (const probe of [
      "await fetch('http://127.0.0.1:9')",
      "await Bun.secrets.get({ service: 'schway', name: 'probe' })",
      `await (await import('node:fs/promises')).readFile(${JSON.stringify(config)})`,
      `await import(${JSON.stringify(join(repo, "src/tui/app.ts"))})`,
    ]) {
      const result = await run([process.execPath, "--no-env-file", "-e", `try { ${probe} } catch {}`], cwd, env);
      expect(result.exitCode).toBe(90);
      expect(result.stderr).toContain("Forbidden version side effect:");
    }
  });
});

test("the launcher and relative symlink chain preserve version output outside Git", async () => {
  await withTempDir(async root => {
    const bin = join(repo, "bin/schway");
    const first = join(root, "first"), second = join(root, "schway");
    await symlink(bin, first);
    await symlink("first", second);
    const before = (await readdir(root)).sort();
    for (const executable of [bin, second]) for (const flag of ["--version", "-V"]) {
      expect(await run([executable, flag], root, buildIsolatedCliEnv(root, { HOME: undefined }))).toEqual({
        stdout: `schway ${version}\n`, stderr: "", exitCode: 0,
      });
    }
    expect((await readdir(root)).sort()).toEqual(before);
  });
});

test("doctor JSON retains its existing package version and schema", async () => {
  await withTempDir(async cwd => {
    const result = await run([process.execPath, "--no-env-file", entry, "doctor", "--json", "--provider", "openai-compatible", "--base-url", "http://127.0.0.1:9/v1", "--auth", "none"],
      cwd, buildIsolatedCliEnv(cwd, { PATH: "", BUN_OPTIONS: `--preload ${join(import.meta.dir, "fixtures/credential-store-preload.ts")}` }));
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ version, schemaVersion: 1 });
  });
});

test("bun run dev preserves exact version streams and still exposes application errors", async () => {
  await withTempDir(async home => {
    const env = buildIsolatedCliEnv(home);
    for (const flag of ["--version", "-V"]) {
      expect(await run([process.execPath, "run", "dev", "--", flag], repo, env)).toEqual({
        stdout: `schway ${version}\n`, stderr: "", exitCode: 0,
      });
    }
    const result = await run([process.execPath, "run", "dev", "--", "--version", "--json"], repo, env);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith(`${mixedError}\n`);
    expect(result.stderr).not.toContain("$ bun");
    expect(await readdir(home)).toEqual([]);
  });
});
