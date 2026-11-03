import { afterAll, expect, test } from "bun:test";
import { lstat, mkdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildIsolatedCliEnv, makeTempRoot, removeTempRoot } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");
let packed: Promise<{ dir: string; consumer: string }> | undefined;

/** Pack the current checkout once and install the tarball into an isolated consumer, as the release test does. */
function packedInstall(): Promise<{ dir: string; consumer: string }> {
  packed ??= (async () => {
    const dir = await makeTempRoot("schway-renewal-");
    const packDir = join(dir, "pack");
    await mkdir(packDir, { recursive: true });
    const pack = Bun.spawn(["bun", "pm", "pack", "--destination", packDir], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [packOut, packErr, packCode] = await Promise.all([new Response(pack.stdout).text(), new Response(pack.stderr).text(), pack.exited]);
    expect(packCode, packOut + packErr).toBe(0);
    const entries = await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: packDir }));
    expect(entries.length).toBe(1);
    const consumer = join(dir, "consumer");
    await mkdir(join(consumer, "node_modules"), { recursive: true });
    await Bun.write(join(consumer, "package.json"), JSON.stringify({ name: "renewal-consumer", version: "1.0.0", type: "module",
      dependencies: { schway: `file:${join(packDir, entries[0]!)}` } }, null, 2));
    const install = Bun.spawn(["bun", "install"], { cwd: consumer, stdout: "pipe", stderr: "pipe" });
    const [installOut, installErr, installCode] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
    expect(installCode, installOut + installErr).toBe(0);
    // The installed package is a real copy, not a link back to this checkout.
    const installed = join(consumer, "node_modules/schway");
    expect((await lstat(installed)).isSymbolicLink()).toBe(false);
    await expect(readlink(installed)).rejects.toThrow();
    expect(await Bun.file(join(installed, "dist/types/host/index.d.ts")).text()).toContain("routeRenewalContract");
    await Bun.write(join(consumer, "consumer.ts"), await Bun.file(join(root, "tests/fixtures/host-release-consumer.ts")).text());
    return { dir, consumer };
  })();
  return packed;
}

afterAll(async () => {
  if (packed) await removeTempRoot((await packed).dir);
});

/** Run the packed consumer under an import guard with an isolated HOME. */
async function packedConsumer(consumer: string, input: Record<string, unknown>, guard: string): Promise<unknown> {
  const guardFile = join(consumer, `guard-${crypto.randomUUID()}.ts`);
  await Bun.write(guardFile, guard);
  const home = join(consumer, `home-${crypto.randomUUID()}`);
  await mkdir(home, { recursive: true });
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guardFile, join(consumer, "consumer.ts")], {
    cwd: consumer, env: buildIsolatedCliEnv(home), stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

for (const route of ["codex", "grok"] as const) {
  test(`packed ${route} host recovers from token expiry by renewal alone, then runs pinned`, async () => {
    const { consumer } = await packedInstall();
    const workspaceRoot = join(consumer, `work-${route}`), homeDirectory = join(consumer, `home-${route}`);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDirectory, { recursive: true });
    // Interpolated into the guard's regex literal as-is: `xai\.ts`.
    const unselected = route === "codex" ? "(?:grok-subscription|xai\\.ts)" : "codex-subscription";
    const result = await packedConsumer(consumer,
      { action: "route-renewal", route, workspaceRoot, homeDirectory, sessionDirectory: join(consumer, `sessions-${route}`) },
      `await Bun.plugin({name:'route-renewal-guard',setup(builder){
        builder.onLoad({filter:/providers[/\\\\]${unselected}/},()=>{throw new Error('unselected route loaded');});
        builder.onLoad({filter:/providers[/\\\\](?:openai\\.ts|openai-compatible)/},()=>{throw new Error('API-key adapter loaded');});
        builder.onLoad({filter:/(?:[/\\\\]tui[/\\\\]|@opentui)/},()=>{throw new Error('TUI loaded');});
      }});`) as Record<string, unknown>;
    expect(result).toMatchObject({
      contract: "schway.host.route-renewal/v1",
      // Listing alone cannot recover: it never renews.
      stuck: "needs-login",
      renewal: { outcome: "renewed", renewalRequests: 1, auth: { route, status: "configured-unverified", observedInference: "not-checked" } },
      // Renewal sent one token request and nothing else.
      afterRenewal: { token: 1, catalog: 0, inference: 0 },
      again: "fresh",
      listed: "listed",
      run: "completed",
      providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 0 },
      counts: { token: 1, catalog: 1, inference: 1 },
      efforts: [route === "codex" ? "high" : "low"],
    });
  }, 120_000);
}
