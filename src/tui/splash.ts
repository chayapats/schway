import { Renderable, RGBA, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { easeInOut } from "./motion.ts";
import type { TuiTheme } from "./theme.ts";

type RGB = [number, number, number];

/** Total splash length; every phase below fits inside it. */
export const SPLASH_DURATION_MS = 2000;

/** Phase boundaries in milliseconds from splash start. */
const T = { boltStart: 140, boltEnd: 620, flashEnd: 800, holdEnd: 1450, exitEnd: 1800, end: SPLASH_DURATION_MS };

/** Line typed beneath the logo after the lightning return stroke. */
export const SPLASH_TAGLINE = "lean · light · fast · hackable";

const LETTERS: readonly (readonly string[])[] = [
  ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  ["██╗    ██╗", "██║    ██║", "██║ █╗ ██║", "██║███╗██║", "╚███╔███╔╝", " ╚══╝╚══╝ "],
  [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
];

/** The SCHWAY wordmark in the ANSI Shadow block style, one grapheme per cell. */
export const SPLASH_LOGO: readonly (readonly string[])[] = Array.from({ length: 6 }, (_, row) =>
  [...LETTERS.map(letter => letter[row]!.padEnd(letter[0]!.length)).join("")]);
const LW = SPLASH_LOGO[0]!.length;
const LH = SPLASH_LOGO.length;

/** Smallest terminal that shows the full wordmark with margins; smaller terminals skip the splash. */
export const SPLASH_MIN_SIZE = { width: LW + 6, height: 16 } as const;

/** Where the closing spark lands: the lightning mark in the top bar. */
export const SPLASH_HANDOFF = { x: 1, y: 0 } as const;

interface Cell { x: number; y: number; char: string }
interface Spark { x: number; y: number; vx: number; vy: number; born: number; life: number }

/** Precomputed randomness for one splash, so a seed always renders identical frames. */
export interface SplashScene {
  path: readonly Cell[];
  branches: readonly { at: number; cells: readonly Cell[] }[];
  sparks: readonly Spark[];
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const headX = (t: number) => -12 + (LW + 24) * easeInOut((t - T.boltStart) / (T.boltEnd - T.boltStart));

function headAt(path: readonly Cell[], x: number): Cell | undefined {
  let best: Cell | undefined;
  for (const cell of path) { if (cell.x > x) break; best = cell; }
  return best;
}

/** Build the stepped-leader channel, its forks, and the spark schedule from a seed. */
export function createSplashScene(seed: number): SplashScene {
  const rand = random(seed);
  const path: Cell[] = [];
  let y = 2.5 + (rand() - 0.5);
  let previous = Math.round(y);
  for (let x = -12; x <= LW + 12; x++) {
    if (rand() < 0.6) y = Math.min(LH - 0.4, Math.max(-0.6, y + (rand() - 0.5) * 3.4));
    const next = Math.round(y);
    if (next === previous) path.push({ x, y: next, char: "━" });
    else {
      const direction = Math.sign(next - previous);
      for (let row = previous + direction; row !== next + direction; row += direction) path.push({ x, y: row, char: direction > 0 ? "╲" : "╱" });
    }
    previous = next;
  }
  const branches = Array.from({ length: 5 }, () => {
    const at = Math.floor((0.15 + rand() * 0.75) * path.length);
    const direction = rand() < 0.5 ? -1 : 1;
    const cells: Cell[] = [];
    let bx = path[at]!.x, by = path[at]!.y;
    for (let step = 0, steps = 2 + Math.floor(rand() * 4); step < steps; step++) {
      by += direction; bx += rand() < 0.7 ? 1 : 0;
      cells.push({ x: bx, y: by, char: direction > 0 ? "╲" : "╱" });
    }
    return { at, cells };
  });
  const sparks = Array.from({ length: 22 }, (_, index) => {
    const born = T.boltStart + ((index + rand()) / 22) * (T.boltEnd - T.boltStart);
    const origin = headAt(path, headX(born)) ?? { x: -12, y: LH / 2 };
    return { x: origin.x, y: origin.y, vx: (rand() - 0.2) * 45, vy: (rand() - 0.65) * 26, born, life: 220 + rand() * 320 };
  });
  return { path, branches, sparks };
}

/** One frame of splash cells; `covered` marks cells that hide the UI beneath. */
export class SplashCanvas {
  chars: string[] = [];
  fg = new Float32Array(0);
  bg = new Float32Array(0);
  bold = new Uint8Array(0);
  covered = new Uint8Array(0);
  width = 0;
  height = 0;

  /** Reset every cell to a blank covering cell of the given background. */
  reset(width: number, height: number, background: RGB) {
    const count = width * height;
    if (width !== this.width || height !== this.height) {
      this.width = width; this.height = height;
      this.fg = new Float32Array(count * 3); this.bg = new Float32Array(count * 3);
      this.bold = new Uint8Array(count); this.covered = new Uint8Array(count);
    }
    this.chars = new Array(count).fill(" ");
    for (let index = 0; index < count; index++) { this.setRgb(this.bg, index, background); this.setRgb(this.fg, index, background); }
    this.bold.fill(0); this.covered.fill(1);
  }
  private setRgb(target: Float32Array, index: number, color: RGB) { target[index * 3] = color[0]; target[index * 3 + 1] = color[1]; target[index * 3 + 2] = color[2]; }
  private index(x: number, y: number) {
    const cx = Math.round(x), cy = Math.round(y);
    return cx < 0 || cy < 0 || cx >= this.width || cy >= this.height ? -1 : cy * this.width + cx;
  }
  put(x: number, y: number, char: string, fg: RGB, bg?: RGB, bold = false) {
    const index = this.index(x, y);
    if (index < 0) return;
    this.chars[index] = char; this.setRgb(this.fg, index, fg);
    if (bg) this.setRgb(this.bg, index, bg);
    this.bold[index] = bold ? 1 : 0;
  }
  paint(x: number, y: number, bg: RGB) { const index = this.index(x, y); if (index >= 0) this.setRgb(this.bg, index, bg); }
  bgAt(x: number, y: number): RGB {
    const index = this.index(Math.min(this.width - 1, Math.max(0, x)), Math.min(this.height - 1, Math.max(0, y)));
    return index < 0 ? [0, 0, 0] : [this.bg[index * 3]!, this.bg[index * 3 + 1]!, this.bg[index * 3 + 2]!];
  }
  uncover(x: number, y: number) { const index = this.index(x, y); if (index >= 0) this.covered[index] = 0; }
  text(x: number, y: number, text: string, fg: RGB) { let cx = x; for (const char of text) this.put(cx++, y, char, fg); }
}

const rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};
const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };

/** Paint the splash at `t` ms: ghost logo, lightning ignition, flash, shimmer, CRT collapse, spark handoff, radial reveal. */
export function renderSplashFrame(canvas: SplashCanvas, scene: SplashScene, t: number, width: number, height: number, theme: TuiTheme, version = ""): void {
  const P = {
    bg: rgb(theme.background), glow: rgb(theme.glow), flash: rgb(theme.flash), core: rgb(theme.core), cyan: rgb(theme.cyan),
    accent: rgb(theme.accent), violet: rgb(theme.violet), spark: rgb(theme.bolt), ember: mix(rgb(theme.bolt), rgb(theme.error), 0.6), muted: rgb(theme.muted),
  };
  canvas.reset(width, height, P.bg);
  const gradient = (k: number): RGB => { const u = Math.min(1, Math.max(0, k)); return u < 0.5 ? mix(P.cyan, P.accent, u * 2) : mix(P.accent, P.violet, (u - 0.5) * 2); };
  const ox = Math.floor((width - LW) / 2);
  const oy = Math.max(2, Math.floor((height - LH) / 2) - 2);
  const hx = headX(t);
  const boltActive = t >= T.boltStart && t < T.boltEnd;
  const flash = t >= T.boltEnd && t < T.flashEnd ? 1 - (t - T.boltEnd) / (T.flashEnd - T.boltEnd) : 0;
  const head = headAt(scene.path, hx) ?? { x: hx, y: LH / 2 };
  // A column ignites when the leader reaches it; its heat decays toward the gradient.
  const litAt = (lx: number) => {
    if (t < T.boltStart) return undefined;
    const reached = T.boltStart + inverseHead(lx) * (T.boltEnd - T.boltStart);
    return reached <= t ? reached : undefined;
  };

  if (flash > 0) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) canvas.paint(x, y, mix(P.bg, P.flash, flash));
  if (boltActive) for (let dy = -6; dy <= 6; dy++) for (let dx = -16; dx <= 16; dx++) {
    const x = ox + Math.round(head.x) + dx, y = oy + Math.round(head.y) + dy;
    canvas.paint(x, y, mix(canvas.bgAt(x, y), P.glow, 0.55 * Math.exp(-(dx ** 2 + (dy * 2.1) ** 2) / 40)));
  }

  const logoCell = (lx: number, ly: number): { char: string; fg: RGB } | undefined => {
    const char = SPLASH_LOGO[ly]![lx]!;
    if (char === " ") return undefined;
    const face = char === "█";
    const base = gradient(lx / (LW - 1) + ly * 0.015);
    const lit = litAt(lx);
    let color = lit === undefined ? mix(P.bg, base, face ? 0.16 : 0.09) : mix(base, P.core, Math.exp(-(t - lit) / 190));
    if (flash > 0) color = mix(color, P.core, flash * 0.85);
    if (boltActive) color = mix(color, P.core, 0.9 * Math.exp(-((lx - head.x) ** 2 + ((ly - head.y) * 2) ** 2) / 18));
    if (t >= T.flashEnd && t < T.holdEnd) {
      const band = -14 + (LW + 28) * Math.min(1, (t - T.flashEnd) / 620);
      color = mix(color, P.core, 0.5 * Math.exp(-((lx + ly * 1.3 - band) ** 2) / 6) * (face ? 1 : 0.6));
    }
    if (!face && lit !== undefined) color = mix(P.bg, color, 0.5);
    return { char, fg: color };
  };

  const exit = t >= T.holdEnd ? Math.min(1, (t - T.holdEnd) / (T.exitEnd - T.holdEnd)) : 0;
  const cy = oy + (LH - 1) / 2, cx = ox + (LW - 1) / 2;
  if (t < T.holdEnd) {
    for (let ly = 0; ly < LH; ly++) for (let lx = 0; lx < LW; lx++) {
      const cell = logoCell(lx, ly);
      if (cell) canvas.put(ox + lx, oy + ly, cell.char, cell.fg);
    }
  } else if (exit < 0.42) {
    // CRT power-off: rows squeeze toward the center line while brightening.
    const q = (exit / 0.42) ** 3;
    const scale = 1 - q * 0.93;
    for (let row = oy - 3; row <= oy + LH + 2; row++) {
      const ly = Math.round((LH - 1) / 2 + (row - cy) / scale);
      if (ly < 0 || ly >= LH) continue;
      for (let lx = 0; lx < LW; lx++) {
        const cell = logoCell(lx, ly);
        if (cell) canvas.put(ox + lx, row, scale < 0.3 ? "━" : cell.char, mix(cell.fg, P.core, q * 0.9), mix(P.bg, P.glow, q * 0.4));
      }
    }
  } else if (exit < 0.72) {
    const q = easeInOut((exit - 0.42) / 0.3);
    const half = (LW / 2) * (1 - q);
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      const edge = 1 - Math.abs(x - cx) / Math.max(1, half);
      canvas.put(x, Math.round(cy), half < 1.5 ? "●" : "━", mix(P.accent, P.core, 0.4 + edge * 0.6), mix(P.bg, P.glow, 0.3 + edge * 0.4));
    }
  } else if (t < T.exitEnd) {
    // The last spark arcs into the top bar's lightning mark.
    const q = easeInOut((exit - 0.72) / 0.28);
    const at = (k: number) => {
      const u = Math.min(1, Math.max(0, k));
      const x1 = cx * 0.35, y1 = -2;
      return { x: (1 - u) ** 2 * cx + 2 * (1 - u) * u * x1 + u * u * SPLASH_HANDOFF.x, y: (1 - u) ** 2 * cy + 2 * (1 - u) * u * y1 + u * u * SPLASH_HANDOFF.y };
    };
    for (let k = 8; k >= 1; k--) { const p = at(q - k * 0.035); canvas.put(p.x, p.y, "·", mix(P.bg, P.spark, 1 - k / 9)); }
    const p = at(q);
    canvas.put(p.x, p.y, "●", P.spark, mix(canvas.bgAt(p.x, p.y), P.glow, 0.5));
  }

  if (t >= T.boltStart && t < T.flashEnd && (boltActive || Math.floor(t / 34) % 3 !== 1)) {
    for (const cell of scene.path) {
      if (cell.x > hx) break;
      const age = hx - cell.x;
      const near = boltActive && age < 3;
      const x = ox + cell.x, y = oy + cell.y;
      canvas.put(x, y, near ? "█" : cell.char, flash > 0 ? P.core : mix(P.core, P.cyan, age / 30), near ? mix(canvas.bgAt(x, y), P.glow, 0.8) : undefined, true);
    }
    for (const branch of scene.branches) {
      const since = hx - scene.path[branch.at]!.x;
      if (since < 0 || (boltActive && since > 14)) continue;
      for (const cell of branch.cells) canvas.put(ox + cell.x, oy + cell.y, cell.char, mix(P.accent, P.core, flash), undefined, true);
    }
  }

  for (const spark of scene.sparks) {
    const age = t - spark.born;
    if (age < 0 || age >= spark.life) continue;
    const s = age / 1000;
    const x = ox + spark.x + spark.vx * s, y = oy + spark.y + spark.vy * s + 30 * s * s;
    const a = age / spark.life;
    canvas.put(x, y, a < 0.3 ? "*" : a < 0.6 ? "+" : a < 0.85 ? "·" : ".", mix(mix(P.spark, P.ember, a), canvas.bgAt(x, y), a * a));
  }

  if (t >= T.flashEnd && t < T.exitEnd) {
    const shown = [...SPLASH_TAGLINE].slice(0, Math.floor((t - T.flashEnd) / 20)).join("");
    const suffix = version ? `  v${version}` : "";
    const fade = 1 - Math.min(1, exit / 0.3);
    const x = Math.floor((width - Bun.stringWidth(SPLASH_TAGLINE + suffix)) / 2);
    canvas.text(x, oy + LH + 1, shown, mix(P.bg, P.muted, fade));
    if (shown.length === [...SPLASH_TAGLINE].length && suffix) canvas.text(x + Bun.stringWidth(SPLASH_TAGLINE), oy + LH + 1, suffix, mix(P.bg, P.accent, fade));
  }

  if (t >= T.exitEnd) {
    // Radial reveal from the lightning mark; the wavefront glows as it uncovers the UI.
    const reach = (Math.hypot(width, height * 2) + 6) * easeInOut((t - T.exitEnd) / (T.end - T.exitEnd));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - SPLASH_HANDOFF.x, (y - SPLASH_HANDOFF.y) * 2) + hash(x, y) * 3;
      if (distance < reach - 2) canvas.uncover(x, y);
      else if (distance < reach) canvas.paint(x, y, mix(P.bg, P.glow, 0.6));
    }
  }
}

/** Fraction of the bolt window at which the leader reaches logo column `lx`. */
function inverseHead(lx: number): number {
  const target = (lx + 12) / (LW + 24);
  let lo = 0, hi = 1;
  for (let step = 0; step < 20; step++) { const mid = (lo + hi) / 2; if (easeInOut(mid) < target) lo = mid; else hi = mid; }
  return hi;
}

/** Full-screen overlay that paints splash frames above the UI until the timeline ends. */
export class SplashRenderable extends Renderable {
  private readonly canvas = new SplashCanvas();
  private readonly scene: SplashScene;
  private start: number | undefined;
  private lastFrame = 0;
  private stalled = 0;
  constructor(ctx: RenderContext, private readonly source: { now(): number; theme(): TuiTheme; version?: string; seed: number }) {
    super(ctx, { id: "splash", position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 1000 });
    this.scene = createSplashScene(source.seed);
  }
  /** Milliseconds of the timeline actually shown; it starts at the first painted frame and pauses across event-loop stalls. */
  elapsed(): number { return this.start === undefined ? 0 : this.source.now() - this.start; }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    const now = this.source.now();
    if (this.start === undefined) this.start = now;
    // Startup work can block rendering; hold the timeline so no phase is skipped, within a bounded extension.
    const gap = now - this.lastFrame;
    if (this.lastFrame && gap > 120 && this.stalled < 1000) { const shift = Math.min(gap - 33, 1000 - this.stalled); this.start += shift; this.stalled += shift; }
    this.lastFrame = now;
    const width = buffer.width, height = buffer.height;
    renderSplashFrame(this.canvas, this.scene, this.elapsed(), width, height, this.source.theme(), this.source.version);
    const { chars, fg, bg, bold, covered } = this.canvas;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!covered[index]) continue;
      buffer.setCell(x, y, chars[index]!, RGBA.fromInts(fg[index * 3]!, fg[index * 3 + 1]!, fg[index * 3 + 2]!, 255),
        RGBA.fromInts(bg[index * 3]!, bg[index * 3 + 1]!, bg[index * 3 + 2]!, 255), bold[index] ? 1 : 0);
    }
  }
}
