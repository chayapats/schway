/** Elements whose content never reaches readable text. */
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg"]);
/** Elements whose content is literal text up to the matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(["title", "textarea"]);
/** Block elements that end the current line. */
const LINE_ELEMENTS = new Set([
  "address", "article", "aside", "body", "caption", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "footer", "form", "header", "hgroup", "html", "legend", "main", "menu", "nav", "option",
  "section", "summary",
]);
/** Block elements separated from neighbors by a blank line. */
const PARAGRAPH_ELEMENTS = new Set(["p", "blockquote", "table", "figure", "hr"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Deepest list level that adds indentation; deeper items keep this indent so output stays linear in input size. */
const MAX_LIST_INDENT = 6;
/** Noncharacters standing in for preformatted newlines, spaces and tabs during whitespace normalization. */
const PRE_NEWLINE = "\ufdd0";
const PRE_SPACE = "\ufdd1";
const PRE_TAB = "\ufdd2";

/** Named character references decoded in text; others stay literal. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", minus: "−",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  bull: "•", middot: "·", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", dagger: "†", Dagger: "‡",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", micro: "µ", permil: "‰",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞",
  iexcl: "¡", iquest: "¿", shy: "", zwj: "‍", zwnj: "‌", lrm: "", rlm: "",
  aacute: "á", Aacute: "Á", agrave: "à", Agrave: "À", acirc: "â", auml: "ä", Auml: "Ä", aring: "å", atilde: "ã", aelig: "æ",
  ccedil: "ç", Ccedil: "Ç", eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", ntilde: "ñ", Ntilde: "Ñ",
  oacute: "ó", Oacute: "Ó", ograve: "ò", ocirc: "ô", ouml: "ö", Ouml: "Ö", otilde: "õ", oslash: "ø", szlig: "ß",
  uacute: "ú", Uacute: "Ú", ugrave: "ù", ucirc: "û", uuml: "ü", Uuml: "Ü", yacute: "ý", yuml: "ÿ",
};
/** Names that browsers also decode without a trailing semicolon. */
const LEGACY_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);
/** Windows-1252 code points that numeric references in 0x80–0x9F denote. */
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** Decode HTML character references; unknown names stay literal and invalid code points become U+FFFD. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (match, body: string, semicolon: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1);
      const code = digits.length > 8 ? Number.NaN : Number.parseInt(digits, hex ? 16 : 10);
      const mapped = WINDOWS_1252[code] ?? code;
      if (!Number.isFinite(mapped) || mapped === 0 || mapped > 0x10ffff || (mapped >= 0xd800 && mapped <= 0xdfff)) return "�";
      return String.fromCodePoint(mapped);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined || (!semicolon && !LEGACY_ENTITIES.has(body))) return match;
    return named;
  });
}

/**
 * Convert an HTML or XHTML document to readable plain text without running scripts.
 * Drops script, style, noscript, template and svg content; keeps headings, paragraphs, list items,
 * table rows and preformatted blocks as lines; keeps link text; decodes entities and collapses whitespace outside
 * preformatted blocks. List indentation stops growing past six levels, so output stays linear in input size.
 */
export function htmlToText(html: string): string {
  const source = html.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  let hasOutput = false;
  let atLineStart = true;
  let lastChar = "";
  let pendingBreak = 0;
  let pendingPrefix = "";
  let pendingInline = "";
  let preDepth = 0;
  let skipPreNewline = false;
  let rowCells = 0;
  const lists: Array<{ ordered: boolean; count: number }> = [];

  const push = (text: string): void => {
    out.push(text);
    hasOutput = true;
    const tail = text.at(-1);
    lastChar = tail === undefined ? lastChar : tail === PRE_NEWLINE ? "\n" : tail === PRE_SPACE || tail === PRE_TAB ? " " : tail;
    atLineStart = lastChar === "\n";
  };
  const block = (lines: number): void => { pendingBreak = Math.max(pendingBreak, lines); pendingInline = ""; };
  const text = (raw: string): void => {
    // Page text, including decoded references such as &#xFDD0;, can never produce the placeholders.
    let value = decodeHtmlEntities(raw).replace(/[\ufdd0-\ufdd2]/g, "\ufffd");
    if (preDepth > 0) {
      if (skipPreNewline && value.startsWith("\n")) value = value.slice(1);
      skipPreNewline = false;
      value = value.replace(/[\n \t]/g, char => char === "\n" ? PRE_NEWLINE : char === " " ? PRE_SPACE : PRE_TAB);
    } else {
      value = value.replace(/[\s\u00a0]+/g, " ");
      if (atLineStart || pendingBreak > 0 || lastChar === " " || pendingInline) value = value.replace(/^ /, "");
    }
    if (!value) return;
    if (pendingBreak > 0) {
      const newlines = atLineStart ? pendingBreak - 1 : pendingBreak;
      if (hasOutput && newlines > 0) push("\n".repeat(newlines));
      pendingBreak = 0;
      atLineStart = true;
    }
    if (atLineStart && pendingPrefix) { push(pendingPrefix); pendingPrefix = ""; }
    else if (!atLineStart && pendingInline) push(lastChar === " " ? pendingInline.trimStart() : pendingInline);
    pendingInline = "";
    push(value);
  };
  const startTag = (name: string, selfClosing: boolean): void => {
    if (name === "br") { push("\n"); return; }
    if (HEADINGS.has(name)) { block(2); pendingPrefix = `${"#".repeat(Number(name[1]))} `; return; }
    if (name === "pre") { block(2); preDepth++; skipPreNewline = true; return; }
    if (name === "ul" || name === "ol") { block(lists.length > 0 ? 1 : 2); if (!selfClosing) lists.push({ ordered: name === "ol", count: 0 }); return; }
    if (name === "li") {
      const list = lists.at(-1);
      block(1);
      if (list) list.count++;
      pendingPrefix = `${"  ".repeat(Math.min(MAX_LIST_INDENT, Math.max(0, lists.length - 1)))}${list?.ordered ? `${list.count}. ` : "- "}`;
      return;
    }
    if (name === "tr") { block(1); rowCells = 0; return; }
    if (name === "td" || name === "th") { if (rowCells++ > 0) pendingInline = " | "; return; }
    if (PARAGRAPH_ELEMENTS.has(name)) { block(2); return; }
    if (LINE_ELEMENTS.has(name)) block(1);
  };
  const endTag = (name: string): void => {
    if (HEADINGS.has(name)) { block(2); pendingPrefix = ""; return; }
    if (name === "pre") { preDepth = Math.max(0, preDepth - 1); block(2); return; }
    if (name === "ul" || name === "ol") { lists.pop(); block(lists.length > 0 ? 1 : 2); pendingPrefix = ""; return; }
    if (name === "li" || name === "tr") { block(1); pendingPrefix = ""; return; }
    if (PARAGRAPH_ELEMENTS.has(name)) { block(2); return; }
    if (LINE_ELEMENTS.has(name)) block(1);
  };

  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)/y;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) { text(source.slice(index)); break; }
    if (open > index) text(source.slice(index, open));
    index = open;
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    tagPattern.lastIndex = index;
    const match = tagPattern.exec(source);
    if (!match) {
      const next = source[index + 1];
      if (next === "!" || next === "?") {
        const end = source.indexOf(">", index);
        index = end < 0 ? source.length : end + 1;
      } else {
        text("<");
        index++;
      }
      continue;
    }
    const tagEnd = findTagEnd(source, index + match[0].length);
    const name = match[2]!.toLowerCase();
    const closing = match[1] === "/";
    const selfClosing = source[tagEnd - 1] === "/";
    index = Math.min(tagEnd + 1, source.length);
    if (closing) { endTag(name); continue; }
    if ((DROPPED_ELEMENTS.has(name) || RAW_TEXT_ELEMENTS.has(name)) && !selfClosing) {
      const closer = new RegExp(`</${name}(?=[\\s/>])`, "gi");
      closer.lastIndex = index;
      const found = closer.exec(source);
      const contentEnd = found ? found.index : source.length;
      if (RAW_TEXT_ELEMENTS.has(name)) {
        if (name === "title") block(2);
        text(source.slice(index, contentEnd));
        if (name === "title") block(2);
      }
      const after = found ? source.indexOf(">", found.index) : -1;
      index = after < 0 ? source.length : after + 1;
      continue;
    }
    startTag(name, selfClosing);
  }

  const normalized = trimNewlines(out.join("")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n"));
  return trimNewlines(normalized.replace(/[\ufdd0-\ufdd2]/g, char => char === PRE_NEWLINE ? "\n" : char === PRE_SPACE ? " " : "\t"));
}

/** Remove leading and trailing newlines in linear time; an end-anchored regex backtracks quadratically on long runs. */
function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 10) start++;
  while (end > start && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(start, end);
}

/** Return the index of the `>` closing a tag, ignoring `>` inside quoted attribute values. */
function findTagEnd(source: string, from: number): number {
  let quote = "";
  let previous = "";
  for (let index = from; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if ((char === "\"" || char === "'") && previous === "=") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
    if (!/\s/.test(char)) previous = char;
  }
  return source.length;
}
