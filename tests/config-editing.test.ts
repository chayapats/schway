import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { withTempDir } from "./helpers.ts";

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
    await expect(pending.commit()).rejects.toThrow("changed while");
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
