import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { STARTUP_RECOVERY_CATEGORIES, startupRecoveryMessage } from "../src/tui/controller-support.ts";
import { RECOVERY_ACTION_LABELS } from "../src/tui/running-hints.ts";
import { withTempDir } from "./helpers.ts";

const KEY = /\b(?:Alt|Ctrl|Shift)\+\S+|\bF\d{1,2}\b|\bEsc\b|\bEnter\b/g;

test("startup recovery messages leave every key to the action row", () => {
  for (const category of STARTUP_RECOVERY_CATEGORIES) expect(startupRecoveryMessage(category).match(KEY), category).toBeNull();
});

test("startup recovery guidance names its next step and offers sign-in with Alt+L", () => {
  const verb = (label: string) => label.split(" ")[1]!;
  expect(startupRecoveryMessage("auth").split(" · ")[1]).toStartWith("Connect ");
  expect(RECOVERY_ACTION_LABELS.connect).toBe("Alt+L sign in");
  expect(startupRecoveryMessage("model").split(" · ")[1]).toStartWith("Choose ");
  expect(verb(RECOVERY_ACTION_LABELS["choose-model"])).toBe("choose");
  // A provider failure has no repair key, so its step points at the details the row offers.
  expect(startupRecoveryMessage("provider").split(" · ")[1]).toEndWith(" details");
  expect(verb(RECOVERY_ACTION_LABELS.details)).toBe("details");
});

test("each startup error row names each key once", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    for (const startupError of ["Missing OpenAI API key. Pass --api-key or set OPENAI_API_KEY.", "The model gpt-old is no longer available", "Provider failed to load"]) {
      const tui = new TuiController({ session: createSession(), model: undefined, contextManager: createContextManager(workspace), workspace,
        provider: "openai", modelId: "gpt-old", sessionId: "startup-copy", startupError });
      const text = tui.snapshot().transcript.findLast(entry => entry.kind === "error")!.text;
      const keys = text.match(KEY) ?? [];
      expect(keys.length, startupError).toBeGreaterThan(0);
      expect(new Set(keys).size, text).toBe(keys.length);
      tui.dispose();
    }
  });
});
