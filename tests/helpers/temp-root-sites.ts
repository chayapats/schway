import { join, relative } from "node:path";

/** Kinds of direct temp-tree operations the cleanup ratchet counts: recursive removals and `mkdtemp` roots. */
export type TempSiteKind = "recursiveRemoval" | "mkdtemp";

/** One direct temp-tree operation found in a test source file. */
export interface TempSite { file: string; line: number; kind: TempSiteKind }

/** The guarded helpers themselves and this scanner, whose own text spells out the patterns. */
export const GUARDED_FILES = new Set(["tests/helpers.ts", "tests/helpers/temp-root-sites.ts"]);

// What the scanner catches:
// - calls to rm, rmSync, rmdir and rmdirSync, or an `import { rm as … }` alias of them, whose argument text
//   says `recursive`; and every call to mkdtemp or mkdtempSync, or an alias of them;
// - `rm` with -r, -R, -rf, -f -r or --recursive, and `find … -delete`, in shell text such as Bun.$ or exec;
// - argv lists for spawn, spawnSync, Bun.spawn, execFile and similar: a "rm" literal followed in the same
//   list or call by a recursive flag literal, or a "find" literal followed by "-delete".
// What still escapes: options or flags held in a variable (`rm(dir, options)`), computed access such as
// `fs["rm"]`, destructuring renames (`const { rm: remove } = fs`), and removal done by code outside tests/.
const ALIAS = /\b(rm|rmSync|rmdir|rmdirSync|mkdtemp|mkdtempSync)\s+as\s+([A-Za-z_$][\w$]*)/g;
const REMOVAL_NAMES = ["rm", "rmSync", "rmdir", "rmdirSync"];
const MKDTEMP_NAMES = ["mkdtemp", "mkdtempSync"];
const SHELL_RM = /\brm\s+(?:--?[a-zA-Z][\w-]*\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/g;
const SHELL_FIND_DELETE = /\bfind\s[^\n;|&`]*?\s-delete\b/g;
const ARGV_COMMAND = /(["'`])(rm|find)\1/g;
const RECURSIVE_FLAG = /(["'`])(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\1/;
const DELETE_FLAG = /(["'`])-delete\1/;

function escape(name: string): string {
  return name.replace(/[$]/g, "\\$");
}

/** Index just past the end of the list or call that encloses `start`, skipping quoted strings; bounded. */
function enclosingEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length && i < start + 4000; i++) {
    const char = source[i]!;
    if (char === "\"" || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (--depth < 0) return i;
    }
  }
  return Math.min(source.length, start + 4000);
}

/** Text of the call arguments that start at `open` (the index of `(`), skipping quoted strings; bounded. */
function callArguments(source: string, open: number): string {
  return source.slice(open, enclosingEnd(source, open + 1) + 1);
}

/** Finds direct recursive removals and `mkdtemp` calls in one source text, with 1-based line numbers. */
export function findTempSites(file: string, source: string): TempSite[] {
  const sites: TempSite[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const removal = new Set(REMOVAL_NAMES), mkdtemp = new Set(MKDTEMP_NAMES);
  for (const [, original, alias] of source.matchAll(ALIAS)) (MKDTEMP_NAMES.includes(original!) ? mkdtemp : removal).add(alias!);
  const call = (names: Set<string>) => new RegExp(`(?<![\\w$])(?:${[...names].map(escape).join("|")})\\s*\\(`, "g");
  for (const match of source.matchAll(call(removal))) {
    const open = match.index + match[0].length - 1;
    if (/\brecursive\b/.test(callArguments(source, open))) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  }
  for (const match of source.matchAll(call(mkdtemp))) sites.push({ file, line: lineOf(match.index), kind: "mkdtemp" });
  for (const pattern of [SHELL_RM, SHELL_FIND_DELETE]) {
    for (const match of source.matchAll(pattern)) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  }
  for (const match of source.matchAll(ARGV_COMMAND)) {
    const after = match.index + match[0].length;
    const rest = source.slice(after, enclosingEnd(source, after));
    if ((match[2] === "rm" ? RECURSIVE_FLAG : DELETE_FLAG).test(rest)) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
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
