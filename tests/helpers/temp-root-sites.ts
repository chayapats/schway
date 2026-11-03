import { join, relative } from "node:path";

/** Kinds of direct temp-tree operations the cleanup ratchet counts: recursive removals and `mkdtemp` roots. */
export type TempSiteKind = "recursiveRemoval" | "mkdtemp";

/** One direct temp-tree operation found in a test source file. */
export interface TempSite { file: string; line: number; kind: TempSiteKind }

/** The guarded helpers themselves and this scanner, whose own text spells out the patterns. */
export const GUARDED_FILES = new Set(["tests/helpers.ts", "tests/helpers/temp-root-sites.ts"]);

// What the scanner catches, outside comments:
// - calls to rm, rmSync, rmdir and rmdirSync, or an `import { rm as … }` alias of them, whose argument text
//   says `recursive`; and every call to mkdtemp or mkdtempSync, or an import alias of them;
// - `rm` with -r, -R, -rf, -f -r or --recursive, and `find … -delete`, in shell text such as Bun.$ or exec;
// - argv for spawn, spawnSync, Bun.spawn, execFile and similar: a "rm" literal with a recursive flag literal,
//   or a "find" literal with "-delete", in the same call's argument list or the same array literal.
// What still escapes: options or flags held in a variable (`rm(dir, options)`), computed access such as
// `fs["rm"]`, destructuring renames (`const { rm: remove } = fs`), and removal done by code outside tests/.
// The tokenizer knows strings and comments but not regex literals, so a quote inside a regex can confuse it.
const IMPORT_CLAUSE = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\b/g;
const ALIAS = /(?<![\w$])(rm|rmSync|rmdir|rmdirSync|mkdtemp|mkdtempSync)\s+as\s+([A-Za-z_$][\w$]*)/g;
const REMOVAL_NAMES = ["rm", "rmSync", "rmdir", "rmdirSync"];
const MKDTEMP_NAMES = ["mkdtemp", "mkdtempSync"];
const SHELL_RM = /\brm\s+(?:--?[a-zA-Z][\w-]*\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/g;
const SHELL_FIND_DELETE = /\bfind\s[^\n;|&`]*?\s-delete\b/g;
const RECURSIVE_FLAG = /(["'`])(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\1/;
const DELETE_FLAG = /(["'`])-delete\1/;

/** A string literal with the bracket that directly encloses it, if any. */
interface Literal { value: string; start: number; end: number; opener?: { char: string; index: number } }

/**
 * One pass over `source`: the same text with comments blanked (offsets and newlines kept), every string
 * literal with its directly enclosing bracket, and the index of each bracket's matching close.
 */
function tokenize(source: string): { code: string; literals: Literal[]; closeOf: Map<number, number> } {
  const code = source.split("");
  const literals: Literal[] = [];
  const closeOf = new Map<number, number>();
  const stack: { char: string; index: number }[] = [];
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " "; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") { i++; continue; }
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 1;
    } else if (char === "\"" || char === "'" || char === "`") {
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) if (source[j] === "\\") j++;
      literals.push({ value: source.slice(i + 1, j), start: i, end: j + 1, opener: stack.at(-1) });
      i = j;
    } else if (char === "(" || char === "[" || char === "{") stack.push({ char, index: i });
    else if (char === ")" || char === "]" || char === "}") {
      const open = stack.pop();
      if (open) closeOf.set(open.index, i);
    }
  }
  return { code: code.join(""), literals, closeOf };
}

function escape(name: string): string {
  return name.replace(/[$]/g, "\\$");
}

/** Text of the call arguments that start at `open` (the index of `(`), up to its matching close; bounded. */
function callArguments(code: string, closeOf: Map<number, number>, open: number): string {
  return code.slice(open, Math.min(closeOf.get(open) ?? code.length, open + 4000) + 1);
}

/** Finds direct recursive removals and `mkdtemp` calls in one source text, with 1-based line numbers. */
export function findTempSites(file: string, source: string): TempSite[] {
  const sites: TempSite[] = [];
  const { code, literals, closeOf } = tokenize(source);
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const removal = new Set(REMOVAL_NAMES), mkdtemp = new Set(MKDTEMP_NAMES);
  for (const [, clause] of code.matchAll(IMPORT_CLAUSE)) {
    for (const [, original, alias] of clause!.matchAll(ALIAS)) (MKDTEMP_NAMES.includes(original!) ? mkdtemp : removal).add(alias!);
  }
  const call = (names: Set<string>) => new RegExp(`(?<![\\w$])(?:${[...names].map(escape).join("|")})\\s*\\(`, "g");
  for (const match of code.matchAll(call(removal))) {
    const open = match.index + match[0].length - 1;
    if (/\brecursive\b/.test(callArguments(code, closeOf, open))) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  }
  for (const match of code.matchAll(call(mkdtemp))) sites.push({ file, line: lineOf(match.index), kind: "mkdtemp" });
  for (const pattern of [SHELL_RM, SHELL_FIND_DELETE]) {
    for (const match of code.matchAll(pattern)) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  }
  for (const literal of literals) {
    if ((literal.value !== "rm" && literal.value !== "find") || !literal.opener || literal.opener.char === "{") continue;
    // Only the rest of this call's argument list or this array literal, including arrays nested in it.
    const rest = code.slice(literal.end, closeOf.get(literal.opener.index) ?? literal.end);
    if ((literal.value === "rm" ? RECURSIVE_FLAG : DELETE_FLAG).test(rest)) sites.push({ file, line: lineOf(literal.start), kind: "recursiveRemoval" });
  }
  return sites.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

/** Scans every `.ts`/`.tsx` file under `tests/` except the guarded helpers, in sorted file order. */
export async function scanTempSites(repo: string): Promise<TempSite[]> {
  const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: join(repo, "tests"), absolute: true }));
  const sites: TempSite[] = [];
  for (const path of files.sort()) {
    const file = relative(repo, path).split("\\").join("/");
    if (GUARDED_FILES.has(file)) continue;
    sites.push(...findTempSites(file, await Bun.file(path).text()));
  }
  return sites;
}

/** Per-file counts of each kind, keyed by repository-relative path, in sorted key order. */
export function countTempSites(sites: readonly TempSite[]): Record<string, Partial<Record<TempSiteKind, number>>> {
  const counts: Record<string, Partial<Record<TempSiteKind, number>>> = {};
  for (const site of [...sites].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const entry = counts[site.file] ??= {};
    entry[site.kind] = (entry[site.kind] ?? 0) + 1;
  }
  return counts;
}
