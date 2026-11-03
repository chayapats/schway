import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";
import { RENEWED_SIGN_IN_NOT_SAVED, SAVING_RENEWED_SIGN_IN, SAVING_RENEWED_SIGN_IN_HINT } from "../src/cli/renewal-exit.ts";

const bin = join(import.meta.dir, "../bin/schway");

/** Preload for the CLI process: an in-memory OS store holding an expired login, and a token endpoint the test controls. */
const PRELOAD = String.raw`
import { existsSync, writeFileSync } from "node:fs";
const dir = process.env.RENEWAL_DIR, route = process.env.RENEWAL_ROUTE, mode = process.env.RENEWAL_MODE;
const account = route === "codex" ? "codex-subscription:chatgpt" : "grok-subscription:xai";
const values = new Map([[account, JSON.stringify({ accessToken: "expired-access", refreshToken: "stored-refresh", obtainedAt: 1, expiresAt: 1 })]]);
Object.defineProperty(Bun, "secrets", { value: {
  async get({ name }) { return values.get(name) ?? null; },
  async set({ name, value }) { values.set(name, value); writeFileSync(dir + "/saved.json", value); },
  async delete({ name }) { return values.delete(name); },
} });
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/oauth/token") || url.includes("auth.x.ai")) {
    writeFileSync(dir + "/sent", "1");
    if (mode === "never") return new Promise(() => {});
    while (!existsSync(dir + "/release")) await Bun.sleep(5);
    return Response.json({ access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  }
  if (url.includes("/models")) return Response.json(route === "codex" ? { models: [{ slug: "gpt-5.4", visibility: "list" }] } : { data: [{ id: "grok-4.7" }] });
  // Inference never answers: the run is interrupted while its renewal is in flight.
  return new Promise(() => {});
};
`;

async function until(check: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Start a headless subscription run, or `models list`, whose renewal the preload holds, collecting stderr as it arrives. */
async function headless(dir: string, route: "codex" | "grok", mode: "late" | "never", command: "run" | "models" = "run") {
  const home = join(dir, "home"), work = join(dir, "work"), state = join(dir, "state");
  await mkdir(home, { recursive: true }); await mkdir(work, { recursive: true }); await mkdir(state, { recursive: true });
  const preload = join(dir, "preload.ts");
  await writeFile(preload, PRELOAD);
  const routeArgs = route === "codex" ? ["--provider", "openai", "--openai-auth", "chatgpt", "--model", "gpt-5.4"] : ["--provider", "xai", "--xai-auth", "grok", "--model", "grok-4.7"];
  const args = command === "models" ? ["models", "list", ...routeArgs.filter(arg => arg !== "--model" && !arg.startsWith("gpt-") && !arg.startsWith("grok-4")), "--json"]
    : [...routeArgs, "-p", "renew, then stop"];
  const proc = Bun.spawn([bin, ...args], {
    cwd: work,
    env: { ...buildIsolatedCliEnv(home), BUN_OPTIONS: `--preload ${preload}`, RENEWAL_DIR: state, RENEWAL_ROUTE: route, RENEWAL_MODE: mode },
    stdout: "pipe", stderr: "pipe",
  });
  let stderr = "";
  const decoder = new TextDecoder();
  const reading = (async () => { for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true }); })();
  const stdout = new Response(proc.stdout).text();
  return { proc, state, stderr: () => stderr, done: async () => { const code = await proc.exited; await reading; return { code, stdout: await stdout, stderr }; } };
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} headless run interrupted after its renewal left waits and stores the rotated token`, async () => {
    await withTempDir(async dir => {
      const run = await headless(dir, route, "late");
      await until(() => existsSync(join(run.state, "sent")), "the token request");
      run.proc.kill("SIGINT");
      await until(() => run.stderr().includes(SAVING_RENEWED_SIGN_IN), "the saving status");
      await writeFile(join(run.state, "release"), "1");
      const { code, stderr } = await run.done();
      expect(code).toBe(1);
      // Stdin is not a terminal, so the status offers no Ctrl+C hint.
      expect(stderr).toContain(`${SAVING_RENEWED_SIGN_IN}\n`);
      expect(stderr).not.toContain(SAVING_RENEWED_SIGN_IN_HINT);
      expect(stderr).not.toContain(RENEWED_SIGN_IN_NOT_SAVED);
      expect(JSON.parse(await readFile(join(run.state, "saved.json"), "utf8")).refreshToken).toBe("rotated-refresh");
      expect(stderr).not.toMatch(/renewed-access|rotated-refresh|stored-refresh/);
    });
  }, 60_000);

  test(`${route} a second interrupt while the renewal settles exits at once with a warning`, async () => {
    await withTempDir(async dir => {
      const run = await headless(dir, route, "never");
      await until(() => existsSync(join(run.state, "sent")), "the token request");
      run.proc.kill("SIGINT");
      await until(() => run.stderr().includes(SAVING_RENEWED_SIGN_IN), "the saving status");
      const second = performance.now();
      run.proc.kill("SIGINT");
      const { code, stderr } = await run.done();
      expect(performance.now() - second).toBeLessThan(5_000);
      expect(code).toBe(130);
      expect(stderr).toContain(RENEWED_SIGN_IN_NOT_SAVED);
      expect(existsSync(join(run.state, "saved.json"))).toBe(false);
    });
  }, 60_000);
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} SIGTERM caps the wait for an unanswered renewal, then warns`, async () => {
    await withTempDir(async dir => {
      const run = await headless(dir, route, "never");
      await until(() => existsSync(join(run.state, "sent")), "the token request");
      const stopped = performance.now();
      run.proc.kill("SIGTERM");
      const { code, stderr } = await run.done();
      // Inside a 10-second container grace period: the wait after SIGTERM is capped at 5 seconds.
      expect(performance.now() - stopped).toBeLessThan(9_000);
      expect(code).toBe(143);
      expect(stderr).toContain(SAVING_RENEWED_SIGN_IN);
      expect(stderr).toContain(RENEWED_SIGN_IN_NOT_SAVED);
    });
  }, 60_000);

  test(`${route} a second SIGTERM during the wait exits at once with a warning`, async () => {
    await withTempDir(async dir => {
      const run = await headless(dir, route, "never");
      await until(() => existsSync(join(run.state, "sent")), "the token request");
      run.proc.kill("SIGTERM");
      await until(() => run.stderr().includes(SAVING_RENEWED_SIGN_IN), "the saving status");
      const second = performance.now();
      run.proc.kill("SIGTERM");
      const { code, stderr } = await run.done();
      expect(performance.now() - second).toBeLessThan(3_000);
      expect(code).toBe(143);
      expect(stderr).toContain(RENEWED_SIGN_IN_NOT_SAVED);
      expect(existsSync(join(run.state, "saved.json"))).toBe(false);
    });
  }, 60_000);

  test(`${route} models list past its deadline waits for its renewal before exiting`, async () => {
    await withTempDir(async dir => {
      const run = await headless(dir, route, "late", "models");
      await until(() => existsSync(join(run.state, "sent")), "the token request");
      // The listing ends at its five-second deadline; the process then waits for the renewal.
      await until(() => run.stderr().includes(SAVING_RENEWED_SIGN_IN), "the saving status", 20_000);
      await writeFile(join(run.state, "release"), "1");
      const { code, stdout, stderr } = await run.done();
      expect(code).not.toBe(0);
      // Stdout stays one JSON document; the status went to stderr only.
      expect(JSON.parse(stdout)).toMatchObject({ route, status: "error", models: [] });
      expect(stdout).not.toContain(SAVING_RENEWED_SIGN_IN);
      expect(stderr).not.toContain(RENEWED_SIGN_IN_NOT_SAVED);
      expect(JSON.parse(await readFile(join(run.state, "saved.json"), "utf8")).refreshToken).toBe("rotated-refresh");
    });
  }, 60_000);
}
