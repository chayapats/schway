import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");

/** Pack the current checkout and install the tarball into an isolated consumer. */
async function packAndInstall(dir: string): Promise<{ consumer: string; tarball: string }> {
  const packDir = join(dir, "pack");
  await mkdir(packDir, { recursive: true });
  const pack = Bun.spawn(["bun", "pm", "pack", "--destination", packDir], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [packOut, packErr, packCode] = await Promise.all([
    new Response(pack.stdout).text(), new Response(pack.stderr).text(), pack.exited,
  ]);
  expect(packCode, packOut + packErr).toBe(0);
  const entries = await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: packDir }));
  expect(entries.length).toBe(1);
  const tarball = join(packDir, entries[0]!);

  const consumer = join(dir, "consumer");
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  const pkg = { name: "release-consumer", version: "1.0.0", type: "module", dependencies: { schway: `file:${tarball}` } };
  await Bun.write(join(consumer, "package.json"), JSON.stringify(pkg, null, 2));
  const install = Bun.spawn(["bun", "install"], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
  const [installOut, installErr, installCode] = await Promise.all([
    new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited,
  ]);
  expect(installCode, installOut + installErr).toBe(0);

  const installed = join(consumer, "node_modules/schway");
  expect((await stat(installed)).isDirectory()).toBe(true);
  expect((await stat(installed)).isSymbolicLink()).toBe(false);
  expect(await Bun.file(join(installed, "package.json")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "dist/types/host/index.d.ts")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "src/host/index.ts")).exists()).toBe(true);
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  expect(manifest.exports["./host"]).toEqual({
    types: "./dist/types/host/index.d.ts", default: "./src/host/index.ts",
  });
  return { consumer, tarball };
}

/** Run the packed consumer with an import guard and isolated HOME. */
async function packedConsumer(consumer: string, input: Record<string, unknown>, guard: string): Promise<unknown> {
  await Bun.write(join(consumer, "consumer.ts"), await Bun.file(join(root, "tests/fixtures/host-release-consumer.ts")).text());
  await Bun.write(join(consumer, "guard.ts"), guard);
  const home = join(consumer, `home-${crypto.randomUUID()}`);
  await mkdir(home, { recursive: true });
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", join(consumer, "guard.ts"), join(consumer, "consumer.ts")], {
    cwd: consumer,
    env: buildIsolatedCliEnv(home),
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

test("packed release artifact installs without private source access and advertises release/v1", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-release-")));
  try {
    const { consumer } = await packAndInstall(dir);
    const fixture = await Bun.file(join(root, "tests/fixtures/host-release-consumer.ts")).text();
    expect(fixture).toContain('from "schway/host"');
    expect(fixture).not.toContain("schway/src");
    expect(fixture).not.toContain("schway/host/");
    expect(fixture).not.toMatch(/from ["']\.\.?\//);
    const result = await packedConsumer(consumer, { action: "capabilities" },
      `await Bun.plugin({name:'release-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui|agent|context|session|tools)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Discovery loaded runtime');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({
      contract: "schway.host.base/v1",
      releaseContract: "schway.host.release/v1",
      contextContract: "schway.host.context-policy/v1",
      toolContract: "schway.host.tool-policy/v1",
      sessionContract: "schway.host.durable-sessions/v1",
      authContract: "schway.host.auth-routes/v1",
      runContract: "schway.host.run-control/v1",
      dataContract: "schway.host.managed-session-data/v1",
      snapshotContract: "schway.host.session-snapshot/v1",
      observedInference: "not-checked",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("packed release consumer composes strict review, lifecycle, cancel and snapshot without private imports", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-release-")));
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work");
    const homeDirectory = join(consumer, "home");
    const sessionDirectory = join(consumer, "sessions");
    const restoreDirectory = join(consumer, "restored");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    const result = await packedConsumer(consumer,
      { action: "release", workspaceRoot, homeDirectory, sessionDirectory, restoreDirectory },
      `await Bun.plugin({name:'release-lifecycle-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Forbidden provider or TUI init');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({
      releaseContract: "schway.host.release/v1",
      completed: "completed",
      tooled: "completed",
      cancelled: "cancelled",
      retired: "closed",
      deleted: "deleted",
      executions: 1,
    });
    expect(["restored", "partial"]).toContain(result["restored"] as string);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("packed release consumer proves codex route isolation without fallback", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-release-")));
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work-codex");
    const homeDirectory = join(consumer, "home-codex");
    const sessionDirectory = join(consumer, "sessions-codex");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    const result = await packedConsumer(consumer,
      { action: "codex-route", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'release-codex-guard',setup(builder){
        builder.onLoad({filter:/providers\\/grok-subscription/},()=>{throw new Error('unselected grok loaded');});
        builder.onLoad({filter:/providers\\/xai\\.ts/},()=>{throw new Error('unselected xai loaded');});
        builder.onLoad({filter:/providers\\/openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers\\/openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/\\/tui\\//},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: "completed", observed: "observed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("packed release consumer proves grok route isolation without fallback", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-release-")));
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work-grok");
    const homeDirectory = join(consumer, "home-grok");
    const sessionDirectory = join(consumer, "sessions-grok");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    const result = await packedConsumer(consumer,
      { action: "grok-route", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'release-grok-guard',setup(builder){
        builder.onLoad({filter:/providers\\/codex-subscription/},()=>{throw new Error('unselected codex loaded');});
        builder.onLoad({filter:/providers\\/openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers\\/openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/\\/tui\\//},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: "completed", observed: "observed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("packed release consumer fixture imports only the public host entry", async () => {
  await withTempDir(async () => {
    const fixture = await Bun.file(join(root, "tests/fixtures/host-release-consumer.ts")).text();
    const specifiers = [...fixture.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
    for (const specifier of specifiers) {
      if (specifier === "schway" || specifier.startsWith("schway/")) expect(specifier).toBe("schway/host");
      expect(specifier.startsWith("."), `${specifier} must not use a relative import`).toBe(false);
      expect(specifier).not.toContain("src/host");
    }
    expect(fixture).not.toContain("node:fs");
  });
});
