import { expect, test } from "bun:test";
import { ScrollBarRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { serializeScreen } from "./screen-catalog/format.ts";
import { synchronizeScrollThumbs } from "../src/tui/scrollbars.ts";

for (const orientation of ["vertical", "horizontal"] as const) test(`scrollbar ${orientation} resize order preserves the same final thumb and scroll position`, async () => {
  const terminal = await createTestRenderer({ width: 40, height: 24 });
  const bar = new ScrollBarRenderable(terminal.renderer, { id: "resize-order", orientation, showArrows: false,
    width: orientation === "vertical" ? 1 : 20, height: orientation === "vertical" ? 20 : 1 });
  terminal.renderer.root.add(bar);
  const onFrame = () => synchronizeScrollThumbs([bar]);
  terminal.renderer.on("frame", onFrame);
  const capture = async () => { await terminal.flush(); return serializeScreen(terminal.captureSpans(), {
    screen: "resize-order", title: "Resize order", description: "Identical geometry has identical scroll affordances.", variant: orientation, cursor: terminal.renderer.getCursorState(),
  }); };
  try {
    bar.scrollSize = 31; bar.viewportSize = 20; bar.scrollPosition = 5;
    const expected = await capture();
    for (const update of [
      () => { bar.viewportSize = 0; bar.scrollSize = 0; bar.viewportSize = 20; bar.scrollSize = 31; },
      () => { bar.viewportSize = 0; bar.scrollSize = 0; bar.scrollSize = 31; bar.viewportSize = 20; },
      () => { bar.scrollSize = 100; bar.viewportSize = 4; bar.viewportSize = 20; bar.scrollSize = 31; },
      () => { bar.viewportSize = 40; bar.scrollSize = 5; bar.scrollSize = 31; bar.viewportSize = 20; },
    ]) {
      update(); bar.scrollPosition = 5;
      expect(bar.scrollSize).toBe(31); expect(bar.viewportSize).toBe(20); expect(bar.scrollPosition).toBe(5);
      expect(await capture()).toBe(expected);
      bar.scrollPosition = 1000;
      expect(bar.scrollPosition).toBe(11);
    }
  } finally { terminal.renderer.off("frame", onFrame); terminal.renderer.destroy(); }
});
