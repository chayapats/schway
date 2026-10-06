import { PREFERENCE_SCOPES, preferenceChoice, type PreferencesSnapshot } from "./preferences.ts";

/** Keys for a staged preference preview, shown once in the panel and once in the hint row. */
export const PREFERENCE_PREVIEW_ACTIONS = "Enter confirm · Esc cancel";

/** Esc phrase for preferences: cancel while a staged preview waits, back otherwise; Esc clears only the preview first. */
export function preferenceEscape(panel: PreferencesSnapshot): string {
  return panel.preview ? "Esc cancel" : "Esc back";
}

/** Render the basic list and explicit save preview without exposing advanced provenance. */
export function preferenceLines(panel: PreferencesSnapshot, compact: boolean): string[] {
  const row = panel.rows[panel.selectedIndex]!;
  const choice = preferenceChoice(row.choices[panel.choiceIndex]);
  const advanced = panel.page === "advanced";
  const action = opensPreferenceAction(panel);
  const escape = preferenceEscape(panel);
  const scope = { session: "This session", memory: "This workspace", user: "All workspaces", project: "This project" }[panel.scope];
  const value = (item: typeof row) => preferenceChoice(advanced ? item.value : item.effectiveValue ?? item.value);
  const selected = `› ${row.label}: ${value(row)}`;
  const hint = action ? "Enter open · Esc back" : "←→ change · Enter preview · Esc back";
  const state = panel.error ? `! Not saved: ${choice}` : panel.preview ? `Enter saves · ${choice}` : action ? hint : `Choice: ${choice}`;
  const lines = [compact ? `Preferences · ${panel.scope}` : `Preferences · ${advanced ? "Advanced" : "Basic"} · ${scope}`, selected, state];
  if (panel.preview || panel.error) {
    lines.push(panel.error ?? panel.preview!, panel.error ? `←→ change · ${escape}` : PREFERENCE_PREVIEW_ACTIONS);
  } else if (!compact) {
    // Keep the whole ordinary menu visible; compact terminals retain the selected row above.
    const start = advanced ? Math.max(0, Math.min(panel.selectedIndex - 2, panel.rows.length - 5)) : 0;
    lines.splice(1, 1, ...panel.rows.slice(start, advanced ? start + 5 : undefined).map((item, index) => `${index + start === panel.selectedIndex ? "›" : " "} ${item.label}${item.value ? `: ${value(item)}` : ""}`));
  }
  lines.push(`↑↓ select · Tab scope · ${escape}`);
  if (action && row.action === "choose-model") lines.push("Remember a model for this workspace");
  if (!action) {
    // A staged preview already names its keys above; the ordinary change/preview hint would contradict them.
    lines.push(...panel.preview ? [] : [hint], PREFERENCE_SCOPES[panel.scope]);
    if (advanced || panel.scope === "memory") lines.push(`Saved: ${row.saved}`, `Effective source: ${row.origin}`, row.reset);
    else lines.push(`Saved here: ${row.scopeSaved ?? "Inherited"}`, `Effective now: ${value(row)}`);
  }
  lines.push("", "Approval modes · Shift+Tab change in composer", "Auto: Run tools without asking.",
    "Ask: Ask before tools that need approval.", "Read-only: Allow read-only tools.");
  lines.push(`PgUp/PgDn scroll · ${escape}`);
  return lines;
}

/** Name the selected row action or pending confirmation in the persistent footer. */
export function preferenceHint(panel: PreferencesSnapshot): string {
  if (panel.error) return `←→ change · ${preferenceEscape(panel)}`;
  if (panel.preview) return PREFERENCE_PREVIEW_ACTIONS;
  return opensPreferenceAction(panel)
    ? "↑↓ select · Enter open · Esc back"
    : "←→ change · Enter preview · Esc back";
}

/** Distinguish navigation choices from scoped reset choices on the same row. */
function opensPreferenceAction(panel: PreferencesSnapshot): boolean {
  const row = panel.rows[panel.selectedIndex]!;
  return !!row.action && (row.action !== "choose-model" || row.choices[panel.choiceIndex] !== undefined);
}
