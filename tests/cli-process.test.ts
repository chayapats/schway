import { expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";

const bin = join(import.meta.dir, "../bin/schway");

function spawnEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "ANTHROPIC_API_KEY" &&
      key !== "OPENAI_API_KEY"
    ) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function spawnSchway(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) {
  const proc = Bun.spawn([bin, ...args], {
    cwd: options.cwd,
    env: spawnEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("package exposes the schway command and development scripts", async () => {
  const pkg = (await Bun.file("package.json").json()) as {
    bin: { schway: string };
    scripts: Record<string, string>;
  };
  expect(pkg.bin.schway).toBe("./bin/schway");
  expect(pkg.scripts.test).toBe("bun test");
  expect(pkg.scripts.dev).toContain("bun");
  expect(pkg.scripts.typecheck).toContain("tsc");
  expect(await Bun.file("bun.lock").exists()).toBe(true);
});

test("schway -p without credentials fails from a non-Git workspace", async () => {
  await withTempDir(async (dir) => {
    const result = await spawnSchway(["-p", "hello"], { cwd: dir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing Anthropic API key");
    expect(result.stdout).toBe("");
  });
});

test("schway -p --provider openai without credentials fails headlessly", async () => {
  await withTempDir(async (dir) => {
    const result = await spawnSchway(["-p", "hello", "--provider", "openai"], {
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing OpenAI API key");
    expect(result.stderr.toLowerCase().includes("login")).toBe(false);
    expect(result.stdout).toBe("");
  });
});

test("project .env files are not loaded automatically", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-from-dotenv\n");
    const result = await spawnSchway(["-p", "hello"], { cwd: dir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing Anthropic API key");
    expect(result.stderr.includes("sk-from-dotenv")).toBe(false);
  });
});

test("the schway bin is executable", async () => {
  const info = await stat(bin);
  expect(info.mode & 0o111).not.toBe(0);
});
