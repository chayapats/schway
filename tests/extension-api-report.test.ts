import { expect, test } from "bun:test";
import { resolve, relative, dirname } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Read checked-in contract evidence without depending on packed declarations. */
async function source(path: string): Promise<string> {
  return Bun.file(resolve(root, path)).text();
}

/** Extract named top-level declarations from API Extractor's generated report. */
function exportsIn(report: string): string[] {
  return [...report.matchAll(/^export (?:declare )?(?:type|interface|function|class|const|enum) (\w+)/gm)].map(match => match[1]!);
}

test("public extension API report matches emitted declarations", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/extension-api-report.ts"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}, 30_000);

test("only the public extensions subpath is exported, with shipped declarations", async () => {
  const pkg = JSON.parse(await source("package.json"));
  expect(pkg.exports).toEqual({ "./extensions": {
    types: "./dist/types/extensions/index.d.ts", default: "./src/extensions/index.ts",
  } });
  expect(pkg.scripts.prepack).toBe("bun scripts/build-extension-types.ts");
  expect(pkg.files).toContain("dist/types");
});

test("public API inventory lists each documented reachable export exactly once", async () => {
  const report = await source("api/extensions.api.md");
  expect(report).not.toContain("ae-forgotten-export");
  expect(report).not.toMatch(/\/\/[^\n]*\(undocumented\)\r?\nexport /);
  const section = (await source("docs/extensions.md")).split("## Public API\n")[1]!.split("\n## ")[0]!;
  const names = [...section.matchAll(/^\| `(\w+)` \| .+ \|$/gm)].map(match => match[1]!);
  expect(names.length).toBe(new Set(names).size);
  expect(names.sort()).toEqual(exportsIn(report).sort());
  // The sole ambient namespace is deliberate: ToolContext.env uses Node's environment contract.
  expect([...report.matchAll(/\b(?:NodeJS|Bun)\.\w+/g)].map(match => match[0])).toEqual(["NodeJS.ProcessEnv"]);
});

test("registration method documentation matches ExtensionContext in both directions", async () => {
  const report = await source("api/extensions.api.md");
  const context = report.split("export interface ExtensionContext {")[1]!.split("\n}")[0]!;
  const methods = [...context.matchAll(/^    (\w+)(?:<[^\n]+>)?\(/gm)].map(match => match[1]!);
  const doc = await source("docs/extensions.md");
  const section = doc.split("## Registration methods\n")[1]!.split("\n## ")[0]!;
  const names = [...section.matchAll(/^\| `(\w+)` \| .+ \|$/gm)].map(match => match[1]!);
  expect(names.length).toBe(new Set(names).size);
  expect(names.sort()).toEqual(methods.sort());
});

test("every example uses only the public Schway entry point", async () => {
  for await (const path of new Bun.Glob("examples/**/*.ts").scan({ cwd: root })) {
    const code = await source(path);
    const specifiers = [...code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)];
    for (const [, specifier] of specifiers) {
      if (specifier === "schway" || specifier!.startsWith("schway/")) expect(specifier, path).toBe("schway/extensions");
      if (specifier!.startsWith(".")) {
        const target = relative(resolve(root, "src"), resolve(root, dirname(path), specifier!));
        expect(target === "" || (!target.startsWith("../") && target !== ".."), `${path}: ${specifier}`).toBe(false);
      }
    }
  }
});
