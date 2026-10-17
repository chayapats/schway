import { expect, test } from "bun:test";
import { resolve, relative, dirname } from "node:path";
import { chmod, mkdir, rename, symlink } from "node:fs/promises";
import { withTempDir } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");

/** Read checked-in contract evidence without depending on packed declarations. */
async function source(path: string): Promise<string> {
  return Bun.file(resolve(root, path)).text();
}

/** Extract named top-level declarations from API Extractor's generated report. */
function exportsIn(report: string): string[] {
  return [...report.matchAll(/^export (?:declare )?(?:type|interface|function|class|const|enum) (\w+)/gm)].map(match => match[1]!);
}

/** Copy the builder into a disposable repository whose compiler emits only a fixture declaration. */
async function buildFixture(directory: string): Promise<string> {
  const repo = resolve(directory, "repo");
  await Bun.write(resolve(repo, "scripts/build-extension-types.ts"), await source("scripts/build-extension-types.ts"));
  await Bun.write(resolve(repo, "src/keep.ts"), "source sentinel");
  await Bun.write(resolve(repo, "node_modules/keep.txt"), "dependency sentinel");
  await Bun.write(resolve(repo, "keep.txt"), "repository sentinel");
  await Bun.write(resolve(directory, "keep.txt"), "ancestor sentinel");
  const compiler = resolve(repo, "node_modules/.bin/tsc");
  await Bun.write(compiler, `#!/usr/bin/env bun
const out = process.argv[process.argv.indexOf('--outDir') + 1];
await Bun.write(out + '/extensions/index.d.ts', 'export type Fixture = string;');
`);
  await chmod(compiler, 0o755);
  return repo;
}

/** Run only the copied fixture builder and retain refusal diagnostics for assertions. */
async function buildTypes(repo: string, out?: string) {
  const proc = Bun.spawn([process.execPath, resolve(repo, "scripts/build-extension-types.ts"),
    ...(out === undefined ? [] : ["--out", out])], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("declaration cleanup refuses protected paths and ancestor symlink aliases without deleting sentinels", async () => {
  await withTempDir(async directory => {
    const repo = await buildFixture(directory);
    await symlink(repo, resolve(directory, "alias"), "dir");
    await mkdir(resolve(repo, "dist"));
    await symlink(resolve(repo, "src"), resolve(repo, "dist/source-alias"), "dir");
    for (const out of [".", "..", "src", "src/new", "node_modules", "node_modules/new", "scripts",
      "dist/source-alias/new", resolve(directory, "alias"), resolve(directory, "alias/src/new"),
      resolve(directory, "alias/node_modules/new")]) {
      const result = await buildTypes(repo, out);
      expect(result.exitCode, `${out}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Output overlaps repository sources or dependencies");
      expect(await Bun.file(resolve(repo, "keep.txt")).text()).toBe("repository sentinel");
      expect(await Bun.file(resolve(repo, "src/keep.ts")).text()).toBe("source sentinel");
      expect(await Bun.file(resolve(repo, "node_modules/keep.txt")).text()).toBe("dependency sentinel");
      expect(await Bun.file(resolve(directory, "keep.txt")).text()).toBe("ancestor sentinel");
    }
  });
});

test("declaration cleanup refuses existing non-generated directories even through aliases", async () => {
  await withTempDir(async directory => {
    const repo = await buildFixture(directory);
    const unrelated = resolve(directory, "unrelated");
    await Bun.write(resolve(unrelated, "keep.d.ts"), "declaration sentinel");
    await symlink(unrelated, resolve(directory, "alias"), "dir");
    for (const out of [unrelated, resolve(directory, "alias")]) {
      const result = await buildTypes(repo, out);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.stderr).toContain("not a generated declaration directory");
      expect(await Bun.file(resolve(unrelated, "keep.d.ts")).text()).toBe("declaration sentinel");
    }
  });
});

test("declaration output supports default and temporary rebuilds but refuses added user files and symlinks", async () => {
  await withTempDir(async directory => {
    const repo = await buildFixture(directory);
    for (const out of [undefined, resolve(directory, "temporary/types")]) {
      const destination = out ?? resolve(repo, "dist/types");
      const first = await buildTypes(repo, out);
      expect(first.exitCode, first.stderr).toBe(0);
      await Bun.write(resolve(destination, "stale.d.ts"), "old generated declaration");
      const second = await buildTypes(repo, out);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(await Bun.file(resolve(destination, "stale.d.ts")).exists()).toBe(false);
      expect(await Bun.file(resolve(destination, "extensions/index.d.ts")).text()).toBe("export type Fixture = string;");
    }
    const destination = resolve(repo, "dist/types");
    await Bun.write(resolve(destination, "keep.txt"), "user sentinel");
    expect((await buildTypes(repo)).exitCode).toBe(1);
    expect(await Bun.file(resolve(destination, "keep.txt")).text()).toBe("user sentinel");
    const temporary = resolve(directory, "temporary/types");
    await symlink(resolve(repo, "src"), resolve(temporary, "alias"), "dir");
    expect((await buildTypes(repo, temporary)).exitCode).toBe(1);
    expect(await Bun.file(resolve(repo, "src/keep.ts")).text()).toBe("source sentinel");
  });
});

test("declaration cleanup refuses a symlinked root marker even when its signature is valid", async () => {
  await withTempDir(async directory => {
    const repo = await buildFixture(directory);
    const out = resolve(directory, "generated");
    const generated = await buildTypes(repo, out);
    expect(generated.exitCode, generated.stderr).toBe(0);
    const marker = resolve(out, ".schway-extension-types");
    const retained = resolve(directory, "retained-marker");
    const signature = await Bun.file(marker).text();
    await rename(marker, retained);
    await symlink(retained, marker);
    const result = await buildTypes(repo, out);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain("not a generated declaration directory");
    expect(await Bun.file(retained).text()).toBe(signature);
    expect(await Bun.file(resolve(out, "extensions/index.d.ts")).text()).toBe("export type Fixture = string;");
  });
});

test("public extension API report matches emitted declarations", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/extension-api-report.ts"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}, 30_000);

test("public host API report matches emitted declarations", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/extension-api-report.ts", "--host"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(exitCode, stdout + stderr).toBe(0);
}, 30_000);

test("host API inventory covers every documented reachable export once", async () => {
  const report = await source("api/host.api.md");
  expect(report).not.toContain("ae-forgotten-export");
  expect(report).not.toMatch(/\/\/[^\n]*\(undocumented\)\r?\nexport /);
  expect(report).not.toMatch(/\b(?:NodeJS|Bun)\./);
  const section = (await source("docs/host.md")).split("## Public API\n")[1]!.split("\n## ")[0]!;
  const names = [...section.matchAll(/^\| `(\w+)` \| .+ \|$/gm)].map(match => match[1]!);
  expect(names.length).toBe(new Set(names).size);
  expect(names.sort()).toEqual(exportsIn(report).sort());
});

test("only the public extensions and host subpaths are exported, with shipped declarations", async () => {
  const pkg = JSON.parse(await source("package.json"));
  expect(pkg.exports).toEqual({ "./extensions": {
    types: "./dist/types/extensions/index.d.ts", default: "./src/extensions/index.ts",
  }, "./host": {
    types: "./dist/types/host/index.d.ts", default: "./src/host/index.ts",
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
  expect(report).not.toMatch(/\b(?:NodeJS|Bun)\./);
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
      if (specifier === "schway" || specifier!.startsWith("schway/")) expect(["schway/extensions", "schway/host"]).toContain(specifier!);
      if (specifier!.startsWith(".")) {
        const target = relative(resolve(root, "src"), resolve(root, dirname(path), specifier!));
        expect(target === "" || (!target.startsWith("../") && target !== ".."), `${path}: ${specifier}`).toBe(false);
      }
    }
  }
});
