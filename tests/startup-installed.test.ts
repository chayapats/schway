import { expect, test } from "bun:test";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

/** Run the installed command with captured output and a bounded cleanup deadline. */
async function run(argv: string[], cwd: string, env?: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timeout); }
}

test("installed PTY fixture reaps its executable after an outer timeout signal", async () => {
  if (process.platform !== "linux" || !Bun.which("python3")) return;
  await withTempDir(async root => {
    const pidPath = join(root, "installed.pid");
    const script = "import os,sys,time; open(sys.argv[1], 'w').write(str(os.getpid())); print('Type a task', flush=True); time.sleep(30)";
    const fixture = Bun.spawn(["python3", join(resolve(import.meta.dir, ".."), "tests/fixtures/installed-pty.py"),
      "python3", "-c", script, pidPath], { cwd: root, stdout: "pipe", stderr: "pipe" });
    let installedPid: number | undefined;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await Bun.file(pidPath).exists()) {
          installedPid = Number(await Bun.file(pidPath).text());
          break;
        }
        await Bun.sleep(20);
      }
      expect(installedPid).toBeGreaterThan(0);
      process.kill(fixture.pid, "SIGTERM");
      expect(await fixture.exited).not.toBe(0);
      expect(() => process.kill(installedPid!, 0)).toThrow();
    } finally {
      if (fixture.exitCode === null) fixture.kill();
      if (installedPid) { try { process.kill(-installedPid, "SIGKILL"); } catch { /* Already reaped. */ } }
      await fixture.exited;
    }
  });
});

test("packed executable verifies startup, appearance and Linux PTY cleanup with isolated state", async () => {
  await withTempDir(async root => {
    const repo = resolve(import.meta.dir, "..");
    const packed = await run(["npm", "pack", "--silent", "--pack-destination", root], repo);
    expect(packed.exit).toBe(0);
    const archive = join(root, packed.stdout.trim().split("\n").at(-1)!);
    const install = join(root, "install");
    const installed = await run(["npm", "install", "--prefix", install, "--no-audit", "--no-fund", "--silent", archive], root);
    expect(installed.exit).toBe(0);
    const packageRoot = join(install, "node_modules/schway");
    const executable = join(install, "node_modules/.bin/schway");
    const versionHome = join(root, "version-home"), versionWork = join(root, "version-work");
    await mkdir(versionHome); await mkdir(versionWork);
    const metadataPath = join(packageRoot, "package.json");
    const metadataText = await Bun.file(metadataPath).text();
    const metadata = JSON.parse(metadataText);
    try {
      for (const packageVersion of [metadata.version, "2.3.4-rc.5+build.006"]) {
        await Bun.write(metadataPath, JSON.stringify({ ...metadata, version: packageVersion }));
        for (const flag of ["--version", "-V"]) {
          expect(await run([executable, flag], versionWork, buildIsolatedCliEnv(versionHome, { HOME: undefined }))).toEqual({
            stdout: `schway ${packageVersion}\n`, stderr: "", exit: 0,
          });
        }
      }
    } finally { await Bun.write(metadataPath, metadataText); }
    expect(await readdir(versionHome)).toEqual([]);
    expect(await readdir(versionWork)).toEqual([]);
    for (const args of [[], ["--resume", "saved"], ["-p", ""], ["-p=\u0085", "--json", "--debug"]]) {
      expect(await run([executable, ...args], versionWork, buildIsolatedCliEnv(versionHome))).toEqual({
        exit: 1, stdout: "", stderr: args.some(arg => arg.startsWith("-p"))
          ? 'Task is empty · Pass -p "<task>" with a task\n'
          : 'Interactive mode needs a terminal · Use -p "<task>" to run a task\n',
      });
    }
    // Ordinary dispatch may use Bun's transpiler cache; app state stays absent.
    expect((await readdir(versionHome)).filter(name => name !== ".bun")).toEqual([]);
    expect(await readdir(versionWork)).toEqual([]);
    const fixture = join(install, "startup-preload.ts");
    await Bun.write(fixture, `
import { mock } from "bun:test";
import * as core from "@opentui/core";
import * as stateFs from "node:fs/promises";
import { createTestRenderer } from "@opentui/core/testing";
import * as storeModule from "./node_modules/schway/src/auth/store.ts";
import { InteractiveMemory } from "./node_modules/schway/src/config/interactive-memory.ts";
// Only this captured-output renderer fixture simulates interactive descriptors.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
const scenario = process.env.STARTUP_SCENARIO;
const stateReadFile = stateFs.readFile, stateWriteFile = stateFs.writeFile;
let splashWriteStarted = false, splashReadCalls = 0;
if (scenario.startsWith("splash")) mock.module("node:fs/promises", () => ({ ...stateFs,
  readFile: (...args) => {
    if (String(args[0]).endsWith("/.schway/ui-state.json")) {
      splashReadCalls++;
      if (scenario === "splash-read-stalled") return new Promise(() => {});
    }
    return stateReadFile(...args);
  },
  writeFile: (...args) => {
    if (scenario === "splash-stalled" && String(args[0]).includes("/.ui-state-")) { splashWriteStarted = true; return new Promise(() => {}); }
    return stateWriteFile(...args);
  },
}));
const values = new Map();
if (scenario.startsWith("returning")) {
  values.set("api-key:openai", "installed-fixture-key");
  await (await InteractiveMemory.load(process.env.HOME!, process.cwd())).write({ provider: "openai", openaiAuth: "api-key", model: "gpt-5.4" });
}
if (scenario.startsWith("invalid-model")) {
  values.set("codex-subscription:chatgpt", JSON.stringify({ accessToken: "fixture-subscription", expiresAt: Date.now() + 600_000 }));
  values.set("api-key:openai", "must-not-fallback");
}
mock.module("./node_modules/schway/src/auth/store.ts", () => ({ ...storeModule, createNativeCredentialStore: () => ({
  get: async identity => {
    // Returning startup deliberately exceeds the old fixed 80 ms wait.
    if (scenario.startsWith("returning")) await Bun.sleep(150);
    if (scenario === "denied") throw new Error(storeModule.credentialStoreError("read"));
    return values.get(identity.account) ?? null;
  },
  set: async (identity, value) => { values.set(identity.account, value); },
  delete: async identity => values.delete(identity.account),
}) }));
let requests = 0;
let loaderCalls = 0;
let catalogRequests = 0;
mock.module("./node_modules/schway/src/model/loader.ts", () => ({ bindGrokModel: model => model, isGrokModel: () => false, loadProviderModel: async input => {
  loaderCalls++;
  return { provider: input.provider, id: input.model, async *stream() {
    requests++;
    yield { type: "text_delta", text: "fixture complete" };
    yield { type: "message_complete", message: { type: "assistant", id: "fixture-response", content: [{ type: "text", text: "fixture complete" }] } };
  } };
} }));
globalThis.fetch = async (url, init) => {
  if (scenario === "fresh" && String(url) === "https://api.openai.com/v1/models") {
    if (new Headers(init.headers).get("authorization") !== "Bearer installed-fixture-key") throw new Error("Wrong model-list credential");
    return Response.json({ data: [{ id: "gpt-6-astra" }] });
  }
  if (scenario.startsWith("invalid-model") && String(url).includes("/models?")) {
    catalogRequests++;
    if (init.headers.Authorization !== "Bearer fixture-subscription") throw new Error("Wrong catalog route");
    return Response.json({ models: [{ slug: "available-account-model", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] }] });
  }
  throw new Error("Unexpected network in installed startup fixture");
};
const terminal = await createTestRenderer({ width: scenario === "splash-small" ? 40 : 80, height: scenario === "splash-small" ? 12 : 24, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => terminal.renderer }));
const assert = (condition, message) => { if (!condition) throw new Error(message + "\\n" + terminal.captureCharFrame()); };
const settle = async (ready, label) => {
  const deadline = performance.now() + 5000;
  do {
    if (scenario.startsWith("splash")) await terminal.renderOnce();
    else await terminal.flush();
    if (ready()) return;
    await Bun.sleep(10);
  } while (performance.now() < deadline);
  assert(false, "Timed out waiting for " + label);
};
const screenIncludes = text => terminal.captureCharFrame().includes(text);
void (async () => {
  if (scenario.startsWith("splash")) {
    await settle(() => !!terminal.renderer.root.findDescendantById("prompt"), "splash startup");
    const splash = () => terminal.renderer.root.findDescendantById("splash");
    const expected = process.env.SPLASH_EXPECT_FULL === "1";
    assert(!!splash() === expected, "installed splash policy mismatch");
    if (["splash-off", "splash-reduced", "splash-never", "splash-always"].includes(scenario)) assert(splashReadCalls === 0, "gated splash unnecessarily read version state");
    if (scenario === "splash-read-stalled") assert(splashReadCalls === 1, "stalled read fixture was not exercised");
    if (expected) {
      assert(terminal.captureCharFrame().includes("███████╗"), "full splash never painted");
      if (process.env.SPLASH_SKIP === "key") await terminal.mockInput.typeText("x");
      else if (process.env.SPLASH_SKIP === "paste") await terminal.mockInput.pasteBracketedText("hello");
      else if (process.env.SPLASH_SKIP === "click") await terminal.mockMouse.click(2, 2);
      await settle(() => !splash(), "full splash removal");
      if (scenario === "splash-stalled") {
        await settle(() => splashWriteStarted, "stalled splash write");
        let restored = false;
        const destroy = terminal.renderer.destroy.bind(terminal.renderer);
        terminal.renderer.destroy = () => { restored = true; return destroy(); };
        terminal.mockInput.pressKey("c", { ctrl: true });
        const deadline = performance.now() + 1000;
        while (!restored && performance.now() < deadline) await Bun.sleep(10);
        assert(restored, "splash storage blocked terminal restoration");
        await Bun.write(process.env.STARTUP_RESULT!, JSON.stringify({ full: true, requests, restored }));
        return;
      }
      await settle(() => require("node:fs").existsSync(process.env.HOME + "/.schway/ui-state.json"), "recorded splash state");
    }
    assert(requests === 0, "splash caused inference");
    await Bun.write(process.env.STARTUP_RESULT!, JSON.stringify({ full: expected, requests }));
    terminal.mockInput.pressKey("c", { ctrl: true });
    return;
  }
  const startupAction = scenario.startsWith("returning") ? "Type a task · Enter sends"
    : scenario === "denied" ? "Unlock credential storage"
    : scenario.startsWith("invalid-model") ? "Choose a model" : "Connect a provider";
  await settle(() => terminal.renderer.root.findDescendantById("prompt")?.focused && screenIncludes(startupAction), "startup readiness");
  const editor = terminal.renderer.root.findDescendantById("prompt");
  const initial = terminal.captureCharFrame();
  assert(initial.includes(process.cwd().split("/").at(-1)), "workspace missing");
  assert(!initial.includes("Session ready.") && !initial.includes("Interactive memory:"), "recurring transcript guidance");
  if (scenario.startsWith("returning")) {
    assert(initial.includes("gpt-5.4") && initial.includes("Type a task"), "remembered readiness missing");
    assert(!initial.includes("Connect to get started"), "redundant setup");
    if (scenario.startsWith("returning-appearance")) {
      const expected = scenario.endsWith("-env") ? "#f7f7f4" : "#0e1117";
      const canvas = terminal.renderer.root.findDescendantById("conversation");
      assert(canvas.backgroundColor.equals(core.RGBA.fromHex(expected)), "installed appearance or environment precedence wrong");
      terminal.mockInput.pressKey("p", { meta: true });
      await settle(() => screenIncludes("Preferences"), "installed appearance preferences");
      terminal.mockInput.pressTab();
      for (let index = 0; index < 3; index++) terminal.mockInput.pressArrow("down");
      await settle(() => screenIncludes("› Appearance"), "installed appearance row");
      assert(screenIncludes("All workspaces") && screenIncludes("Saved here: dark"), "saved appearance hidden");
      assert(screenIncludes(scenario.endsWith("-env") ? "Effective now: light" : "Effective now: dark"), "effective appearance hidden");
      terminal.mockInput.pressEscape();
      await settle(() => editor.focused && !screenIncludes("Preferences"), "appearance panel return");
    }
  } else if (scenario === "denied" || scenario.startsWith("invalid-model")) {
    assert(initial.includes(scenario === "denied" ? "Unlock credential storage" : "Choose a model"), "repair action missing");
    if (scenario.startsWith("invalid-model")) assert(initial.includes("Selected model is not available in this account."), "selected model explanation missing");
    terminal.mockInput.pressKey("i", { ctrl: true });
    await settle(() => terminal.captureCharFrame().replace(/\\s+/g, " ").includes(scenario === "denied" ? "secure store" : "not available in this ChatGPT account"), "failure details");
    assert(terminal.captureCharFrame().replace(/\\s+/g, " ").includes(scenario === "denied" ? "secure store" : "not available in this ChatGPT account"), "actual failure unavailable");
  } else {
    assert(initial.includes("Not connected") && initial.includes("Connect a provider"), "fresh connect action missing");
    assert(!initial.includes("gpt-"), "fresh install named a model");
    const draft = "ตรวจงานนี้\\nอธิบายภาษาไทย";
    await terminal.mockInput.pasteBracketedText(draft);
    terminal.mockInput.pressArrow("left");
    const cursor = editor.cursorOffset;
    terminal.mockInput.pressKey("l", { meta: true });
    await settle(() => screenIncludes("Subscription"), "sign-in choices");
    assert(terminal.captureCharFrame().includes("Subscription"), "keyboard connect unavailable");
    terminal.mockInput.pressEscape();
    await settle(() => editor.focused && editor.plainText === draft && editor.cursorOffset === cursor && !screenIncludes("Subscription"), "cancelled setup");
    assert(editor.plainText === draft && editor.cursorOffset === cursor, "cancel lost draft/cursor");
    terminal.mockInput.pressKey("l", { meta: true });
    await settle(() => screenIncludes("Subscription"), "reopened sign-in choices");
    while (!/^\\s*› OpenAI\\s*$/m.test(terminal.captureCharFrame())) { terminal.mockInput.pressArrow("down"); await terminal.flush(); }
    terminal.mockInput.pressEnter();
    await settle(() => screenIncludes("Enter saves · Esc cancels"), "credential entry");
    await terminal.mockInput.pasteBracketedText("installed-fixture-key");
    terminal.mockInput.pressEnter();
    await settle(() => loaderCalls === 1 && editor.focused && screenIncludes("Ready"), "connection activation");
    assert(editor.plainText === draft && editor.cursorOffset === cursor, "activation lost draft/cursor");
    assert(requests === 0, "setup submitted task");
    terminal.resize(44, 18);
    await settle(() => terminal.renderer.width === 44 && editor.focused && screenIncludes("Ready"), "resized task editor");
    terminal.mockInput.pressEnter();
    await settle(() => requests === 1 && screenIncludes("fixture complete"), "explicit task completion");
    assert(requests === 1, "explicit send did not produce exactly one request");
  }
  if (scenario.startsWith("invalid-model")) {
    assert(catalogRequests === 1 && loaderCalls === 0, "explicit account model bypassed catalog validation or fell back");
  }
  assert(requests === (scenario === "fresh" ? 1 : 0), "unexpected inference");
  await Bun.write(process.env.STARTUP_RESULT!, JSON.stringify({ initial, requests }));
  terminal.mockInput.pressKey("c", { ctrl: true });
})().catch(error => { console.error(error); process.exit(2); });
`);
    // The shipped shell executable still dispatches main.ts. Only the Bun launcher
    // gains a preload for isolated storage/adapter/terminal fixtures in this child.
    const launchers = join(root, "launchers");
    await mkdir(launchers);
    const launcher = join(launchers, "bun");
    await Bun.write(launcher, `#!/bin/bash\nexec ${shell(process.execPath)} --preload ${shell(fixture)} "$@"\n`);
    await chmod(launcher, 0o755);
    for (const scenario of ["fresh", "returning", "returning-appearance", "returning-appearance-env", "denied", "invalid-model", "invalid-model-config"]) {
      const home = join(root, `home-${scenario}`), work = join(root, `workspace-${scenario}`), result = join(root, `${scenario}.json`);
      await mkdir(home); await mkdir(work);
      const env = buildIsolatedCliEnv(home, { PATH: `${launchers}:${process.env.PATH}`, STARTUP_SCENARIO: scenario, STARTUP_RESULT: result,
        ...(scenario.endsWith("-env") ? { SCHWAY_THEME: "light" } : {}),
      });
      if (scenario.startsWith("returning-appearance")) {
        await mkdir(join(home, ".schway"), { recursive: true });
        await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ appearance: "dark" }));
      }
      if (scenario === "invalid-model-config") await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ provider: "openai", openaiAuth: "codex", model: "invalid-explicit-model" }));
      const args = scenario === "invalid-model" ? ["--provider", "openai", "--openai-auth", "codex", "--model", "invalid-explicit-model"]
        : scenario === "denied" ? ["--provider", "openai", "--model", "gpt-5.4"] : [];
      const output = await run([executable, ...args], work, env);
      expect(output.stderr).toMatch(/^(?:Latest completed draft checkpoint saved\.\n)?(?:Resume: schway --resume [a-f0-9-]+\n)?$/);
      expect(output.exit).toBe(0);
      expect((await Bun.file(result).json()).requests).toBe(scenario === "fresh" ? 1 : 0);
      const sessions = join(home, ".schway/sessions");
      const sessionFiles = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith(".jsonl"));
      let users = 0;
      for (const file of sessionFiles) users += (await Bun.file(join(sessions, file)).text()).split("\n").filter(line => { try { return JSON.parse(line).entries?.some((entry: { item?: { type?: string } }) => entry.item?.type === "user"); } catch { return false; } }).length;
      expect(users).toBe(scenario === "fresh" ? 1 : 0);
    }
    const splashHome = join(root, "splash-home"), splashWork = join(root, "splash-work");
    await mkdir(splashHome); await mkdir(splashWork);
    const splashState = join(splashHome, ".schway/ui-state.json");
    const installedVersion = (await Bun.file(join(packageRoot, "package.json")).json()).version;
    for (const [index, full] of [true, false, true].entries()) {
      if (index === 2) await Bun.write(splashState, JSON.stringify({ splashSeenVersion: "older-version" }));
      const result = join(root, `splash-${index}.json`);
      const output = await run([executable], splashWork, buildIsolatedCliEnv(splashHome, {
        PATH: `${launchers}:${process.env.PATH}`, STARTUP_SCENARIO: "splash", STARTUP_RESULT: result,
        SCHWAY_MOTION: "full", SPLASH_EXPECT_FULL: full ? "1" : "0", SPLASH_SKIP: index === 2 ? "key" : "time",
      }));
      if (output.exit !== 0) throw new Error(output.stderr || output.stdout);
      expect(await Bun.file(result).json()).toEqual({ full, requests: 0 });
      expect(await Bun.file(splashState).json()).toEqual({ splashSeenVersion: installedVersion });
    }
    for (const scenario of ["splash-off", "splash-reduced", "splash-small", "splash-never", "splash-always", "splash-paste", "splash-click", "splash-stalled", "splash-read-stalled"]) {
      const home = join(root, scenario), result = join(root, `${scenario}.json`);
      await mkdir(home);
      if (scenario === "splash-never" || scenario === "splash-always") await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ ui: { splash: scenario === "splash-never" ? "never" : "always" } }));
      const full = ["splash-always", "splash-paste", "splash-click", "splash-stalled", "splash-read-stalled"].includes(scenario);
      const output = await run([executable], splashWork, buildIsolatedCliEnv(home, {
        PATH: `${launchers}:${process.env.PATH}`, STARTUP_SCENARIO: scenario, STARTUP_RESULT: result,
        SCHWAY_MOTION: scenario === "splash-off" ? "off" : scenario === "splash-reduced" ? "reduced" : "full", SPLASH_EXPECT_FULL: full ? "1" : "0", SPLASH_SKIP: scenario.slice(7),
      }));
      if (output.exit !== 0) throw new Error(output.stderr || output.stdout);
      expect(await Bun.file(result).json()).toEqual({ full, requests: 0, ...(scenario === "splash-stalled" ? { restored: true } : {}) });
      const state = Bun.file(join(home, ".schway/ui-state.json"));
      expect(await state.exists()).toBe(full && scenario !== "splash-stalled");
      if (full && scenario !== "splash-stalled") expect(await state.json()).toEqual({ splashSeenVersion: installedVersion });
    }
    if (process.platform === "linux" && Bun.which("python3")) {
      const ptyPreload = join(install, "pty-preload.ts");
      await Bun.write(ptyPreload, `
import { mock } from "bun:test";
import * as storeModule from "./node_modules/schway/src/auth/store.ts";
mock.module("./node_modules/schway/src/auth/store.ts", () => ({ ...storeModule, createNativeCredentialStore: () => ({
  get: async () => null, set: async () => {}, delete: async () => {},
}) }));
mock.module("./node_modules/schway/src/model/loader.ts", () => ({ bindGrokModel: model => model, isGrokModel: () => false, loadProviderModel: async input => ({
  provider: input.provider, id: input.model,
  async *stream() {
    const text = "Answer: ไทย 中文 👩‍💻 é";
    yield { type: "text_delta", text };
    yield { type: "message_complete", message: { type: "assistant", id: "installed-pty-response", content: [{ type: "text", text }] } };
  },
}) }));
`);
      const ptyLaunchers = join(root, "pty-launchers");
      await mkdir(ptyLaunchers);
      const ptyLauncher = join(ptyLaunchers, "bun");
      await Bun.write(ptyLauncher, `#!/bin/bash\nexec ${shell(process.execPath)} --preload ${shell(ptyPreload)} "$@"\n`);
      await chmod(ptyLauncher, 0o755);
      const ptyHome = join(root, "pty-home"), ptyWork = join(root, "pty-work");
      await mkdir(ptyHome); await mkdir(ptyWork);
      const pty = await run(["python3", join(repo, "tests/fixtures/installed-pty.py"), executable, "--provider", "openai", "--model", "offline-demo"],
        ptyWork, buildIsolatedCliEnv(ptyHome, { PATH: `${ptyLaunchers}:${process.env.PATH}`, OPENAI_API_KEY: "fixture-key", NO_COLOR: "1" }));
      if (pty.exit !== 0) throw new Error(pty.stderr || pty.stdout);
      expect(pty.exit).toBe(0);
      const result = JSON.parse(pty.stdout) as Record<string, unknown>;
      expect(result).toMatchObject({ exit: 0, thai: true, cjk: true, emoji: true, combining: true,
        alternate_enter: true, alternate_exit: true, answer: true, draft_input: true, narrow_recovery: true });
    }
    const plainHome = join(root, "plain-home"), plainWork = join(root, "plain-work");
    await mkdir(plainHome); await mkdir(plainWork);
    // These probes exercise interactive setup failures before renderer creation.
    // Give them explicit capabilities without changing the real installed PTY above.
    const setupPreload = join(root, "setup-terminal-preload.ts");
    await Bun.write(setupPreload, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\nObject.defineProperty(process.stdout, "isTTY", { value: true });\n');
    const setupEnv = (home: string, overrides: Record<string, string | undefined> = {}) =>
      buildIsolatedCliEnv(home, { BUN_OPTIONS: `--preload ${setupPreload}`, ...overrides });
    for (const [args, expected] of [[["--profile", "missing-profile"], /profile/i], [[], /HOME is not set/]] as const) {
      const env = setupEnv(plainHome, args.length === 0 ? { HOME: undefined } : {});
      const result = await run([executable, ...args], plainWork, env);
      expect(result.exit).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(expected);
      expect(result.stderr).not.toContain("\x1b");
    }
    await Bun.write(join(plainHome, ".schway/config.json"), "{ invalid");
    const broken = await run([executable], plainWork, setupEnv(plainHome));
    expect(broken.exit).toBe(1);
    expect(broken.stderr).toContain("config");
    const blockedHome = join(root, "blocked-home");
    await Bun.write(join(blockedHome, ".schway/sessions"), "not a directory");
    const blocked = await run([executable], plainWork, setupEnv(blockedHome));
    expect(blocked.exit).toBe(1);
    expect(blocked.stderr).toContain("session storage");
    expect(await Bun.file(join(packageRoot, "docs/tui.md")).exists()).toBe(true);
  });
}, 120_000);

/** Quote a filesystem path as one literal POSIX-shell argument. */
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
