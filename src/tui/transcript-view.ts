import { BoxRenderable, MarkdownRenderable, RGBA, TextBufferRenderable, TextTableRenderable, TextRenderable, SyntaxStyle, StyledText, fg, bg, bold, italic, underline, link, type BaseRenderable, type BorderCharacters, type CliRenderer, type Renderable, type RenderNodeContext, type TextChunk } from "@opentui/core";
import type { TuiTranscriptEntry } from "./controller.ts";
import { highlightCode } from "./highlight.ts";
import { HINT_KEY, keyHintChunks, wrapHintSegments } from "./hints.ts";
import { easeOut, progress, shimmer, spinnerFrame, type MotionMode } from "./motion.ts";
import { displayText, fitLine, toolPresentation } from "./presentation.ts";
import { mixColor, TEXT_ROLES, textOn, themeOn, tint, type TuiTheme } from "./theme.ts";
import { browserUrl, linkify } from "./links.ts";
import { boundDisplay, formatDiffRows, hasInlineDiff } from "./transcript-format.ts";
import { DEFAULT_INLINE_DIFF_LINES } from "../config/config.ts";

/** Left-edge bar used by user and error blocks; only the vertical glyph is ever drawn. */
const BAR: BorderCharacters = { topLeft: "▌", topRight: " ", bottomLeft: "▌", bottomRight: " ", horizontal: " ", vertical: "▌", topT: " ", bottomT: " ", leftT: "▌", rightT: " ", cross: " " };

/** Pill color by tool family: reads blue, writes amber, shell violet, everything else cyan. */
function toolColor(name: string | undefined, theme: TuiTheme): string {
  if (name === "edit" || name === "write") return theme.warning;
  if (name === "bash") return theme.violet;
  if (name === "read" || name === "ls" || name === "find" || name === "grep") return theme.accent;
  return theme.cyan;
}

/** Blinking caret appended to a streaming answer outside fenced code. */
const STREAM_CARET = "▍";

/** Clock and motion policy shared by animated transcript rows. */
export interface TranscriptMotion { now(): number; mode: MotionMode }

type MarkdownToken = {
  type: string; text?: string; raw?: string; lang?: string; href?: string;
  tokens?: MarkdownToken[]; items?: MarkdownToken[]; ordered?: boolean; start?: number | "";
  task?: boolean; checked?: boolean;
};

function inline(tokens: readonly MarkdownToken[], theme: TuiTheme, styles: { strong?: boolean; emphasis?: boolean; link?: boolean; code?: boolean; url?: string } = {}, base = theme): TextChunk[] {
  return tokens.flatMap(token => {
    const next = { ...styles, strong: styles.strong || token.type === "strong", emphasis: styles.emphasis || token.type === "em", link: styles.link || token.type === "link", code: styles.code || token.type === "codespan", url: token.type === "link" ? browserUrl(token.href ?? "") : styles.url };
    if (token.tokens) {
      const children = inline(token.tokens, theme, next, base);
      if (token.type === "link" && token.href) children.push(next.url ? link(next.url)(fg(theme.muted)(` (${token.href})`)) : fg(theme.muted)(` (${token.href})`));
      return children;
    }
    const text = token.type === "br" ? "\n" : token.text ?? token.raw ?? "";
    // The streaming caret is presentation only; it is appended by the row and colored here.
    if (!next.code && text.endsWith(STREAM_CARET)) return [...inline([{ ...token, text: text.slice(0, -1) }], theme, styles, base), fg(theme.accent)(STREAM_CARET)];
    // Inline code paints its own tint, so it keeps the base palette measured against that tint.
    let chunk = fg(next.code ? base.code : next.link ? theme.accent : theme.text)(text);
    if (next.code) chunk = bg(tint(base, base.code))(chunk);
    if (next.strong) chunk = bold(chunk);
    if (next.emphasis) chunk = italic(chunk);
    if (next.link) chunk = underline(chunk);
    if (next.url) chunk = link(next.url)(chunk);
    return [chunk];
  });
}

/** Remap native table cell colors from one palette's text roles to another's; returns the same content when nothing changes. */
function recolorCells(content: TextTableRenderable["content"], from: readonly TuiTheme[], to: TuiTheme): TextTableRenderable["content"] {
  const map = new Map<string, string>();
  for (const palette of from) for (const role of TEXT_ROLES) map.set(palette[role], to[role]);
  const hex = (color: RGBA) => `#${color.toInts().slice(0, 3).map(n => n.toString(16).padStart(2, "0")).join("")}`;
  let changed = false;
  const next = content.map(row => row.map(cell => cell?.map(chunk => {
    const target = chunk.fg && map.get(hex(chunk.fg));
    if (!target || target === hex(chunk.fg!)) return chunk;
    changed = true;
    return { ...chunk, fg: RGBA.fromHex(target) };
  })));
  return changed ? next : content;
}

/** Live text palette for one row; painters recolor rendered Markdown in place so search targets survive fill changes. */
interface RowInk { paint(node: Renderable, apply: (ink: TuiTheme) => void): void }

function markdownBlock(renderer: CliRenderer, token: MarkdownToken, theme: TuiTheme, registerCode: (box: BoxRenderable, text: string, title: string) => void, ink: RowInk = { paint: (_, apply) => apply(theme) }): BoxRenderable | TextRenderable | undefined {
  // Tables and rules use OpenTUI's native structured widgets. Text uses the
  // already-tokenized Markdown AST so first paint never waits for a WASM download.
  if (token.type === "table" || token.type === "hr") return undefined;
  if (token.type === "code") {
    const block = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: theme.surface, marginTop: 1, marginBottom: 1 });
    const title = token.lang || "code";
    registerCode(block, token.text ?? "", title);
    // Header strip: language pill left, inspection hint right, on the second surface.
    const header = new BoxRenderable(renderer, { flexDirection: "row", backgroundColor: theme.surface2, paddingX: 1 });
    header.add(new TextRenderable(renderer, { content: codeTitle(title, false, theme), flexShrink: 0 }));
    header.add(new BoxRenderable(renderer, { flexGrow: 1 }));
    header.add(new TextRenderable(renderer, { content: "Alt+I inspect", fg: theme.muted, flexShrink: 1, wrapMode: "none" }));
    block.add(header);
    const code = new BoxRenderable(renderer, { flexDirection: "column", paddingX: 1 });
    code.add(new TextRenderable(renderer, { content: linkify(highlightCode(token.text ?? "", token.lang, theme)), fg: theme.code, wrapMode: "word" }));
    block.add(code);
    return block;
  }
  if (token.type === "list" || token.type === "blockquote") {
    const block = new BoxRenderable(renderer, { flexDirection: "column", paddingLeft: 2, ...(token.type === "blockquote" ? { border: ["left" as const], borderColor: theme.border } : {}) });
    if (token.type === "list") {
      for (const [index, item] of (token.items ?? []).entries()) {
        const itemBox = new BoxRenderable(renderer, { flexDirection: "row" });
        const marker = item.task ? item.checked ? "[x] " : "[ ] " : token.ordered ? `${(token.start || 1) + index}. ` : "▸ ";
        const markerText = new TextRenderable(renderer, { content: marker, flexShrink: 0 });
        ink.paint(markerText, palette => { markerText.fg = item.task ? item.checked ? palette.success : palette.muted : token.ordered ? palette.muted : palette.accent; });
        itemBox.add(markerText);
        const contents = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
        for (const child of item.tokens ?? [{ type: "text", text: item.text }]) {
          const rendered = markdownBlock(renderer, child, theme, registerCode, ink);
          if (rendered) contents.add(rendered);
        }
        itemBox.add(contents);
        block.add(itemBox);
      }
    } else for (const child of token.tokens ?? []) {
      const rendered = markdownBlock(renderer, child, theme, registerCode, ink);
      if (rendered) block.add(rendered);
    }
    return block;
  }
  const text = new TextRenderable(renderer, { content: "", wrapMode: "word" });
  ink.paint(text, palette => {
    text.content = linkify(inline(token.tokens ?? [{ type: "text", text: token.text ?? token.raw ?? "" }], palette, { strong: token.type === "heading" }, theme));
    text.fg = palette.text;
  });
  return text;
}

/** Wrap OpenTUI's native top-level table with an inspection header, keeping its layout and options; `paintTable` recolors the native table node. */
function tableBlock(renderer: CliRenderer, context: RenderNodeContext, theme: TuiTheme, registerTable: (box: BoxRenderable) => void, paintTable: (table: Renderable) => void): BoxRenderable | undefined {
  const table = context.defaultRender();
  if (!table) return undefined;
  paintTable(table);
  const block = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, marginTop: typeof table.marginTop === "number" ? table.marginTop : 0 });
  table.marginTop = 0;
  table.marginBottom = 0;
  registerTable(block);
  const header = new BoxRenderable(renderer, { flexDirection: "row", backgroundColor: theme.surface2, paddingX: 1 });
  header.add(new TextRenderable(renderer, { content: codeTitle("table", false, theme), flexShrink: 0 }));
  header.add(new BoxRenderable(renderer, { flexGrow: 1 }));
  header.add(new TextRenderable(renderer, { content: "Alt+I inspect", fg: theme.muted, flexShrink: 1, wrapMode: "none" }));
  block.add(header);
  block.add(table);
  return block;
}

/** Language pill for a code block header; focus adds the inspection marker. */
function codeTitle(title: string, focused: boolean, theme: TuiTheme): StyledText {
  return new StyledText([bold(bg(tint(theme, theme.accent))(fg(theme.accent)(` ${focused ? "› " : ""}${title} `)))]);
}

/** A rendered code or top-level table block; `index` counts only blocks of the same kind, and table text is undefined when its source span is unproven. */
export interface ReadableBlock { kind: "code" | "table"; index: number; id: string; text: string | undefined; title: string }

/** A stable transcript item whose text can change without replacing neighboring messages. */
export interface TranscriptItemView {
  root: BoxRenderable;
  /** Return code blocks in rendered order with the exact sanitized representation shown by Markdown. */
  codeBlocks(): { id: string; text: string }[];
  /** Return code and top-level tables in rendered order; table text is the sanitized Markdown source without its final newline. */
  readableBlocks(): ReadableBlock[];
  /** Return visible text blocks and their exact rendered scroll targets. */
  searchSegments(): readonly { text: string; target: Renderable; visualLine: number; lineInfo?: { lineSources: readonly number[]; lineStartCols: readonly number[] } }[];
  /** Mark the selected search row without changing its rendered content. */
  setSearchMatch(selected: boolean): void;
  /** Render the current entry at the supplied width and expansion state using the effective inline diff limit. */
  update(entry: TuiTranscriptEntry, expanded: boolean, streaming: boolean, width: number, focusedCode?: number, focusedTool?: boolean, inlineDiffLines?: number, focusedTable?: number): void;
  /** Advance spinners and completion flashes; returns whether this row still animates. */
  tick(): boolean;
}

/** Create Markdown styles from the same semantic palette used by tools and controls. */
export function markdownStyle(theme: TuiTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    "markup.heading": { fg: theme.text, bold: true },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.text, italic: true },
    "markup.raw": { fg: theme.code },
    "markup.link": { fg: theme.accent },
    "markup.link.label": { fg: theme.accent, underline: true },
    "markup.link.url": { fg: theme.muted },
    "markup.list": { fg: theme.muted },
    "markup.quote": { fg: theme.muted },
    conceal: { fg: theme.border },
  });
}

/** Mount one semantic message, rendering Markdown and code locally without downloading parsers. */
export function createTranscriptItem(renderer: CliRenderer, initial: TuiTranscriptEntry, theme: TuiTheme, syntaxStyle: SyntaxStyle, toggleTool: () => void, motion: TranscriptMotion = { now: () => Date.now(), mode: "off" }): TranscriptItemView {
  const errorBlock = mixColor(theme.background, theme.error, 0.12);
  const baseBackground = initial.kind === "user" ? theme.surface : initial.kind === "tool" ? theme.surface2 : initial.kind === "error" ? errorBlock : undefined;
  const root = new BoxRenderable(renderer, { id: `message-${initial.id}`, flexDirection: "column", flexShrink: 0, marginTop: initial.kind === "assistant" ? 1 : 0, marginBottom: initial.kind === "tool" ? 0 : 1, backgroundColor: baseBackground });
  const codeData = new WeakMap<BoxRenderable, { text: string; title: string }>();
  const registerCode = (box: BoxRenderable, text: string, title: string) => { codeData.set(box, { text, title }); };
  // Text roles follow the composed row background (search, focus, flash); explicitly tinted chunks keep the base palette.
  let ink = theme;
  let repaint: (() => void) | undefined;
  let painters: { node: Renderable; apply: (ink: TuiTheme) => void }[] = [];
  let pruneAt = 64;
  const rowInk: RowInk = {
    paint(node, apply) {
      // Prune destroyed nodes at a doubling threshold so long answers stay linear.
      if (painters.length >= pruneAt) { painters = painters.filter(painter => !painter.node.isDestroyed); pruneAt = Math.max(64, painters.length * 2); }
      painters.push({ node, apply });
      apply(ink);
    },
  };
  const tableData = new WeakSet<BoxRenderable>();
  // Native tables keep OpenTUI's own node inside the inspection wrapper; their cells are remapped from the base palette to the row ink.
  const paintTable = (table: Renderable) => {
    if (!(table instanceof TextTableRenderable)) return;
    let applied = theme;
    rowInk.paint(table, palette => {
      const next = recolorCells(table.content, [theme, applied], palette);
      if (next !== table.content) table.content = next;
      applied = palette;
    });
  };
  const renderMarkdownNode = (token: MarkdownToken, context: RenderNodeContext) => token.type === "table"
    ? tableBlock(renderer, context, theme, box => { tableData.add(box); }, paintTable)
    : markdownBlock(renderer, token, theme, registerCode, rowInk);
  const codeBlocks = () => {
    const blocks: { id: string; text: string }[] = [];
    const visit = (node: BaseRenderable) => {
      if (node instanceof BoxRenderable) {
        const code = codeData.get(node);
        if (code) {
          const id = `code-${initial.id}-${blocks.length}`;
          node.id = id;
          blocks.push({ id, text: code.text });
        }
      }
      for (const child of node.getChildren()) visit(child);
    };
    visit(root);
    return blocks;
  };
  /** Recover a rendered table's original sanitized Markdown from its validated top-level source span. */
  const tableSource = (node: BoxRenderable): string | undefined => {
    if (!(body instanceof MarkdownRenderable)) return undefined;
    const state = body._parseState;
    const token = body._blockStates.find(block => block.renderable === node)?.token;
    if (!state || !token?.raw) return undefined;
    let offset = 0;
    for (const candidate of state.tokens) {
      if (candidate === token) break;
      offset += candidate.raw.length;
    }
    if (state.content.slice(offset, offset + token.raw.length) !== token.raw) return undefined;
    // The streaming caret is presentation appended after the answer, never source.
    const raw = streamText !== undefined && token.raw.endsWith(STREAM_CARET) && offset + token.raw.length === state.content.length ? token.raw.slice(0, -1) : token.raw;
    return raw.replace(/\n+$/, "");
  };
  const readableBlocks = () => {
    const blocks: ReadableBlock[] = [];
    let code = 0, table = 0;
    const visit = (node: BaseRenderable) => {
      if (node instanceof BoxRenderable) {
        const data = codeData.get(node);
        if (data) {
          node.id = `code-${initial.id}-${code}`;
          blocks.push({ kind: "code", index: code++, id: node.id, text: data.text, title: data.title });
        } else if (tableData.has(node)) {
          node.id = `table-${initial.id}-${table}`;
          blocks.push({ kind: "table", index: table++, id: node.id, text: tableSource(node), title: "table" });
          return;
        }
      }
      for (const child of node.getChildren()) visit(child);
    };
    visit(root);
    return blocks;
  };
  const label = new TextRenderable(renderer, { content: "", fg: theme.muted, flexShrink: 0 });
  const body = initial.kind === "assistant"
    ? new MarkdownRenderable(renderer, {
      content: "", syntaxStyle, fg: theme.text, streaming: true, internalBlockMode: "top-level",
      tableOptions: { style: "columns", wrapMode: "word", cellPaddingX: 1 },
      renderNode: renderMarkdownNode,
    })
    : new TextRenderable(renderer, { content: "", fg: theme.text, wrapMode: "word" });
  const paintHeading = () => {
    if (initial.kind === "user") label.content = new StyledText([bold(fg(ink.accent)("You"))]);
    if (initial.kind === "error") label.content = new StyledText([bold(fg(ink.error)("! Error"))]);
  };
  if (initial.kind === "user") {
    Object.assign(root, { border: ["left"], borderColor: theme.accent, customBorderChars: BAR, paddingLeft: 1, paddingRight: 1 });
    paintHeading();
    root.add(label);
  } else if (initial.kind === "assistant") {
    label.visible = false;
    root.add(label);
  } else if (initial.kind === "tool") {
    let press: { x: number; y: number } | undefined;
    label.onMouseDown = event => { press = event.button === 0 ? { x: event.x, y: event.y } : undefined; };
    label.onMouseDrag = () => { press = undefined; };
    label.onMouseUp = event => {
      if (event.button === 0 && press?.x === event.x && press.y === event.y) toggleTool();
      press = undefined;
    };
    root.add(label);
  } else if (initial.kind === "error") {
    Object.assign(root, { border: ["left"], borderColor: theme.error, customBorderChars: BAR, paddingLeft: 1, paddingRight: 1 });
    paintHeading();
    root.add(label);
  }
  // Text renderables do not pad their own content; tool output is indented under the target by a box.
  if (initial.kind === "tool") {
    const indent = new BoxRenderable(renderer, { flexDirection: "column", paddingLeft: 3, paddingRight: 1 });
    indent.add(body);
    root.add(indent);
  } else root.add(body);
  let fingerprint = "";
  let searchSelected = false;
  let focusedRow = false;
  let flashStart: number | undefined;
  let status = initial.toolStatus;
  let paintLabel: (() => void) | undefined;
  let streamText: string | undefined;
  let caretOn: boolean | undefined;
  const caretContent = () => {
    const on = motion.mode !== "full" || Math.floor(motion.now() / 530) % 2 === 0;
    caretOn = on;
    return on && streamText ? `${streamText.trimEnd()}${STREAM_CARET}` : streamText ?? "";
  };
  const background = () => searchSelected ? theme.border : focusedRow ? tint(theme, theme.accent) : baseBackground;
  /** Set the row fill and repaint text whose readable role colors changed on it. */
  const paintBackground = (color: string | undefined) => {
    root.backgroundColor = color;
    const next = themeOn(theme, color ?? theme.background);
    if (next === ink || JSON.stringify(next) === JSON.stringify(ink)) return;
    ink = next;
    paintHeading();
    repaint?.();
  };
  /** Apply the row background, blending a decaying success flash over the tray color; returns whether it still flashes. */
  const applyBackground = () => {
    if (flashStart === undefined || searchSelected || focusedRow) { flashStart = searchSelected || focusedRow ? undefined : flashStart; paintBackground(background()); return false; }
    const k = progress(motion.now(), flashStart, 600);
    paintBackground(mixColor(mixColor(theme.surface2, theme.success, 0.35), theme.surface2, easeOut(k)));
    if (k < 1) return true;
    flashStart = undefined;
    return false;
  };
  return {
    root,
    codeBlocks,
    readableBlocks,
    searchSegments() {
      const segments: { text: string; target: Renderable; visualLine: number; lineInfo?: { lineSources: readonly number[]; lineStartCols: readonly number[] } }[] = [];
      const visit = (node: BaseRenderable) => {
        if (!node.visible) return;
        if (node instanceof TextBufferRenderable) {
          if (node.plainText) segments.push({ text: node.plainText, target: node, visualLine: 0 });
          return;
        }
        if (node instanceof TextTableRenderable) {
          // OpenTUI exposes table cells but not row geometry; its laid-out row
          // offsets are the source of truth after a frame, including wrapped cells.
          const table = node as unknown as {
            _layout?: { rowOffsets?: readonly number[] };
            _cells?: readonly (readonly ({ textBufferView?: { lineInfo: { lineSources: readonly number[]; lineStartCols: readonly number[] } } } | undefined)[])[];
          };
          const layout = table._layout;
          for (const [rowIndex, cells] of node.content.entries()) {
            for (const [columnIndex, cell] of cells.entries()) {
              const text = cell?.map(chunk => chunk.text).join("") ?? "";
              if (text) segments.push({
                text, target: node, visualLine: (layout?.rowOffsets?.[rowIndex] ?? rowIndex) + 1 + node.cellPaddingY,
                lineInfo: table._cells?.[rowIndex]?.[columnIndex]?.textBufferView?.lineInfo,
              });
            }
          }
          return;
        }
        // Code and table header strips are inspection chrome, not message content.
        const chrome = node instanceof BoxRenderable && (codeData.has(node) || tableData.has(node));
        for (const child of node.getChildren().slice(chrome ? 1 : 0)) visit(child);
      };
      visit(root);
      return segments;
    },
    setSearchMatch(selected) {
      if (searchSelected === selected) return;
      searchSelected = selected;
      applyBackground();
    },
    tick() {
      if (initial.kind === "assistant" && streamText !== undefined && body instanceof MarkdownRenderable) {
        const was = caretOn;
        const next = caretContent();
        if (caretOn !== was) body.content = next;
        return motion.mode === "full";
      }
      if (initial.kind !== "tool") return false;
      let animating = false;
      if (status === "running" && motion.mode !== "off") { paintLabel?.(); animating = true; }
      if (flashStart !== undefined && applyBackground()) animating = true;
      return animating;
    },
    update(entry, expanded, streaming, width, focusedCode, focusedTool, inlineDiffLines = DEFAULT_INLINE_DIFF_LINES, focusedTable) {
      const next = JSON.stringify([entry.text, entry.toolSummary, entry.resultSummary, entry.shellOutcome, entry.diffRows, entry.toolStatus, entry.incomplete, expanded, streaming, width, focusedCode, focusedTool, inlineDiffLines, focusedTable]);
      if (next === fingerprint) return;
      fingerprint = next;
      repaint = undefined;
      if (entry.kind === "tool") {
        const tool = toolPresentation(entry, expanded);
        const inline = hasInlineDiff(entry, inlineDiffLines);
        const detail = inline ? boundDisplay(displayText(formatDiffRows(entry.diffRows!)).split("\n").map(line => line.slice(0, 300)).join("\n")) : tool.detail;
        if (status === "running" && tool.tone === "success" && motion.mode === "full") flashStart = motion.now();
        status = entry.toolStatus;
        focusedRow = !!focusedTool;
        applyBackground();
        // Reserve shell outcome and disclosure first; optional summaries give way to the target.
        const inner = Math.max(8, width - 2);
        const color = toolColor(entry.toolName, theme);
        const pillBg = tint(theme, color);
        const focus = focusedTool ? "› " : "";
        const kind = ` ${fitLine((entry.toolName ?? "tool").toUpperCase(), Math.max(1, Math.min(12, inner - 10)))} `;
        const state = tool.state === "done" ? "" : tool.state === "running" ? "running…" : tool.state;
        const disclosure = inline ? "" : `${expanded ? "▾" : "▸"} `;
        const fixed = Bun.stringWidth(` ${focus}● ${kind}`);
        const fullTarget = tool.target ? ` ${fitLine(tool.target, Number.MAX_SAFE_INTEGER)}` : "";
        const candidate = entry.toolStatus === "success" ? displayText(entry.resultSummary ?? "") : "";
        const summary = entry.toolName === "bash" && state && candidate ? `${state} · ${candidate}` : candidate;
        const result = summary && fixed + Bun.stringWidth(fullTarget) + Bun.stringWidth(summary) + Bun.stringWidth(disclosure) + (disclosure ? 1 : 0) + 1 <= inner ? summary : "";
        const right = entry.toolName === "bash" ? result || state : state || result;
        const rightWidth = Bun.stringWidth(right);
        const trailerWidth = Bun.stringWidth(disclosure) + (right && disclosure ? 1 : 0);
        const targetWidth = inner - fixed - rightWidth - trailerWidth - 1;
        const target = targetWidth > 1 && tool.target ? ` ${fitLine(tool.target, targetWidth - 1)}` : "";
        const gap = " ".repeat(Math.max(1, inner - fixed - Bun.stringWidth(target) - rightWidth - trailerWidth));
        paintLabel = () => {
          const glyph = status === "running" ? spinnerFrame(motion.now(), motion.mode) : tool.marker;
          label.content = new StyledText([
            fg(ink.accent)(` ${focus}`),
            bold(fg(ink[tool.tone])(glyph)),
            fg(ink.text)(" "),
            bold(bg(pillBg)(fg(color)(kind))),
            fg(ink.text)(target),
            fg(ink.muted)(gap),
            ...(right ? status === "running" ? shimmer(right, motion.now(), ink.muted, ink.text, motion.mode) : [fg(state ? ink[tool.tone] : ink.muted)(right)] : []),
            fg(ink.muted)(`${right && disclosure ? " " : ""}${disclosure}`),
          ]);
        };
        paintLabel();
        body.visible = detail.length > 0;
        root.marginBottom = detail ? 1 : 0;
        // Diffs keep explicit +/- markers on full-width tinted rows; ordinary output stays neutral.
        const isDiff = entry.toolName === "edit" || entry.toolName === "write";
        const bodyWidth = Math.max(1, width - 4);
        if (body instanceof TextRenderable) body.wrapMode = isDiff ? "char" : "word";
        const paintBody = () => {
          // Detail lines such as "HTTP 401 · application/json · 58 bytes" wrap at ` · ` instead of leaving a separator at a row end.
          const lines = detail.split("\n").flatMap(line => !isDiff && line.includes(" · ") ? wrapHintSegments(line, bodyWidth) : [line]);
          body.content = linkify(lines.flatMap((line, index) => {
            const numbered = isDiff ? line.match(/^(\s*\d+ │)([+-])(.*)$/) : null;
            const sign = numbered?.[2] === "+" ? theme.success : numbered?.[2] === "-" ? theme.error : undefined;
            const prefix = index ? "\n" : "";
            if (!sign) return [fg(ink.muted)(`${prefix}${line}`)];
            const used = Bun.stringWidth(line);
            const padded = line + " ".repeat(Math.max(0, Math.ceil(Math.max(1, used) / bodyWidth) * bodyWidth - used));
            // Line numbers stay quieter than the change but are measured on the diff tint they sit on.
            return [fg(ink.muted)(prefix), bg(tint(theme, sign))(fg(textOn(theme.muted, tint(theme, sign)))(numbered![1]!)), bg(tint(theme, sign))(fg(sign)(padded.slice(numbered![1]!.length)))];
          }));
        };
        paintBody();
        repaint = () => { paintLabel?.(); paintBody(); };
      } else {
        // A caret after a closing fence would turn that fence into code text, changing the
        // block's canonical source and inspection witness; leave such a frame caret-free.
        streamText = entry.kind === "assistant" && streaming && motion.mode !== "off" && (displayText(entry.text).match(/```/g)?.length ?? 0) % 2 === 0
          && !/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*$/.test(displayText(entry.text).trimEnd()) ? displayText(entry.text) : undefined;
        caretOn = undefined;
        // A fill change repaints with the new ink; rendered Markdown recolors in place without reparsing.
        const paintText = (refill: boolean) => {
          if (entry.kind === "assistant") {
            label.visible = !!entry.incomplete;
            label.content = entry.incomplete ? new StyledText([fg(ink.warning)("Incomplete response · not saved")]) : "";
          }
          const color = entry.kind === "error" ? ink.error : entry.kind === "system" ? ink.muted : ink.text;
          // Recovery lines such as "Ctrl+R continue · Esc keep editing" get key chips inside error blocks.
          // Notice and error lines wrap at ` · ` so a key never ends a row apart from its action; wrapped recovery rows keep their chips.
          const columns = Math.max(1, width - (entry.kind === "error" ? 3 : 0));
          const errorLines = (line: string, index: number): TextChunk[] => {
            const chips = entry.kind === "error" && HINT_KEY.test(line) && line.includes(" ");
            const rows = (entry.kind === "error" || entry.kind === "system") && line.includes(" · ") ? wrapHintSegments(line, columns) : [line];
            return rows.flatMap((row, rowIndex) => [...(index || rowIndex ? [fg(color)("\n")] : []),
              ...(chips ? keyHintChunks(row, { key: theme.text, chip: mixColor(errorBlock, theme.border, 0.9), action: ink.error }) : [fg(color)(row)])]);
          };
          if (body instanceof MarkdownRenderable && refill) {
            painters = painters.filter(painter => !painter.node.isDestroyed);
            pruneAt = Math.max(64, painters.length * 2);
            for (const painter of painters) painter.apply(ink);
          } else if (body instanceof MarkdownRenderable) {
            const content = streamText !== undefined ? caretContent() : displayText(entry.text);
            if (!body.streaming && body.content !== content) {
              // Finalized Markdown caches its parsed prefix; changed saved content needs a fresh parse.
              body.content = "";
              body.streaming = streaming;
            }
            body.content = content;
            body.streaming = streaming;
          } else {
            body.content = linkify(displayText(entry.text).split("\n").flatMap(errorLines));
            body.fg = color;
          }
          if (entry.kind === "assistant") {
            codeBlocks().forEach(({ id }, index) => {
              const code = root.findDescendantById(id) as BoxRenderable;
              const header = code.getChildren()[0] as BoxRenderable;
              const [label, , hint] = header.getChildren() as TextRenderable[];
              const focused = focusedCode === index;
              label!.content = codeTitle(codeData.get(code)!.title, focused, theme);
              header.backgroundColor = focused ? tint(theme, theme.accent) : theme.surface2;
              hint!.content = focused ? "R read · C copy · Esc back" : "Alt+I inspect";
              hint!.fg = focused ? theme.text : theme.muted;
            });
            for (const block of readableBlocks()) {
              if (block.kind !== "table") continue;
              const table = root.findDescendantById(block.id) as BoxRenderable;
              const header = table.getChildren()[0] as BoxRenderable;
              const [label, , hint] = header.getChildren() as TextRenderable[];
              const focused = focusedTable === block.index;
              label!.content = codeTitle("table", focused, theme);
              header.backgroundColor = focused ? tint(theme, theme.accent) : theme.surface2;
              hint!.content = focused ? "R read · C copy · Esc back" : "Alt+I inspect";
              hint!.fg = focused ? theme.text : theme.muted;
            }
          }
        };
        paintText(false);
        repaint = () => paintText(true);
      }
    },
  };
}
