import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { buildScreen } from "./screen-catalog/harness.ts";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";

afterEach(() => setSystemTime());

test("resumed review measures final wrapped rows and its scrollbar before capture", async () => {
  const screen = SCREENS.find(screen => screen.id === "resumed-review-git-failed")!;
  const variant = variantsFor(screen).find(variant => variant.id === "nocolor-dark-40")!;
  let frame: string | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
    const ui = await buildScreen(screen, variant);
    try {
      await screen.drive(ui);
      await ui.waitFor(snapshot => screen.ready(snapshot, ui));
      await ui.settle();
      const text = ui.renderer.root.findDescendantById("change-review-text") as TextRenderable;
      const scroll = ui.renderer.root.findDescendantById("change-review-diff") as ScrollBoxRenderable;
      expect(text.height).toBe(text.virtualLineCount);
      expect(scroll.verticalScrollBar.scrollSize).toBe(scroll.content.height);
      expect(scroll.verticalScrollBar.viewportSize).toBe(scroll.viewport.height);
      expect(scroll.verticalScrollBar.visible).toBe(scroll.content.height > scroll.viewport.height);
      if (frame !== undefined) expect(ui.captureCharFrame()).toBe(frame);
      frame = ui.captureCharFrame();
    } finally { await ui.dispose(); }
  }
});

test("concurrent resumed review fixtures release their own status reads", async () => {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const screen = SCREENS.find(screen => screen.id === "resumed-review-git-failed")!;
  const variants = variantsFor(screen).filter(variant => variant.cols === 40).slice(0, 2);
  const spawn = Bun.spawn;
  const fixtures = await Promise.all(variants.map(variant => buildScreen(screen, variant)));
  try {
    await Promise.all(fixtures.map(async ui => {
      await screen.drive(ui);
      await ui.waitFor(snapshot => screen.ready(snapshot, ui));
      await ui.settle();
      expect(ui.captureCharFrame()).toContain("Current changes unavailable");
      expect(ui.captureCharFrame()).not.toContain("Loading current changes");
    }));
    expect(Bun.spawn).toBe(spawn);
  } finally { await Promise.all(fixtures.map(ui => ui.dispose())); }
});

test("a disposed palette stops readiness checks before they read the editor", async () => {
  const screen = SCREENS.find(screen => screen.id === "command-palette-exact")!;
  const variant = variantsFor(screen).find(variant => variant.id === "nocolor-dark-50")!;
  const ui = await buildScreen(screen, variant);
  await ui.dispose();
  let polls = 0;
  await expect(ui.waitFor(snapshot => { polls++; return screen.ready(snapshot, ui); })).rejects.toThrow("disposed");
  expect(polls).toBe(0);
});
