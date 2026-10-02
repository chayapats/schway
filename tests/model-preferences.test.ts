import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { ModelPreferences } from "../src/config/model-preferences.ts";
import { modelPickerIdentity } from "../src/tui/model-picker.ts";
import { withTempDir } from "./helpers.ts";

/** Derive an exact fixture identity without storing its endpoint or credential reference. */
function identity(modelId: string, endpoint = "https://user:secret@fixture.test/v1?key=secret") {
  return modelPickerIdentity({ provider: "openai-compatible", authRoute: "provider", modelId }, endpoint, "secret-reference");
}

test("favorites and recents survive restart, merge writers, and contain no raw endpoint secrets", async () => {
  await withTempDir(async home => {
    const a = new ModelPreferences(home), b = new ModelPreferences(home);
    a.read(); b.read();
    a.pin(identity("first"), true, { modelId: "first", groupIdentity: identity("") });
    b.pin(identity("second"), true);
    a.used(identity("second")); b.used(identity("first"));
    b.pin(identity("second"), false);
    const saved = new ModelPreferences(home).read();
    expect(saved.favorites).toEqual([identity("first")]);
    expect(saved.recents).toEqual([identity("first"), identity("second")]);
    expect(saved.models).toEqual({ [identity("first")]: { modelId: "first", groupIdentity: identity("") } });
    expect(identity("first", "https://fixture.test/other")).not.toBe(identity("first"));
    const file = join(home, ".schway/model-preferences.sqlite");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(file, "utf8");
    for (const secret of ["secret", "fixture.test", "https://"]) expect(bytes).not.toContain(secret);
  });
});

test("recent history is bounded while favorites remain pinned", async () => {
  await withTempDir(async home => {
    const store = new ModelPreferences(home);
    store.pin(identity("old"), true);
    for (let n = 0; n < 40; n++) store.used(identity(String(n)));
    expect(store.read().recents).toHaveLength(32);
    expect(store.read().favorites).toEqual([identity("old")]);
  });
});

test("SQLite rolls back a mutation that exceeds the favorite limit before closing", async () => {
  await withTempDir(async home => {
    const store = new ModelPreferences(home);
    for (let n = 0; n < 128; n++) store.pin(identity(String(n)), true);
    store.used(identity("recent"));
    const before = store.read();
    expect(() => store.pin(identity("overflow"), true, { modelId: "overflow", groupIdentity: identity("") })).toThrow("Favorite limit reached");
    expect(new ModelPreferences(home).read()).toEqual(before);
    store.pin(identity("0"), false);
    expect(store.pin(identity("replacement"), true).favorites).toHaveLength(128);
  });
});

test("malformed state fails closed and never replaces the database", async () => {
  await withTempDir(async home => {
    const store = new ModelPreferences(home); store.read();
    expect(() => store.pin("https://endpoint?secret=key", true)).toThrow("Invalid model identity");
    expect(() => store.pin(identity("x"), true, { modelId: "https://endpoint?secret=key", groupIdentity: identity("") })).toThrow("Invalid model identity");
    const file = join(home, ".schway/model-preferences.sqlite");
    const db = new Database(file);
    db.query("INSERT INTO preferences(identity, pinned) VALUES (?, ?)").run("malformed", -1); db.close();
    expect(() => store.read()).toThrow("Invalid model preferences");
    expect(() => store.used(identity("new"))).toThrow("Invalid model preferences");
    await writeFile(file, "broken state");
    expect(() => store.read()).toThrow();
    expect(await readFile(file, "utf8")).toBe("broken state");
  });
});

test("contention fails promptly and a retry preserves the other writer's changes", async () => {
  await withTempDir(async home => {
    const store = new ModelPreferences(home); store.pin(identity("existing"), true);
    const db = new Database(join(home, ".schway/model-preferences.sqlite"));
    db.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(() => store.read()).toThrow();
      expect(() => store.pin(identity("new"), true)).toThrow();
      expect(performance.now() - started).toBeLessThan(150);
    } finally { db.exec("ROLLBACK"); db.close(); }
    expect(store.pin(identity("new"), true).favorites).toEqual([identity("new"), identity("existing")]);
  });
});
