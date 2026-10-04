import { PREFERENCE_SCOPES, preferenceChoice, type PreferencesSnapshot } from "./preferences.ts";

/** Render the basic list and explicit save preview without exposing advanced provenance. */
export function preferenceLines(panel: PreferencesSnapshot, compact: boolean): string[] {
  const row = panel.rows[panel.selectedIndex]!;
  const choice = preferenceChoice(row.choices[panel.choiceIndex]);
  const advanced = panel.page === "advanced";
  const action = opensPreferenceAction(panel);
  const scope = { session: "This session", memory: "This workspace", user: "All workspaces", project: "This project" }[panel.scope];
  const value = (item: typeof row) => preferenceChoice(advanced ? item.value : item.effectiveValue ?? item.value);
  const selected = `› ${row.label}: ${value(row)}`;
  const hint = action ? "Enter open · Esc back" : "←→ change · Enter preview · Esc back";
  const state = panel.error ? `! Not saved: ${choice}` : panel.preview ? `Enter saves · ${choice}` : action ? hint : `Choice: ${choice}`;
  const lines = [compact ? `Preferences · ${panel.scope}` : `Preferences · ${advanced ? "Advanced" : "Basic"} · ${scope}`, selected, state];
  if (panel.preview || panel.error) {
    lines.push(panel.error ?? panel.preview!, panel.error ? "←→ change · Esc back" : "Enter confirm · Esc cancel");
  } else if (!compact) {
    // Keep the whole ordinary menu visible; compact terminals retain the selected row above.
    const start = advanced ? Math.max(0, Math.min(panel.selectedIndex - 2, panel.rows.length - 5)) : 0;
    lines.splice(1, 1, ...panel.rows.slice(start, advanced ? start + 5 : undefined).map((item, index) => `${index + start === panel.selectedIndex ? "›" : " "} ${item.label}${item.value ? `: ${value(item)}` : ""}`));
  }
  lines.push("↑↓ select · Tab scope · Esc back");
  if (action && row.action === "choose-model") lines.push("Remember a model for this workspace");
  if (!action) {
    lines.push(hint, PREFERENCE_SCOPES[panel.scope]);
    if (advanced || panel.scope === "memory") lines.push(`Saved: ${row.saved}`, `Effective source: ${row.origin}`, row.reset);
    else lines.push(`Saved here: ${row.scopeSaved ?? "Inherited"}`, `Effective now: ${value(row)}`);
  }
  lines.push("", "Approval modes · Change from the composer", "Auto: Run tools without asking.",
    "Ask: Ask before tools that need approval.", "Read-only: Allow read-only tools.");
  lines.push("PgUp/PgDn scroll · Esc back");
  return lines;
}

/** Name the selected row action or pending confirmation in the persistent footer. */
export function preferenceHint(panel: PreferencesSnapshot): string {
  if (panel.error) return "←→ change · Esc back";
  if (panel.preview) return "Enter confirm · Esc cancel";
  return opensPreferenceAction(panel)
    ? "↑↓ select · Enter open · Esc back"
    : "←→ change · Enter preview · Esc back";
}

/** Distinguish navigation choices from scoped reset choices on the same row. */
function opensPreferenceAction(panel: PreferencesSnapshot): boolean {
  const row = panel.rows[panel.selectedIndex]!;
  return !!row.action && (row.action !== "choose-model" || row.choices[panel.choiceIndex] !== undefined);
}
