import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { withTempDir } from "./helpers.ts";

test("interactive configuration loading reports both invalid files before reading memory", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), workspaceRoot = join(dir, "project");
    const paths = [join(home, ".schway/config.json"), join(workspaceRoot, ".schway/config.json")];
    for (const path of paths) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, '{"approval":{"mode":"private-secret"}}'); }
    const error = await loadConfigEditor({ home, workspaceRoot, interactiveMemory: true }).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    for (const path of paths) expect((error as Error).message).toContain(path);
    expect((error as Error).message.match(/Invalid approval.mode/g)).toHaveLength(2);
    expect((error as Error).message).not.toContain("private-secret");
    expect(await readdir(join(home, ".schway"))).toEqual(["config.json"]);
  });
});

test("interactive unknown profile errors retain source without exposing selected or available names", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), workspaceRoot = join(dir, "project"), path = join(home, ".schway/config.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ profile: "private-selection", profiles: { "private-available": { baseUrl: "https://example.test" } } }));
    const error = await loadConfigEditor({ home, workspaceRoot }).catch(error => error as Error);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toContain("Invalid profile · Select a configured compatible profile");
    expect((error as Error).message).not.toContain("private-");
  });
});

test("ui splash setting and field reset preserve sibling keys in session and disk layers", async () => {
  await withTempDir(async home => {
    const editor = await loadConfigEditor({ home, workspaceRoot: join(home, "project") });
    for (const scope of ["user", "session"] as const) {
      await (await editor.prepare({ scope, key: "ui", value: { inlineDiffLines: 7 } })).commit();
      await (await editor.prepare({ scope, key: "ui", value: { splash: "never" } })).commit();
      expect(editor.settings).toMatchObject({ splash: "never", inlineDiffLines: 7 });
      await (await editor.prepare({ scope, key: "ui", value: { splash: undefined } })).commit();
      expect(editor.settings).toMatchObject({ splash: "first-run", inlineDiffLines: 7 });
      if (scope === "user") expect(await Bun.file(join(home, ".schway/config.json")).json()).toEqual({ ui: { inlineDiffLines: 7 } });
    }
  });
});

test("config edits preserve provenance and reset to lower precedence without creating files", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const root = join(dir, "project");
    await mkdir(home); await mkdir(root);
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { maxTurns: 7 } });
    expect(editor.settings.maxTurns).toBe(7);
    expect(editor.origins.maxTurns).toBe("CLI");
    expect(editor.origins.provider).toBe("built-in default");
    expect(editor.origins.appearance).toBe("built-in default");
    expect(editor.origins.contextWindow).toBe("catalog");
    const edit = await editor.prepare({ scope: "session", key: "maxTurns", value: 3 });
    expect(editor.settings.maxTurns).toBe(7);
    await edit.commit();
    expect(editor.settings.maxTurns).toBe(3);
    expect(editor.origins.maxTurns).toBe("current-session override");
    await (await editor.prepare({ scope: "session", key: "maxTurns" })).commit();
    expect(editor.settings.maxTurns).toBe(7);
    await (await editor.prepare({ scope: "user", key: "maxTurns" })).commit();
    await (await editor.prepare({ scope: "project", key: "maxTurns" })).commit();
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
});

test("config editor loads inline diff limits and unrelated edits preserve the ui layer", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), root = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(root, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ ui: { inlineDiffLines: 24 } }));
    const path = join(root, ".schway/config.json");
    await writeFile(path, JSON.stringify({ ui: { inlineDiffLines: 0 }, maxTurns: 5 }));
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    expect(editor.settings.inlineDiffLines).toBe(0);
    expect(editor.origins.ui).toBe("project");
    await (await editor.prepare({ scope: "project", key: "maxTurns", value: 7 })).commit();
    expect(editor.settings.inlineDiffLines).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ui: { inlineDiffLines: 0 }, maxTurns: 7 });
    const overridden = await loadConfigEditor({ home, workspaceRoot: root, cli: { ui: { inlineDiffLines: 6 } } });
    expect(overridden.settings.inlineDiffLines).toBe(6);
    expect(overridden.origins.ui).toBe("CLI");
  });
});

test("provider changes clear inherited model origins and cancelled writes create no files", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), root = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(root);
    await writeFile(join(home, ".schway/config.json"), '{"model":"gpt-5.4-mini","maxOutput":4000}');
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } });
    expect(editor.settings.model).toBe("");
    expect(editor.settings.modelConfigured).toBe(false);
    expect(editor.origins.model).toBeUndefined();
    expect(editor.settings.maxOutput).toBe(4000);
    expect(editor.origins.maxOutput).toBe("user-global");
    const edit = await editor.prepare({ scope: "project", key: "maxTurns", value: 9 });
    const abort = new AbortController(); abort.abort();
    await expect(edit.commit(abort.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(editor.settings.maxTurns).toBe(32);
  });
});

test("invalid values, malformed destinations and concurrent changes never replace valid state", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, ".schway/config.json");
    await mkdir(join(dir, ".schway"));
    await writeFile(path, '{"maxTurns":5}');
    const editor = await loadConfigEditor({ home: join(dir, "home"), workspaceRoot: dir });
    for (const [key, value] of [["maxOutput", -1], ["model", " "], ["apiKey", "secret"], ["headers", { Authorization: "secret" }], ["packages", ["some-package"]]]) {
      await expect(editor.prepare({ scope: "project", key: key as string, value })).rejects.toThrow();
    }
    expect(await readFile(path, "utf8")).toBe('{"maxTurns":5}');
    await writeFile(path, '{broken');
    await expect(editor.prepare({ scope: "project", key: "maxTurns", value: 9 })).rejects.toThrow("Repair this file");
    expect(await readFile(path, "utf8")).toBe('{broken');
    expect(editor.settings.maxTurns).toBe(5);
    await writeFile(path, '{"maxTurns":5}');
    const pending = await editor.prepare({ scope: "project", key: "maxTurns", value: 9 });
    await writeFile(path, '{"maxTurns":6}');
    await expect(pending.commit()).rejects.toThrow("Settings file changed · Reopen and retry the edit");
    expect(await readFile(path, "utf8")).toBe('{"maxTurns":6}');
    expect(editor.settings.maxTurns).toBe(5);
    expect(await readdir(join(dir, ".schway"))).toEqual(["config.json"]);
  });
});

test("persisted edits replace only one validated key and reset restores inheritance", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home"), root = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(root, ".schway"), { recursive: true });
    const path = join(root, ".schway/config.json");
    await writeFile(join(home, ".schway/config.json"), '{"maxTurns":11}');
    await writeFile(path, '{"maxTurns":5,"maxConcurrentTools":2}');
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { maxTurns: 7 } });
    const edit = await editor.prepare({ scope: "project", key: "maxTurns", value: 4 });
    expect(JSON.parse(await readFile(path, "utf8")).maxTurns).toBe(5);
    await edit.commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ maxTurns: 4, maxConcurrentTools: 2 });
    expect(editor.settings.maxTurns).toBe(7);
    expect(editor.origins.maxTurns).toBe("CLI");
    await (await editor.prepare({ scope: "project", key: "maxTurns" })).commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ maxConcurrentTools: 2 });
    const inherited = await loadConfigEditor({ home, workspaceRoot: root });
    expect(inherited.settings.maxTurns).toBe(11);
    expect(inherited.origins.maxTurns).toBe("user-global");
    expect(await readdir(join(root, ".schway"))).toEqual(["config.json"]);
  });
});

test("persisted base URLs reject userinfo and queries without creating or changing either scope", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), root = join(dir, "project");
    await mkdir(home); await mkdir(root);
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    const credential = "url-secret-sentinel";
    const urls = [
      `https://user:${credential}@example.test/v1`,
      `https://${credential}@example.test/v1`,
      `https://example.test/v1?token=${credential}`,
      "https://example.test/v1?region=test",
    ];
    for (const scope of ["user", "project"] as const) {
      const before = editor.settings;
      const scopeRoot = scope === "user" ? home : root;
      const path = join(scopeRoot, ".schway/config.json");
      for (const value of urls) {
        await expect(editor.prepare({ scope, key: "baseUrl", value })).rejects.toThrow("session scope");
      }
      expect(await readdir(scopeRoot)).toEqual([]);
      await mkdir(join(scopeRoot, ".schway"));
      const original = '{"baseUrl":"https://example.test/v1","maxTurns":7}';
      await writeFile(path, original);
      for (const value of urls) {
        const error = await editor.prepare({ scope, key: "baseUrl", value }).catch(error => error as Error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(credential);
        expect(await readFile(path, "utf8")).toBe(original);
      }
      expect(editor.settings).toEqual(before);
      await (await editor.prepare({ scope, key: "baseUrl", value: "https://safe.example.test:8443/v2" })).commit();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ baseUrl: "https://safe.example.test:8443/v2", maxTurns: 7 });
      expect(await readFile(path, "utf8")).not.toContain(credential);
      expect(await readdir(join(scopeRoot, ".schway"))).toEqual(["config.json"]);
    }
  });
});

test("unrelated edits preserve existing URL values and resetting removes the selected override", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, ".schway"));
    const path = join(root, ".schway/config.json");
    const baseUrl = "https://legacy:existing-password@example.test/v1?region=legacy";
    await writeFile(path, JSON.stringify({ baseUrl, maxTurns: 7 }));
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    await (await editor.prepare({ scope: "project", key: "maxTurns", value: 9 })).commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ baseUrl, maxTurns: 9 });
    await (await editor.prepare({ scope: "project", key: "baseUrl" })).commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ maxTurns: 9 });
  });
});

test("Grok and xAI API-key model staging commit explicit distinct billing routes", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), workspaceRoot = join(root, "project"); await mkdir(home); await mkdir(workspaceRoot);
    const editor = await loadConfigEditor({ home, workspaceRoot, cli: { provider: "xai", model: "grok-4.7" } });
    expect(editor.settings.xaiAuth).toBe("auto");
    const grok = await editor.prepareGrokModel("grok-4.7"); expect(editor.settings.xaiAuth).toBe("auto"); await grok.commit(); expect(editor.settings.xaiAuth).toBe("grok");
    await (await editor.prepareXaiModel("grok-4.7")).commit(); expect(editor.settings.xaiAuth).toBe("api-key");
    await (await editor.prepare({ scope: "session", key: "xaiAuth", value: "grok" })).commit(); expect(editor.settings.xaiAuth).toBe("grok");
    await expect(editor.prepare({ scope: "session", key: "xaiAuth", value: "bogus" })).rejects.toThrow("Invalid xaiAuth · Use auto, grok, or api-key");
  });
});

test("saving unrelated and sibling settings preserves legacy JSON keys and repeats warnings on a later load", async () => {
  await withTempDir(async home => {
    const configDeprecations = [
      { key: "oldTurns", replacement: "maxTurns", since: "1.1.0", removeIn: "2.0" },
      { key: "ui.oldSplash", replacement: "ui.splash", since: "1.1.0", removeIn: "2.0" },
    ];
    const path = join(home, ".schway/config.json");
    await mkdir(join(home, ".schway"));
    await writeFile(path, JSON.stringify({ oldTurns: 7, ui: { oldSplash: "never" } }));
    const input = { home, workspaceRoot: join(home, "work"), configDeprecations };
    const editor = await loadConfigEditor(input);
    expect(editor.settings).toMatchObject({ maxTurns: 7, splash: "never" });
    expect(editor.deprecationWarnings).toHaveLength(2);
    await (await editor.prepare({ scope: "user", key: "appearance", value: "dark" })).commit();
    await (await editor.prepare({ scope: "user", key: "ui", value: { inlineDiffLines: 3 } })).commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ oldTurns: 7, ui: { oldSplash: "never", inlineDiffLines: 3 }, appearance: "dark" });
    const reloaded = await loadConfigEditor(input);
    expect(reloaded.deprecationWarnings).toEqual(editor.deprecationWarnings);
    expect(reloaded.settings).toMatchObject({ maxTurns: 7, splash: "never", inlineDiffLines: 3, appearance: "dark" });
  });
});

test("partial git edits preserve a deprecated sibling and explicit replacements keep precedence after reload", async () => {
  await withTempDir(async home => {
    const path = join(home, ".schway/config.json");
    await mkdir(join(home, ".schway"));
    await writeFile(path, JSON.stringify({ git: { oldTracking: "snapshot" } }));
    const input = { home, workspaceRoot: join(home, "work"), configDeprecations: [
      { key: "git.oldTracking", replacement: "git.changeTracking", since: "1.1.0", removeIn: "2.0" },
    ] };
    const editor = await loadConfigEditor(input);
    const transaction = await editor.prepare({ scope: "user", key: "git", value: { changeTracking: "off" } });
    expect(transaction.settings.gitChangeTracking).toBe("off");
    await transaction.commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ git: { oldTracking: "snapshot", changeTracking: "off" } });
    const reloaded = await loadConfigEditor(input);
    expect(reloaded.settings.gitChangeTracking).toBe("off");
    expect(reloaded.deprecationWarnings.map(warning => warning.message)).toEqual([
      `Config: "git.oldTracking" in ${path} is deprecated; use "git.changeTracking". It will be removed in 2.0. "git.oldTracking" is ignored because "git.changeTracking" is set.`,
    ]);
  });
});

test("partial undo edits retain multiple deeply nested legacy values without merging ordinary fields", async () => {
  await withTempDir(async home => {
    const path = join(home, ".schway/config.json");
    await mkdir(join(home, ".schway"));
    await writeFile(path, JSON.stringify({ undo: { legacy: { age: 7, size: 100 }, maxAgeDays: 42 } }));
    const input = { home, workspaceRoot: join(home, "work"), configDeprecations: [
      { key: "undo.legacy.age", replacement: "undo.maxAgeDays", since: "1.1.0", removeIn: "2.0" },
      { key: "undo.legacy.size", replacement: "undo.maxSizeMB", since: "1.1.0", removeIn: "2.0" },
    ] };
    const editor = await loadConfigEditor(input);
    const value = { maxSizeMB: 250 };
    await (await editor.prepare({ scope: "user", key: "undo", value })).commit();
    expect(value).toEqual({ maxSizeMB: 250 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ undo: { legacy: { age: 7, size: 100 }, maxSizeMB: 250 } });
    const reloaded = await loadConfigEditor(input);
    expect(reloaded.settings).toMatchObject({ undoMaxAgeDays: 7, undoMaxSizeMB: 250 });
    expect(reloaded.deprecationWarnings.map(warning => warning.key)).toEqual(["undo.legacy.age", "undo.legacy.size"]);
    expect(reloaded.deprecationWarnings[1]!.message).toEndWith('"undo.legacy.size" is ignored because "undo.maxSizeMB" is set.');
    const partialLegacy = { legacy: { age: 14 }, maxSizeMB: 300 };
    await (await reloaded.prepare({ scope: "user", key: "undo", value: partialLegacy })).commit();
    expect(partialLegacy).toEqual({ legacy: { age: 14 }, maxSizeMB: 300 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ undo: { legacy: { age: 14, size: 100 }, maxSizeMB: 300 } });
    expect((await loadConfigEditor(input)).settings).toMatchObject({ undoMaxAgeDays: 14, undoMaxSizeMB: 300 });
  });
});

for (const [name, value, saved, warnings] of [
  ["explicit legacy value", { oldTracking: "on-demand" }, { git: { oldTracking: "on-demand" } }, 1],
  ["explicit legacy removal", { oldTracking: undefined, changeTracking: "off" }, { git: { changeTracking: "off" } }, 0],
  ["empty object reset", {}, { git: {} }, 0],
  ["whole setting reset", undefined, {}, 0],
] as const) test(`partial object preservation honors ${name}`, async () => {
  await withTempDir(async home => {
    const path = join(home, ".schway/config.json");
    await mkdir(join(home, ".schway"));
    await writeFile(path, JSON.stringify({ git: { oldTracking: "snapshot" } }));
    const input = { home, workspaceRoot: join(home, "work"), configDeprecations: [
      { key: "git.oldTracking", replacement: "git.changeTracking", since: "1.1.0", removeIn: "2.0" },
    ] };
    const editor = await loadConfigEditor(input);
    await (await editor.prepare({ scope: "user", key: "git", value })).commit();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
    expect((await loadConfigEditor(input)).deprecationWarnings).toHaveLength(warnings);
  });
});

for (const configDeprecations of [[], [{ key: "undo.oldAge", replacement: "undo.maxAgeDays", since: "1.1.0", removeIn: "2.0" }]]) {
  test(`ordinary object edits retain wholesale replacement with ${configDeprecations.length ? "an absent legacy path" : "no deprecations"}`, async () => {
    await withTempDir(async home => {
      const path = join(home, ".schway/config.json");
      await mkdir(join(home, ".schway"));
      await writeFile(path, JSON.stringify({ undo: { maxAgeDays: 7, maxSizeMB: 100 } }));
      const input = { home, workspaceRoot: join(home, "work"), configDeprecations };
      const editor = await loadConfigEditor(input);
      await (await editor.prepare({ scope: "user", key: "undo", value: { maxSizeMB: 250 } })).commit();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ undo: { maxSizeMB: 250 } });
      expect((await loadConfigEditor(input)).settings).toMatchObject({ undoMaxAgeDays: 30, undoMaxSizeMB: 250 });
    });
  });
}
