import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

test("existing workspaces keep their choices while a new workspace inherits the latest successful tuple", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const [a, b, c] = ["a", "b", "c"].map(name => join(root, name));
    for (const path of [a!, b!, c!]) await mkdir(path);
    /** Open interactive settings against the test's isolated home and selected workspace. */
    const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
    const first = await load(a!);
    await (await first.prepareOpenAIApiModel("gpt-4o")).commit();
    await first.rememberChoice("api-key");
    const second = await load(b!);
    expect(second.settings).toMatchObject({ provider: "openai", model: "gpt-4o", openaiAuth: "api-key" });
    await (await second.prepareOpenAIApiModel("gpt-5.4")).commit();
    await (await second.prepare({ scope: "session", key: "thinking", value: "high" })).commit();
    await second.rememberChoice("api-key");
    expect((await load(a!)).settings.model).toBe("gpt-4o");
    expect((await load(b!)).settings).toMatchObject({ model: "gpt-5.4", thinking: "high" });
    expect((await load(c!)).settings).toMatchObject({ provider: "openai", model: "gpt-5.4", openaiAuth: "api-key", thinking: "high" });
    expect((await load(c!)).origins.model).toBe("interactive memory");
  });
});

test("explicit layers outrank inherited choices and opening, staging and resuming do not publish them", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
    for (const path of [a, b, c]) await mkdir(path);
    /** Resolve interactive settings with explicit CLI overrides in the isolated test home. */
    const load = (workspaceRoot: string, cli = {}) => loadConfigEditor({ home, workspaceRoot, cli, interactiveMemory: true });
    const first = await load(a);
    await (await first.prepareOpenAIApiModel("gpt-5.4")).commit();
    await (await first.prepare({ scope: "session", key: "thinking", value: "high" })).commit();
    await first.rememberChoice("api-key");
    const globalPath = join(home, ".schway/interactive/global/latest.json");
    const remembered = await readFile(globalPath, "utf8");
    for (const scope of ["user", "project", "cli", "session"] as const) {
      const overrides = { provider: "openai" as const, model: "gpt-4o", openaiAuth: "api-key" as const };
      const editor = await load(b, scope === "cli" ? overrides : {});
      if (scope !== "cli") for (const [key, value] of Object.entries(overrides)) await (await editor.prepare({ scope, key, value })).commit();
      expect(editor.settings.model).toBe("gpt-4o");
      expect(editor.settings.thinking).toBeUndefined();
      expect(editor.origins.model).toBe({ user: "user-global", project: "project", cli: "CLI", session: "current-session override" }[scope]);
      if (scope === "user" || scope === "project") for (const key of Object.keys(overrides)) await (await editor.prepare({ scope, key })).commit();
    }
    const staged = await load(b);
    await staged.prepareMemory({ provider: "openai", model: "gpt-4o", openaiAuth: "api-key" });
    await (await staged.prepareOpenAIApiModel("gpt-4o")).commit();
    const resumed = await staged.forWorkspace(c);
    expect(resumed.settings).toMatchObject({ model: "gpt-5.4", thinking: "high", openaiAuth: "api-key" });
    expect((await load(c)).settings).toMatchObject({ model: "gpt-5.4", thinking: "high" });
    const headless = await loadConfigEditor({ home, workspaceRoot: c });
    expect(headless.settings.model).toBe("");
    expect(headless.settings.thinking).toBeUndefined();
    expect(await readFile(globalPath, "utf8")).toBe(remembered);
  });
});

test("new workspaces inherit subscription billing routes and explicit route changes discard their model", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    const source = await loadConfigEditor({ home, workspaceRoot: a, interactiveMemory: true });
    await (await source.prepareSubscriptionModel("gpt-5.4")).commit(); await source.rememberChoice("codex");
    const codex = await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true });
    expect(codex.settings).toMatchObject({ provider: "openai", model: "gpt-5.4", openaiAuth: "codex" });
    const api = await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true, cli: { openaiAuth: "api-key" } });
    expect(api.settings).toMatchObject({ provider: "openai", model: "", openaiAuth: "api-key" });
    await (await source.prepareGrokModel("grok-4.7")).commit(); await source.rememberChoice("grok");
    const grok = await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true });
    expect(grok.settings).toMatchObject({ provider: "xai", model: "grok-4.7", xaiAuth: "grok" });
    const xai = await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true, cli: { xaiAuth: "api-key" } });
    expect(xai.settings).toMatchObject({ provider: "xai", model: "", xaiAuth: "api-key" });
  });
});

test("standalone compatible endpoints and legacy ambiguous routes stay workspace-only", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    const source = await loadConfigEditor({ home, workspaceRoot: a, interactiveMemory: true, cli: {
      provider: "openai-compatible", model: "custom", baseUrl: "https://private.example/v1", auth: "none",
    } });
    await source.rememberChoice("none");
    const inherited = await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true, cli: { baseUrl: "https://different.example/v1" } });
    expect(inherited.settings.model).toBe("");
    await (await InteractiveMemory.load(home, a)).write({ provider: "xai", model: "grok-4.7" }, undefined, true);
    expect((await InteractiveMemory.load(home, b)).choice).toBeUndefined();
  });
});

test("forget and reset suppress fallback only for that workspace and legacy records remain authoritative", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const paths = ["legacy", "seed", "forgotten", "reset", "new"].map(name => join(root, name));
    for (const path of paths) await mkdir(path);
    const [legacy, seed, forgotten, reset, fresh] = paths as [string, string, string, string, string];
    await (await InteractiveMemory.load(home, legacy)).write({ provider: "openai", model: "gpt-4o", openaiAuth: "api-key" });
    /** Open interactive settings against the test's isolated home and selected workspace. */
    const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
    const editor = await load(seed);
    await (await editor.prepareOpenAIApiModel("gpt-5.4")).commit(); await editor.rememberChoice("api-key");
    await (await load(forgotten)).forgetChoice();
    await (await (await load(reset)).prepareMemory()).commit();
    expect((await load(legacy)).settings.model).toBe("gpt-4o");
    expect((await load(forgotten)).settings.model).toBe("");
    expect((await load(reset)).settings.model).toBe("");
    expect((await load(fresh)).settings.model).toBe("gpt-5.4");
  });
});

test("project compatible profiles never bind the global choice to a different endpoint", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
    for (const path of [a, b, c]) await mkdir(join(path, ".schway"), { recursive: true });
    for (const [path, endpoint] of [[a, "one"], [b, "two"]]) {
      await writeFile(join(path!, ".schway/config.json"), JSON.stringify({ profiles: { local: {
        baseUrl: `https://${endpoint}.example/v1`, model: "custom", auth: "none", headers: { "x-secret": "private-endpoint-secret" },
      } } }));
    }
    /** Open interactive settings against the test's isolated home and selected workspace. */
    const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
    const first = await load(a);
    await (await first.prepareProfile("local")).commit(); await first.rememberChoice("none");
    expect((await load(a)).settings).toMatchObject({ profile: "local", model: "custom", baseUrl: "https://one.example/v1" });
    expect((await load(b)).settings.model).toBe("");
    expect((await load(c)).settings.model).toBe("");
    const directory = join(home, ".schway/interactive");
    for (const file of await readdir(directory)) {
      const contents = await readFile(join(directory, file), "utf8");
      expect(contents).not.toContain("private-endpoint-secret"); expect(contents).not.toContain("one.example");
    }
    const portable = await load(c);
    await (await portable.prepareOpenAIApiModel("gpt-4o")).commit(); await portable.rememberChoice("api-key");
    await first.rememberChoice("none");
    expect((await load(b)).settings).toMatchObject({ provider: "openai", model: "gpt-4o" });
    expect((await load(b)).settings.profile).toBeUndefined();
  });
});

test("malformed workspace state blocks fallback and can be repaired without losing the global choice", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    const first = await loadConfigEditor({ home, workspaceRoot: a, interactiveMemory: true });
    await (await first.prepareOpenAIApiModel("gpt-4o")).commit(); await first.rememberChoice("api-key");
    const directory = join(home, ".schway/interactive");
    const file = (await readdir(directory)).find(name => name.endsWith(".json"))!;
    await writeFile(join(directory, file), "{broken");
    const broken = await loadConfigEditor({ home, workspaceRoot: a, interactiveMemory: true });
    expect(broken.settings.model).toBe(""); expect(broken.memoryActivationError).toContain("could not be read");
    await broken.forgetChoice();
    expect((await loadConfigEditor({ home, workspaceRoot: a, interactiveMemory: true })).settings.model).toBe("");
    expect((await loadConfigEditor({ home, workspaceRoot: b, interactiveMemory: true })).settings.model).toBe("gpt-4o");
  });
});

test("a global writer excludes other workspaces and process death preserves the last committed choice", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
    for (const path of [a, b, c]) await mkdir(path);
    /** Open interactive settings against the test's isolated home and selected workspace. */
    const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
    const seed = await load(a);
    await (await seed.prepareOpenAIApiModel("gpt-5.4")).commit(); await seed.rememberChoice("api-key");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/interactive-memory-lock-owner.ts"), a], {
      cwd: join(import.meta.dir, ".."), env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("LOCKED"); reader.releaseLock();
      expect((await load(c)).settings.model).toBe("gpt-5.4");
      const contender = await load(b);
      await (await contender.prepareOpenAIApiModel("gpt-4o")).commit();
      await expect(contender.rememberChoice("api-key")).rejects.toThrow("updating");
      child.kill("SIGKILL"); await child.exited;
      expect((await load(a)).settings.model).toBe("gpt-5.4");
      expect((await load(b)).settings.model).toBe("gpt-5.4");
      await contender.rememberChoice("api-key");
      expect((await load(a)).settings.model).toBe("gpt-5.4");
      expect((await load(c)).settings.model).toBe("gpt-4o");
      expect((await stat(join(home, ".schway/interactive/global/latest.json"))).mode & 0o777).toBe(0o600);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  });
}, 10000);

test("malformed global state can be forgotten locally or repaired by a successful selection", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"), c = join(root, "c");
    for (const path of [a, b, c]) await mkdir(path);
    const directory = join(home, ".schway/interactive/global"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "latest.json"), "{broken");
    /** Open interactive settings against the test's isolated home and selected workspace. */
    const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
    const broken = await load(a);
    expect(broken.memoryActivationError).toContain("could not be read");
    await broken.forgetChoice();
    expect((await load(a)).memoryActivationError).toBeUndefined();
    expect((await load(b)).memoryActivationError).toContain("could not be read");
    const repair = await load(b);
    await (await repair.prepareOpenAIApiModel("gpt-4o")).commit(); await repair.rememberChoice("api-key");
    expect((await load(c)).settings.model).toBe("gpt-4o");
    expect((await load(a)).settings.model).toBe("");
  });
});

for (const fault of ["workspace-rename", "global-stage", "global-rename"]) {
  for (const mode of ["remember", "prepare"]) test(`${mode} recovers its revision after ${fault} failure`, async () => {
    await withTempDir(async root => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/interactive-memory-lock-owner.ts"), root, fault, mode], {
        cwd: join(import.meta.dir, ".."), env: buildIsolatedCliEnv(join(root, "home")), stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(err).toBe("");
      const result = JSON.parse(out);
      expect(result.error).toBeDefined();
      const committed = fault === "global-rename";
      expect(result.afterFailure).toEqual({ model: committed || mode === "remember" ? "gpt-5.4" : "gpt-4o",
        memory: committed ? "gpt-5.4" : "gpt-4o", reopened: committed ? "gpt-5.4" : "gpt-4o", global: "gpt-4o" });
      expect(result.retried).toBe("gpt-5.4"); expect(result.global).toBe("gpt-5.4");
    });
  });
}
