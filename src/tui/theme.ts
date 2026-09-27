/** User-selectable appearance; auto follows terminal background detection. */
export type ThemeMode = "auto" | "dark" | "light";

/** Semantic colors shared by transcript, editor, pickers, and status indicators. */
export interface TuiTheme {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  code: string;
}

/** Restrained palettes with readable text on both base and raised surfaces. */
export const TUI_THEMES: Record<"dark" | "light", TuiTheme> = {
  dark: {
    background: "#15181e", surface: "#20252e", text: "#e2e6ec", muted: "#a7b0be",
    border: "#4a5565", accent: "#83bfff", success: "#91c99a", warning: "#e6c078",
    error: "#f29b9b", code: "#cfb9ed",
  },
  light: {
    background: "#fafaf8", surface: "#eeefed", text: "#242a33", muted: "#566170",
    border: "#9ba3ad", accent: "#075985", success: "#166534", warning: "#854d0e",
    error: "#b91c1c", code: "#6b3890",
  },
};

/** Resolve explicit preference, terminal detection, then COLORFGBG, with a dark fallback. */
export function resolveTheme(mode: ThemeMode, detected: "dark" | "light" | null, env: Record<string, string | undefined>): TuiTheme {
  const background = env.COLORFGBG?.split(";").at(-1);
  const fallback = background === "7" || background === "15" ? "light" : "dark";
  const theme = TUI_THEMES[mode === "auto" ? detected ?? fallback : mode];
  if (!env.NO_COLOR) return theme;
  return { ...theme, accent: theme.text, success: theme.text, warning: theme.text, error: theme.text, code: theme.text };
}
