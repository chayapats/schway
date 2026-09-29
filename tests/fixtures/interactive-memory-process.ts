// Each invocation runs the real interactive dispatcher and renderer with isolated credentials and transport.
import { mock } from "bun:test";
import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import type { ConversationViewOptions } from "../../src/tui/view.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { join } from "node:path";
import { fakeCredentialStore } from "../helpers/credential-store.ts";
import { createScriptedModel } from "../helpers/scripted-model.ts";
import { credentialIdentity, codexSubscriptionIdentity } from "../../src/auth/store.ts";

const mode = process.argv[2]!;
const workspace = process.argv[3]!;
const home = process.env.HOME!;
const store = fakeCredentialStore();
if (mode !== "missing-key" && mode !== "forget-missing-key") await store.set(credentialIdentity({ provider: "openai" }), "fixture-stored-key");
if (mode.includes("codex") || mode === "missing-model" || mode === "forget-missing-key") await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-fixture", expiresAt: Date.now() + 600_000 }));
let terminal: Awaited<ReturnType<typeof createTestRenderer>>;
let controller: import("../../src/tui/controller.ts").TuiController | undefined;
let submission: Promise<unknown> | undefined;
let selection: Promise<unknown> | undefined;
const viewPath = join(import.meta.dir, "../../src/tui/view.ts");
const originalView = await import(viewPath);
const createView = originalView.createConversationView;
mock.module(viewPath, () => ({ ...originalView, createConversationView: (renderer: CliRenderer, options: ConversationViewOptions) => {
  controller = options.controller;
  const selectModel = controller.selectPickerModel.bind(controller);
  controller.selectPickerModel = () => { const pending = selectModel(); selection = pending; return pending; };
  return createView(renderer, { ...options, submit: (...args: Parameters<typeof options.submit>) => {
    const pending = options.submit(...args);
    submission = pending;
    return pending;
  } });
} }));
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Fixture operation did not settle (${mode})`);
    await Bun.sleep(5);
  }
};
const fixture = join(import.meta.dir, "../../src/tui/credential-input.ts");
const credentialInput = await import(fixture);
const core = await credentialInput.loadCredentialSafeTui();
let inputTask: Promise<void>;
let screen = "";
const requests: unknown[] = [];
mock.module(fixture, () => ({ ...credentialInput, loadCredentialSafeTui: async () => ({ ...core,
  createCliRenderer: async (options: CliRendererConfig) => {
    terminal = await createTestRenderer({ ...options, width: 80, height: 24, kittyKeyboard: true });
    inputTask = (async () => {
      await until(() => !!controller && controller.snapshot().readiness !== "loading" && !!terminal.renderer.root.findDescendantById("prompt"));
      const command = async (text: string) => {
        await terminal.mockInput.pasteBracketedText(text);
        submission = undefined;
        terminal.mockInput.pressEnter();
        await until(() => submission !== undefined);
        await submission;
        await terminal.flush();
      };
      await terminal.flush();
      screen = terminal.captureCharFrame();
      if (mode === "select" || mode === "select-codex") {
        terminal.mockInput.pressKey("m", { meta: true });
        await until(() => !!controller?.snapshot().modelPicker);
        const query = mode === "select-codex" ? "account-model" : "gpt-5.4";
        await terminal.mockInput.typeText(query);
        await until(() => { const picker = controller?.snapshot().modelPicker; return picker?.query === query && !picker.accessLoading && !picker.loading; });
        terminal.mockInput.pressEnter();
        await until(() => selection !== undefined);
        await selection;
        await command(mode === "select-codex" ? "/thinking max" : "/thinking high");
      }
      if (mode.startsWith("forget")) { await command("/model forget"); screen += "\n" + terminal.captureCharFrame(); }
      await command("/config show");
      screen += "\n" + terminal.captureCharFrame();
      terminal.resize(44, 18);
      await terminal.flush();
      screen += "\n" + terminal.captureCharFrame();
      await command("hello");
      terminal.mockInput.pressKey("c", { ctrl: true });
      // Native Ctrl+C must leave teardown to the app's loop, just as in production.
      if (terminal.renderer.isDestroyed) throw new Error("Native Ctrl+C destroyed the renderer before app cleanup");
    })();
    return terminal.renderer;
  },
}) }));
const { runCli } = await import("../../src/cli/main.ts");
const args = mode === "override" ? ["--provider", "openai-compatible", "--base-url", "http://127.0.0.1:1/v1"] : mode === "override-full" ? ["--provider", "openai", "--model", "gpt-4o", "--openai-auth", "api-key"] : [];
const code = await runCli(args, { cwd: workspace, env: { HOME: home, SCHWAY_MOTION: "off" }, credentialStore: store,
  fetch: async (url) => String(url).includes("api.openai.com")
    ? Response.json({ data: [{ id: "gpt-5.4" }, { id: "gpt-4o" }] })
    : Response.json({ models: [{ slug: mode === "missing-model" ? "replacement-model" : "account-model", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }] }),
  createModel: async input => {
    requests.push({ ...input, apiKey: input.apiKey === "fixture-stored-key" ? "stored" : input.apiKey ? "openai" : undefined });
    return createScriptedModel({ provider: input.openaiAuth === "codex" ? "codex-subscription" : input.provider, id: input.model, text: "fixture reply" });
  }, stdout: { write() {} }, stderr: { write(text) { process.stderr.write(text); } },
});
await inputTask!;
console.log(JSON.stringify({ code, requests, screen }));
