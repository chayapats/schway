import { BoxRenderable, MarkdownRenderable, TextBufferRenderable, TextTableRenderable, TextRenderable, SyntaxStyle, StyledText, fg, bold, italic, underline, link, type BaseRenderable, type CliRenderer, type Renderable, type TextChunk } from "@opentui/core";
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

function markdownBlock(renderer: CliRenderer, token: MarkdownToken, theme: TuiTheme, registerCode: (box: BoxRenderable, text: string, title: string) => void): BoxRenderable | TextRenderable | undefined {
  // Tables and rules use OpenTUI's native structured widgets. Text uses the
  // already-tokenized Markdown AST so first paint never waits for a WASM download.
  if (token.type === "table" || token.type === "hr") return undefined;
  if (token.type === "code") {
    const block = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: theme.surface, paddingX: 1, marginTop: 1, marginBottom: 1 });
    const title = token.lang || "code";
    registerCode(block, token.text ?? "", title);
    block.add(new TextRenderable(renderer, { content: title, fg: theme.muted }));
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
          const rendered = markdownBlock(renderer, child, theme, registerCode);
          if (rendered) contents.add(rendered);
        }
        itemBox.add(contents);
        block.add(itemBox);
      }
    } else for (const child of token.tokens ?? []) {
      const rendered = markdownBlock(renderer, child, theme, registerCode);
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
  /** Return code blocks in rendered order with the exact sanitized representation shown by Markdown. */
  codeBlocks(): { id: string; text: string }[];
  /** Return visible text blocks and their exact rendered scroll targets. */
  searchSegments(): readonly { text: string; target: Renderable }[];
  /** Mark the selected search row without changing its rendered content. */
  setSearchMatch(selected: boolean): void;
  update(entry: TuiTranscriptEntry, expanded: boolean, streaming: boolean, width: number, focusedCode?: number, focusedTool?: boolean): void;
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
  const codeData = new WeakMap<BoxRenderable, { text: string; title: string }>();
  const registerCode = (box: BoxRenderable, text: string, title: string) => { codeData.set(box, { text, title }); };
  const renderMarkdownNode = (token: MarkdownToken) => markdownBlock(renderer, token, theme, registerCode);
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
  const label = new TextRenderable(renderer, { content: "", fg: theme.muted, flexShrink: 0 });
  const body = initial.kind === "assistant"
    ? new MarkdownRenderable(renderer, {
      content: "", syntaxStyle, fg: theme.text, streaming: true, internalBlockMode: "top-level",
      tableOptions: { style: "columns", wrapMode: "word", cellPaddingX: 1 },
      renderNode: renderMarkdownNode,
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
  let searchSelected = false;
  return {
    root,
    codeBlocks,
    searchSegments() {
      const segments: { text: string; target: Renderable }[] = [];
      const visit = (node: BaseRenderable) => {
        if (!node.visible) return;
        if (node instanceof TextBufferRenderable) {
          if (node.plainText) segments.push({ text: node.plainText, target: node });
          return;
        }
        if (node instanceof TextTableRenderable) {
          for (const cells of node.content) {
            const text = cells.map(cell => cell?.map(chunk => chunk.text).join("") ?? "").join("  ");
            if (text) segments.push({ text, target: node });
          }
          return;
        }
        for (const child of node.getChildren()) visit(child);
      };
      visit(root);
      return segments;
    },
    setSearchMatch(selected) {
      if (searchSelected === selected) return;
      searchSelected = selected;
      root.backgroundColor = selected ? theme.border : initial.kind === "user" ? theme.surface : undefined;
    },
    update(entry, expanded, streaming, width, focusedCode, focusedTool) {
      const next = JSON.stringify([entry.text, entry.toolSummary, entry.toolStatus, entry.incomplete, expanded, streaming, width, focusedCode, focusedTool]);
      if (next === fingerprint) return;
      fingerprint = next;
      if (entry.kind === "tool") {
        const tool = toolPresentation(entry, expanded);
        const suffix = ` · ${tool.state}`;
        const focusWidth = focusedTool ? 2 : 0;
        const name = fitLine(entry.toolName ?? "tool", Math.max(1, width - Bun.stringWidth(suffix) - 5 - focusWidth));
        const targetWidth = width - Bun.stringWidth(name + suffix) - 5 - focusWidth;
        const target = targetWidth > 0 && tool.target ? ` ${fitLine(tool.target, targetWidth)}` : "";
        label.content = new StyledText([
          fg(focusedTool ? theme.accent : theme.muted)(`${focusedTool ? "› " : ""}${expanded ? "▾" : "▸"} `),
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
        if (entry.kind === "assistant") {
          codeBlocks().forEach(({ id }, index) => {
            const code = root.findDescendantById(id) as BoxRenderable;
            const label = code.getChildren()[0] as TextRenderable;
            const title = codeData.get(code)!.title;
            label.content = `${focusedCode === index ? "› " : ""}${title}`;
            label.fg = focusedCode === index ? theme.accent : theme.muted;
          });
        }
      }
    },
  };
}
