import { BoxRenderable, MarkdownRenderable, TextRenderable, SyntaxStyle, StyledText, fg, bold, italic, underline, link, type CliRenderer, type TextChunk } from "@opentui/core";
import type { TuiTranscriptEntry } from "./controller.ts";
import { displayText, fitLine, toolPresentation } from "./presentation.ts";
import type { TuiTheme } from "./theme.ts";
import { browserUrl, linkify } from "./links.ts";

type MarkdownToken = {
  type: string; text?: string; raw?: string; lang?: string; href?: string;
  tokens?: MarkdownToken[]; items?: MarkdownToken[]; ordered?: boolean; start?: number | "";
  task?: boolean; checked?: boolean;
};

function inline(tokens: readonly MarkdownToken[], theme: TuiTheme, styles: { strong?: boolean; emphasis?: boolean; link?: boolean; code?: boolean; url?: string } = {}): TextChunk[] {
  return tokens.flatMap(token => {
    const next = { ...styles, strong: styles.strong || token.type === "strong", emphasis: styles.emphasis || token.type === "em", link: styles.link || token.type === "link", code: styles.code || token.type === "codespan", url: token.type === "link" ? browserUrl(token.href ?? "") : styles.url };
    if (token.tokens) {
      const children = inline(token.tokens, theme, next);
      if (token.type === "link" && token.href) children.push(next.url ? link(next.url)(fg(theme.muted)(` (${token.href})`)) : fg(theme.muted)(` (${token.href})`));
      return children;
    }
    let chunk = fg(next.code ? theme.code : next.link ? theme.accent : theme.text)(token.type === "br" ? "\n" : token.text ?? token.raw ?? "");
    if (next.strong) chunk = bold(chunk);
    if (next.emphasis) chunk = italic(chunk);
    if (next.link) chunk = underline(chunk);
    if (next.url) chunk = link(next.url)(chunk);
    return [chunk];
  });
}

function markdownBlock(renderer: CliRenderer, token: MarkdownToken, theme: TuiTheme): BoxRenderable | TextRenderable | undefined {
  // Tables and rules use OpenTUI's native structured widgets. Text uses the
  // already-tokenized Markdown AST so first paint never waits for a WASM download.
  if (token.type === "table" || token.type === "hr") return undefined;
  if (token.type === "code") {
    const block = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: theme.surface, paddingX: 1, marginTop: 1, marginBottom: 1 });
    block.add(new TextRenderable(renderer, { content: token.lang || "code", fg: theme.muted }));
    block.add(new TextRenderable(renderer, { content: linkify([fg(theme.code)(token.text ?? "")]), fg: theme.code, wrapMode: "word" }));
    return block;
  }
  if (token.type === "list" || token.type === "blockquote") {
    const block = new BoxRenderable(renderer, { flexDirection: "column", paddingLeft: 2, ...(token.type === "blockquote" ? { border: ["left" as const], borderColor: theme.border } : {}) });
    if (token.type === "list") {
      for (const [index, item] of (token.items ?? []).entries()) {
        const itemBox = new BoxRenderable(renderer, { flexDirection: "row" });
        const marker = item.task ? item.checked ? "[x] " : "[ ] " : token.ordered ? `${(token.start || 1) + index}. ` : "• ";
        itemBox.add(new TextRenderable(renderer, { content: marker, fg: theme.muted, flexShrink: 0 }));
        const contents = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
        for (const child of item.tokens ?? [{ type: "text", text: item.text }]) {
          const rendered = markdownBlock(renderer, child, theme);
          if (rendered) contents.add(rendered);
        }
        itemBox.add(contents);
        block.add(itemBox);
      }
    } else for (const child of token.tokens ?? []) {
      const rendered = markdownBlock(renderer, child, theme);
      if (rendered) block.add(rendered);
    }
    return block;
  }
  const chunks = inline(token.tokens ?? [{ type: "text", text: token.text ?? token.raw ?? "" }], theme, { strong: token.type === "heading" });
  return new TextRenderable(renderer, { content: linkify(chunks), fg: theme.text, wrapMode: "word" });
}

/** A stable transcript item whose text can change without replacing neighboring messages. */
export interface TranscriptItemView {
  root: BoxRenderable;
  update(entry: TuiTranscriptEntry, expanded: boolean, streaming: boolean, width: number): void;
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
export function createTranscriptItem(renderer: CliRenderer, initial: TuiTranscriptEntry, theme: TuiTheme, syntaxStyle: SyntaxStyle, toggleTool: () => void): TranscriptItemView {
  const root = new BoxRenderable(renderer, { id: `message-${initial.id}`, flexDirection: "column", flexShrink: 0, marginTop: initial.kind === "assistant" ? 1 : 0, marginBottom: initial.kind === "tool" ? 0 : 1 });
  const label = new TextRenderable(renderer, { content: "", fg: theme.muted, flexShrink: 0 });
  const body = initial.kind === "assistant"
    ? new MarkdownRenderable(renderer, {
      content: "", syntaxStyle, fg: theme.text, streaming: true, internalBlockMode: "top-level",
      tableOptions: { style: "columns", wrapMode: "word", cellPaddingX: 1 },
      renderNode: (token) => markdownBlock(renderer, token, theme),
    })
    : new TextRenderable(renderer, { content: "", fg: theme.text, wrapMode: "word" });
  if (initial.kind === "user") {
    root.backgroundColor = theme.surface;
    root.paddingX = 1;
    label.content = new StyledText([bold(fg(theme.accent)("› You"))]);
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
    body.paddingLeft = 2;
  } else if (initial.kind === "error") {
    label.content = new StyledText([bold(fg(theme.error)("! Error"))]);
    root.add(label);
  }
  root.add(body);
  let fingerprint = "";
  return {
    root,
    update(entry, expanded, streaming, width) {
      const next = JSON.stringify([entry.text, entry.toolSummary, entry.toolStatus, entry.incomplete, expanded, streaming, width]);
      if (next === fingerprint) return;
      fingerprint = next;
      if (entry.kind === "tool") {
        const tool = toolPresentation(entry, expanded);
        const suffix = ` · ${tool.state}`;
        const name = fitLine(entry.toolName ?? "tool", Math.max(1, width - Bun.stringWidth(suffix) - 5));
        const targetWidth = width - Bun.stringWidth(name + suffix) - 5;
        const target = targetWidth > 0 && tool.target ? ` ${fitLine(tool.target, targetWidth)}` : "";
        label.content = new StyledText([
          fg(theme.muted)(`${expanded ? "▾" : "▸"} `),
          fg(theme[tool.tone])(`${tool.marker} `),
          fg(theme.text)(name),
          fg(theme.muted)(target),
          fg(tool.state === "done" ? theme.muted : theme[tool.tone])(suffix),
        ]);
        body.visible = tool.detail.length > 0;
        root.marginBottom = tool.detail ? 1 : 0;
        // Diffs retain explicit +/- markers; ordinary output stays neutral.
        const isDiff = entry.toolName === "edit" || entry.toolName === "write";
        body.content = linkify(tool.detail.split("\n").map((line, index) =>
          fg(isDiff && line.startsWith("+") ? theme.success : isDiff && line.startsWith("-") ? theme.error : theme.muted)(`${index ? "\n" : ""}${line}`)));
      } else {
        if (entry.kind === "assistant") {
          label.visible = !!entry.incomplete;
          label.content = entry.incomplete ? new StyledText([fg(theme.warning)("Incomplete response · not saved")]) : "";
        }
        const color = entry.kind === "error" ? theme.error : entry.kind === "system" ? theme.muted : theme.text;
        body.content = body instanceof MarkdownRenderable ? displayText(entry.text) : linkify([fg(color)(displayText(entry.text))]);
        if (body instanceof MarkdownRenderable) body.streaming = streaming;
        else body.fg = entry.kind === "error" ? theme.error : entry.kind === "system" ? theme.muted : theme.text;
      }
    },
  };
}
