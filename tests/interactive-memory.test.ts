import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir, buildIsolatedCliEnv } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

async function launch(home: string, cwd: string, cli = {}, stage?: () => Promise<void>) {
  const workspace = await resolveWorkspace(cwd);
  const editor = await loadConfigEditor({ home, workspaceRoot: workspace.root, cli, interactiveMemory: true });
  const settings = editor.settings;
  const controller = new TuiController({ session: createSession(), sessionId: "memory", workspace,
    configEditor: editor, provider: settings.provider, modelId: settings.model,
    model: createScriptedModel(), contextManager: createContextManager(workspace),
    stageSettings: async next => { await stage?.(); return { model: createScriptedModel({ provider: next.provider, id: next.model }), contextManager: createContextManager(workspace) }; },
  });
  return { controller, editor };
}

test("successful controller model and reasoning choices return on reopen without project writes", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), project = join(root, "project");
    await mkdir(project);
    const first = await launch(home, project);
    expect(await first.controller.selectModel("openai/gpt-5.4")).toBe(true);
    expect(await first.controller.thinkingCommand("high")).toBe(true);
    first.controller.dispose();
    const second = await launch(home, project);
    expect(second.editor.settings).toMatchObject({ provider: "openai", model: "gpt-5.4", openaiAuth: "api-key", thinking: "high" });
    expect(second.controller.describeConfig()).toContain("interactive memory");
    expect(await readdir(project)).toEqual([]);
    second.controller.dispose();
  });
});

test("explicit user, project, CLI and session values outrank memory and explain shadowing", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), project = join(root, "project"); await mkdir(project);
    const original = await launch(home, project);
    await original.controller.selectModel("openai/gpt-5.4"); await original.controller.thinkingCommand("high"); original.controller.dispose();
    for (const scope of ["user", "project", "cli"] as const) {
      const overrides = { provider: "anthropic" as const };
      const path = join(scope === "user" ? home : project, ".schway/config.json");
      if (scope !== "cli") { await mkdir(join(scope === "user" ? home : project, ".schway"), { recursive: true }); await writeFile(path, JSON.stringify(overrides)); }
      const current = await launch(home, project, scope === "cli" ? overrides : {});
      expect(current.editor.settings.provider).toBe("anthropic");
      expect(current.editor.settings.model).toBe("claude-sonnet-4-6");
      expect(current.editor.settings.thinking).toBeUndefined();
      expect(current.editor.memoryNotice).toContain("Shadowed");
      current.controller.dispose();
      if (scope !== "cli") await rm(path);
    }
    const route = await launch(home, project, { openaiAuth: "codex" });
    expect(route.editor.settings.provider).toBe("openai");
    expect(route.editor.settings.thinking).toBeUndefined();
    route.controller.dispose();
    const session = await launch(home, project, { model: "gpt-4o" });
    expect(session.editor.settings.model).toBe("gpt-4o");
    expect(session.editor.settings.thinking).toBeUndefined();
    expect(await session.controller.selectModel("anthropic/claude-haiku-4-5")).toBe(true);
    expect(session.editor.settings.model).toBe("claude-haiku-4-5"); session.controller.dispose();
  });
});

test("canonical Git roots, subdirectories, symlink aliases and non-Git directories isolate choices", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"), plain = join(root, "plain");
    for (const path of [a, b, plain]) await mkdir(path);
    for (const path of [a, b]) expect(await Bun.spawn(["git", "init", "--quiet", path]).exited).toBe(0);
    await mkdir(join(a, "nested")); await symlink(a, join(root, "alias"));
    const first = await launch(home, a); await first.controller.selectModel("openai/gpt-4o"); first.controller.dispose();
    const second = await launch(home, b); await second.controller.selectModel("anthropic/claude-haiku-4-5"); second.controller.dispose();
    for (const path of [a, join(a, "nested"), join(root, "alias", "nested")]) {
      const reopened = await launch(home, path); expect(reopened.editor.settings.model).toBe("gpt-4o"); reopened.controller.dispose();
    }
    const nonGit = await launch(home, plain); expect(nonGit.editor.settings.model).toBe("claude-sonnet-4-6");
    await nonGit.controller.selectModel("openai/gpt-5.4"); nonGit.controller.dispose();
    const reopened = await launch(home, plain); expect(reopened.editor.settings.model).toBe("gpt-5.4"); reopened.controller.dispose();
    const unchanged = await launch(home, b); expect(unchanged.editor.settings.model).toBe("claude-haiku-4-5"); unchanged.controller.dispose();
  });
});

test("failed and cancelled activation preserve memory while storage failure leaves a usable runtime", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const first = await launch(home, root); await first.controller.selectModel("openai/gpt-4o"); first.controller.dispose();
    const denied = await launch(home, root, {}, async () => { throw new Error("fixture activation denied"); });
    expect(await denied.controller.selectModel("openai/gpt-5.4")).toBe(false); denied.controller.dispose();
    let release!: () => void;
    const cancelled = await launch(home, root, {}, () => new Promise<void>(resolve => { release = resolve; }));
    const pending = cancelled.controller.selectModel("openai/gpt-5.4");
    while (!release) await Bun.sleep(1);
    cancelled.controller.cancel(); release();
    expect(await pending).toBe(false); cancelled.controller.dispose();
    const preserved = await launch(home, root); expect(preserved.editor.settings.model).toBe("gpt-4o"); preserved.controller.dispose();
    const brokenHome = join(root, "broken-home"); await mkdir(join(brokenHome, ".schway"), { recursive: true });
    await writeFile(join(brokenHome, ".schway/interactive"), "not a directory");
    const broken = await launch(brokenHome, root);
    expect(await broken.controller.selectModel("openai/gpt-5.4")).toBe(true);
    expect(broken.controller.snapshot().modelId).toBe("gpt-5.4");
    expect(broken.controller.snapshot().transcript.at(-1)?.text).toContain("not remembered");
    expect(broken.controller.snapshot().transcript.at(-1)?.text).toContain("No additional login");
    await broken.controller.submit("still usable");
    expect(broken.controller.snapshot().status).not.toBe("error"); broken.controller.dispose();
  });
});

test("interleaved controller updates preserve the newer revision and report stale memory writes", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const one = await launch(home, root), two = await launch(home, root);
    expect(await one.controller.selectModel("openai/gpt-4o")).toBe(true);
    expect(await two.controller.selectModel("openai/gpt-5.4")).toBe(true);
    expect(two.controller.snapshot().transcript.at(-1)?.text).toContain("newer choice was preserved");
    const reopen = await launch(home, root); expect(reopen.editor.settings.model).toBe("gpt-4o"); reopen.controller.dispose();
    expect(await one.controller.thinkingCommand("off")).toBe(true);
    const stateFiles = await readdir(join(home, ".schway/interactive")); expect(stateFiles).toHaveLength(1);
    const raw = await readFile(join(home, ".schway/interactive", stateFiles[0]!), "utf8"); expect(JSON.parse(raw).choice).toEqual({ provider: "openai", model: "gpt-4o", openaiAuth: "api-key", thinking: "off" });
    one.controller.dispose(); two.controller.dispose();
  });
});

test("missing profiles are explained and forget exposes explicit config without changing another workspace", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
    const config = join(home, ".schway/config.json"); await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(config, JSON.stringify({ profiles: { local: { baseUrl: "http://localhost:1234/v1", model: "local", auth: "none" } } }));
    const first = await launch(home, a); expect(await first.controller.selectProfile("local")).toBe(true); first.controller.dispose();
    const other = await launch(home, b); await other.controller.selectModel("openai/gpt-4o"); other.controller.dispose();
    await writeFile(config, JSON.stringify({ maxTurns: 8 }));
    const stale = await launch(home, a);
    expect(stale.editor.memoryProblem).toContain('Unknown profile "local"');
    expect(await stale.controller.selectModel("forget")).toBe(true);
    expect(stale.controller.describeConfig()).toContain("maxTurns: 8 [user-global]");
    stale.controller.dispose();
    const reset = await launch(home, a); expect(reset.editor.memoryProblem).toBeUndefined(); expect(reset.editor.settings.model).toBe("claude-sonnet-4-6"); reset.controller.dispose();
    const unchanged = await launch(home, b); expect(unchanged.editor.settings.model).toBe("gpt-4o"); unchanged.controller.dispose();
  });
});

test("remembered profile model sits above profile defaults and below individually explicit file fields", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"); await mkdir(join(home, ".schway"), { recursive: true });
    const config = join(home, ".schway/config.json");
    const profiles = { local: { baseUrl: "http://localhost:1234/v1", model: "old-default", auth: "none" as const } };
    await writeFile(config, JSON.stringify({ profiles }));
    const first = await launch(home, root); await first.controller.selectProfile("local"); first.controller.dispose();
    profiles.local.model = "changed-default";
    await writeFile(config, JSON.stringify({ profiles }));
    const unchanged = await launch(home, root); expect(unchanged.editor.settings.model).toBe("old-default"); unchanged.controller.dispose();
    await writeFile(config, JSON.stringify({ profiles, model: "explicit-model", thinking: "off" }));
    const override = await launch(home, root); expect(override.editor.settings.model).toBe("explicit-model"); expect(override.editor.settings.thinking).toBe("off");
    expect(override.editor.origins.model).toBe("user-global"); override.controller.dispose();
  });
});

test("fresh interactive processes restore the tuple through real picker keyboard, paste and resize input", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), project = join(root, "project"); await mkdir(project); await mkdir(home);
    const run = async (mode: string) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/interactive-memory-process.ts"), mode, project], {
        cwd: join(import.meta.dir, ".."), env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 8000);
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(stderr).toBe(""); expect(exit).toBe(0);
        return JSON.parse(stdout.trim()) as { code: number; requests: Array<{ provider: string; model: string; thinking?: string; apiKey: string }>; screen: string };
      } finally { clearTimeout(timer); }
    };
    const selected = await run("select"); expect(selected.code).toBe(0);
    expect(selected.requests.at(-1)).toMatchObject({ provider: "openai", model: "gpt-5.4", thinking: "high", apiKey: "stored" });
    const stateDirectory = join(home, ".schway/interactive"), stateFile = (await readdir(stateDirectory))[0]!;
    const saved = await readFile(join(stateDirectory, stateFile), "utf8");
    const reopened = await run("reopen"); expect(reopened.requests).toHaveLength(1);
    expect(reopened.requests[0]).toMatchObject({ provider: "openai", model: "gpt-5.4", thinking: "high", apiKey: "stored" });
    expect(reopened.screen).toContain("interactive memory"); expect(reopened.screen).not.toContain("fixture-stored-key");
    const override = await run("override"); expect(override.requests[0]?.provider).toBe("anthropic");
    expect(await readFile(join(stateDirectory, stateFile), "utf8")).toBe(saved);
    expect(await readdir(project)).toEqual([]);
  });
}, 15000);

test("fresh headless dispatcher ignores memory and retains runtime credential precedence and lazy loading", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"); await mkdir(home);
    const run = async () => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/headless-memory-process.ts"), root], {
        cwd: join(import.meta.dir, ".."), env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(err).toBe("");
      return JSON.parse(out) as { code: number; requests: Array<{ auth: string; body: { model: string } }>; modules: string[] };
    };
    const before = await run();
    const interactive = await launch(home, root); await interactive.controller.selectModel("anthropic/claude-haiku-4-5"); interactive.controller.dispose();
    const after = await run();
    expect(after.code).toBe(0); expect(after.requests).toEqual(before.requests);
    expect(after.requests[0]).toMatchObject({ auth: "Bearer fixture-runtime", body: { model: "gpt-4o" } });
    expect(after.modules.some(path => path.endsWith("/providers/openai.ts"))).toBe(true);
    expect(after.modules.some(path => /\/tui\/|@opentui|@anthropic-ai|providers\/(anthropic|openai-compatible|codex)/.test(path))).toBe(false);
  });
});

test("fresh startup explains removed credentials and subscription models without switching billing, then keyboard forget repairs", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"); await mkdir(home);
    const run = async (mode: string) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/interactive-memory-process.ts"), mode, root], {
        cwd: join(import.meta.dir, ".."), env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill(), 8000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0); expect(err).toBe("");
        return JSON.parse(out) as { requests: Array<{ provider: string; openaiAuth?: string; model: string; thinking?: string }>; screen: string };
      } finally { clearTimeout(timer); }
    };
    await run("select");
    const missing = await run("missing-key"); expect(missing.requests).toEqual([]); expect(missing.screen).toContain("Missing OpenAI API key");
    const repaired = await run("forget-missing-key"); expect(repaired.requests[0]?.provider).toBe("anthropic"); expect(repaired.screen).toContain("Forgot interactive memory");
    const selected = await run("select-codex"); expect(selected.requests.at(-1)).toMatchObject({ provider: "openai", openaiAuth: "codex", model: "account-model", thinking: "max" });
    const restored = await run("reopen-codex"); expect(restored.requests[0]).toMatchObject({ openaiAuth: "codex", model: "account-model", thinking: "max" });
    const removed = await run("missing-model"); expect(removed.requests).toEqual([]); expect(removed.screen.replace(/\s+/g, " ")).toContain("no longer available");
    const intact = await launch(home, root); expect(intact.editor.settings).toMatchObject({ openaiAuth: "codex", model: "account-model", thinking: "max" }); intact.controller.dispose();
  });
}, 15000);

test("individual explicit model, reasoning and profile fields resolve at every higher layer without rewriting memory", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), project = join(root, "project"); await mkdir(project);
    const first = await launch(home, project); await first.controller.selectModel("openai/gpt-5.4"); await first.controller.thinkingCommand("high"); first.controller.dispose();
    const directory = join(home, ".schway/interactive"); const file = join(directory, (await readdir(directory))[0]!); const saved = await readFile(file, "utf8");
    for (const scope of ["user", "project", "cli"] as const) {
      for (const [override, expected] of [
        [{ model: "gpt-4o" }, { provider: "openai", model: "gpt-4o", thinking: undefined }],
        [{ thinking: "low" }, { provider: "openai", model: "gpt-5.4", thinking: "low" }],
        [{ openaiAuth: "codex" }, { provider: "openai", model: "gpt-5.4", openaiAuth: "codex", thinking: undefined }],
        [{ profiles: { local: { baseUrl: "http://localhost:1234", model: "local", auth: "none" } }, profile: "local" }, { provider: "openai-compatible", model: "local", profile: "local", thinking: undefined }],
      ] as const) {
        const path = join(scope === "user" ? home : project, ".schway/config.json");
        if (scope !== "cli") { await mkdir(join(scope === "user" ? home : project, ".schway"), { recursive: true }); await writeFile(path, JSON.stringify(override)); }
        const current = await launch(home, project, scope === "cli" ? override : {});
        for (const [key, value] of Object.entries(expected)) expect(current.editor.settings[key as keyof typeof current.editor.settings]).toEqual(value);
        expect(current.editor.memoryNotice).toContain("Shadowed");
        current.controller.dispose(); if (scope !== "cli") await rm(path);
      }
    }
    expect(await readFile(file, "utf8")).toBe(saved);
  });
});

test("resume into another workspace resolves its current memory and project settings, discarding the previous session choice", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), a = join(root, "a"), b = join(root, "b"); await mkdir(a); await mkdir(b);
    const first = await launch(home, a); await first.controller.selectModel("openai/gpt-4o");
    const second = await launch(home, b); await second.controller.selectModel("anthropic/claude-haiku-4-5"); second.controller.dispose();
    const destination = await resolveWorkspace(b);
    expect(await first.controller.switchSession(createSession(), "saved-in-b", { workspace: destination, contextManager: createContextManager(destination) })).toBe(true);
    expect(first.controller.snapshot().modelId).toBe("claude-haiku-4-5");
    await mkdir(join(b, ".schway")); await writeFile(join(b, ".schway/config.json"), JSON.stringify({ model: "claude-opus-4-6" }));
    expect(await first.controller.switchSession(createSession(), "older-saved-in-b", { workspace: destination, contextManager: createContextManager(destination) })).toBe(true);
    expect(first.controller.snapshot().modelId).toBe("claude-opus-4-6"); first.controller.dispose();
  });
});
