/** User-selectable appearance; auto follows terminal background detection. */
export type ThemeMode = "auto" | "dark" | "light";

/** Semantic colors shared by transcript, editor, pickers, status indicators, and the splash. */
export interface TuiTheme {
  background: string;
  /** Raised blocks: top bar, user messages, composer, code bodies, status bar. */
  surface: string;
  /** Second raise: tool trays, code headers, pickers, key chips. */
  surface2: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  code: string;
  /** Brand gradient start (logo) and type annotations in code. */
  cyan: string;
  /** Brand gradient end (logo), reasoning chip, and shell tools. */
  violet: string;
  /** Lightning mark in the top bar and splash sparks. */
  bolt: string;
  /** Decorative bloom behind the splash lightning; never carries text. */
  glow: string;
  /** Decorative whole-screen flash tint during the splash return stroke. */
  flash: string;
  /** Hottest splash color: freshly ignited letters and the lightning core. */
  core: string;
  /** Text drawn on a saturated fill such as the status pill. */
  onFill: string;
}

/** Voltage palettes: calm canvases, color blocks for zones, and one loud status fill at a time. */
export const TUI_THEMES: Record<"dark" | "light", TuiTheme> = {
  dark: {
    background: "#0e1117", surface: "#161b24", surface2: "#1e2430", text: "#e6eaf0", muted: "#8b95a7",
    border: "#2c3444", accent: "#7cc4ff", success: "#8fd19e", warning: "#f0c674", error: "#f79d9d",
    code: "#c0acff", cyan: "#5ee7ff", violet: "#c0acff", bolt: "#ffd84a", glow: "#2f5f99",
    flash: "#1d2940", core: "#ffffff", onFill: "#0e1117",
  },
  light: {
    background: "#f7f7f4", surface: "#ecedea", surface2: "#e1e3df", text: "#1d232c", muted: "#545e6c",
    border: "#c5c9cf", accent: "#0a5894", success: "#19612f", warning: "#7a5000", error: "#a61f16",
    code: "#6a3fb0", cyan: "#065e74", violet: "#6a3fb0", bolt: "#b27b00", glow: "#ffe29a",
    flash: "#fff3cc", core: "#16204a", onFill: "#ffffff",
  },
};

/** Resolve explicit preference, terminal detection, then COLORFGBG, with a dark fallback. */
export function resolveTheme(mode: ThemeMode, detected: "dark" | "light" | null, env: Record<string, string | undefined>): TuiTheme {
  const background = env.COLORFGBG?.split(";").at(-1);
  const fallback = background === "7" || background === "15" ? "light" : "dark";
  const theme = TUI_THEMES[mode === "auto" ? detected ?? fallback : mode];
  if (!env.NO_COLOR) return theme;
  const text = theme.text;
  return { ...theme, accent: text, success: text, warning: text, error: text, code: text, cyan: text, violet: text, bolt: text, glow: theme.surface2, flash: theme.background, core: text, onFill: theme.background };
}

/** Linearly blend two #rrggbb colors; t=0 returns a, t=1 returns b, clamped. */
export function mixColor(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2].map(index => Math.round(channel(a, index) + (channel(b, index) - channel(a, index)) * k).toString(16).padStart(2, "0")).join("")}`;
}

/** Quiet background tint of a semantic color over surface2, used for pills, diffs, and selection. */
export function tint(theme: TuiTheme, color: string, base = theme.surface2): string {
  return mixColor(base, color, theme.background === TUI_THEMES.light.background ? 0.12 : 0.22);
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(channels: readonly number[]): number {
  const linear = channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

/** Preserve passing opaque #rrggbb text or adjust it to 4.5:1 against resolved #rrggbb; other color forms return undefined. */
export function readableForeground(preferred: string, background: string): string | undefined {
  // Callers must first resolve terminal defaults, indexed colors and alpha composition.
  if (!/^#[0-9a-f]{6}$/i.test(preferred) || !/^#[0-9a-f]{6}$/i.test(background)) return undefined;
  const original = rgb(preferred), backgroundLuminance = luminance(rgb(background));
  const contrast = (channels: readonly number[]) => {
    const value = luminance(channels);
    return (Math.max(value, backgroundLuminance) + 0.05) / (Math.min(value, backgroundLuminance) + 0.05);
  };
  if (contrast(original) >= 4.5) return preferred;
  let closest: string | undefined, closestDistance = Infinity;
  for (const endpoint of ["#000000", "#ffffff"]) {
    if (contrast(rgb(endpoint)) < 4.5) continue;
    let low = 0, high = 1, candidate = endpoint;
    // Each path has one passing boundary; remeasure rounded bytes at every bounded step.
    for (let step = 0; step < 24; step++) {
      const midpoint = (low + high) / 2, mixed = mixColor(preferred, endpoint, midpoint);
      if (contrast(rgb(mixed)) >= 4.5) { high = midpoint; candidate = mixed; }
      else low = midpoint;
    }
    const distance = rgb(candidate).reduce((sum, channel, index) => sum + (channel - original[index]!) ** 2, 0);
    if (distance < closestDistance) { closest = candidate; closestDistance = distance; }
  }
  return closest;
}
