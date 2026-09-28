import { fg, type TextChunk } from "@opentui/core";
import type { MotionMode } from "./motion-policy.ts";
import { mixColor } from "./theme.ts";

export type { MotionMode } from "./motion-policy.ts";

/** Braille spinner frames shown while an operation is active. */
export const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Return the active-work glyph: an 80ms spinner unless motion is off, which shows a static dot. */
export function spinnerFrame(now: number, motion: MotionMode): string {
  return motion === "off" ? "●" : SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length]!;
}

/** Cubic ease-out for panels and fades that should settle gently. */
export function easeOut(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return 1 - (1 - k) ** 3;
}

/** Quadratic ease-in-out for sweeps that accelerate then settle. */
export function easeInOut(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
}

/** Progress of an animation that started at `start`, clamped to 0..1. */
export function progress(now: number, start: number, durationMs: number): number {
  return Math.min(1, Math.max(0, (now - start) / durationMs));
}

/** Color a label with a moving highlight band in full motion; other modes return one plain chunk. */
export function shimmer(text: string, now: number, base: string, highlight: string, motion: MotionMode): TextChunk[] {
  if (motion !== "full" || !text) return [fg(base)(text)];
  const chars = [...text];
  const sweep = ((now / 45) % (chars.length + 14)) - 7;
  return chars.map((char, index) => fg(mixColor(base, highlight, Math.exp(-((index - sweep) ** 2) / 5)))(char));
}

/** A frame pump that runs only while `active()` reports visible motion, so idle costs nothing. */
export function createTicker(onTick: () => void, active: () => boolean, intervalMs = 33) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    /** Start ticking if motion became active; safe to call on every refresh. */
    ensure() {
      if (timer || !active()) return;
      timer = setInterval(() => {
        if (!active()) { clearInterval(timer); timer = undefined; return; }
        onTick();
      }, intervalMs);
    },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
