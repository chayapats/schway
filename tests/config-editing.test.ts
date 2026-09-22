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
    await writeFile(join(home, ".schway/config.json"), '{"model":"claude-opus-4-6","maxOutput":4000}');
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai" } });
    expect(editor.settings.model).toBe("gpt-5.4");
    expect(editor.origins.model).toBe("built-in default");
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
