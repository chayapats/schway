/** Default UTF-8 byte budget for the model-facing output of each core tool and of executor error results. */
export const TOOL_OUTPUT_BUDGET_BYTES = 50_000;

/** UTF-8 byte length of `text`; a lone surrogate counts as the 3 bytes of its U+FFFD encoding. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, cut on a code-point boundary,
 * so the cut never leaves a lone surrogate or a partial UTF-8 sequence.
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Each UTF-16 code unit encodes to at most 3 bytes, so short text needs no scan.
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    let size = 3;
    let units = 1;
    if (unit < 0x80) size = 1;
    else if (unit < 0x800) size = 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { size = 4; units = 2; }
    }
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += units;
  }
  return index === text.length ? text : text.slice(0, index);
}
