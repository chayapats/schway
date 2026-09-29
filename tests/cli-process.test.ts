import { expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertIsolatedCliClean,
  buildIsolatedCliEnv,
  withIsolatedCliDirs,
} from "./helpers.ts";

const bin = join(import.meta.dir, "../bin/schway");

function spawnEnv(
  home: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  if (home === process.env.HOME) {
    throw new Error("CLI subprocess HOME must be an isolated temp dir");
  }
  return {
    ...buildIsolatedCliEnv(home, overrides),
    BUN_OPTIONS: `--preload ${join(import.meta.dir, "fixtures/credential-store-preload.ts")}`,
  };
}

async function spawnSchway(
  args: string[],
  options: { cwd: string; home: string; env?: Record<string, string | undefined> },
) {
  const env = spawnEnv(options.home, options.env);
  if (env.HOME !== options.home || env.HOME === process.env.HOME) {
    throw new Error("CLI subprocess did not use its isolated HOME");
  }
  const ambient = options.env ?? {};
  for (const credential of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (!(credential in ambient) && credential in env) {
      throw new Error(`Isolated CLI env leaked ${credential}`);
    }
  }
  const proc = Bun.spawn([bin, ...args], {
    cwd: options.cwd,
    env,
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
  await withIsolatedCliDirs(async (dirs) => {
    const result = await spawnSchway(["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"], {
      cwd: dirs.work,
      home: dirs.home,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing OpenAI API key");
    expect(result.stdout).toBe("");
    await assertIsolatedCliClean(dirs);
  });
});

test("schway -p --provider openai without credentials fails headlessly", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    const result = await spawnSchway(["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"], {
      cwd: dirs.work,
      home: dirs.home,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing OpenAI API key");
    expect(result.stderr).toContain("/login codex");
    expect(result.stdout).toBe("");
    await assertIsolatedCliClean(dirs);
  });
});

test("schway -p --provider openai-compatible without --base-url fails headlessly", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    const result = await spawnSchway(
      ["-p", "hello", "--provider", "openai-compatible"],
      { cwd: dirs.work, home: dirs.home },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing --base-url");
    expect(result.stdout).toBe("");
    await assertIsolatedCliClean(dirs);
  });
});

test("schway -p --provider openai-compatible --auth required without --api-key fails headlessly", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    const result = await spawnSchway(
      [
        "-p",
        "hello",
        "--provider",
        "openai-compatible",
        "--base-url",
        "http://127.0.0.1:9/v1",
        "--auth",
        "required",
        "--model",
        "gpt-4o",
      ],
      { cwd: dirs.work, home: dirs.home },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Missing API key for OpenAI-compatible endpoint",
    );
    expect(result.stderr.toLowerCase().includes("login")).toBe(false);
    expect(result.stdout).toBe("");
    await assertIsolatedCliClean(dirs);
  });
});

test("project .env files are not loaded automatically", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    await writeFile(join(dirs.work, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n");
    const result = await spawnSchway(["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"], {
      cwd: dirs.work,
      home: dirs.home,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing OpenAI API key");
    expect(result.stderr.includes("sk-from-dotenv")).toBe(false);
    await assertIsolatedCliClean(dirs);
  });
});

test("a missing --env-file path fails from the schway bin", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    await writeFile(join(dirs.work, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n");
    const result = await spawnSchway(
      ["-p", "hello", "--env-file", join(dirs.work, "missing.env")],
      { cwd: dirs.work, home: dirs.home },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing.env");
    expect(result.stderr.includes("sk-from-dotenv")).toBe(false);
    await assertIsolatedCliClean(dirs);
  });
});

test("a conflicting global compatible-provider fixture is honored without leaking", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    await mkdir(join(dirs.home, ".schway"), { recursive: true });
    const fixturePath = join(dirs.home, ".schway", "config.json");
    const fixture = JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      auth: "required",
    });
    await writeFile(fixturePath, `${fixture}\n`);
    expect(dirs.home).not.toBe(process.env.HOME);

    const fromGlobal = await spawnSchway(["-p", "hello", "--model", "gpt-4o"], {
      cwd: dirs.work,
      home: dirs.home,
    });
    expect(fromGlobal.exitCode).toBe(1);
    expect(fromGlobal.stderr).toContain(
      "Missing API key for OpenAI-compatible endpoint",
    );
    expect(fromGlobal.stdout).toBe("");

    const fixtureBaseUrl = await spawnSchway(
      ["-p", "hello", "--provider", "openai-compatible", "--model", "gpt-4o"],
      { cwd: dirs.work, home: dirs.home },
    );
    expect(fixtureBaseUrl.exitCode).toBe(1);
    expect(fixtureBaseUrl.stderr).toContain(
      "Missing API key for OpenAI-compatible endpoint",
    );
    expect(fixtureBaseUrl.stderr).not.toContain("Missing --base-url");
    expect(fixtureBaseUrl.stdout).toBe("");

    const cliOverridesGlobal = await spawnSchway(
      ["-p", "hello", "--provider", "openai", "--model", "gpt-5.4"],
      { cwd: dirs.work, home: dirs.home },
    );
    expect(cliOverridesGlobal.exitCode).toBe(1);
    expect(cliOverridesGlobal.stderr).toContain("Missing OpenAI API key");
    expect(cliOverridesGlobal.stdout).toBe("");

    for (const result of [fromGlobal, fixtureBaseUrl, cliOverridesGlobal]) {
      expect(result.stderr.toLowerCase()).not.toContain("econnrefused");
      expect(result.stderr.toLowerCase()).not.toContain("fetch failed");
    }
    expect(await Bun.file(fixturePath).text()).toBe(`${fixture}\n`);
    await assertIsolatedCliClean(dirs);
  });
});

test("isolation check detects an empty .schway dir outside HOME", async () => {
  await withIsolatedCliDirs(async (dirs) => {
    await mkdir(join(dirs.work, ".schway"), { recursive: true });
    await expect(assertIsolatedCliClean(dirs)).rejects.toThrow("outside HOME");
  });
});

test("isolated CLI dirs clean up after an assertion failure", async () => {
  let capturedRoot = "";
  await expect(
    withIsolatedCliDirs(async (dirs) => {
      capturedRoot = dirs.root;
      expect((await stat(dirs.sentinelPath)).isFile()).toBe(true);
      throw new Error("simulated assertion failure");
    }),
  ).rejects.toThrow("simulated assertion failure");
  let missing = false;
  try {
    await stat(capturedRoot);
  } catch {
    missing = true;
  }
  expect(missing).toBe(true);
});

test("the schway bin is executable", async () => {
  const info = await stat(bin);
  expect(info.mode & 0o111).not.toBe(0);
});
