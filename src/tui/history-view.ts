import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, bold, fg, type CliRenderer, type TextChunk } from "@opentui/core";
import { formatCount } from "../text/format.ts";
import type { HistoryTurn } from "../history/timeline.ts";
import { historyCommandLine, historyCountsLabel, historyDurationLabel, historyOutcomeLabel, historyOutcomeTone, historyTaskLabel, historyTimeLabel, historyUndoLine,
  type HistorySnapshot } from "./controller-history.ts";
import { displayText } from "./presentation.ts";
import { currentDiffLabel, fitPathStart } from "./review-scope.ts";
import type { TuiTheme } from "./theme.ts";

/** One painted body line and its color; `bold` marks section titles. */
type Line = { text: string; color: string; bold?: boolean };

/** Fit one line to `columns` cells at grapheme boundaries, keeping column padding that `fitLine` would collapse. */
function clip(text: string, columns: number): string {
  const line = displayText(text).replace(/[\t\n\r]/g, " ");
  if (columns <= 0) return "";
  if (Bun.stringWidth(line) <= columns) return line;
  let result = "", width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)) {
    const next = Bun.stringWidth(segment);
    if (width + next > columns - 1) break;
    result += segment; width += next;
  }
  return `${result}…`;
}

/** Wrap text at spaces into lines of at most `columns` cells, breaking only overlong words at grapheme boundaries. */
function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of displayText(text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (Bun.stringWidth(candidate) <= columns) { line = candidate; continue; }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (Bun.stringWidth(rest) > columns) {
      let head = "", width = 0;
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(rest)) {
        const next = Bun.stringWidth(segment);
        if (width + next > columns && head) break;
        head += segment; width += next;
      }
      lines.push(head); rest = rest.slice(head.length);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Read-only `/history` panel: a paged turn list, saved evidence for one turn, or current content for one observed path. */
export function createHistoryPanel(renderer: CliRenderer) {
  const root = new BoxRenderable(renderer, { id: "history-panel", flexBasis: 0, flexGrow: 1, minHeight: 1, visible: false, flexDirection: "column" });
  const heading = new TextRenderable(renderer, { id: "history-heading", content: "", flexShrink: 0, wrapMode: "none", marginBottom: 1 });
  const notice = new TextRenderable(renderer, { id: "history-notice", content: "", flexShrink: 0, wrapMode: "none", visible: false });
  const scroll = new ScrollBoxRenderable(renderer, { id: "history-scroll", flexGrow: 1, minHeight: 1, scrollX: false, contentOptions: { paddingRight: 1 } });
  const body = new TextRenderable(renderer, { id: "history-body", content: "", wrapMode: "none" });
  scroll.add(body);
  root.add(heading);
  root.add(notice);
  root.add(scroll);
  let paintedKey = "";
  let paintedFocus = "";
  let content = "";

  /** Keep a line index inside the viewport without moving when it is already visible. */
  const reveal = (line: number) => {
    const height = Math.max(1, scroll.viewport.height);
    if (line < scroll.scrollTop) scroll.scrollTo(line);
    else if (line >= scroll.scrollTop + height) scroll.scrollTo(line - height + 1);
  };

  /** Paint the snapshot at `width` columns; `safe` strips controls and masks secrets from every user-derived string. */
  function paint(history: HistorySnapshot | undefined, width: number, theme: TuiTheme, safe: (value: string) => string): void {
    root.visible = !!history;
    if (!history) { paintedKey = ""; return; }
    const tone = (turn: HistoryTurn) => ({ success: theme.success, error: theme.error, warning: theme.warning, muted: theme.muted })[historyOutcomeTone(turn)];
    const turn = history.turns[history.selected];
    const lines: Line[] = [];
    // The scroll content reserves one column on the right.
    const inner = Math.max(1, width - 1);
    let focus = -1, focusMore = false;
    notice.visible = history.view === "list" && !!history.notice;
    notice.content = new StyledText([fg(theme.warning)(clip(history.notice ?? "", width))]);
    // Details wrap at words; current diff rows wrap anywhere, as in review, so no current content is clipped.
    body.wrapMode = history.showingDetails ? "word" : history.view === "current" && !history.loading ? "char" : "none";
    if (history.loading) {
      heading.content = new StyledText([bold(fg(theme.text)("Loading history…"))]);
      lines.push({ text: "Reading saved turn evidence · Esc back", color: theme.muted });
    } else if (history.showingDetails) {
      heading.content = new StyledText([bold(fg(theme.accent)(clip(history.view === "list" ? "History details" : `Turn ${turn?.ordinal ?? ""} details`, width)))]);
      for (const text of history.details.split("\n")) lines.push({ text: safe(text), color: theme.text });
    } else if (history.view === "current" && history.current) {
      const current = history.current;
      const label = currentDiffLabel("");
      heading.content = new StyledText([bold(fg(theme.accent)(clip(currentDiffLabel(fitPathStart(safe(current.path), Math.max(1, width - Bun.stringWidth(label)))), width)))]);
      lines.push({ text: clip(`Current content · not turn ${current.turn}'s patch`, inner), color: theme.warning, bold: true });
      for (const row of current.rows) {
        const text = `${row.line === undefined ? "" : `${String(row.line).padStart(3)} ${row.sign} `}${safe(row.text)}`;
        lines.push({ text, color: row.comparison ? theme.accent : row.sign === "+" ? theme.success : row.sign === "-" ? theme.error : theme.text, ...(row.comparison ? { bold: true } : {}) });
      }
    } else if (history.view === "detail" && turn) {
      const unsaved = history.unsaved[turn.turnId] !== undefined;
      heading.content = new StyledText([bold(fg(theme.text)(clip(`Turn ${turn.ordinal} · `, width))), bold(fg(tone(turn))(clip(historyOutcomeLabel(turn, unsaved), Math.max(1, width - Bun.stringWidth(`Turn ${turn.ordinal} · `)))))]);
      for (const text of wrap(safe(historyTaskLabel(turn)), inner)) lines.push({ text, color: theme.text });
      if (turn.evidence === "missing") {
        lines.push({ text: clip(unsaved ? "History not saved · F2 details" : "Details unavailable · F2 details", inner), color: theme.muted }, { text: "", color: theme.text });
      } else {
        const meta = [historyTimeLabel(turn), historyDurationLabel(turn), turn.attempts.length > 1 ? formatCount(turn.attempts.length, "attempt") : ""].filter(Boolean).join(" · ");
        lines.push({ text: clip(meta, inner), color: theme.muted }, { text: "", color: theme.text });
        const files = turn.files;
        lines.push({ text: clip(files.truncated ? `Files · ${files.items.length} of ${files.total} shown` : `Files · ${files.total}`, inner), color: theme.accent, bold: true });
        if (!files.items.length) lines.push({ text: `  ${files.total ? "Not stored · F2 details" : "No file changes observed"}`, color: theme.muted });
        const badgeOf = (file: HistoryTurn["files"]["items"][number]) => file.source === "shell" ? "detected" : file.added === undefined && file.removed === undefined ? "edited" : `+${file.added ?? "?"} −${file.removed ?? "?"}`;
        // Keep badges beside their paths instead of at the far edge of a wide terminal.
        const rowWidth = Math.min(inner, Math.max(36, ...files.items.map(file => Bun.stringWidth(safe(file.path)) + 4 + Bun.stringWidth(badgeOf(file)))));
        files.items.forEach((file, index) => {
          const badge = badgeOf(file);
          const room = Math.max(1, rowWidth - 4 - Bun.stringWidth(badge));
          const path = fitPathStart(safe(file.path), room);
          if (index === history.file) focus = lines.length;
          lines.push({ text: `${index === history.file ? "›" : " "} ${path}${" ".repeat(Math.max(0, room - Bun.stringWidth(path)))}  ${badge}`, color: index === history.file ? theme.accent : theme.text });
        });
        lines.push({ text: "", color: theme.text });
        const commands = turn.commands;
        lines.push({ text: clip(commands.truncated ? `Commands · ${commands.items.length} of ${commands.total} shown` : `Commands · ${commands.total}`, inner), color: theme.accent, bold: true });
        if (!commands.items.length) lines.push({ text: `  ${commands.total ? "Not stored · F2 details" : "No commands ran"}`, color: theme.muted });
        for (const command of commands.items) {
          const line = historyCommandLine(command);
          lines.push({ text: clip(`  ${line.glyph} ${safe(line.text)}`, inner), color: ({ success: theme.success, warning: theme.warning, muted: theme.muted, error: theme.error })[line.tone] });
        }
        lines.push({ text: "", color: theme.text });
      }
      lines.push({ text: "Undo", color: theme.accent, bold: true }, { text: clip(`  ${historyUndoLine(turn, history.undo)}`, inner), color: theme.text });
      if (turn.attempts.some(attempt => attempt.git?.status === "unavailable")) lines.push({ text: "", color: theme.text }, { text: clip("Shell changes not tracked · F2 details", inner), color: theme.muted });
    } else {
      heading.content = new StyledText([bold(fg(theme.text)(clip(history.total ? `History · ${formatCount(history.total, "turn")}` : "No turns yet · Esc back", width)))]);
      if (!history.total) lines.push({ text: clip("Accepted tasks appear here after they run.", inner), color: theme.muted });
      const ordinals = Math.max(1, ...history.turns.map(item => String(item.ordinal).length));
      const labels = Math.max(0, ...history.turns.map(item => Bun.stringWidth(historyOutcomeLabel(item, history.unsaved[item.turnId] !== undefined))));
      const timeWidth = Math.max(0, ...history.turns.map(item => historyTimeLabel(item).length));
      const countsWidth = Math.max(0, ...history.turns.map(item => Bun.stringWidth(historyCountsLabel(item))));
      const durationWidth = Math.max(0, ...history.turns.map(item => Bun.stringWidth(historyDurationLabel(item))));
      history.turns.forEach((item, index) => {
        const selected = index === history.selected;
        const label = historyOutcomeLabel(item, history.unsaved[item.turnId] !== undefined);
        const prefix = `${selected ? "›" : " "} ${String(item.ordinal).padStart(ordinals)}  `;
        const task = safe(historyTaskLabel(item));
        const counts = historyCountsLabel(item), duration = historyDurationLabel(item), time = historyTimeLabel(item);
        if (selected) focus = lines.length;
        if (width < 60) {
          // Narrow terminals keep the outcome word and its glyph on the first line and the task below.
          lines.push({ text: clip(`${prefix}${label}${duration ? ` · ${duration}` : ""}`, inner), color: selected ? theme.accent : tone(item) });
          lines.push({ text: clip(`${" ".repeat(prefix.length)}${task}`, inner), color: selected ? theme.accent : theme.text });
          return;
        }
        const columns = [label.padEnd(labels), ...(width >= 100 ? [time.padEnd(timeWidth)] : []), counts.padEnd(countsWidth), duration.padEnd(durationWidth)].filter(column => column.length);
        lines.push({ text: clip(`${prefix}${columns.join("  ")}  ${task}`, inner), color: selected ? theme.accent : theme.text });
      });
      if (history.turns.length < history.total && history.selected === history.turns.length - 1) focusMore = true;
      if (history.turns.length < history.total) lines.push({ text: clip(`  ${formatCount(history.total - history.turns.length, "older turn")} · ↓ show more`, inner), color: theme.muted });
    }
    const key = JSON.stringify([history.view, history.showingDetails, history.view === "list" ? "" : turn?.turnId, history.current?.path]);
    const next = JSON.stringify([lines, theme.background]);
    if (next !== content) {
      body.content = new StyledText(lines.map((line, index): TextChunk => {
        const text = `${line.text}${index < lines.length - 1 ? "\n" : ""}`;
        return line.bold ? bold(fg(line.color)(text)) : fg(line.color)(text);
      }));
      content = next;
    }
    // A new view starts at its top; the list and detail keep their selection visible.
    if (key !== paintedKey) { scroll.scrollTo(0); paintedKey = key; }
    // Scroll only when the selection or viewport changes, so PageUp/PageDown stay where the user put them.
    // A turn opened at its first file starts at its task instead.
    const focusKey = JSON.stringify([key, history.selected, history.file, scroll.viewport.height, focusMore]);
    if (focus >= 0 && !history.showingDetails && focusKey !== paintedFocus && !(history.view === "detail" && history.file === 0)) {
      if (focusMore) reveal(lines.length - 1);
      else if (width < 60 && history.view === "list") reveal(focus + 1);
      reveal(focus);
    }
    paintedFocus = focusKey;
  }

  /** Scroll the panel by about one page. */
  function page(direction: -1 | 1): void {
    scroll.scrollBy(direction * Math.max(1, scroll.viewport.height - 2));
  }

  return { root, scroll, paint, page };
}
