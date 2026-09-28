import { expect, test } from "bun:test";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

async function run(argv: string[], cwd: string, env?: Record<string, string>) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timeout); }
}

test("packed executable outside checkout shows fresh/remembered readiness, preserves setup draft, and exits actionably for broken config/storage", async () => {
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
    const fixture = join(install, "startup-preload.ts");
    await Bun.write(fixture, `
import { mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import * as storeModule from "./node_modules/schway/src/auth/store.ts";
import { InteractiveMemory } from "./node_modules/schway/src/config/interactive-memory.ts";
const scenario = process.env.STARTUP_SCENARIO;
const values = new Map();
if (scenario === "returning") {
  values.set("api-key:anthropic", "installed-fixture-key");
  await (await InteractiveMemory.load(process.env.HOME!, process.cwd())).write({ provider: "anthropic", model: "claude-sonnet-4-6" });
}
if (scenario.startsWith("invalid-model")) {
  values.set("codex-subscription:chatgpt", JSON.stringify({ accessToken: "fixture-subscription", expiresAt: Date.now() + 600_000 }));
  values.set("api-key:openai", "must-not-fallback");
}
mock.module("./node_modules/schway/src/auth/store.ts", () => ({ ...storeModule, createNativeCredentialStore: () => ({
  get: async identity => {
    // Returning startup deliberately exceeds the old fixed 80 ms wait.
    if (scenario === "returning") await Bun.sleep(150);
    if (scenario === "denied") throw new Error(storeModule.credentialStoreError("read"));
    return values.get(identity.account) ?? null;
  },
  set: async (identity, value) => { values.set(identity.account, value); },
  delete: async identity => values.delete(identity.account),
}) }));
let requests = 0;
let loaderCalls = 0;
let catalogRequests = 0;
mock.module("./node_modules/schway/src/model/loader.ts", () => ({ loadProviderModel: async input => {
  loaderCalls++;
  return { provider: input.provider, id: input.model, async *stream() {
    requests++;
    yield { type: "text_delta", text: "fixture complete" };
    yield { type: "message_complete", message: { type: "assistant", id: "fixture-response", content: [{ type: "text", text: "fixture complete" }] } };
  } };
} }));
globalThis.fetch = async (url, init) => {
  if (scenario.startsWith("invalid-model") && String(url).includes("/models?")) {
    catalogRequests++;
    if (init.headers.Authorization !== "Bearer fixture-subscription") throw new Error("Wrong catalog route");
    return Response.json({ models: [{ slug: "available-account-model", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] }] });
  }
  throw new Error("Unexpected network in installed startup fixture");
};
const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => terminal.renderer }));
const assert = (condition, message) => { if (!condition) throw new Error(message + "\\n" + terminal.captureCharFrame()); };
const settle = async (ready, label) => {
  const deadline = performance.now() + 5000;
  do {
    await terminal.flush();
    if (ready()) return;
    await Bun.sleep(10);
  } while (performance.now() < deadline);
  assert(false, "Timed out waiting for " + label);
};
const screenIncludes = text => terminal.captureCharFrame().includes(text);
void (async () => {
  const startupAction = scenario === "returning" ? "Type a task"
    : scenario === "denied" ? "Repair connection"
    : scenario.startsWith("invalid-model") ? "Choose an available model" : "Connect to get started";
  await settle(() => terminal.renderer.root.findDescendantById("prompt") && screenIncludes(startupAction), "startup readiness");
  const editor = terminal.renderer.root.findDescendantById("prompt");
  const initial = terminal.captureCharFrame();
  assert(initial.includes(process.cwd().split("/").at(-1)), "workspace missing");
  assert(!initial.includes("Session ready.") && !initial.includes("Interactive memory:"), "recurring transcript guidance");
  if (scenario === "returning") {
    assert(initial.includes("claude-sonnet-4-6") && initial.includes("Type a task"), "remembered readiness missing");
    assert(!initial.includes("Connect to get started"), "redundant setup");
  } else if (scenario === "denied" || scenario.startsWith("invalid-model")) {
    assert(initial.includes(scenario === "denied" ? "Repair connection" : "Choose an available model"), "repair action missing");
    if (scenario.startsWith("invalid-model")) assert(initial.includes("Selected model is not available in this account."), "selected model explanation missing");
    terminal.mockInput.pressKey("i", { ctrl: true });
    await settle(() => terminal.captureCharFrame().replace(/\\s+/g, " ").includes(scenario === "denied" ? "secure store" : "not available in this ChatGPT account"), "failure details");
    assert(terminal.captureCharFrame().replace(/\\s+/g, " ").includes(scenario === "denied" ? "secure store" : "not available in this ChatGPT account"), "actual failure unavailable");
  } else {
    assert(initial.includes("Connect to get started"), "fresh connect action missing");
    const draft = "ตรวจงานนี้\\nอธิบายภาษาไทย";
    await terminal.mockInput.pasteBracketedText(draft);
    terminal.mockInput.pressArrow("left");
    const cursor = editor.cursorOffset;
    terminal.mockInput.pressKey("l", { meta: true });
    await settle(() => screenIncludes("Anthropic API key"), "sign-in choices");
    assert(terminal.captureCharFrame().includes("Anthropic API key"), "keyboard connect unavailable");
    terminal.mockInput.pressEscape();
    await settle(() => editor.focused && editor.plainText === draft && editor.cursorOffset === cursor && !screenIncludes("Sign in ·"), "cancelled setup");
    assert(editor.plainText === draft && editor.cursorOffset === cursor, "cancel lost draft/cursor");
    terminal.mockInput.pressKey("l", { meta: true });
    await settle(() => screenIncludes("Anthropic API key"), "reopened sign-in choices");
    for (let i = 0; i < 4; i++) terminal.mockInput.pressArrow("down");
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
    for (const scenario of ["fresh", "returning", "denied", "invalid-model", "invalid-model-config"]) {
      const home = join(root, `home-${scenario}`), work = join(root, `workspace-${scenario}`), result = join(root, `${scenario}.json`);
      await mkdir(home); await mkdir(work);
      const env = buildIsolatedCliEnv(home, { PATH: `${launchers}:${process.env.PATH}`, STARTUP_SCENARIO: scenario, STARTUP_RESULT: result,
      });
      if (scenario === "invalid-model-config") await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ provider: "openai", openaiAuth: "codex", model: "invalid-explicit-model" }));
      const args = scenario === "invalid-model" ? ["--provider", "openai", "--openai-auth", "codex", "--model", "invalid-explicit-model"] : [];
      const output = await run([executable, ...args], work, env);
      expect(output.stderr).toBe("");
      expect(output.exit).toBe(0);
      expect((await Bun.file(result).json()).requests).toBe(scenario === "fresh" ? 1 : 0);
      const sessions = join(home, ".schway/sessions");
      const sessionFiles = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith(".jsonl"));
      let users = 0;
      for (const file of sessionFiles) users += (await Bun.file(join(sessions, file)).text()).split("\n").filter(line => { try { return JSON.parse(line).entries?.some((entry: { item?: { type?: string } }) => entry.item?.type === "user"); } catch { return false; } }).length;
      expect(users).toBe(scenario === "fresh" ? 1 : 0);
    }
    const plainHome = join(root, "plain-home"), plainWork = join(root, "plain-work");
    await mkdir(plainHome); await mkdir(plainWork);
    for (const [args, expected] of [[["--profile", "missing-profile"], "missing-profile"], [[], "HOME is not set"]] as const) {
      const env = buildIsolatedCliEnv(plainHome, expected === "HOME is not set" ? { HOME: undefined } : {});
      const result = await run([executable, ...args], plainWork, env);
      expect(result.exit).toBe(1);
      expect(result.stderr).toContain(expected);
    }
    await Bun.write(join(plainHome, ".schway/config.json"), "{ invalid");
    const broken = await run([executable], plainWork, buildIsolatedCliEnv(plainHome));
    expect(broken.exit).toBe(1);
    expect(broken.stderr).toContain("config");
    const blockedHome = join(root, "blocked-home");
    await Bun.write(join(blockedHome, ".schway/sessions"), "not a directory");
    const blocked = await run([executable], plainWork, buildIsolatedCliEnv(blockedHome));
    expect(blocked.exit).toBe(1);
    expect(blocked.stderr).toContain("session storage");
    expect(await Bun.file(join(packageRoot, "docs/tui.md")).exists()).toBe(true);
  });
}, 120_000);

function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
