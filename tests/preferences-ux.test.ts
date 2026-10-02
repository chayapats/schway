import { expect, test } from "bun:test";
import { preferenceLines } from "../src/tui/preferences-view.ts";
import type { PreferencesSnapshot } from "../src/tui/preferences.ts";

test("basic Thinking uses structured effective value while Advanced retains requested evidence", () => {
  const panel: PreferencesSnapshot = {
    scope: "session", selectedIndex: 0, choiceIndex: 0,
    rows: [{ key: "thinking", label: "Thinking", value: "Requested: high; provider uses medium", effectiveValue: "medium",
      origin: "session", saved: "high", reset: "Reset to inherit", choices: [undefined, "high"] }],
  };
  const basic = preferenceLines(panel, false).join("\n");
  expect(basic).toContain("› Thinking: medium");
  expect(basic).toContain("Effective now: medium");
  expect(basic).not.toContain("Requested:");
  const advanced = preferenceLines({ ...panel, page: "advanced" }, false).join("\n");
  expect(advanced).toContain("› Thinking: Requested: high; provider uses medium");
  expect(advanced).toContain("Saved: high");
});
