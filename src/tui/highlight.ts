import { fg, type TextChunk } from "@opentui/core";
import type { TuiTheme } from "./theme.ts";

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "defer", "del",
  "do", "elif", "else", "enum", "except", "export", "extends", "false", "fi", "finally", "fn", "for", "from", "func", "function",
  "go", "if", "impl", "implements", "import", "in", "interface", "is", "lambda", "let", "loop", "match", "mod", "module", "mut",
  "new", "nil", "None", "not", "null", "of", "or", "and", "package", "pass", "private", "protected", "pub", "public", "raise",
  "readonly", "return", "self", "static", "struct", "super", "switch", "then", "this", "throw", "trait", "true", "True", "False",
  "try", "type", "typeof", "undefined", "use", "var", "void", "where", "while", "with", "yield", "done", "esac", "local",
]);
const TYPES = new Set(["string", "number", "boolean", "bigint", "symbol", "unknown", "never", "any", "object", "int", "float", "bool", "str", "i32", "i64", "u8", "u32", "u64", "usize", "f64", "String", "Vec", "Option", "Result", "Promise", "Record", "Array", "Map", "Set"]);

const TOKEN = /(\/\/[^\n]*|#(?![{[])[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(\s*\()?/g;
const HASH_COMMENTS = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "rb", "ruby", "yaml", "yml", "toml", "conf", "dockerfile", "make", "makefile"]);

/** Split code into theme-colored chunks with a small lexer; the concatenated text is always the input unchanged. */
export function highlightCode(code: string, lang: string | undefined, theme: TuiTheme): TextChunk[] {
  const hashComments = HASH_COMMENTS.has((lang ?? "").toLowerCase());
  const chunks: TextChunk[] = [];
  let last = 0;
  const plain = (end: number) => { if (end > last) chunks.push(fg(theme.code)(code.slice(last, end))); };
  for (const match of code.matchAll(TOKEN)) {
    const [whole, comment, string, number, word, call] = match;
    const start = match.index!;
    if (comment?.startsWith("#") && !hashComments) continue;
    plain(start);
    if (comment) chunks.push(fg(theme.muted)(comment));
    else if (string) chunks.push(fg(theme.success)(string));
    else if (number) chunks.push(fg(theme.warning)(number));
    else if (word) {
      const color = KEYWORDS.has(word) ? theme.violet : TYPES.has(word) || /^[A-Z][a-z]/.test(word) ? theme.cyan : call ? theme.accent : theme.text;
      chunks.push(fg(color)(word));
      if (call) chunks.push(fg(theme.text)(call));
    }
    last = start + whole.length;
  }
  plain(code.length);
  return chunks;
}
