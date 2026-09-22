import { expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

/** Read a repo-relative source file as text. */
async function source(path: string): Promise<string> {
  return Bun.file(join(import.meta.dir, "..", path)).text();
}

/** Run a command and collect piped output with its exit code. */async function runCommand(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
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

test("only shipped extension surfaces are present in the base harness", async () => {
  const entries = await readdir(join(import.meta.dir, "../src"));
  // Skills and explicit local tools are supported; broader orchestration remains deferred.
  expect(entries.includes("skills")).toBe(true);
  expect(entries.includes("extensions")).toBe(true);
  for (const deferred of ["server", "subagents", "workflows"]) {
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
  // URLs are stripped first so the pinned toolchain download does not trip the check.
  const travis = await source(".travis.yml");
  const lowered = travis.toLowerCase().replace(/https?:\/\/\S+/g, "");
  expect(/\bpublish\b/.test(lowered)).toBe(false);
  expect(/\brelease\b/.test(lowered)).toBe(false);
  expect(lowered.includes("typecheck")).toBe(true);
  expect(lowered).toContain("bun test");
});

test("npm pack installs the public extension API and completes a headless tool round trip", async () => {
  await withTempDir(async (dir) => {
    // Offline: pack the repository and inspect the artifact, never the checkout.
    const pack = Bun.spawn(["npm", "pack", "--pack-destination", dir, "--silent"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    expect(`${stdout}${stderr}`.toLowerCase().includes("error")).toBe(false);
    expect(exitCode).toBe(0);
    const tarball = stdout.trim().split("\n").at(-1) ?? "";
    expect(tarball.endsWith(".tgz")).toBe(true);

    const list = Bun.spawn(["tar", "-tzf", join(dir, tarball)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [entriesText, listExit] = await Promise.all([
      new Response(list.stdout).text(),
      list.exited,
    ]);
    expect(listExit).toBe(0);
    const entries = entriesText.split("\n").filter((line) => line.length > 0);
    for (const required of [
      "package/bin/schway",
      "package/src/cli/main.ts",
      "package/src/tui/app.ts",
      "package/src/extensions/index.ts",
      "package/src/extensions/loader.ts",
      "package/examples/extensions/greet.ts",
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
    ]) {
      expect(entries.includes(required)).toBe(true);
    }
    // Tests, CI config, and repo docs stay out of the installed artifact.
    expect(entries.some((entry) => entry.startsWith("package/tests/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("package/.github/"))).toBe(false);
    expect(entries.includes("package/.travis.yml")).toBe(false);

    // Install the tarball into an isolated directory and run the installed binary.
    // This step needs registry access for the runtime dependencies.
    const installDir = join(dir, "install");
    const installed = await runCommand(
      ["npm", "install", "--prefix", installDir, "--no-audit", "--no-fund", "--silent", join(dir, tarball), "@types/bun@1.4.2"],
      {},
    );
    expect(installed.exitCode).toBe(0);
    const help = await runCommand(
      [join(installDir, "node_modules", ".bin", "schway"), "--help"],
      {},
    );
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: schway");

    // A consumer uses only the public installed contract, with ordinary Bun types.
    await Bun.write(join(installDir, "greet.ts"), await Bun.file(join(installDir, "node_modules/schway/examples/extensions/greet.ts")).text());
    const checked = await runCommand([
      join(import.meta.dir, "../node_modules/.bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--moduleResolution", "bundler", "--module", "esnext", "--target", "esnext",
      "--allowImportingTsExtensions", "--types", "bun", "greet.ts",
    ], { cwd: installDir });
    expect(checked.stdout + checked.stderr).toBe("");
    expect(checked.exitCode).toBe(0);

    // Missing renderer and unused SDK packages prove the installed headless path stays lazy.
    for (const dependency of ["@opentui", "openai", "@anthropic-ai/sdk"]) {
      await rm(join(installDir, "node_modules", dependency), { recursive: true, force: true });
    }
    const marker = join(installDir, "disabled-ran");
    await Bun.write(join(installDir, "disabled.ts"), `await Bun.write(${JSON.stringify(marker)}, 'bad'); throw new Error('disabled extension ran');`);
    const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push(await request.json() as typeof requests[number]);
      const first = requests.length === 1;
      const delta = first
        ? { tool_calls: [{ index: 0, id: "greet-call", type: "function", function: { name: "greet", arguments: '{"name":"Ada"}' } }] }
        : { content: "Greeting complete" };
      return new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    } });
    const isolatedHome = join(dir, "home");
    await mkdir(isolatedHome);
    try {
      const conversation = await runCommand([
        join(installDir, "node_modules/.bin/schway"), "-p", "greet Ada", "--json",
        "--provider", "openai-compatible", "--base-url", `http://127.0.0.1:${server.port}/v1`,
        "--model", "fixture", "--auth", "none", "--extension", "greet.ts",
      ], { cwd: installDir, env: buildIsolatedCliEnv(isolatedHome) });
      expect(conversation.stderr).toBe("");
      expect(conversation.exitCode).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.tools?.some((tool) => tool.function.name === "greet")).toBe(true);
      expect(requests[1]!.messages?.filter((message) => message.role === "tool"))
        .toEqual([{ role: "tool", tool_call_id: "greet-call", content: "Hello, Ada!" }]);
      const events = conversation.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "tool.finished")).toMatchObject([
        { toolCallId: "greet-call", status: "success", content: "Hello, Ada!" },
      ]);
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
}, 180_000);

test("travis commands have no unquoted YAML mapping inside list items", async () => {
  // A `: ` inside an unquoted `- ` item parses as a mapping, not a command.
  // That silently breaks the CI step (e.g. `echo "unsupported arch: ..."`).
  const raw = await source(".travis.yml");
  const suspicious = raw
    .split("\n")
    .filter((line) => /^  - [^'\"]/.test(line) && line.includes(": "));
  expect(suspicious).toEqual([]);
});
