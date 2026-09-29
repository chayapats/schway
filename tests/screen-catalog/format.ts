import type { CapturedFrame, RGBA } from "@opentui/core";

/** Metadata identifying a captured terminal and its actual cursor state. */
export interface ScreenMeta { screen: string; title: string; description: string; variant: string; cursor: { x: number; y: number; visible: boolean } }
/** A half-open cell range sharing foreground, background and terminal attributes. */
export interface StyleRun { row: number; start: number; end: number; fg: string; bg: string; attrs: string }
/** Parsed terminal text and cell style runs, independent of the renderer. */
export interface ScreenGolden extends ScreenMeta { cols: number; rows: number; text: string[]; styles: StyleRun[] }
const letters = "bdiukrhs";
function color(value: RGBA): string {
  if (value.intent === "default") return "default";
  if (value.intent === "indexed") return `idx${value.slot}`;
  const ints = value.toInts();
  return `#${ints.slice(0, ints[3] === 255 ? 3 : 4).map(n => n.toString(16).padStart(2, "0")).join("")}`;
}
/** Serialize captured spans using cell widths and merged, line-diffable style runs. */
export function serializeScreen(frame: CapturedFrame, meta: ScreenMeta): string {
  const styles: StyleRun[] = [];
  frame.lines.forEach((line, row) => {
    let column = 0;
    for (const span of line.spans) {
      const attrs = [...letters].filter((_, bit) => (span.attributes & 0xff) & (1 << bit)).join("") || "-";
      const run = { row, start: column, end: column + span.width, fg: color(span.fg), bg: color(span.bg), attrs };
      const previous = styles.at(-1);
      if (previous && previous.row === row && previous.end === column && previous.fg === run.fg && previous.bg === run.bg && previous.attrs === attrs) previous.end = run.end;
      else if (span.width) styles.push(run);
      column += span.width;
    }
  });
  return ["schway-screen 1", `screen ${meta.screen}`, `title ${meta.title}`, `description ${meta.description}`, `variant ${meta.variant}`, `size ${frame.cols}x${frame.rows}`, `cursor ${meta.cursor.x} ${meta.cursor.y} ${meta.cursor.visible ? "visible" : "hidden"}`, "== text",
    ...frame.lines.map(line => line.spans.map(span => span.text).join("").replace(/ +$/, "")), "== styles",
    ...styles.map(run => `${String(run.row).padStart(frame.rows > 99 ? 3 : 2, "0")} ${run.start}-${run.end} ${run.fg} ${run.bg} ${run.attrs}`), ""].join("\n");
}
/** Parse version-one goldens, rejecting malformed headers, row counts and cell ranges. */
export function parseScreen(text: string): ScreenGolden {
  const lines = text.split("\n");
  if (lines.shift() !== "schway-screen 1") throw new Error("Unknown screen golden version");
  if (!text.endsWith("\n") || /[\t\r]/.test(text)) throw new Error("Golden requires LF lines, no tabs and a final newline");
  const field = (name: string) => { const line = lines.shift(); if (!line?.startsWith(`${name} `)) throw new Error(`Missing ${name} header`); return line.slice(name.length + 1); };
  const screen = field("screen"), title = field("title"), description = field("description"), variant = field("variant");
  const size = /^(\d+)x(\d+)$/.exec(field("size"));
  if (!size) throw new Error("Invalid size header");
  const cols = Number(size[1]), rows = Number(size[2]);
  const cursor = /^(-?\d+) (-?\d+) (visible|hidden)$/.exec(field("cursor"));
  if (!cursor) throw new Error("Invalid cursor header");
  if (lines.shift() !== "== text") throw new Error("Missing text section");
  const boundary = lines.indexOf("== styles");
  if (boundary !== rows) throw new Error(`Text row count ${boundary} does not match size ${rows}`);
  const content = lines.splice(0, rows); lines.shift(); lines.pop();
  const styles = lines.map(line => {
    const match = /^(\d+) (\d+)-(\d+) (#[0-9a-f]{6}(?:[0-9a-f]{2})?|default|idx\d+) (#[0-9a-f]{6}(?:[0-9a-f]{2})?|default|idx\d+) (-|[bdiukrhs]+)$/.exec(line);
    if (!match) throw new Error(`Invalid style run: ${line}`);
    const run = { row: Number(match[1]), start: Number(match[2]), end: Number(match[3]), fg: match[4]!, bg: match[5]!, attrs: match[6]! };
    if (run.row >= rows || run.start >= run.end || run.end > cols) throw new Error(`Invalid cell range: ${line}`);
    return run;
  });
  return { screen, title, description, variant, cols, rows, cursor: { x: Number(cursor[1]), y: Number(cursor[2]), visible: cursor[3] === "visible" }, text: content, styles };
}
