import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { buildIsolatedCliEnv, makeTempRoot, removeTempRoot, withTempDir } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");

/** This checkout's short commit, or undefined when it isn't the top of a Git work tree (a copy without .git). */
function checkoutRevision(): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel", "--short=7", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [toplevel, revision] = result.stdout.toString().trim().split("\n");
    if (result.exitCode !== 0 || !toplevel || !revision) return undefined;
    return realpathSync(toplevel) === realpathSync(root) ? revision : undefined;
  } catch { return undefined; }
}

/**
 * Check that `path` is a `schway-<version>-<short-sha>.tgz` packed from this checkout: its name and its packed
 * manifest carry this package.json version, and its short SHA is this commit's when Git can tell.
 */
async function checkPrebuiltTarball(path: string): Promise<string> {
  const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version;
  const refuse = (reason: string): never => {
    throw new Error(`SCHWAY_PACKED_TARBALL=${path} ${reason}. Unset it to pack this checkout, or point it at the schway-${version}-<short-sha>.tgz packed from this commit.`);
  };
  if (!isAbsolute(path)) refuse("is not an absolute path");
  const name = /^schway-(.+)-([0-9a-f]{7,40})\.tgz$/.exec(basename(path)) ?? refuse("is not named schway-<version>-<short-sha>.tgz");
  if (name[1] !== version) refuse(`is named for version ${name[1]}, but package.json has ${version}`);
  const revision = checkoutRevision();
  if (revision !== undefined && name[2] !== revision) refuse(`was packed from ${name[2]}, but this checkout is at ${revision}`);
  const manifest = Bun.spawnSync(["tar", "-xzOf", path, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
  if (manifest.exitCode !== 0) refuse("can't be read as a package tarball");
  const packed = (JSON.parse(manifest.stdout.toString()) as { version?: string }).version;
  if (packed !== version) refuse(`contains version ${packed}, but package.json has ${version}`);
  return path;
}

/**
 * Pack the current checkout, or copy the prebuilt tarball named by `SCHWAY_PACKED_TARBALL` (CI's
 * uploaded artifact, checked against this checkout first), and install it into an isolated consumer.
 */
async function packAndInstall(dir: string): Promise<{ consumer: string; tarball: string }> {
  const packDir = join(dir, "pack");
  await mkdir(packDir, { recursive: true });
  const prebuilt = process.env.SCHWAY_PACKED_TARBALL?.trim();
  if (prebuilt) {
    await copyFile(await checkPrebuiltTarball(prebuilt), join(packDir, basename(prebuilt)));
  } else {
    const pack = Bun.spawn(["bun", "pm", "pack", "--destination", packDir], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [packOut, packErr, packCode] = await Promise.all([
      new Response(pack.stdout).text(), new Response(pack.stderr).text(), pack.exited,
    ]);
    expect(packCode, packOut + packErr).toBe(0);
  }
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
  expect((await lstat(installed)).isSymbolicLink()).toBe(false);
  await expect(readlink(installed)).rejects.toThrow();
  expect(await Bun.file(join(installed, "package.json")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "dist/types/host/index.d.ts")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "src/host/index.ts")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "examples/host/review.ts")).exists()).toBe(true);
  expect(await Bun.file(join(installed, "docs/host.md")).exists()).toBe(true);
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

test("packed release artifact installs without private source access and advertises release/v2", async () => {
  const dir = await makeTempRoot("schway-release-");
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
      releaseContract: "schway.host.release/v2",
      coreToolsContract: "schway.host.core-tools/v1",
      webToolsContract: "schway.host.web-tools/v1",
      modelCatalog: "schway.host.model-catalog/v1",
      contextContract: "schway.host.context-policy/v1",
      toolContract: "schway.host.tool-policy/v1",
      sessionContract: "schway.host.durable-sessions/v1",
      authContract: "schway.host.auth-routes/v1",
      credentialLifecycleContract: "schway.host.credential-lifecycle/v1",
      sessionInventoryContract: "schway.host.session-inventory/v1",
      runContract: "schway.host.run-control/v1",
      dataContract: "schway.host.managed-session-data/v1",
      snapshotContract: "schway.host.session-snapshot/v1",
      dispatchAuthorizationContract: "schway.host.dispatch-authorization/v1",
      routeRenewalContract: "schway.host.route-renewal/v1",
      providerRequestsContract: "schway.host.provider-requests/v1",
      effortContract: "schway.host.effort/v1",
      outputCapContract: "schway.host.output-cap/v1",
      observedInference: "not-checked",
    });
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

test("packed release consumer composes strict review, lifecycle, cancel and snapshot without private imports", async () => {
  const dir = await makeTempRoot("schway-release-");
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
      releaseContract: "schway.host.release/v2",
      completed: "completed",
      tooled: "completed",
      cancelled: "cancelled",
      retired: "closed",
      deleted: "deleted",
      executions: 1,
    });
    expect(["restored", "partial"]).toContain(result["restored"] as string);
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

test("packed release consumer discovers and retires orphans through metadata only", async () => {
  const dir = await makeTempRoot("schway-release-");
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work"), homeDirectory = join(consumer, "home"), sessionDirectory = join(consumer, "sessions");
    await mkdir(workspaceRoot); await mkdir(homeDirectory);
    expect(await packedConsumer(consumer, { action: "inventory", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'inventory-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Metadata loaded provider or TUI');});
      }});`)).toEqual({ retired: "retired", deleted: "deleted", retry: "already-deleted", tombstone: "deleted" });
  } finally { await removeTempRoot(dir); }
}, 120_000);

test("packed release consumer runs core tools over a fake backend through the exact policy", async () => {
  const dir = await makeTempRoot("schway-release-");
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work-core");
    const homeDirectory = join(consumer, "home-core");
    const sessionDirectory = join(consumer, "sessions-core");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    const result = await packedConsumer(consumer,
      { action: "core-tools", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'release-core-tools-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Forbidden provider or TUI init');});
      }});`) as Record<string, unknown>;
    expect(result).toEqual({
      outcome: "completed",
      advertised: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      results: [
        { id: "bash-1", content: "Exit code: 1\n\nstdout:\nbuilt\n", isError: false },
        { id: "write-1", content: "Wrote out/result.txt", isError: false },
      ],
      calls: [
        'spawn make @ /box/workspace env={"PATH":"/usr/bin"}',
        "realpath /box/workspace",
        "realpath /box/workspace/out/result.txt",
        "realpath /box/workspace/out",
        "realpath /box/workspace",
        "observeFile /box/workspace/out/result.txt",
        "writeFileAtomically /box/workspace/out/result.txt",
      ],
      written: "box result\n",
    });
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

test("packed release consumer proves codex route isolation without fallback", async () => {
  const dir = await makeTempRoot("schway-release-");
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
        builder.onLoad({filter:/providers[/\\\\]grok-subscription/},()=>{throw new Error('unselected grok loaded');});
        builder.onLoad({filter:/providers[/\\\\]xai\\.ts/},()=>{throw new Error('unselected xai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/[/\\\\]tui[/\\\\]/},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: "completed", observed: "observed" });
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

test("packed release consumer proves grok route isolation without fallback", async () => {
  const dir = await makeTempRoot("schway-release-");
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
        builder.onLoad({filter:/providers[/\\\\]codex-subscription/},()=>{throw new Error('unselected codex loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/[/\\\\]tui[/\\\\]/},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: "completed", observed: "observed" });
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

test("packed release consumer authorizes each grok dispatch and reads exact provider requests", async () => {
  const dir = await makeTempRoot("schway-release-");
  try {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "work-dispatch"), homeDirectory = join(consumer, "home-dispatch"), sessionDirectory = join(consumer, "sessions-dispatch");
    await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
    const result = await packedConsumer(consumer, { action: "dispatch", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'release-dispatch-guard',setup(builder){
        builder.onLoad({filter:/providers[/\\\\]codex-subscription/},()=>{throw new Error('unselected codex loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/[/\\\\]tui[/\\\\]/},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`);
    expect(result).toEqual({
      caps: { dispatch: "schway.host.dispatch-authorization/v1", providerRequests: "schway.host.provider-requests/v1" },
      kinds: ["initial:1", "auth-retry:2"], hashesMatch: true,
      completed: { initialSends: 1, authRetrySends: 1, renewalRequests: 1 },
      refused: { status: "dispatch-refused", inferences: 1, providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 1 } },
      directRefused: true, renewals: 2,
      readiness: { aborted: "AbortError", timedOut: "TimeoutError" },
      effort: { contract: "schway.host.effort/v1",
        support: { levels: ["low", "high"], offSendable: false, default: "high", evidence: "account-catalog" },
        dispatch: [{ requested: "low", sent: "low" }], attempts: [{ requested: "low", sent: "low", reported: null }], body: "low", invalidPin: "invalid-input" },
      outputCap: { contract: "schway.host.output-cap/v1", codex: { enforced: false, default: null, maximum: null }, grok: { enforced: true, default: 16384, maximum: 16384 },
        dispatch: [{ sent: 2048 }], attempts: [{ sent: 2048 }], body: 2048, invalidCap: "invalid-input" },
    });
  } finally {
    await removeTempRoot(dir);
  }
}, 120_000);

for (const route of ["codex", "grok"] as const) {
  test(`packed release consumer shares one ${route} renewal without cross-route reads`, async () => {
    const dir = await makeTempRoot("schway-release-");
    try {
      const { consumer } = await packAndInstall(dir);
      const workspaceRoot = join(consumer, `work-renewal-${route}`);
      const homeDirectory = join(consumer, `home-renewal-${route}`);
      const sessionDirectory = join(consumer, `sessions-renewal-${route}`);
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(homeDirectory, { recursive: true });
      const guard = route === "codex"
        ? `await Bun.plugin({name:'release-renewal-guard',setup(builder){
        builder.onLoad({filter:/providers[/\\\\]grok-subscription/},()=>{throw new Error('unselected grok loaded');});
        builder.onLoad({filter:/providers[/\\\\]xai\\.ts/},()=>{throw new Error('unselected xai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/[/\\\\]tui[/\\\\]/},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`
        : `await Bun.plugin({name:'release-renewal-guard',setup(builder){
        builder.onLoad({filter:/providers[/\\\\]codex-subscription/},()=>{throw new Error('unselected codex loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers[/\\\\]openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/[/\\\\]tui[/\\\\]/},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`;
      const result = await packedConsumer(consumer,
        { action: "renewal", route, workspaceRoot, homeDirectory, sessionDirectory },
        guard) as Record<string, unknown>;
      expect(result).toMatchObject({ outcome: "completed", refreshes: 1, inferences: 2 });
    } finally {
      await removeTempRoot(dir);
    }
  }, 120_000);
}

test("packed release consumer fixture imports only the public host entry", async () => {
  await withTempDir(async () => {
    const fixture = await Bun.file(join(root, "tests/fixtures/host-release-consumer.ts")).text();
    const specifiers = [...fixture.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(specifiers).toContain("schway/host");
    for (const specifier of specifiers) {
      expect(specifier.startsWith("."), `${specifier} must not use a relative import`).toBe(false);
      expect(specifier.startsWith("/"), `${specifier} must not use an absolute import`).toBe(false);
      expect(specifier).not.toContain("src/host");
      if (specifier === "schway/host") continue;
      expect(specifier.startsWith("node:"), `${specifier} must not use a node import`).toBe(false);
      expect(specifier.startsWith("bun:"), `${specifier} must not use a bun import`).toBe(false);
      expect(specifier, `${specifier} is not the public host entry`).toBe("schway/host");
    }
    expect(fixture).not.toMatch(/["']node:/);
    expect(fixture).not.toMatch(/["']bun:/);
  });
});

test("packed release example builds against the public host entry", async () => {
  await withTempDir(async (dir) => {
    const outfile = join(dir, "review-bundle.js");
    const child = Bun.spawn(["bun", "build", join(root, "examples/host/review.ts"), "--external", "schway/host", "--outfile", outfile],
      { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(await Bun.file(outfile).exists()).toBe(true);
  });
});


test("packed consumer admits vendor-neutral web tools with guarded untrusted results and hosted lookup off", async () => {
  await withTempDir(async dir => {
    const { consumer } = await packAndInstall(dir);
    const workspaceRoot = join(consumer, "web-work"), homeDirectory = join(consumer, "web-home"), sessionDirectory = join(consumer, "web-sessions");
    await mkdir(workspaceRoot); await mkdir(homeDirectory);
    const result = await packedConsumer(consumer, { action: "web-tools", workspaceRoot, homeDirectory, sessionDirectory },
      `await Bun.plugin({name:'web-tools-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Web tools loaded provider or TUI');});
      }});`) as { outcome: string; contract: string; calls: string[]; results: Array<{ content: string; isError: boolean }> };
    expect(result.outcome).toBe("completed"); expect(result.contract).toBe("schway.host.web-tools/v1");
    expect(result.calls).toEqual(["search weather 2", "guard example.com", "fetch https://example.com/page 93.184.216.34"]);
    expect(result.results.map(item => item.isError)).toEqual([false, false, true]);
    for (const item of result.results.slice(0, 2)) expect(item.content).toContain("&lt;/untrusted_data&gt;");
  });
}, 120_000);

test("packed catalog consumer uses only the public API and selected subscription provider", async () => {
  const dir = await makeTempRoot("schway-catalog-");
  try {
    const { consumer } = await packAndInstall(dir);
    for (const route of ["codex", "grok"] as const) {
      const unselected = route === "codex" ? "grok-subscription" : "codex-subscription";
      const result = await packedConsumer(consumer, { action: "catalog", route },
        `await Bun.plugin({name:'catalog-guard',setup(builder){
          builder.onLoad({filter:/(?:tui|@opentui|providers[/\\\\](?:${unselected}|xai\\.ts|openai\\.ts|openai-compatible))/},()=>{throw new Error('catalog loaded unrelated runtime');});
        }});`);
      // Rows without reasoning metadata: Codex accepts no explicit effort and sends no cap; Grok accepts off only as a no-op and sends its default cap.
      const effort = route === "codex" ? { levels: [], offSendable: false, default: null, evidence: "account-catalog" }
        : { levels: ["off"], offSendable: false, default: null, evidence: "account-catalog" };
      const outputCap = route === "codex" ? { enforced: false, default: null, maximum: null } : { enforced: true, default: 16384, maximum: 16384 };
      expect(result).toEqual({ result: { route, status: "listed", containsNoSecrets: true,
        models: [{ id: route === "codex" ? "gpt-6-astra" : "grok-4.7", recommended: true, contextWindow: 64000, effort, outputCap }] }, requests: 1, writes: 0 });
    }
  } finally { await removeTempRoot(dir); }
}, 120_000);

test("a prebuilt tarball must match this checkout's version and commit", async () => {
  await withTempDir(async dir => {
    const version = ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version;
    const revision = checkoutRevision();
    const pack = async (name: string, packedVersion: string) => {
      await mkdir(join(dir, "src/package"), { recursive: true });
      await writeFile(join(dir, "src/package/package.json"), JSON.stringify({ name: "schway", version: packedVersion }));
      const path = join(dir, name);
      expect(Bun.spawnSync(["tar", "-czf", path, "-C", join(dir, "src"), "package"]).exitCode).toBe(0);
      return path;
    };
    const current = revision ?? "abcdef0", other = current === "0000000" ? "1111111" : "0000000";
    const good = await pack(`schway-${version}-${current}.tgz`, version);
    expect(await checkPrebuiltTarball(good)).toBe(good);
    await expect(checkPrebuiltTarball(`schway-${version}-${current}.tgz`)).rejects.toThrow("is not an absolute path");
    await expect(checkPrebuiltTarball(await pack("schway.tgz", version))).rejects.toThrow("is not named schway-<version>-<short-sha>.tgz");
    await expect(checkPrebuiltTarball(await pack(`schway-0.0.1-${current}.tgz`, version))).rejects.toThrow("is named for version 0.0.1");
    await expect(checkPrebuiltTarball(await pack(`schway-${version}-${current}-stale.tgz`, version))).rejects.toThrow("is not named");
    await expect(checkPrebuiltTarball(join(dir, `schway-${version}-${current}0.tgz`))).rejects.toThrow(revision ? "was packed from" : "can't be read");
    const mismatch = checkPrebuiltTarball(await pack(`schway-${version}-${other}.tgz`, version));
    // Without Git (a copy without .git), only the version is checked.
    if (revision) await expect(mismatch).rejects.toThrow(`was packed from ${other}, but this checkout is at ${revision}`);
    else expect(await mismatch).toContain(other);
    await expect(checkPrebuiltTarball(await pack(`schway-${version}-${current}.tgz`, "0.0.1"))).rejects.toThrow("contains version 0.0.1");
  });
});
