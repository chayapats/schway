import { StyledText, TextBuffer, TextBufferView, TextRenderable, link, type TextChunk, type WidthMethod } from "@opentui/core";

/** Accept browser links without allowing terminal controls or executable URL schemes. */
export function browserUrl(value: string): string | undefined {
  if (/[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

/** Hit-test styled text when the native hyperlink registry rejects a long URL. */
export function textLinkAt(text: TextRenderable, x: number, y: number, widthMethod: WidthMethod): string | undefined {
  if (!text.chunks.some(chunk => chunk.link)) return undefined;
  const buffer = TextBuffer.create(widthMethod);
  const view = TextBufferView.create(buffer);
  try {
    buffer.setStyledText(text.content);
    view.setWrapMode(text.wrapMode);
    view.setWrapWidth(text.width);
    const localX = x - text.x;
    const localY = y - text.y;
    const width = view.lineInfo.lineWidthCols[localY];
    if (width === undefined || localX < 0 || localX >= width) return undefined;
    view.setLocalSelection(localX, localY, localX + 1, localY, undefined, undefined, "cell");
    const selection = view.getSelection();
    if (!selection) return undefined;
    view.setSelection(0, selection.start);
    const offset = view.getSelectedText().length;
    let end = 0;
    for (const chunk of text.chunks) {
      end += chunk.text.length;
      if (offset < end) return chunk.link ? browserUrl(chunk.link.url) : undefined;
    }
  } finally { view.destroy(); buffer.destroy(); }
}

/** Attach terminal hyperlink metadata to bare web URLs while retaining text styles. */
export function linkify(chunks: TextChunk[]): StyledText {
  return new StyledText(chunks.flatMap(chunk => {
    if (chunk.link) return [chunk];
    const result: TextChunk[] = [];
    let start = 0;
    for (const match of chunk.text.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
      let candidate = match[0].replace(/[.,;:!?]+$/, "");
      // A closing parenthesis belongs to the URL only when balanced in it.
      while (candidate.endsWith(")") && (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)) candidate = candidate.slice(0, -1);
      const url = browserUrl(candidate);
      if (!url) continue;
      if (match.index > start) result.push({ ...chunk, text: chunk.text.slice(start, match.index) });
      result.push(link(url)({ ...chunk, text: candidate }));
      start = match.index + candidate.length;
    }
    if (start < chunk.text.length) result.push({ ...chunk, text: chunk.text.slice(start) });
    return result;
  }));
}
