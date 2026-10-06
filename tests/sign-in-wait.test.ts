import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextRenderable } from "@opentui/core";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import type { CodexLoginRunner, GrokLoginRunner } from "../src/tui/controller-types.ts";
import { createConversationView } from "../src/tui/view.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { BROWSER_NOT_OPENED, SIGN_IN_TIMED_OUT, browserNotOpened, codexDeviceApproval, signInTimeout, signInWaitRows } from "../src/tui/sign-in-wait.ts";
import { loginWithBrowserFlow } from "../src/model/providers/codex-subscription.ts";
import { pollDeviceAuthorization, startLoopbackCallback } from "../src/model/providers/grok-subscription.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { parseScreen, type ScreenGolden } from "./screen-catalog/format.ts";
import { SIGN_IN_WAIT_SCREENS } from "./screen-catalog/screens.ts";

const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Resolve on abort so a scripted sign-in waits exactly like a real one. */
const aborted = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
/** Count the words of a status: the text before its first ` · `. */
const statusWords = (text: string) => text.split(" · ")[0]!.trim().split(/\s+/).length;

function controllerWith(credentials: Partial<NonNullable<TuiControllerOptions["credentials"]>>, overrides: Partial<TuiControllerOptions> = {}) {
  const store = credentials.store ?? fakeCredentialStore();
  const controller = new TuiController({ session: createSession(), sessionId: "sign-in-wait", workspace, provider: "openai", modelId: "", contextManager: createContextManager(workspace),
    credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), ...credentials }, ...overrides });
  cleanups.push(() => controller.dispose());
  return { controller, store };
}

/** Render a real conversation view over a controller with reduced motion and a fixed animation clock. */
async function render(controller: TuiController, width = 80, height = 30) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], motion: "reduced", now: () => 1_000,
    quit: () => {}, openUrl: async () => {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, async command => command.name === "login" ? controller.login(command.args) : false, accepted) });
  cleanups.push(() => { view.destroy(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  await settle();
  const hints = () => (terminal.renderer.root.findDescendantById("hints") as TextRenderable).plainText;
  return { ...terminal, view, settle, hints, rows: () => terminal.captureCharFrame().split("\n").map(line => line.trimEnd()) };
}

/** Real provider timeout messages; these are the CLI-facing strings the TUI maps to short copy. */
async function providerTimeouts() {
  const codex = await loginWithBrowserFlow({ store: fakeCredentialStore(), timeoutMs: 20, deps: { openBrowser: () => {},
    waitForCallbackCode: ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) } }).catch((error: Error) => error.message);
  const listener = startLoopbackCallback({ expectedState: "state", signal: new AbortController().signal, timeoutMs: 10 });
  const grokBrowser = await listener.code.catch((error: Error) => error.message);
  listener.close();
  const grokDevice = await pollDeviceAuthorization({ verificationUri: "https://x.ai/device", deviceCode: "device", userCode: "ABCD-EFGH", expiresIn: 0, interval: 1,
    fetch: async () => { throw new Error("no network in fixtures"); } }).catch((error: Error) => error.message);
  return { codex: String(codex), grokBrowser: String(grokBrowser), grokDevice: String(grokDevice) };
}

test("provider timeout messages used outside the TUI stay unchanged", async () => {
  expect(await providerTimeouts()).toEqual({
    codex: "ChatGPT sign-in timed out waiting for the browser callback. If you already approved in the browser, paste the redirect with /login codex --code <callback-url-or-code>; otherwise retry /login codex, or use /login codex --device on headless machines.",
    grokBrowser: "Grok sign-in timed out waiting for browser approval. Retry /login grok.",
    grokDevice: "Grok device sign-in timed out waiting for approval. Restart /login grok --device.",
  });
});

test("wait rows put the heading first, the address step before the code step, and a glyph status last", () => {
  expect(signInWaitRows({ provider: "Grok" }, "Open x.ai/device and enter ABCD-EFGH", { kind: "device", verificationUri: "https://x.ai/device/", userCode: "ABCD-EFGH" }).map(row => row.text))
    .toEqual(["Sign in to Grok", "1 Open x.ai/device", "2 Enter ABCD-EFGH", "◌ Waiting for approval"]);
  expect(signInWaitRows({ provider: "ChatGPT" }, "Approve in your browser").map(row => row.text)).toEqual(["Sign in to ChatGPT", "Approve in your browser", "◌ Waiting for approval"]);
  expect(signInWaitRows({ provider: "ChatGPT" }, "Starting device approval").map(row => row.text)).toEqual(["Sign in to ChatGPT", "◌ Starting device approval"]);
  expect(signInWaitRows({ provider: "Grok", saving: true }, "Approve in your browser", { kind: "browser" }).map(row => row.text)).toEqual(["Sign in to Grok", "◌ Saving sign-in"]);
  expect(codexDeviceApproval("Enter this code at https://auth.openai.com/codex/device: ABCD-1234")).toEqual({ kind: "device", verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  expect(codexDeviceApproval("Open this URL to sign in with ChatGPT: https://auth.openai.com/oauth")).toBeUndefined();
  expect(browserNotOpened("The browser could not be opened automatically. Open https://accounts.x.ai/authorize?x=1")).toEqual({ link: "https://accounts.x.ai/authorize?x=1" });
  expect(browserNotOpened("The browser could not be opened automatically; use the printed URL instead.")).toEqual({});
  expect(signInTimeout("Grok sign-in was denied. Retry /login grok.")).toBeUndefined();
  for (const rows of [signInWaitRows({ provider: "Grok" }, "x", { kind: "browser" }), signInWaitRows({ provider: "ChatGPT" }, "Starting device approval")]) expect(rows.some(row => row.text.includes("Esc"))).toBe(false);
});

test("ChatGPT callback timeout shows a short status, keeps the recovery recipe in details and reopens more options", async () => {
  const { codex } = await providerTimeouts();
  const { controller } = controllerWith({ codexLogin: async () => ({ ok: false, message: codex }) });
  expect(await controller.login("codex")).toBe(false);
  const failure = controller.snapshot().transcript.at(-1)!;
  expect(failure).toMatchObject({ kind: "error", text: SIGN_IN_TIMED_OUT });
  expect(SIGN_IN_TIMED_OUT).toBe("Sign-in timed out · Alt+L retry · F2 details");
  expect(statusWords(failure.text)).toBeLessThanOrEqual(6);
  expect(controller.snapshot().transcript.some(entry => /\/login \w+ --/.test(entry.text))).toBe(false);
  const chooser = controller.snapshot().loginChooser!;
  expect(chooser.level).toBe("chatgpt");
  expect(chooser.rows.map(row => row.kind === "choice" ? row.label : "")).toEqual(["Device approval", "Paste browser callback"]);
  expect(controller.inspectNoticeDetails()).toBe(true);
  const details = controller.snapshot().transcript.at(-1)!.text;
  expect(details).toContain("paste the redirect with /login codex --code");
  expect(details).toContain("/login codex --device");
});

for (const device of [false, true]) test(`Grok ${device ? "device" : "browser"} timeout shows the same short status with recovery text in details`, async () => {
  const { grokBrowser, grokDevice } = await providerTimeouts();
  const message = device ? grokDevice : grokBrowser;
  const { controller } = controllerWith({ grokLogin: async ({ onApproval }) => {
    onApproval(device ? { kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" } : { kind: "browser" });
    return { ok: false, message };
  } }, { provider: "xai" });
  expect(await controller.login(device ? "grok --device" : "grok")).toBe(false);
  expect(controller.snapshot().transcript.at(-1)).toMatchObject({ kind: "error", text: SIGN_IN_TIMED_OUT });
  expect(controller.snapshot().transcript.some(entry => entry.text.includes("/login grok"))).toBe(false);
  expect(controller.inspectNoticeDetails()).toBe(true);
  expect(controller.snapshot().transcript.at(-1)!.text).toContain(message);
  expect(controller.snapshot().transcript.some(entry => entry.text.includes("ABCD-EFGH"))).toBe(false);
});

test("Esc while secure storage saves never claims the save was cancelled, then the saved outcome follows", async () => {
  const saving = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const { controller, store } = controllerWith({ codexLogin: async ({ onProgress, onSaving, onSaved }) => {
    onProgress("Approval received. Saving ChatGPT credential in the OS secure store…");
    onSaving?.(); saving.resolve(); await finish.promise;
    await store.set(codexSubscriptionIdentity(), "fixture-token"); onSaved?.();
    return { ok: true, status: "Saved" };
  } });
  const ui = await render(controller);
  const pending = controller.login("codex");
  await saving.promise; await ui.settle();
  expect(controller.snapshot().loginWait).toEqual({ provider: "ChatGPT", saving: true });
  expect(controller.snapshot().transcript.map(entry => entry.text)).toContain("Approval received · Saving sign-in");
  expect(ui.rows().filter(line => line.includes("Esc"))).toEqual([]);
  expect(ui.hints()).toBe("Wait for secure storage");
  ui.mockInput.pressEscape(); await ui.settle();
  const notice = controller.snapshot().transcript.at(-1)!.text;
  expect(notice).toBe("Saving credential · Wait for secure storage");
  expect(statusWords(notice)).toBeLessThanOrEqual(6);
  for (const entry of controller.snapshot().transcript) expect(entry.text).not.toMatch(/Esc|cancelled/);
  finish.resolve();
  expect(await pending).toBe(false);
  expect(controller.snapshot().transcript.at(-1)!.text).toBe("Sign-in cancelled; credential saved · /model choose model");
  expect(await store.get(codexSubscriptionIdentity())).toBe("fixture-token");
});

test("ChatGPT browser wait names its provider before any approval data and Enter neither shows nor changes anything", async () => {
  let calls = 0;
  const { controller } = controllerWith({ codexLogin: async ({ signal }) => { calls++; await aborted(signal); return { ok: false, message: "Cancelled." }; } });
  const ui = await render(controller);
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter(); await ui.settle();
  expect(controller.snapshot().loginApprovalData).toBeUndefined();
  const rows = ui.rows();
  expect(rows.map(line => line.trim())).toContain("Sign in to ChatGPT");
  expect(rows.some(line => line.includes("Complete ChatGPT approval"))).toBe(false);
  // Reduced motion keeps the spinner glyph; the fixed clock pins its frame.
  expect(rows.join("\n")).toContain("⠹ Signing in");
  expect(ui.hints()).toBe("Esc cancel sign-in");
  expect(rows.join("\n")).not.toContain("Enter");
  const frame = ui.captureCharFrame(), before = JSON.stringify(controller.snapshot());
  for (let press = 0; press < 3; press++) { ui.mockInput.pressEnter(); await ui.settle(); }
  expect(ui.captureCharFrame()).toBe(frame);
  expect(JSON.stringify(controller.snapshot())).toBe(before);
  expect(controller.running).toBe(true); expect(calls).toBe(1);
  ui.mockInput.pressEscape(); await controller.waitForIdle(); await ui.settle();
  expect(controller.snapshot().transcript.at(-1)!.text).toBe("Sign-in cancelled; nothing saved · Alt+L retry");
});

for (const provider of ["ChatGPT", "Grok"] as const) test(`${provider} device code stays out of the transcript, details and saved session; Esc cancels without saving`, async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), space = { root, launchCwd: root, extraRoots: [] };
    const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: space });
    const code = "QWER-7788";
    let attempt = 0;
    const wait = async (signal: AbortSignal) => {
      // The first attempt fails with details; the second waits for Esc.
      if (++attempt === 1) return { ok: false as const, message: provider === "Grok" ? "Grok device sign-in timed out waiting for approval. Restart /login grok --device." : "Device sign-in timed out after 900s without approval. Restart /login codex --device for a fresh code." };
      await aborted(signal); return { ok: false as const, message: "Cancelled." };
    };
    const codexLogin: CodexLoginRunner = async ({ signal, onProgress }) => { onProgress(`Enter this code at https://auth.openai.com/codex/device: ${code}`); return wait(signal); };
    const grokLogin: GrokLoginRunner = async ({ signal, onApproval }) => { onApproval({ kind: "device", verificationUri: "https://x.ai/device", userCode: code }); return wait(signal); };
    const { controller, store } = controllerWith({ codexLogin, grokLogin }, { session, sessionId: session.header.id, home, workspace: space, provider: "scripted", modelId: "scripted-model",
      model: createScriptedModel({ responses: [{ text: "Answered after sign-in." }] }), contextManager: createContextManager(space) });
    const command = provider === "Grok" ? "grok --device" : "codex --device";
    expect(await controller.login(command)).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(true);
    // A failed ChatGPT device attempt reopens the chooser; Esc closes it before the next direct command.
    if (controller.snapshot().loginChooser) controller.cancel();
    const ui = await render(controller);
    const running = controller.login(command); await ui.settle();
    const rows = ui.rows().map(line => line.trim());
    expect(rows.indexOf(`1 Open ${provider === "Grok" ? "x.ai/device" : "auth.openai.com/codex/device"}`)).toBeLessThan(rows.indexOf(`2 Enter ${code}`));
    expect(rows.indexOf(`Sign in to ${provider}`)).toBeGreaterThan(-1);
    ui.mockInput.pressEscape();
    expect(await running).toBe(false); await ui.settle();
    expect(controller.snapshot().transcript.at(-1)!.text).toBe(provider === "Grok" ? "Sign-in cancelled · Alt+L retry" : "Sign-in cancelled; nothing saved · Alt+L retry");
    expect(await store.get(provider === "Grok" ? grokSubscriptionIdentity() : codexSubscriptionIdentity())).toBeNull();
    expect(await controller.submit("Continue the task")).toBe(true);
    await controller.waitForIdle();
    expect(JSON.stringify(controller.snapshot().transcript)).not.toContain(code);
    const saved = await readdir(sessionsDirectory(home), { recursive: true });
    const files = await Promise.all(saved.filter(file => file.endsWith(".jsonl")).map(file => readFile(join(sessionsDirectory(home), file), "utf8")));
    expect(files.join("\n")).toContain("Continue the task");
    expect(files.join("\n")).not.toContain(code);
  });
});

test("after a successful sign-in no transcript line keeps a key hint from the wait", async () => {
  for (const device of [false, true]) {
    const { controller } = controllerWith({ codexLogin: async ({ onProgress, onSaving, onSaved }) => {
      if (device) onProgress("Enter this code at https://auth.openai.com/codex/device: ABCD-1234");
      else { onProgress("Open this URL to sign in with ChatGPT: https://auth.openai.com/oauth/authorize?state=fixture"); }
      onProgress("Approval received. Saving ChatGPT credential in the OS secure store…"); onSaving?.(); onSaved?.();
      return { ok: true, status: "ChatGPT subscription (Codex OAuth): fixture" };
    } });
    expect(await controller.login(device ? "codex --device" : "codex")).toBe(true);
    const texts = controller.snapshot().transcript.map(entry => entry.text);
    expect(texts[0]).toBe(device ? "ChatGPT device sign-in started" : "ChatGPT browser sign-in started");
    expect(texts.filter(text => text.includes("Esc"))).toEqual([]);
    expect(controller.snapshot().loginWait).toBeUndefined();
    expect(controller.snapshot().loginApprovalData).toBeUndefined();
  }
});

test("browser launcher failure shows a short status below the link and the chooser names Esc cancel sign-in", async () => {
  for (const provider of ["ChatGPT", "Grok"] as const) {
    const link = provider === "Grok" ? "https://accounts.x.ai/oauth2/authorize?state=fixture" : "https://auth.openai.com/oauth/authorize?state=fixture";
    const { controller } = controllerWith({
      codexLogin: async ({ signal, onProgress }) => { onProgress(`Open this URL to sign in with ChatGPT: ${link}`); onProgress("The browser could not be opened automatically; use the printed URL instead."); await aborted(signal); return { ok: false, message: "Cancelled." }; },
      grokLogin: async ({ signal, onApproval, onProgress }) => { onApproval({ kind: "browser" }); onProgress(`The browser could not be opened automatically. Open ${link}`); await aborted(signal); return { ok: false, message: "Cancelled." }; },
    });
    const ui = await render(controller);
    const running = controller.login(provider === "Grok" ? "grok" : "codex"); await ui.settle();
    const texts = controller.snapshot().transcript.map(entry => entry.text);
    expect(texts.at(-1)).toBe(BROWSER_NOT_OPENED);
    expect(statusWords(BROWSER_NOT_OPENED)).toBeLessThanOrEqual(6);
    expect(texts.at(-2)).toBe(provider === "Grok" ? link : `Open this URL to sign in with ChatGPT: ${link}`);
    expect(texts.some(text => text.includes("printed URL"))).toBe(false);
    expect(controller.snapshot().loginChooser?.level).toBe(provider === "Grok" ? "grok" : "chatgpt");
    expect(ui.hints()).toEndWith("Esc cancel sign-in");
    expect(ui.rows().filter(line => line.includes("Esc"))).toHaveLength(1);
    ui.mockInput.pressEscape();
    expect(await running).toBe(false);
  }
});

/** Read every golden of one catalog screen. */
async function goldens(screen: string): Promise<ScreenGolden[]> {
  const directory = join(import.meta.dir, "screen-catalog/goldens", screen);
  const files = (await readdir(directory)).filter(file => file.endsWith(".golden")).sort();
  return Promise.all(files.map(async file => parseScreen(await readFile(join(directory, file), "utf8"))));
}

test("every sign-in wait golden names Esc once with its real effect and no dead or wrong key", async () => {
  for (const screen of SIGN_IN_WAIT_SCREENS) {
    const variants = await goldens(screen);
    expect(variants.map(golden => golden.variant)).toEqual(expect.arrayContaining(["dark-40", "nocolor-dark-40", "dark-40x8"]));
    for (const golden of variants) {
      const label = `${screen}/${golden.variant}`;
      const text = golden.text.join("\n");
      expect(text.match(/\bEsc\b/g)?.length ?? 0, label).toBe(1);
      for (const phrase of ["Enter confirm", "Esc back", "Esc stop", "Esc stops", "Esc cancels"]) expect(text, label).not.toContain(phrase);
      const last = golden.text.at(-1)!.trim();
      // The hint row shows from 14 rows; below that the compact status bar is the last row.
      if (golden.rows >= 14) expect(last, label).toBe("Esc cancel sign-in");
      else expect(last, label).toMatch(/· Esc cancel$/);
      const heading = screen.startsWith("grok-") ? "Sign in to Grok" : "Sign in to ChatGPT";
      expect(golden.text.map(line => line.trim()), label).toContain(heading);
      if (golden.rows >= 14) expect(text, label).toContain("Signing in");
      expect(text, label).not.toContain("Working");
    }
  }
});

test("device goldens list the address step before the full code step at every width", async () => {
  for (const [screen, address, code] of [["grok-device-approval", "x.ai/device", "ABCD-EFGH"], ["chatgpt-device-approval", "auth.openai.com/codex/device", "ABCD-1234"]] as const) {
    const variants = await goldens(screen);
    expect(variants.map(golden => golden.cols)).toEqual(expect.arrayContaining([120, 80, 50, 40]));
    for (const golden of variants) {
      const rows = golden.text.map(line => line.trim());
      const open = rows.findIndex(line => line.startsWith("1 Open "));
      const enter = rows.indexOf(`2 Enter ${code}`);
      expect(open, `${screen}/${golden.variant}`).toBeGreaterThan(-1);
      expect(enter, `${screen}/${golden.variant}`).toBeGreaterThan(open);
      expect(rows.slice(open, enter).join(""), `${screen}/${golden.variant}`).toBe(`1 Open ${address}`);
      expect(rows.filter(line => line.includes(code)), `${screen}/${golden.variant}`).toEqual([`2 Enter ${code}`]);
    }
  }
});

test("timeout and browser-not-opened goldens keep their short status and a table Esc verb", async () => {
  for (const golden of await goldens("sign-in-timeout")) {
    const text = golden.text.join("\n");
    expect(text.replace(/\s+/g, " ")).toContain("Sign-in timed out");
    expect(text).not.toContain("--code");
    expect(text).not.toContain("--device");
  }
  for (const golden of await goldens("sign-in-browser-not-opened")) {
    const text = golden.text.join("\n");
    expect(text.replace(/\s+/g, " ")).toContain("Browser didn't open");
    expect(text).not.toContain("Esc back");
    expect(text.match(/\bEsc\b/g)?.length ?? 0, golden.variant).toBe(1);
    expect(golden.text.at(-1)!.trim()).toEndWith("Esc cancel sign-in");
  }
});

test("Grok device sign-in shows a starting status, not browser steps, until its code arrives", async () => {
  const code = Promise.withResolvers<void>();
  const { controller } = controllerWith({ grokLogin: async ({ signal, onApproval }) => {
    await code.promise; onApproval({ kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" });
    await aborted(signal); return { ok: false, message: "Cancelled." };
  } }, { provider: "xai" });
  const ui = await render(controller);
  const running = controller.login("grok --device"); await ui.settle();
  expect(ui.rows().map(line => line.trim()).filter(line => line.startsWith("Sign in") || line.startsWith("◌") || line.startsWith("Approve"))).toEqual(["Sign in to Grok", "◌ Starting device approval"]);
  code.resolve(); await Bun.sleep(1); await ui.settle();
  expect(ui.rows().map(line => line.trim())).toContain("2 Enter ABCD-EFGH");
  controller.cancel();
  expect(await running).toBe(false);
});
