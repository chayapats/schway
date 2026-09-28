// Each invocation runs the real interactive dispatcher and renderer with isolated credentials and transport.
import { mock } from "bun:test";
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
if (mode.includes("codex") || mode === "missing-model") await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-fixture", expiresAt: Date.now() + 600_000 }));
await store.set(credentialIdentity({ provider: "anthropic" }), "fixture-anthropic-key");
const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
const fixture = join(import.meta.dir, "../../src/tui/credential-input.ts");
const credentialInput = await import(fixture);
const core = await credentialInput.loadCredentialSafeTui();
let inputTask: Promise<void>;
let screen = "";
const requests: unknown[] = [];
mock.module(fixture, () => ({ ...credentialInput, loadCredentialSafeTui: async () => ({ ...core,
  createCliRenderer: async () => {
    inputTask = (async () => {
      await Bun.sleep(30);
      const command = async (text: string) => {
        await terminal.mockInput.pasteBracketedText(text);
        terminal.mockInput.pressEnter();
        await Bun.sleep(60);
        await terminal.flush();
      };
      await terminal.flush();
      screen = terminal.captureCharFrame();
      if (mode === "select" || mode === "select-codex") {
        terminal.mockInput.pressKey("m", { meta: true });
        await Bun.sleep(40);
        await terminal.mockInput.typeText(mode === "select-codex" ? "account-model" : "gpt-5.4");
        await Bun.sleep(20);
        terminal.mockInput.pressEnter();
        await Bun.sleep(80);
        await command(mode === "select-codex" ? "/thinking max" : "/thinking high");
      }
      if (mode.startsWith("forget")) { await command("/model forget"); screen += "\n" + terminal.captureCharFrame(); }
      await command("/config");
      screen += "\n" + terminal.captureCharFrame();
      terminal.resize(44, 18);
      await terminal.flush();
      screen += "\n" + terminal.captureCharFrame();
      await command("hello");
      terminal.mockInput.pressKey("c", { ctrl: true });
    })();
    return terminal.renderer;
  },
}) }));
const { runCli } = await import("../../src/cli/main.ts");
const args = mode === "override" ? ["--provider", "anthropic"] : [];
const code = await runCli(args, { cwd: workspace, env: { HOME: home }, credentialStore: store,
  fetch: async () => Response.json({ models: [{ slug: mode === "missing-model" ? "replacement-model" : "account-model", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "max" }] }] }),
  createModel: async input => {
    requests.push({ ...input, apiKey: input.apiKey === "fixture-stored-key" ? "stored" : input.apiKey ? "anthropic" : undefined });
    return createScriptedModel({ provider: input.openaiAuth === "codex" ? "codex-subscription" : input.provider, id: input.model, text: "fixture reply" });
  }, stdout: { write() {} }, stderr: { write(text) { process.stderr.write(text); } },
});
await inputTask!;
console.log(JSON.stringify({ code, requests, screen }));
