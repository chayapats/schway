import { mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlSession, sessionsDirectory, loadJsonlSession } from "../../src/session/jsonl.ts";
import { resolveWorkspace } from "../../src/workspace/workspace.ts";
import { fakeCredentialStore } from "./credential-store.ts";
import { runInteractiveTui } from "../../src/tui/app.ts";
import { InteractiveMemory } from "../../src/config/interactive-memory.ts";
import type { CliArgs } from "../../src/cli/args.ts";

const home = process.argv[2]!;
const scenario = process.argv[3]!;
const root = join(home, "workspace"), other = join(home, "elsewhere");
await mkdir(root); await mkdir(other);
const workspace = await resolveWorkspace(root);
const directory = sessionsDirectory(home);
const old = await createJsonlSession({ directory, workspace });
old.append({ type: "user", id: "old-user", content: [{ type: "text", text: "Continue the local task" }] });
old.append({ type: "assistant", id: "old-answer", content: [{ type: "text", text: "Saved local answer" }] });
const branch = old.forkBranch("old-answer", "side task");
await Bun.sleep(3);
const foreign = await createJsonlSession({ directory, workspace: await resolveWorkspace(other) });
foreign.append({ type: "user", id: "foreign-user", content: [{ type: "text", text: "Other workspace task" }] });
await createJsonlSession({ directory, workspace });
const originalCount = (await readdir(directory)).filter(name => name.endsWith(".jsonl")).length;
let requests = 0;
const loaded: Array<{ provider: string; model?: string }> = [];
const args: CliArgs = { json: false, help: false, provider: "openai", model: "current-model", openaiAuth: "api-key", apiKey: "fixture-private-key" };
if (scenario === "preferences") {
  await (await InteractiveMemory.load(home, root)).write({ provider: "openai", model: "old-subscription-model", openaiAuth: "codex" });
  await mkdir(join(root, ".schway"));
  await writeFile(join(root, ".schway/config.json"), JSON.stringify({ provider: "openai", model: "current-model", openaiAuth: "api-key" }));
  delete args.provider; delete args.model; delete args.openaiAuth;
}
if (["explicit", "repair", "preferences"].includes(scenario)) { args.resume = old.header.id; args.branch = branch; }
if (scenario === "repair") delete args.apiKey;
let errors = "";
let terminal = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true });
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => terminal.renderer }));
const store = fakeCredentialStore();
const start = (launchArgs: CliArgs) => runInteractiveTui({ cwd: root, env: { HOME: home }, args: launchArgs,
  credentialStore: store, stdout: { write() {} }, stderr: { write(text) { errors += text; } },
  createModel: async input => { loaded.push({ provider: input.provider, model: input.model }); return { provider: input.provider, id: input.model ?? "fixture", async *stream() {
    requests++;
    yield { type: "message_complete" as const, message: { type: "assistant" as const, id: crypto.randomUUID(), content: [{ type: "text" as const, text: "New task answer" }] } };
  } }; },
});
const assert = (ok: unknown, why: string) => { if (!ok) throw new Error(`${why}\n${terminal.captureCharFrame()}\n${errors}`); };
const frame = () => terminal.captureCharFrame();
const wait = async (ready: () => boolean, label: string) => {
  for (let n = 0; n < 500; n++) { await terminal.flush(); if (ready()) return; await Bun.sleep(10); }
  assert(false, label);
};
const count = async () => (await readdir(directory)).filter(name => name.endsWith(".jsonl")).length;
const app = start(args);
try {
  await wait(() => !!terminal.renderer.root.findDescendantById("prompt") && frame().includes(scenario === "repair" ? "Needs attention" : "Ready"), "startup");
  const editor = terminal.renderer.root.findDescendantById("prompt") as core.TextareaRenderable;
  if (["explicit", "repair", "preferences"].includes(scenario)) {
    await wait(() => frame().includes("Restored workspace:"), "restored identity");
    assert(!frame().includes("Alt+B"), "explicit destination must suppress recent offer");
    assert(frame().includes(branch), "explicit branch visible");
    assert(frame().includes("current-model") && frame().includes("OpenAI API key"), "effective explicit connection visible");
    assert(frame().includes("Saved local answer"), "history restored");
    assert(requests === 0, "resume must not replay");
    if (scenario === "repair") {
      terminal.mockInput.pressKey("l", { meta: true });
      await wait(() => frame().includes("Sign in"), "repair chooser");
      for (let i = 0; i < 3; i++) terminal.mockInput.pressArrow("down");
      terminal.mockInput.pressEnter();
      await wait(() => frame().includes("Enter saves"), "credential entry");
      await terminal.mockInput.pasteBracketedText("fixture-private-key");
      terminal.mockInput.pressEnter();
      await wait(() => frame().includes("Ready") && !frame().includes("Needs attention"), "auth repaired");
      assert(requests === 0, "repair never sends a task");
    }
  } else {
    await wait(() => frame().includes("Alt+B resume: Continue the local task"), "current workspace meaningful offer");
    assert(!frame().includes("Saved local answer") && !frame().includes("Other workspace task"), "new context only");
    assert(await count() === originalCount, "startup creates no empty session");
    await terminal.mockInput.pasteBracketedText("งานใหม่\nkeep this separate");
    terminal.resize(48, 24);
    await wait(() => frame().includes("Alt+B"), "narrow recent action");
    for (let i = 0; i < 3; i++) {
      terminal.mockInput.pressKey("s", { meta: true });
      await wait(() => frame().includes("↑↓"), "navigation");
      terminal.mockInput.pressEscape();
      await wait(() => editor.plainText.includes("keep this separate"), "draft restored");
    }
    assert(await count() === originalCount, "navigation creates no empty sessions");
    if (scenario === "missing" || scenario === "corrupt") {
      const path = join(directory, `${old.header.id}.jsonl`);
      if (scenario === "missing") await rm(path);
      else await writeFile(path, "broken history\n");
      terminal.mockInput.pressKey("b", { meta: true });
      await wait(() => frame().includes("recoverable history"), "recoverable failure");
      assert(editor.plainText.includes("keep this separate"), "failed resume retains new draft");
    } else if (scenario === "resume") {
      terminal.mockInput.pressKey("b", { meta: true });
      await wait(() => frame().includes("Restored workspace:"), "one-action restore");
      assert(editor.plainText === "", "new draft not copied into restored conversation");
      await terminal.mockInput.pasteBracketedText("old session draft");
      editor.setText("/new"); terminal.mockInput.pressEnter();
      await wait(() => frame().includes("New session."), "fresh task action");
      assert(editor.plainText === "", "old session draft not pasted into new task");
      assert(await count() === originalCount, "new navigation is not persisted empty");
    }
    if (scenario !== "resume") {
      terminal.mockInput.pressEnter();
      await wait(() => requests === 1 && frame().includes("New task answer"), "new send");
      const files = (await readdir(directory)).filter(name => name.endsWith(".jsonl") && ![old.header.id, foreign.header.id].some(id => name === `${id}.jsonl`));
      let found = false;
      for (const file of files) {
        const saved = await loadJsonlSession({ directory, id: file.slice(0, -6) });
        if (saved.items.some(item => item.type === "user")) {
          assert(saved.items.filter(item => item.type === "user").length === 1, "new send has no old context"); found = true;
        }
      }
      assert(found, "new task durable");
    }
  }
  terminal.mockInput.pressKey("d", { ctrl: true });
  assert(await app === 0, "clean close");
  if (scenario === "new") {
    terminal = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true });
    const reopened = start(args);
    await wait(() => frame().includes("Alt+B resume:") && frame().includes("keep this separate"), "reopen latest new work");
    assert(!frame().includes("New task answer"), "reopen remains new conversation");
    const editor = terminal.renderer.root.findDescendantById("prompt") as core.TextareaRenderable;
    assert(editor.plainText === "", "reopen new editor empty");
    terminal.mockInput.pressKey("d", { ctrl: true });
    assert(await reopened === 0, "reopen close");
  }
  assert(!frame().includes("fixture-private-key"), "credentials redacted");
  console.log("RECENT_STARTUP_OK", scenario, JSON.stringify({ requests, loaded }));
} catch (error) { console.error(error); process.exit(1); }
