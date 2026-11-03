import { join, relative } from "node:path";

/** Kinds of direct temp-tree operations the cleanup ratchet counts: recursive removals and `mkdtemp` roots. */
export type TempSiteKind = "recursiveRemoval" | "mkdtemp";

/** One direct temp-tree operation found in a test source file. */
export interface TempSite { file: string; line: number; kind: TempSiteKind }

/** The guarded helpers themselves, plus this scanner and its test, whose own text spells out the patterns. */
export const GUARDED_FILES = new Set(["tests/helpers.ts", "tests/helpers/temp-root-sites.ts", "tests/temp-root-guard.test.ts"]);

const REMOVAL_CALL = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(/g;
const MKDTEMP_CALL = /\bmkdtemp(?:Sync)?\s*\(/g;
// `rm -r`/`rm -rf` in shell strings, and `["rm", "-rf", …]` argument lists.
const SHELL_REMOVAL = /\brm\s+-[a-zA-Z]*[rR]|["'`]rm["'`]\s*,\s*["'`]-[a-zA-Z]*[rR]/g;

/** Text of the call arguments that start at `open` (the index of `(`), skipping quoted strings; bounded for safety. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length && i < open + 4000; i++) {
    const char = source[i]!;
    if (char === "\"" || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (--depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open, open + 4000);
}

/** Finds direct recursive removals and `mkdtemp` calls in one source text, with 1-based line numbers. */
export function findTempSites(file: string, source: string): TempSite[] {
  const sites: TempSite[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(REMOVAL_CALL)) {
    const open = match.index + match[0].length - 1;
    if (/\brecursive\b/.test(callArguments(source, open))) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  }
  for (const match of source.matchAll(SHELL_REMOVAL)) sites.push({ file, line: lineOf(match.index), kind: "recursiveRemoval" });
  for (const match of source.matchAll(MKDTEMP_CALL)) sites.push({ file, line: lineOf(match.index), kind: "mkdtemp" });
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
