import { expect, test } from "bun:test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli/main.ts";
import { formatDoctorHelp, formatHelp } from "../src/cli/help.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const entry = join(repo, "src/cli/main.ts");
const ttyFixture = join(import.meta.dir, "fixtures/cli-tty.py");
const emptyTask = 'Task is empty · Pass -p "<task>" with a task\n';
const needsTerminal = 'Interactive mode needs a terminal · Use -p "<task>" to run a task\n';
const blanks = ["", " ", "\t\r\n", "\u0085", "\u00a0", "\u1680", "\u2000\u2007\u2028\u2029\u202f\u205f", "\u3000", "\ufeff", " \u0085\t\ufeff\n"];
const descriptorPairs = [[false, false], [false, true], [true, false], [true, true]] as const;

/** Capture the embedding boundary without inheriting terminal capabilities. */
async function embedded(args: string[], options: Partial<CliIo> = {}) {
  let stdout = "", stderr = "";
  const exit = await runCli(args, {
    cwd: "/missing-launch-workspace", env: {},
    ...options,
    stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } },
  });
  return { exit, stdout, stderr };
}

/** Drain both subprocess outputs and bound cleanup, including fixture signal handling. */
async function subprocess(command: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let expired = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    expired = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, 12_000);
  try {
    const [[stdout, stderr], exit] = await Promise.all([output, child.exited]);
    if (expired) throw new Error("CLI subprocess exceeded its cleanup deadline");
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

/** Run with actual OS descriptor capabilities and stderr captured independently. */
async function descriptors(command: string[], pair: readonly [boolean, boolean], cwd: string, env: Record<string, string>) {
  const result = await subprocess(["python3", ttyFixture, "--stdin-tty", pair[0] ? "1" : "0",
    "--stdout-tty", pair[1] ? "1" : "0", "--", ...command], cwd, env);
  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { stdout: string; stderr: string; exit: number };
}

/** Snapshot file names and bytes so validation cannot silently repair saved state. */
async function snapshot(root: string) {
  const result: Record<string, string | null> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(item.parentPath, item.name);
    result[path.slice(root.length)] = item.isDirectory() ? null : (await readFile(path)).toString("base64");
  }
  return result;
}

test("embedding defaults to nonterminal and validates launch intent before inspecting environment", async () => {
  const env = new Proxy({}, { get() { throw new Error("Launch validation read environment"); } });
  expect(await embedded([], { env })).toEqual({ exit: 1, stdout: "", stderr: needsTerminal });
  for (const [stdin, stdout] of descriptorPairs.slice(0, 3)) {
    for (const args of [[], ["--resume", "saved"], ["--debug", "--json"]]) {
      expect(await embedded(args, { env, terminal: { stdin, stdout } }))
        .toEqual({ exit: 1, stdout: "", stderr: needsTerminal });
    }
  }
  for (const prompt of blanks) for (const args of [["-p", prompt], ["-p=" + prompt]]) {
    expect(await embedded(args, { env, terminal: { stdin: true, stdout: true } }))
      .toEqual({ exit: 1, stdout: "", stderr: emptyTask });
  }
});

test("valid Thai and multiline tasks preserve exact submitted content in both prompt syntaxes", async () => {
  await withTempDir(async root => {
    for (const prompt of ["ตรวจงานนี้", " \tตรวจงานนี้\nอธิบายภาษาไทย\r\n \t", "\u0085hello\ufeff", "\u200b"]) {
      for (const args of [["-p", prompt], ["-p=" + prompt]]) {
        let submitted: unknown;
        const model = createScriptedModel({ responses: [request => {
          submitted = request.items.findLast(item => item.type === "user")?.content;
          return { text: "done" };
        }] });
        const result = await embedded([...args, "--json"], { cwd: root, env: { HOME: root }, model });
        expect(result.exit, result.stderr).toBe(0);
        expect(submitted).toEqual([{ type: "text", text: prompt }]);
        expect(JSON.parse(result.stdout.split("\n")[0]!)).toMatchObject({ type: "session.ready" });
      }
    }
  });
});

test("help keeps precedence and doctor rejects even empty prompts by presence", async () => {
  for (const args of [["--help"], ["--help", "-p", ""], ["-p=\u0085", "-h"]]) {
    expect(await embedded(args)).toEqual({ exit: 0, stdout: formatHelp(), stderr: "" });
  }
  for (const args of [["doctor", "--help"], ["doctor", "-h"]]) {
    expect(await embedded(args)).toEqual({ exit: 0, stdout: formatDoctorHelp(), stderr: "" });
  }
  for (const prompt of ["", "\u0085", "task"]) for (const args of [["-p", prompt], ["-p=" + prompt]]) {
    for (const help of [[], ["--help"]]) {
      expect(await embedded(["doctor", ...args, ...help])).toEqual({
        exit: 2, stdout: "",
        stderr: "Invalid doctor options. Doctor does not accept prompts or session resume.\nRun 'schway doctor --help' for usage.\n",
      });
    }
  }
});

test("rejected real CLI launches cannot inspect setup, import a renderer/provider, or mutate saved work", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), cwd = join(root, "work");
    await mkdir(join(home, ".schway/sessions"), { recursive: true });
    await mkdir(join(home, ".schway/drafts"), { recursive: true });
    await mkdir(join(cwd, ".schway/extensions"), { recursive: true });
    await Bun.write(join(home, ".schway/config.json"), "{ malformed");
    await Bun.write(join(cwd, ".schway/config.json"), "{ malformed");
    await Bun.write(join(home, ".schway/sessions/saved.jsonl"), '{"version":4}\n{"unfinished":');
    await Bun.write(join(home, ".schway/drafts/saved.json"), '{"incomplete":');
    await Bun.write(join(home, ".schway/drafts/saved.lock"), "existing lock");
    await Bun.write(join(cwd, ".env"), "SCHWAY_LAUNCH_ENV=loaded\n");
    await Bun.write(join(cwd, ".schway/extensions/hostile.ts"), "process.exit(91);");
    const preload = join(root, "launch-preload.ts");
    await Bun.write(preload, `
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as childProcess from "node:child_process";
const deny = operation => () => { console.error("Forbidden launch side effect: " + operation); process.exit(90); };
if (process.env.SCHWAY_LAUNCH_ENV) deny("automatic env file loading")();
const block = (module, names) => ({ ...module, ...Object.fromEntries(names.map(name => [name, deny(name)])) });
mock.module("node:fs/promises", () => block(promises, ["access", "readFile", "writeFile", "readdir", "realpath", "stat", "lstat", "mkdir", "open", "rm", "rename", "unlink"]));
mock.module("node:fs", () => block(fs, ["accessSync", "readFileSync", "writeFileSync", "readdirSync", "realpathSync", "statSync", "lstatSync", "mkdirSync", "openSync", "createReadStream", "createWriteStream"]));
mock.module("node:child_process", () => block(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]));
globalThis.fetch = deny("fetch");
const file = Bun.file;
Bun.file = (path, ...args) => typeof path === "number" && path >= 0 && path <= 2 ? file(path, ...args) : deny("Bun.file")();
for (const name of ["write", "spawn", "spawnSync", "connect", "listen"]) Bun[name] = deny("Bun." + name);
Object.defineProperty(Bun, "secrets", { value: Object.fromEntries(["get", "set", "delete"].map(name => [name, deny("credentials." + name)])) });
await Bun.plugin({ name: "launch-import-guard", setup(builder) {
  builder.onLoad({ filter: /(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/ }, deny("provider or TUI import"));
} });
`);
    const env = buildIsolatedCliEnv(home, { BUN_OPTIONS: `--preload ${preload}`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", FORCE_COLOR: "1" });
    const before = await snapshot(root);
    const extras = ["--json", "--resume", "saved", "--debug-file", "debug.jsonl",
      "--env-file", ".env", "--extension", "./.schway/extensions/hostile.ts"];
    for (const prompt of blanks) for (const args of [["-p", prompt], ["-p=" + prompt]]) {
      const result = await subprocess([process.execPath, "--no-env-file", entry, ...args, ...extras], cwd, env);
      expect(result, JSON.stringify(args)).toEqual({ exit: 1, stdout: "", stderr: emptyTask });
      expect(result.stdout + result.stderr).not.toContain("\x1b");
    }
    for (const args of [[], ["--resume", "saved"], ["--debug-file", "debug.jsonl"], ["--env-file", ".env"]]) {
      expect(await subprocess([process.execPath, "--no-env-file", entry, ...args], cwd, env))
        .toEqual({ exit: 1, stdout: "", stderr: needsTerminal });
    }
    for (const args of [["--help"], ["--help", "-p", ""], ["doctor", "--help"], ["--version"], ["doctor", "-p="]]) {
      const result = await subprocess([process.execPath, "--no-env-file", entry, ...args], cwd, { ...env, HOME: "" });
      expect(result.exit, result.stderr).toBe(args.includes("-p=") ? 2 : 0);
      expect(result.stdout + result.stderr).not.toContain("\x1b");
    }
    expect(await snapshot(root)).toEqual(before);
    // Calibrate every prohibited boundary: caught exceptions must not hide a hit.
    for (const probe of [
      "await fetch('http://127.0.0.1:9')",
      "await Bun.secrets.get({ service: 'schway', name: 'probe' })",
      "await (await import('node:fs/promises')).readFile('config.json')",
      `await import(${JSON.stringify(join(repo, "src/tui/app.ts"))})`,
      `await import(${JSON.stringify(join(repo, "src/model/providers/openai.ts"))})`,
    ]) {
      const result = await subprocess([process.execPath, "--no-env-file", "-e", `try { ${probe} } catch {}`], cwd, env);
      expect(result.exit).toBe(90);
      expect(result.stderr).toContain("Forbidden launch side effect:");
    }
  });
}, 30_000);

test("real mixed terminal descriptors guard only ordinary launches and preserve headless JSONL", async () => {
  if (process.platform === "win32" || !Bun.which("python3")) return;
  await withTempDir(async root => {
    const home = join(root, "home"), cwd = join(root, "work"), preload = join(root, "model-preload.ts");
    await mkdir(home); await mkdir(cwd);
    await Bun.write(preload, `
import { mock } from "bun:test";
mock.module(${JSON.stringify(join(repo, "src/tui/app.ts"))}, () => ({
  runInteractiveTui: async io => { io.stdout.write("interactive\\n"); io.stderr.write("stderr captured\\n"); return 0; },
}));
const store = await import(${JSON.stringify(join(repo, "src/auth/store.ts"))});
mock.module(${JSON.stringify(join(repo, "src/auth/store.ts"))}, () => ({ ...store,
  createNativeCredentialStore: () => ({ get: async () => null, set: async () => {}, delete: async () => {} }),
}));
mock.module(${JSON.stringify(join(repo, "src/model/loader.ts"))}, () => ({
  bindGrokModel: model => model, isGrokModel: () => false,
  loadProviderModel: async input => {
    let turn = 0;
    return { provider: input.provider, id: input.model, async *stream(request) {
      if (process.env.LAUNCH_ASK && turn++ === 0) {
        yield { type: "message_complete", message: { type: "assistant", id: "write-fixture", content: [
          { type: "tool_call", id: "write", name: "write", arguments: { path: "must-not-exist", content: "changed" } },
        ] } };
        return;
      }
      const text = request.items.findLast(item => item.type === "user").content[0].text;
      yield { type: "text_delta", text };
      yield { type: "message_complete", message: { type: "assistant", id: "echo-fixture", content: [{ type: "text", text }] } };
    } };
  },
}));
globalThis.fetch = () => { throw new Error("Unexpected network access"); };
`);
    const env = buildIsolatedCliEnv(home, { BUN_OPTIONS: `--preload ${preload}`,
      OPENAI_API_KEY: "fixture-key", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
    for (const pair of descriptorPairs) {
      for (const args of [[], ["--resume", "saved"]]) {
        expect(await descriptors([process.execPath, "--no-env-file", entry, ...args], pair, cwd, env))
          .toEqual(pair.every(Boolean) ? { exit: 0, stdout: "interactive\n", stderr: "stderr captured\n" }
            : { exit: 1, stdout: "", stderr: needsTerminal });
      }
      for (const prompt of ["", "\u0085"]) {
        expect(await descriptors([process.execPath, "--no-env-file", entry, "-p=" + prompt], pair, cwd, env))
          .toEqual({ exit: 1, stdout: "", stderr: emptyTask });
      }
      const prompt = " \tตรวจงานนี้\nอธิบายภาษาไทย \t\n";
      for (const json of [false, true]) {
        const result = await descriptors([process.execPath, "--no-env-file", entry,
          "--provider", "openai", "--model", "scripted", "-p", prompt, ...(json ? ["--json"] : [])], pair, cwd, env);
        expect(result.exit, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        if (json) {
          const events = result.stdout.trimEnd().split("\n").map(line => JSON.parse(line));
          expect(events[0]).toMatchObject({ type: "session.ready" });
          expect(events.filter(event => event.type === "model.delta" && event.content.type === "text")
            .map(event => event.content.text).join("")).toBe(prompt);
        } else expect(result.stdout).toBe(prompt + "\n");
        expect(result.stdout).not.toContain("\x1b");
      }
      const ask = await descriptors([process.execPath, "--no-env-file", entry, "-p=write it",
        "--model", "scripted", "--approval", "ask", "--json"], pair, cwd, { ...env, LAUNCH_ASK: "1" });
      expect(ask.exit, ask.stderr).toBe(0);
      expect(ask.stdout).toContain('"type":"tool.denied"');
      expect(await Bun.file(join(cwd, "must-not-exist")).exists()).toBe(false);
    }
  });
}, 45_000);

test("descriptor fixture drains large separated streams and reaps a stalled process group", async () => {
  if (process.platform === "win32" || !Bun.which("python3")) return;
  await withTempDir(async root => {
    const env = buildIsolatedCliEnv(root);
    const script = "import os; os.write(1, b'o' * 150000); os.write(2, b'e' * 150000)";
    expect(await descriptors(["python3", "-c", script], [false, true], root, env))
      .toEqual({ exit: 0, stdout: "o".repeat(150000), stderr: "e".repeat(150000) });
    const pidFile = join(root, "pid");
    const stalled = "import os,sys,time; open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)";
    const result = await subprocess(["python3", ttyFixture, "--stdin-tty", "0", "--stdout-tty", "1",
      "--timeout", "0.5", "--", "python3", "-c", stalled, pidFile], root, env);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("descriptor deadline");
    const pid = Number(await Bun.file(pidFile).text());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
