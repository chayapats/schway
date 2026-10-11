import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { grokSubscriptionIdentity } from "../src/auth/store.ts";
import { createContextManager } from "../src/context/manager.ts";
import { bindGrokModel } from "../src/model/loader.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { modelPickerEntries } from "../src/tui/model-picker.ts";
import { createConversationView } from "../src/tui/view.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

for (const [state, modelId, label, diagnostic] of [
  ["failed", "grok-account-only", "grok-account-only", "Grok account catalog returned HTTP 500"],
  ["offline", "grok-4.7", "Grok 4.7", "fetch failed: network offline"],
] as const) for (const width of [50, 80, 120]) test(`${state} Grok discovery keeps ${modelId} marked at ${width} columns without color`, async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-oauth", obtainedAt: 0 }));
    const controller = new TuiController({
      home, workspace, session: createSession(), sessionId: "grok-picker", provider: "xai", modelId,
      model: bindGrokModel(createScriptedModel({ provider: "xai", id: modelId })),
      contextManager: createContextManager(workspace),
      credentials: { store, env: { XAI_API_KEY: "fixture-api-key" }, reload: async () => ({ error: "unused" }),
        listGrokModels: async () => { throw new Error(diagnostic); },
        listRouteModels: async () => [{ id: modelId }],
      },
    });
    const terminal = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, {
      controller, home, workspaceRoot: home, env: { NO_COLOR: "1", SCHWAY_MOTION: "off" },
      secrets: [], quit() {}, submit: async () => {},
    });
    try {
      terminal.mockInput.pressKey("m", { meta: true });
      const deadline = Date.now() + 2_000;
      while (controller.snapshot().modelPicker?.loading && Date.now() < deadline) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.loading).toBe(false);
      view.refresh(); await terminal.flush();
      const frame = terminal.captureCharFrame();
      expect(frame).toContain(`${label} · Grok subscription ✓`);
      expect(frame).toContain("Grok models unavailable");
      expect(frame).toContain("Ctrl+R retry");
      expect(frame).toContain("Esc back");
      expect(frame).not.toContain(diagnostic);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.entries.filter(entry => entry.kind === "model" && entry.authRoute === "grok").map(entry => entry.modelId))
        .toEqual([modelId]);
      expect(picker.entries.filter(entry => entry.active).map(entry => [entry.authRoute, entry.modelId]))
        .toEqual([["grok", modelId]]);
      expect(picker.entries[picker.selectedIndex]).toMatchObject({ authRoute: "grok", modelId, active: true, listUnavailable: true });
      expect(picker.entries.find(entry => entry.authRoute === "api-key" && entry.modelId === modelId)?.active).toBe(false);
    } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
  });
});

test("Grok discovery fallback neither copies an API-key choice nor revives a model from a successfully loaded empty list", () => {
  const access = { providers: {}, profiles: {}, subscription: "Login required", openaiApiKey: "Login required", xaiApiKey: "API key", grok: "Grok" } as const;
  for (const options of [
    { activeRoute: "api-key" as const, grokModelsUnavailable: true },
    { activeRoute: "grok" as const, grokModels: [] },
  ]) {
    const entries = modelPickerEntries("", "xai", "grok-account-only", {}, { access, ...options });
    expect(entries.filter(entry => entry.kind === "model" && entry.authRoute === "grok")).toEqual([]);
  }
});
