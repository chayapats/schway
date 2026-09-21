import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Read a repo-relative source file as text. */
async function source(path: string): Promise<string> {
  return Bun.file(join(import.meta.dir, "..", path)).text();
}

const CORE_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

test("single npm-compatible package exposes the schway executable", async () => {
  const pkg = (await Bun.file("package.json").json()) as {
    name: string;
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
    workspaces?: unknown;
  };
  expect(pkg.name).toBe("schway");
  expect(pkg.bin.schway).toBe("./bin/schway");
  expect(pkg.files).toContain("bin");
  expect(pkg.files).toContain("src");
  expect(pkg.files).toContain("README.md");
  // Single package, not a multi-package monorepo.
  expect(pkg.workspaces).toBeUndefined();
  expect(pkg.scripts.test).toBe("bun test");
  expect(pkg.scripts.typecheck).toContain("tsc");
  expect(await Bun.file("bun.lock").exists()).toBe(true);
  expect(await Bun.file("bin/schway").exists()).toBe(true);

  const bin = await source("bin/schway");
  expect(bin).toContain("src/cli/main.ts");
});

test("headless and interactive entry points wire all seven core tools", async () => {
  const cli = await source("src/cli/main.ts");
  const tui = await source("src/tui/app.ts");
  for (const tool of CORE_TOOLS) {
    expect(cli).toContain(`${tool}Tool`);
    expect(tui).toContain(`${tool}Tool`);
  }
  // Tool implementations exist for every advertised name.
  for (const tool of CORE_TOOLS) {
    expect(await Bun.file(`src/tools/${tool}.ts`).exists()).toBe(true);
  }
});

test("all three provider families are selectable with headless and interactive modes", async () => {
  const args = await source("src/cli/args.ts");
  for (const provider of ["anthropic", "openai", "openai-compatible"]) {
    expect(args).toContain(provider);
  }
  // Headless prompt mode, runtime JSONL streaming, and session resume.
  for (const flag of ["-p", "--json", "--resume"]) {
    expect(args).toContain(flag);
  }
  const loader = await source("src/model/loader.ts");
  for (const adapter of ["anthropic", "openai", "openai-compatible"]) {
    expect(loader).toContain(adapter);
  }
  // Interactive entry point exists alongside headless main.
  expect(await Bun.file("src/tui/app.ts").exists()).toBe(true);
  expect(await Bun.file("src/tui/controller.ts").exists()).toBe(true);
});

test("v0.1 keeps later-milestone surfaces out of the base harness", async () => {
  const entries = await readdir(join(import.meta.dir, "../src"));
  for (const deferred of ["skills", "extensions", "server", "subagents", "workflows"]) {
    expect(entries.includes(deferred)).toBe(false);
  }
  const cli = await source("src/cli/main.ts");
  const tui = await source("src/tui/app.ts");
  for (const surface of ["mcp", "subagent", "doctor", "keychain", "subscription"]) {
    expect(cli.toLowerCase().includes(surface)).toBe(false);
    expect(tui.toLowerCase().includes(surface)).toBe(false);
  }
});

test("validating the release artifact does not publish it", async () => {
  const pkg = (await Bun.file("package.json").json()) as {
    scripts: Record<string, string>;
  };
  const scriptText = Object.values(pkg.scripts).join("\n").toLowerCase();
  expect(scriptText.includes("npm publish")).toBe(false);
  expect(scriptText.includes("release")).toBe(false);
  // Travis CI validates with typecheck and tests only; no registry publish or release step.
  const travis = await source(".travis.yml");
  const lowered = travis.toLowerCase();
  expect(lowered.includes("publish")).toBe(false);
  expect(lowered.includes("release")).toBe(false);
  expect(lowered.includes("typecheck")).toBe(true);
  expect(lowered).toContain("bun test");
});
