import { mock } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import * as fs from "node:fs";
import { join } from "node:path";
import { createScriptedModel } from "../helpers/scripted-model.ts";
import { fakeCredentialStore } from "../helpers/credential-store.ts";

const [home, mode, resume] = process.argv.slice(2) as [string, string, string | undefined];
const abort = new AbortController();
let stopped = false, destroyed = false;
const event = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const wait = async (condition: () => boolean) => {
  const until = Date.now() + 5000;
  while (!condition()) { if (Date.now() > until) throw Error("fixture condition timed out"); await Bun.sleep(10); }
};
if (["failure", "permission", "blocked-exit", "flush-rejection"].includes(mode)) {
  process.env.SCHWAY_DRAFT_FIXTURE = mode;
  process.env.SCHWAY_DRAFT_FIXTURE_MARKER = join(home, "exit-worker-state");
  const actual = await import("../../src/drafts/exit.ts");
  const flush = actual.flushDraftOnExit;
  mock.module(join(import.meta.dir, "../../src/drafts/exit.ts"), () => ({ ...actual,
    flushDraftOnExit: (input: Parameters<typeof actual.flushDraftOnExit>[0]) => mode === "flush-rejection" ? Promise.reject(Error("fixture flush rejection")) : flush(input, join(import.meta.dir, "draft-exit-worker.ts")),
  }));
}
if (["failure", "permission"].includes(mode)) {
  const write = fs.writeFileSync, open = fs.openSync;
  const temporaryDescriptors = new Set<number>();
  mock.module("node:fs", () => ({ ...fs, openSync: ((...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (typeof args[0] === "string" && /\.json\.[a-f0-9-]+\.tmp$/.test(args[0])) temporaryDescriptors.add(fd);
    return fd;
  }), writeFileSync: ((...args: Parameters<typeof write>) => {
    if (typeof args[0] === "number" && temporaryDescriptors.has(args[0])) throw Object.assign(Error("disk failure fixture"), { code: mode === "permission" ? "EACCES" : "ENOSPC" });
    return write(...args);
  }) }));
}
if (mode === "tool") {
  const actual = await import("../../src/tools/bash.ts");
  mock.module(join(import.meta.dir, "../../src/tools/bash.ts"), () => ({ ...actual, bashTool: { ...actual.bashTool, async execute(_input: unknown, context: { signal?: AbortSignal }) {
    fs.writeFileSync(join(home, "tool-effect"), "effect survives cancellation");
    event({ toolStarted: true });
    context.signal?.addEventListener("abort", () => event({ cancellationRequested: true }), { once: true });
    setTimeout(() => abort.abort(), 10);
    return await new Promise<never>(() => {});
  } } }));
}
const credential = await import("../../src/tui/credential-input.ts");
const core = await credential.loadCredentialSafeTui();
let driver: Promise<void> | undefined;
mock.module(join(import.meta.dir, "../../src/tui/credential-input.ts"), () => ({ ...credential, loadCredentialSafeTui: async () => ({ ...core, createCliRenderer: async (options: { exitOnCtrlC: boolean; exitSignals: NodeJS.Signals[] }) => {
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true, ...options });
  const stop = terminal.renderer.stop.bind(terminal.renderer), destroy = terminal.renderer.destroy.bind(terminal.renderer);
  terminal.renderer.stop = () => { stopped = true; return stop(); };
  terminal.renderer.destroy = () => { destroyed = true; return destroy(); };
  driver = (async () => {
    await wait(() => !!terminal.renderer.root.findDescendantById("prompt"));
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    if (mode === "reopen") {
      await terminal.renderOnce();
      event({ recovered: editor.plainText, frame: terminal.captureCharFrame() }); abort.abort(); return;
    }
    await terminal.mockInput.pasteBracketedText(mode === "tool" ? "run silent tool" : "unfinished Thai ภาษาไทย\nsecond line");
    if (mode === "tool") { terminal.mockInput.pressEnter(); return; }
    if (mode === "exit" || mode === "blocked-exit" || mode === "flush-rejection") { abort.abort(); return; }
    if (["failure", "permission"].includes(mode)) {
      await Bun.sleep(650); await terminal.renderOnce();
      event({ retained: editor.plainText, frame: terminal.captureCharFrame() }); abort.abort(); return;
    }
    await wait(() => {
      try { return fs.readdirSync(join(home, ".schway/drafts")).some(name => name.endsWith(".json")); } catch { return false; }
    });
    const ids = fs.readdirSync(join(home, ".schway/sessions")).filter(name => name.endsWith(".jsonl"));
    event({ checkpoint: ids[0]!.slice(0, -6) });
  })();
  driver.catch(error => { event({ error: String(error) }); abort.abort(); });
  return terminal.renderer;
} }) }));
const { runInteractiveTui } = await import("../../src/tui/app.ts");
let stderr = "";
const model = mode === "tool" ? createScriptedModel({ toolCalls: [{ id: "silent-tool", name: "bash", arguments: { command: "fixture" } }] }) : createScriptedModel({ text: "must not be sent" });
const code = await runInteractiveTui({ cwd: home, env: { HOME: home, SCHWAY_MOTION: "off" }, args: { json: false, help: false, ...(resume ? { resume } : {}) }, model, signal: abort.signal, credentialStore: fakeCredentialStore(), stdout: { write() {} }, stderr: { write(text) { stderr += text; } } });
await driver;
event({ code, stopped, destroyed, stderr });
if (mode === "tool") setInterval(() => {}, 1000);
