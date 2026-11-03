import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type * as TypeScript from "../../node_modules/@microsoft/api-extractor/node_modules/typescript/lib/typescript.js";

// The repository's `typescript` devDependency is TypeScript 7, whose parser lives in a native binary with no
// in-process API. @microsoft/api-extractor, also a devDependency, pins TypeScript 5.9.3 (see bun.lock), whose
// compiler API parses one file synchronously. Resolve it from api-extractor's own directory.
const ts = createRequire(Bun.resolveSync("@microsoft/api-extractor/package.json", import.meta.dir))("typescript") as typeof TypeScript;

/** Kinds of direct temp-tree operations the cleanup ratchet counts: recursive removals and `mkdtemp` roots. */
export type TempSiteKind = "recursiveRemoval" | "mkdtemp";

/** One direct temp-tree operation found in a test source file. */
export interface TempSite { file: string; line: number; kind: TempSiteKind }

/** The guarded helpers themselves and this scanner, whose own text spells out the patterns. */
export const GUARDED_FILES = new Set(["tests/helpers.ts", "tests/helpers/temp-root-sites.ts"]);

// The scanner parses each file with the TypeScript compiler, so comments, strings, regex literals and
// templates can't hide code from it. It counts:
// - calls to rm, rmSync, rmdir and rmdirSync whose options are `recursive: true` or not statically known (a
//   variable, a spread, a computed value), and every call to mkdtemp or mkdtempSync. A call matches by name,
//   by property (`fs.promises.rm`), by string element access (`fs["rm"]`) and through `import { rm as … }`;
// - argv: an array literal whose first element is "rm" with a recursive flag literal (-r, -R, -rf, -f -r,
//   --recursive) or "find" with "-delete"; a spawn, spawnSync, execFile or exec call whose first argument is
//   "rm" or "find" with those flags among its other arguments; and an object literal holding "rm" or "find"
//   in one property and the flags in an array property, as in `{ cmd: "rm", args: ["-rf", dir] }`;
// - shell text with `rm` and a recursive flag, or `find … -delete`, in a string or template passed to
//   Bun.$, spawn, spawnSync, Bun.spawn, execFile or exec, or following `sh -c` (or bash, zsh, dash) in argv;
// - all of the above inside a string or template that reads like a script (it has import, await or require
//   and more than one statement), such as the code a test passes to `bun --eval`.
// What still escapes: destructuring renames (`const { rm: remove } = fs`), a removal function or flag held in a
// variable (`const remove = fs.rm`, `["rm", flag, dir]`), shell text assembled at runtime, code inside strings
// that runs as a separate script when it doesn't read like one (no import, await or require), and removal done
// by code outside tests/.
const REMOVAL_NAMES = ["rm", "rmSync", "rmdir", "rmdirSync"];
const MKDTEMP_NAMES = ["mkdtemp", "mkdtempSync"];
const RUNNERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_RM = /\brm\s+(?:--?[a-zA-Z][\w-]*\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/g;
const SHELL_FIND_DELETE = /\bfind\s[^\n;|&]*?\s-delete\b/g;
const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const EMBEDDED_SCRIPT = /\b(?:import|await|require)\b[\s\S]*[;\n]|[;\n][\s\S]*\b(?:import|await|require)\b/;

/** Text of a string or template literal, with each `${…}` replaced by a placeholder; undefined otherwise. */
function literalText(node: TypeScript.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => ` \${…} ${span.literal.text}`).join("");
  return undefined;
}

/** Every string or template literal in `node`, including `node` itself and those nested in arrays or calls. */
function literalsWithin(node: TypeScript.Node): TypeScript.Node[] {
  const found: TypeScript.Node[] = [];
  const visit = (current: TypeScript.Node) => {
    if (literalText(current) !== undefined) found.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** The name a call or tag uses: an identifier, a property name, or a string element-access key. */
function calleeName(expression: TypeScript.Expression): { name: string; viaProperty: boolean } | undefined {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression)) expression = expression.expression;
  if (ts.isIdentifier(expression)) return { name: expression.text, viaProperty: false };
  if (ts.isPropertyAccessExpression(expression)) return { name: expression.name.text, viaProperty: true };
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) return { name: expression.argumentExpression.text, viaProperty: true };
  return undefined;
}

/** False only when the options argument is statically known not to request recursion. */
function mayRecurse(options: TypeScript.Expression | undefined): boolean {
  if (options === undefined) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  let recursive = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) recursive = true;
    else if (property.name && ts.isIdentifier(property.name) && property.name.text === "recursive") {
      recursive = !ts.isPropertyAssignment(property) || property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
    }
  }
  return recursive;
}

/** Whether argv items after the command include the flag that makes `rm` recursive or `find` delete. */
function hasArgvFlag(command: string, rest: readonly TypeScript.Node[]): boolean {
  return rest.flatMap(literalsWithin).some(node => {
    const text = literalText(node)!;
    return command === "rm" ? RECURSIVE_FLAG.test(text) : text === "-delete";
  });
}

/** Finds direct recursive removals and `mkdtemp` calls in one source text, with 1-based line numbers. */
export function findTempSites(file: string, source: string): TempSite[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: TempSite[] = [];
  const add = (node: TypeScript.Node, kind: TempSiteKind) =>
    sites.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, kind });
  const removal = new Set(REMOVAL_NAMES), mkdtemp = new Set(MKDTEMP_NAMES);
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const original = (specifier.propertyName ?? specifier.name).text;
      if (REMOVAL_NAMES.includes(original)) removal.add(specifier.name.text);
      if (MKDTEMP_NAMES.includes(original)) mkdtemp.add(specifier.name.text);
    }
  }
  const shellChecked = new Set<TypeScript.Node>();
  const checkShell = (node: TypeScript.Node) => {
    if (shellChecked.has(node)) return;
    shellChecked.add(node);
    const text = literalText(node)!;
    const matches = [SHELL_RM, SHELL_FIND_DELETE].reduce((count, pattern) => count + [...text.matchAll(pattern)].length, 0);
    for (let match = 0; match < matches; match++) add(node, "recursiveRemoval");
  };
  const command = (node: TypeScript.Node | undefined) => node && ts.isStringLiteralLike(node) && (node.text === "rm" || node.text === "find") ? node.text : undefined;
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      // Import aliases are bare identifiers; a property such as `x.remove` is only checked by its real name.
      const known = (names: Set<string>, originals: readonly string[]) => callee !== undefined && (callee.viaProperty ? originals.includes(callee.name) : names.has(callee.name));
      if (known(removal, REMOVAL_NAMES) && mayRecurse(node.arguments[1])) add(node, "recursiveRemoval");
      if (known(mkdtemp, MKDTEMP_NAMES)) add(node, "mkdtemp");
      if (callee && RUNNERS.has(callee.name)) {
        const name = command(node.arguments[0]);
        if (name && hasArgvFlag(name, node.arguments.slice(1))) add(node, "recursiveRemoval");
        for (const argument of node.arguments) literalsWithin(argument).forEach(checkShell);
      }
    } else if (ts.isTaggedTemplateExpression(node) && calleeName(node.tag)?.name === "$") {
      literalsWithin(node.template).forEach(checkShell);
    } else if (ts.isArrayLiteralExpression(node)) {
      const [first, ...rest] = node.elements;
      const name = command(first);
      if (name && hasArgvFlag(name, rest)) add(node, "recursiveRemoval");
      // `["sh", "-c", script]`: the script is shell text.
      node.elements.forEach((element, index) => {
        const flag = node.elements[index + 1], script = node.elements[index + 2];
        if (ts.isStringLiteralLike(element) && SHELLS.has(element.text) && flag && ts.isStringLiteralLike(flag) && flag.text === "-c" && script) {
          literalsWithin(script).forEach(checkShell);
        }
      });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      // A literal that reads like a script, such as the code passed to `bun --eval`, is parsed as code too.
      // Raw text keeps the source's line breaks, so the script's lines map back onto this file's.
      const raw = ts.isTemplateExpression(node)
        ? (node.head.rawText ?? "") + node.templateSpans.map(span => `__value__${span.literal.rawText ?? ""}`).join("")
        : ts.isNoSubstitutionTemplateLiteral(node) ? node.rawText ?? node.text : node.text;
      if (EMBEDDED_SCRIPT.test(raw)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
        for (const site of findTempSites(file, raw)) sites.push({ ...site, line: site.line + start });
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      const values = node.properties.flatMap(property => ts.isPropertyAssignment(property) ? [property.initializer] : []);
      const name = values.map(command).find(Boolean);
      if (name && hasArgvFlag(name, values.filter(ts.isArrayLiteralExpression))) add(node, "recursiveRemoval");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

/** Start offsets of every statement in `source`, at any depth, for probing the scanner at real code positions. */
export function statementStarts(file: string, source: string): number[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const starts: number[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of node.statements) starts.push(statement.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return starts.sort((a, b) => a - b);
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
