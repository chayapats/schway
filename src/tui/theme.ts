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
