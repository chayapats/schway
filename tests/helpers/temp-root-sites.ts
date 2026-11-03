import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type * as TypeScript from "../../node_modules/@microsoft/api-extractor/node_modules/typescript/lib/typescript.js";

// The repository's `typescript` devDependency is TypeScript 7, whose parser lives in a native binary with no
// in-process API. @microsoft/api-extractor, also a devDependency, pins TypeScript 5.9.3 (see bun.lock), whose
// compiler API parses one file synchronously. Resolve it from api-extractor's own directory, and refuse any
// other copy rather than fail later with an unrelated TypeError.
const API_EXTRACTOR_TYPESCRIPT = "the TypeScript copy that @microsoft/api-extractor installs (node_modules/@microsoft/api-extractor/node_modules/typescript)";
const ts = checkTypeScript5(loadApiExtractorTypeScript());

function loadApiExtractorTypeScript(): unknown {
  try {
    return createRequire(Bun.resolveSync("@microsoft/api-extractor/package.json", import.meta.dir))("typescript");
  } catch (error) {
    throw new Error(`The temp-site scanner needs ${API_EXTRACTOR_TYPESCRIPT}, but it couldn't be loaded. Run bun install.`, { cause: error });
  }
}

/** Returns `loaded` as the TypeScript 5 compiler API, or throws an error naming api-extractor's TypeScript copy. */
export function checkTypeScript5(loaded: unknown): typeof TypeScript {
  const candidate = (loaded ?? {}) as { version?: unknown; createSourceFile?: unknown };
  if (typeof candidate.createSourceFile !== "function" || !String(candidate.version).startsWith("5.")) {
    throw new Error(`The temp-site scanner needs the TypeScript 5 compiler API from ${API_EXTRACTOR_TYPESCRIPT}, but loaded TypeScript ${String(candidate.version)} without it.`);
  }
  return loaded as typeof TypeScript;
}

/** Kinds of direct temp-tree operations the cleanup ratchet counts: recursive removals and `mkdtemp` roots. */
export type TempSiteKind = "recursiveRemoval" | "mkdtemp";

/** One direct temp-tree operation found in a test source file. */
export interface TempSite { file: string; line: number; kind: TempSiteKind }

/** The guarded helpers themselves and this scanner, whose own text spells out the patterns. */
export const GUARDED_FILES = new Set(["tests/helpers.ts", "tests/helpers/temp-root-sites.ts"]);

// The scanner parses each file with the TypeScript compiler, so comments, regex literals and templates can't
// hide code from it, and counts each site once by its position in the source. It counts:
// - calls to rm, rmSync, rmdir and rmdirSync whose options are `recursive: true` (an identifier or string key)
//   or not statically known (a variable, a spread, a computed key, a callback), and every call to mkdtemp or
//   mkdtempSync. A call matches by name, by property (`fs.promises.rm`), by string element access (`fs["rm"]`)
//   and through `import { rm as … }`;
// - any call whose first argument is "rm" with a recursive flag literal (-r, -R, -rf, -f -r, --recursive)
//   among its other arguments, or "find" with "-delete"; any array literal that starts that way; and any object
//   literal holding "rm" or "find" in one property and the flags in an array property (`{ cmd, args }`);
// - shell text in any string or template literal: `rm` with a recursive flag, or `find … -delete`, wherever
//   the text goes (a variable, `sh -c`, a spawn or exec helper, a script written to a file);
// - all of the above inside a string or template that reads like a script (it has import, await or require
//   and more than one statement), such as the code a test passes to `bun --eval`.
// It errs on the side of counting: `git rm -r`, `store.rm(key, value)` and `fs.rm(file, callback)` count too.
// What still escapes: destructuring renames (`const { rm: remove } = fs`), a removal function held in a variable
// (`const remove = fs.rm`), a flag held in a variable (`["rm", flag, dir]`), shell text split across literals
// (`"rm" + " -rf"`), code in a script string that doesn't read like one, and removal done by code outside tests/.
const REMOVAL_NAMES = ["rm", "rmSync", "rmdir", "rmdirSync"];
const MKDTEMP_NAMES = ["mkdtemp", "mkdtempSync"];
const SHELL_RM = /\brm\s+(?:--?[a-zA-Z][\w-]*\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/g;
const SHELL_FIND_DELETE = /\bfind\s[^\n;|&]*?\s-delete\b/g;
const RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const EMBEDDED_SCRIPT = /\b(?:import|await|require)\b[\s\S]*[;\n]|[;\n][\s\S]*\b(?:import|await|require)\b/;

/**
 * The source text between a string or template literal's delimiters, the same length as in the file: each
 * `${…}` becomes underscores (an identifier, so script code still parses) and each escape becomes two spaces.
 */
function literalContent(node: TypeScript.Node, sourceFile: TypeScript.SourceFile): { text: string; offset: number } | undefined {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) return undefined;
  const start = node.getStart(sourceFile) + 1;
  let text = sourceFile.text.slice(start, node.getEnd() - 1);
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const from = span.expression.pos - 2 - start, to = span.literal.getStart(sourceFile) + 1 - start;
      text = text.slice(0, from) + "_".repeat(to - from) + text.slice(to);
    }
  }
  return { text: text.replace(/\\[\s\S]/g, "  "), offset: start };
}

/** The value of a plain string literal, as an argv item or command; undefined for anything else. */
function stringValue(node: TypeScript.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Every plain string literal in `nodes`, including those nested in arrays or calls. */
function stringsWithin(nodes: readonly TypeScript.Node[]): string[] {
  const found: string[] = [];
  const visit = (node: TypeScript.Node) => {
    const value = stringValue(node);
    if (value !== undefined) found.push(value);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
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

/** A property's statically known name: an identifier, a string or a literal computed key; undefined otherwise. */
function propertyName(name: TypeScript.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

/** False only when the options argument is statically known not to request recursion. */
function mayRecurse(options: TypeScript.Expression | undefined): boolean {
  if (options === undefined) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  let recursive = false;
  for (const property of options.properties) {
    const name = propertyName(property.name);
    if (ts.isSpreadAssignment(property) || (property.name && name === undefined)) recursive = true;
    else if (name === "recursive") recursive = !ts.isPropertyAssignment(property) || property.initializer.kind !== ts.SyntaxKind.FalseKeyword;
  }
  return recursive;
}

/** Whether `command` ("rm" or "find") is followed by its recursive or deleting flag among `rest`. */
function commandWithFlag(command: string | undefined, rest: readonly TypeScript.Node[]): boolean {
  if (command !== "rm" && command !== "find") return false;
  return stringsWithin(rest).some(value => command === "rm" ? RECURSIVE_FLAG.test(value) : value === "-delete");
}

/** Records the sites in `sourceFile` into `sites`, keyed by absolute position, shifting positions by `base`. */
function collectSites(sourceFile: TypeScript.SourceFile, base: number, sites: Map<string, { position: number; kind: TempSiteKind }>): void {
  const add = (position: number, kind: TempSiteKind) => sites.set(`${base + position}:${kind}`, { position: base + position, kind });
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
  const visit = (node: TypeScript.Node): void => {
    const at = node.getStart(sourceFile);
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      // Import aliases are bare identifiers; a property such as `x.remove` is only checked by its real name.
      const known = (names: Set<string>, originals: readonly string[]) => callee !== undefined && (callee.viaProperty ? originals.includes(callee.name) : names.has(callee.name));
      if (known(removal, REMOVAL_NAMES) && mayRecurse(node.arguments[1])) add(at, "recursiveRemoval");
      if (known(mkdtemp, MKDTEMP_NAMES)) add(at, "mkdtemp");
      if (commandWithFlag(stringValue(node.arguments[0]), node.arguments.slice(1))) add(at, "recursiveRemoval");
    } else if (ts.isArrayLiteralExpression(node)) {
      if (commandWithFlag(stringValue(node.elements[0]), node.elements.slice(1))) add(at, "recursiveRemoval");
    } else if (ts.isObjectLiteralExpression(node)) {
      const values = node.properties.flatMap(property => ts.isPropertyAssignment(property) ? [property.initializer] : []);
      const command = values.map(value => stringValue(value)).find(value => value === "rm" || value === "find");
      if (commandWithFlag(command, values.filter(ts.isArrayLiteralExpression))) add(at, "recursiveRemoval");
    }
    const content = literalContent(node, sourceFile);
    if (content) {
      for (const pattern of [SHELL_RM, SHELL_FIND_DELETE]) {
        for (const match of content.text.matchAll(pattern)) add(content.offset + match.index, "recursiveRemoval");
      }
      // A literal that reads like a script, such as the code passed to `bun --eval`, is parsed as code too. Its
      // content keeps the file's offsets, so a site it shares with the shell-text check above counts once.
      if (EMBEDDED_SCRIPT.test(content.text)) collectSites(parse(sourceFile.fileName, content.text), base + content.offset, sites);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function parse(file: string, source: string): TypeScript.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Finds direct recursive removals and `mkdtemp` calls in one source text, with 1-based line numbers. */
export function findTempSites(file: string, source: string): TempSite[] {
  const sourceFile = parse(file, source);
  const sites = new Map<string, { position: number; kind: TempSiteKind }>();
  collectSites(sourceFile, 0, sites);
  return [...sites.values()].sort((a, b) => a.position - b.position || a.kind.localeCompare(b.kind))
    .map(site => ({ file, line: sourceFile.getLineAndCharacterOfPosition(site.position).line + 1, kind: site.kind }));
}

/** Start offsets of every statement in `source`, at any depth, for probing the scanner at real code positions. */
export function statementStarts(file: string, source: string): number[] {
  const sourceFile = parse(file, source);
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
