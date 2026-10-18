import type { ScrollBarRenderable } from "@opentui/core";

/** Resynchronizes owned thumbs after layout from public current geometry, independently of installer patches. */
export function synchronizeScrollThumbs(bars: readonly ScrollBarRenderable[]): void {
  for (const bar of bars) {
    if (!bar.isDestroyed && !bar.slider.isDestroyed) bar.slider.viewPortSize = Math.max(1, bar.viewportSize);
  }
}
