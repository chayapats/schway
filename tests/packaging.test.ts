import { expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
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

test("both provider families are selectable with headless and interactive modes", async () => {
  const args = await source("src/cli/args.ts");
  for (const provider of ["openai", "openai-compatible"]) {
    expect(args).toContain(provider);
  }
  expect(args).not.toContain('"anthropic"');
  // Headless prompt mode, runtime JSONL streaming, and session resume.
  for (const flag of ["-p", "--json", "--resume"]) {
    expect(args).toContain(flag);
  }
  const loader = await source("src/model/loader.ts");
  for (const adapter of ["openai", "openai-compatible"]) {
    expect(loader).toContain(adapter);
  }
  expect(loader).not.toContain("anthropic");
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
  // Server orchestration remains deferred; OS credential storage is supported.
  for (const surface of ["mcp", "subagent"]) {
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
      "package/examples/extensions/commands-and-events.ts",
      "package/examples/extensions/context.ts",
      "package/examples/extensions/tool-policy.ts",
      "package/examples/packages/greeting/package.json",
      "package/examples/packages/greeting/greet.ts",
      "package/examples/packages/greeting/skills/greeting/SKILL.md",
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/CHANGELOG.md",
      ...["configuration", "credentials", "diagnostics", "doctor", "evals", "extensions", "live-providers", "sessions", "workspaces"]
        .map((name) => `package/docs/${name}.md`),
    ]) {
      expect(entries.includes(required)).toBe(true);
    }
    // The removed Anthropic route leaves neither its adapter nor its SDK in the artifact.
    expect(entries.includes("package/src/model/providers/anthropic.ts")).toBe(false);
    const packedManifest = Bun.spawn(["tar", "-xzOf", join(dir, tarball), "package/package.json"], { stdout: "pipe", stderr: "pipe" });
    const manifestText = await new Response(packedManifest.stdout).text();
    expect(await packedManifest.exited).toBe(0);
    expect(manifestText.includes("@anthropic-ai/sdk")).toBe(false);
    // Tests, CI config, and repo docs stay out of the installed artifact.
    expect(entries.some((entry) => entry.startsWith("package/tests/"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("package/.github/"))).toBe(false);
    expect(entries.includes("package/.travis.yml")).toBe(false);
    expect(entries.includes("package/docs/releasing.md")).toBe(false);
    expect(entries.includes("package/docs/release-verification.md")).toBe(false);
    expect(entries.some((entry) => entry.startsWith("package/.scratch/"))).toBe(false);

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
    await Bun.write(join(installDir, "commands-and-events.ts"), await Bun.file(join(installDir, "node_modules/schway/examples/extensions/commands-and-events.ts")).text());
    await Bun.write(join(installDir, "context.ts"), await Bun.file(join(installDir, "node_modules/schway/examples/extensions/context.ts")).text());
    await Bun.write(join(installDir, "tool-policy.ts"), await Bun.file(join(installDir, "node_modules/schway/examples/extensions/tool-policy.ts")).text());
    // Install the shipped mixed package using npm, without publishing or a registry fixture.
    const packagePack = await runCommand(["npm", "pack", "--pack-destination", dir, "--silent"], {
      cwd: join(installDir, "node_modules/schway/examples/packages/greeting"),
    });
    expect(packagePack.exitCode).toBe(0);
    const packageInstall = await runCommand(["npm", "install", "--prefix", installDir, "--no-audit", "--no-fund", "--silent",
      join(dir, packagePack.stdout.trim().split("\n").at(-1)!)], {});
    expect(packageInstall.exitCode).toBe(0);
    await Bun.write(join(installDir, ".schway/config.json"), JSON.stringify({ packages: ["schway-example-greeting"] }));
    const checked = await runCommand([
      join(import.meta.dir, "../node_modules/.bin/tsc"), "--noEmit", "--strict", "--skipLibCheck",
      "--moduleResolution", "bundler", "--module", "esnext", "--target", "esnext",
      "--allowImportingTsExtensions", "--types", "bun", "greet.ts", "commands-and-events.ts", "context.ts", "tool-policy.ts",
      "node_modules/schway-example-greeting/greet.ts",
    ], { cwd: installDir });
    expect(checked.stdout + checked.stderr).toBe("");
    expect(checked.exitCode).toBe(0);

    // Missing renderer and unused SDK packages prove the installed headless path stays lazy.
    for (const dependency of ["@opentui", "openai", "@anthropic-ai/sdk"]) {
      await rm(join(installDir, "node_modules", dependency), { recursive: true, force: true });
    }
    const marker = join(installDir, "disabled-ran");
    await Bun.write(join(installDir, "disabled.ts"), `await Bun.write(${JSON.stringify(marker)}, 'bad'); throw new Error('disabled extension ran');`);
    const doctor = await runCommand([
      join(installDir, "node_modules/.bin/schway"), "doctor", "--json", "--provider", "openai-compatible",
      "--base-url", "http://127.0.0.1:11434/v1", "--auth", "none", "--extension", "disabled.ts",
    ], { cwd: installDir, env: buildIsolatedCliEnv(join(dir, "home")) });
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stderr).toBe("");
    expect(JSON.parse(doctor.stdout).checks.find((item: { id: string }) => item.id === "extensions")).toBeUndefined();
    expect(JSON.parse(doctor.stdout).checks.some((item: { id: string; status: string }) => item.id === "extension.0" && item.status === "ok")).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
    const requests: Array<{ model?: string; reasoning_effort?: string; tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
    const authorizations: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      authorizations.push(request.headers.get("authorization") ?? "");
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
    await Bun.write(join(installDir, "failing-observer.ts"),
      "export default ctx => ctx.onRuntimeEvent(() => { throw Error('observer fixture failure'); });");
    try {
      const conversation = await runCommand([
        join(installDir, "node_modules/.bin/schway"), "-p", "/greeting Ada", "--json",
        "--provider", "openai-compatible", "--base-url", `http://127.0.0.1:${server.port}/v1`,
        "--model", "fixture", "--auth", "none", "--debug-file", join(dir, "diagnostics.jsonl"),
        "--extension", "commands-and-events.ts", "--extension", "context.ts",
        "--extension", "tool-policy.ts", "--extension", "failing-observer.ts",
      ], { cwd: installDir, env: buildIsolatedCliEnv(isolatedHome) });
      expect(conversation.stderr).toContain("failing-observer.ts");
      expect(conversation.stderr).toContain("observer failed");
      expect(conversation.exitCode).toBe(0);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(JSON.stringify(request.messages)).toContain("Finish by reporting the greeting or error actually returned by the tool.");
        expect(JSON.stringify(request.messages)).toContain("Distinguish observed results from assumptions.");
        expect(JSON.stringify(request.messages)).toContain("Explain changed behavior, observed checks, and remaining limits concisely.");
        expect(JSON.stringify(request.messages)).toContain("Use relevant deterministic checks before reporting success.");
      }
      expect(requests[0]!.tools?.some((tool) => tool.function.name === "greet")).toBe(true);
      expect(requests[1]!.messages?.filter((message) => message.role === "tool"))
        .toEqual([{ role: "tool", tool_call_id: "greet-call", content: "Hello, Ada!\n[Tool policy reviewed greet.]" }]);
      const events = conversation.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(events.filter((event) => event.type === "tool.finished")).toMatchObject([
        { toolCallId: "greet-call", status: "success", content: "Hello, Ada!\n[Tool policy reviewed greet.]" },
      ]);
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(await Bun.file(marker).exists()).toBe(false);
      const diagnostics = await Bun.file(join(dir, "diagnostics.jsonl")).text();
      expect(diagnostics.trim().split("\n").every((line) => JSON.parse(line).runId)).toBe(true);
      expect(diagnostics).not.toContain("Hello, Ada!");
      expect(diagnostics).not.toContain("observer fixture failure");
      // The installed interactive controller uses the same package initializer and skill path.
      await Bun.write(join(installDir, "interactive-fixture.ts"), `
        import { loadExtensions } from './node_modules/schway/src/extensions/loader.ts';
        import { createToolRegistry } from './node_modules/schway/src/tools/registry.ts';
        import { createContextManager } from './node_modules/schway/src/context/manager.ts';
        import { createSession } from './node_modules/schway/src/session/session.ts';
        import { TuiController } from './node_modules/schway/src/tui/controller.ts';
        import { invokeSkillTurn } from './node_modules/schway/src/tui/app.ts';
        const workspace = { root: process.cwd(), launchCwd: process.cwd(), extraRoots: [] };
        const home = process.env.HOME;
        const loaded = await loadExtensions({ modules: [], workspace, home, tools: createToolRegistry() });
        const manager = createContextManager(workspace, { home });
        const session = createSession();
        let calls = 0;
        const model = { provider: 'scripted', id: 'fixture', async *stream(request) {
          if (!request.context.some(section => section.name === 'active-skill' && section.content.includes('call greet once'))) throw Error('missing packaged skill');
          if (!request.tools.some(tool => tool.name === 'greet')) throw Error('missing packaged tool');
          calls++;
          if (calls === 2 && !request.items.some(item => item.type === 'tool_result' && item.content === 'Hello, Ada!' && !item.isError)) throw Error('missing tool result');
          yield { type: 'message_complete', message: { type: 'assistant', id: 'reply-' + calls,
            content: calls === 1 ? [{ type: 'tool_call', id: 'interactive-greet', name: 'greet', arguments: { name: 'Ada' } }] : [{ type: 'text', text: 'done' }] } };
        } };
        const controller = new TuiController({ session, sessionId: 'installed', workspace, home, contextManager: manager,
          tools: loaded.tools, extensions: loaded.runtime, model, provider: 'scripted', modelId: 'fixture' });
        try {
          await invokeSkillTurn({ name: 'greeting', args: 'Ada', raw: '/greeting Ada' }, { controller, home, skillScope: { manager, workspaceRoot: workspace.root } });
          if (calls !== 2 || controller.snapshot().status !== 'idle') throw Error(JSON.stringify(controller.snapshot()));
          if (JSON.stringify(session.items).includes('call greet once')) throw Error('skill body persisted');
          console.log('installed interactive package round trip passed');
        } finally { controller.dispose(); }
      `);
      const interactive = await runCommand([process.execPath, "--no-env-file", "interactive-fixture.ts"], {
        cwd: installDir, env: buildIsolatedCliEnv(isolatedHome),
      });
      expect(interactive.stderr).toBe("");
      expect(interactive.exitCode).toBe(0);
      expect(interactive.stdout).toContain("installed interactive package round trip passed");

      // Run the combined workspace/branch gate inside the consumer, not via checkout imports.
      const fixture = await Bun.file(join(import.meta.dir, "fixtures/installed-workflow.ts")).text();
      await Bun.write(join(installDir, "installed-workflow.ts"),
        fixture.replaceAll("../../src/", "./node_modules/schway/src/"));
      const workflow = await runCommand([process.execPath, "--no-env-file", "installed-workflow.ts"], {
        cwd: installDir, env: buildIsolatedCliEnv(isolatedHome),
      });
      expect(workflow.stderr).toBe("");
      expect(workflow.exitCode).toBe(0);
      expect(JSON.parse(workflow.stdout).scenarios).toEqual([
        "attached-skill", "primary-tool-root", "branch-tree", "compaction-resume",
      ]);

      // Each profile must affect the actual outgoing request, never merely the display.
      const configPath = join(installDir, ".schway/config.json");
      await Bun.write(configPath, JSON.stringify({
        packages: ["schway-example-greeting"],
        profiles: {
          alpha: { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "fixture-alpha", auth: "required", credentialEnv: "GATE_ALPHA_KEY", extraBody: { reasoning_effort: "low" } },
          beta: { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "fixture-beta", auth: "required", credentialEnv: "GATE_BETA_KEY", extraBody: { reasoning_effort: "high" } },
        },
      }));
      const profileEnv = { ...buildIsolatedCliEnv(isolatedHome), GATE_ALPHA_KEY: "fixture-alpha-key", GATE_BETA_KEY: "fixture-beta-key" };
      for (const [name, model, effort, key] of [
        ["alpha", "fixture-alpha", "low", "fixture-alpha-key"],
        ["beta", "fixture-beta", "high", "fixture-beta-key"],
      ]) {
        const doctorProfile = await runCommand([join(installDir, "node_modules/.bin/schway"), "doctor", "--json", "--provider", "openai-compatible", "--profile", name!], { cwd: installDir, env: profileEnv });
        expect(doctorProfile.exitCode).toBe(0);
        expect(JSON.parse(doctorProfile.stdout)).toMatchObject({ profile: name, authSource: "environment" });
        const text = await runCommand([join(installDir, "node_modules/.bin/schway"), "-p", "hello", "--provider", "openai-compatible", "--profile", name!], { cwd: installDir, env: profileEnv });
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain("Greeting complete");
        expect(requests.at(-1)).toMatchObject({ model, reasoning_effort: effort });
        expect(authorizations.at(-1)).toBe(`Bearer ${key}`);
        expect(text.stdout + text.stderr + doctorProfile.stdout + doctorProfile.stderr).not.toContain(key!);
      }
      const brokenHome = join(dir, "broken-home");
      await Bun.write(join(brokenHome, ".schway", "sessions"), "not a directory");
      const broken = await runCommand([join(installDir, "node_modules/.bin/schway"), "doctor", "--json", "--provider", "openai-compatible", "--profile", "alpha"], { cwd: installDir, env: { ...profileEnv, HOME: brokenHome } });
      expect(broken.exitCode).toBe(1);
      expect(JSON.parse(broken.stdout).checks).toContainEqual(expect.objectContaining({ id: "sessions", status: "error" }));

      const gitDir = join(installDir, "git-fixture");
      const gitFixture = await Bun.file(join(import.meta.dir, "fixtures/installed-git.ts")).text();
      await Bun.write(join(gitDir, "installed-git.ts"),
        gitFixture.replaceAll("../../src/", "../node_modules/schway/src/"));
      const gitResult = await runCommand([process.execPath, "--no-env-file", "installed-git.ts"], {
        cwd: gitDir, env: buildIsolatedCliEnv(isolatedHome),
      });
      expect(gitResult.stderr).toBe("");
      expect(gitResult.exitCode).toBe(0);
      expect(JSON.parse(gitResult.stdout)).toMatchObject({ preExisting: ["tracked.txt"], newChanges: ["new.txt"] });

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
