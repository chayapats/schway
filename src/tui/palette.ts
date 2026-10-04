import type { KeyboardGuideAvailability, KeyboardGuideChoice, KeyboardGuideId, PaletteChoice } from "./command-catalog.ts";
import { fitLine } from "./presentation.ts";

/** Composer prompt shown while the help palette owns the search field. */
export const PALETTE_PLACEHOLDER = "Search commands and actions…";

/** Empty-result row; Esc restores the draft the palette opened from, as the palette hint row says. */
export const PALETTE_NO_MATCHES = "No matches · Esc restore";

/** Notice shown above results while a turn runs; commands can be inserted but not sent yet. */
export const PALETTE_RUNNING = "Turn running · Send commands after it settles";

/** Facts observed in the composer the palette returns to; they only decide availability text. */
export interface PaletteReturnContext {
  /** A turn, login or command is still running. */
  running: boolean;
  /** A tool approval request owns input once the palette closes. */
  toolApproval: boolean;
  /** The conversation has a code block, table or tool result that Alt+I can select. */
  inspectable: boolean;
  /** F2 would open retained notice or recovery details from the composer. */
  details: boolean;
  /** Keys that lead the composer instead of Enter send (see `blockedSubmitHint`); absent or empty when Enter can send. */
  blockedSubmit?: string;
}

/** Note shown above results while a tool approval waits; commands cannot be inserted until it settles. */
export const PALETTE_APPROVAL = "Approval waiting · Esc back to request";

const APPROVAL_WAITING = PALETTE_APPROVAL;
const TURN_RUNNING = "Wait for this turn · Esc stop";
// While work runs Enter cannot send, so an empty conversation names stopping instead.
const NOTHING_TO_INSPECT_RUNNING = "Nothing to inspect yet · Esc stop";

/** Reason Alt+I has nothing to select; it names Enter only when the composer can send. */
export function nothingToInspectReason(context: Pick<PaletteReturnContext, "running" | "blockedSubmit">): string {
  return context.running ? NOTHING_TO_INSPECT_RUNNING : `Nothing to inspect · ${context.blockedSubmit || "Enter send a task"}`;
}

/** Project return-context facts into keyboard availability without reading or changing application state. */
export function keyboardGuideAvailability(context: PaletteReturnContext): Readonly<Record<KeyboardGuideId, KeyboardGuideAvailability>> {
  const ok = { available: true } as const;
  const blocked = (reason: string) => ({ available: false, reason }) as const;
  const approval = context.toolApproval ? blocked(APPROVAL_WAITING) : undefined;
  return {
    newline: approval ?? ok,
    "inspect-copy": approval ?? (context.inspectable ? ok : blocked(nothingToInspectReason(context))),
    "copy-selection": approval ?? ok,
    "approval-mode": approval ?? ok,
    shortcuts: approval ?? ok,
    details: approval ?? (context.running ? blocked(TURN_RUNNING) : context.details ? ok : blocked("No details to show · Esc back")),
    review: approval ?? (context.running ? blocked(TURN_RUNNING) : ok),
    cancel: context.running ? ok : blocked(`Nothing running · ${context.blockedSubmit || "Enter send a task"}`),
  };
}

/** Keyboard rows stay selectable so their guidance is readable; unavailable commands never take selection. */
export function paletteSelectable(row: PaletteChoice): boolean {
  return row.kind === "keyboard" || row.available;
}

/** Return the next selectable index in `delta` direction, wrapping, or -1 when nothing is selectable. */
export function nextPaletteSelection(rows: readonly PaletteChoice[], current: number, delta: number): number {
  const selectable = rows.flatMap((row, index) => paletteSelectable(row) ? [index] : []);
  if (!selectable.length) return -1;
  const position = selectable.indexOf(current);
  const next = position < 0 ? (delta > 0 ? 0 : selectable.length - 1) : (position + delta + selectable.length) % selectable.length;
  return selectable[next]!;
}

/** A visible palette line: a group header or a result with its index in the ranked rows. */
export type PaletteSection = { header: string } | { entry: PaletteChoice; index: number };

/** Interleave group headers for an unfiltered list; a ranked search stays flat so its order is visible. */
export function paletteSections(rows: readonly PaletteChoice[], grouped: boolean): PaletteSection[] {
  const result: PaletteSection[] = [];
  const keyboard = rows.some(row => row.kind === "keyboard");
  let group: string | undefined;
  rows.forEach((entry, index) => {
    const current = entry.kind === "keyboard" ? "keyboard" : entry.group;
    if (grouped && current !== group) {
      if (current === "skills") result.push({ header: "Skills" });
      if (current === "extensions") result.push({ header: "Extensions" });
      if (current === "keyboard") result.push({ header: "Keyboard" });
      // After keyboard guidance, deletion needs its own heading so it is not read as a key.
      if (current === "destructive" && keyboard) result.push({ header: "Destructive" });
      group = current;
    }
    result.push({ entry, index });
  });
  return result;
}

/** Plain text pieces for one keyboard row; the caller styles them, and the marker text survives without color. */
export function keyboardRowParts(row: KeyboardGuideChoice, selected: boolean, nameColumns: number, columns: number): { lead: string; label: string; detail: string } {
  const prefix = `${selected ? "›" : " "} ${row.available ? "  " : "! "}`;
  const key = fitLine(row.shortcut, nameColumns);
  const lead = prefix + key + " ".repeat(Math.max(0, nameColumns - Bun.stringWidth(key)) + 1);
  const room = Math.max(0, columns - Bun.stringWidth(lead));
  const label = fitLine(row.label, room);
  const rest = Math.max(0, room - Bun.stringWidth(label));
  const detail = row.available ? ` · ${row.description}` : ` · ${row.reason}`;
  // An available row drops its description rather than clipping it; a reason clips but keeps its start.
  return { lead, label, detail: row.available ? Bun.stringWidth(detail) <= rest ? detail : "" : fitLine(detail, rest) };
}

/** The selected keyboard row's full description or unavailable reason, shown beneath clipped results. */
export function paletteDetail(row: PaletteChoice | undefined): { text: string; warning: boolean } | undefined {
  if (row?.kind !== "keyboard") return undefined;
  return row.available ? { text: `${row.shortcut} · ${row.description}`, warning: false } : { text: `! ${row.reason}`, warning: true };
}

/** A guidance line with a semantic tone; `wrap` lines may use several terminal rows. */
export type GuidanceLine = { text: string; tone: "accent" | "text" | "muted" | "warning" | "success"; wrap: boolean };

/** Read-only guidance for one keyboard action: exact key, description, prerequisites and current availability. */
export function guidanceLines(row: KeyboardGuideChoice): GuidanceLine[] {
  return [
    { text: `${row.label} · ${row.shortcut}`, tone: "accent", wrap: true },
    { text: row.description, tone: "muted", wrap: true },
    { text: row.guidance, tone: "text", wrap: true },
    row.available ? { text: "✓ Available now", tone: "success", wrap: true } : { text: `! ${row.reason}`, tone: "warning", wrap: true },
  ];
}

/** Estimate terminal rows used by guidance at `columns`, so the composer can reserve space. */
export function guidanceHeight(row: KeyboardGuideChoice, columns: number): number {
  return guidanceLines(row).reduce((sum, line) => sum + Math.max(1, Math.ceil(Bun.stringWidth(line.text) / Math.max(1, columns))), 0);
}

/** Palette hint for the current layer; it says `Enter insert` for commands and never promises execution. */
export function paletteHint(state: { guide: boolean; inserted: boolean; selected?: PaletteChoice }, columns: number): string {
  if (state.guide) return "Esc back";
  const segments = state.inserted ? ["Enter insert", "Tab complete", "Esc restore"]
    : state.selected?.kind === "keyboard" ? ["↑↓ select", "Enter show keys", "Esc restore"]
    : state.selected ? ["↑↓ select", "Tab preview", "Enter insert", "Esc restore"]
    : ["Esc restore"];
  // Keep Enter and the Esc way out; arrows drop first at narrow widths, then the Tab shortcut.
  for (const optional of ["↑↓ select", "Tab preview", "Tab complete"]) {
    const index = segments.indexOf(optional);
    if (Bun.stringWidth(segments.join(" · ")) > columns && index >= 0) segments.splice(index, 1);
  }
  return segments.join(" · ");
}
