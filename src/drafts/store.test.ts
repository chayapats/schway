import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isOrdinaryDraft, openDraftStore } from "./store.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "schway-drafts-")); roots.push(home);
  const workspaceRoot = join(home, "workspace"); mkdirSync(workspaceRoot);
  const options = { home, workspaceRoot, sessionId: "session-a" };
  return { options, store: openDraftStore(options) };
}

describe("durable draft checkpoint", () => {
  test("keeps the latest multiline text through reopen with private permissions and no history", () => {
    const { options, store } = fixture();
    expect(store.checkpoint).toBeUndefined();
    store.save("first", 1); store.save("latest\nline two", 2);
    expect(openDraftStore(options).checkpoint?.text).toBe("latest\nline two");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(store.path))).toHaveLength(1);
  });
  test("fences old asynchronous revisions and accepted/discard cleanup", () => {
    const { options, store } = fixture();
    store.save("latest", 3);
    expect(store.save("stale", 2)).toBe(false);
    expect(store.clear(4)).toBe(true);
    expect(store.save("resurrect", 3)).toBe(false);
    expect(openDraftStore(options).checkpoint).toBeUndefined();
    expect(readdirSync(dirname(store.path))).toEqual([]);
  });
  test("isolates sessions and canonical workspace identities", () => {
    const { options, store } = fixture();
    store.save("first session", 1);
    const second = openDraftStore({ ...options, sessionId: "session-b" }); second.save("second", 1);
    const another = join(options.home, "other"); mkdirSync(another);
    const third = openDraftStore({ ...options, workspaceRoot: another }); third.save("third", 1);
    expect(openDraftStore(options).checkpoint?.text).toBe("first session");
    expect(second.checkpoint?.text).toBe("second"); expect(third.checkpoint?.text).toBe("third");
    const alias = join(options.home, "alias"); symlinkSync(options.workspaceRoot, alias);
    expect(openDraftStore({ ...options, workspaceRoot: alias }).path).toBe(store.path);
  });
  test("rejects conflicting writers without replacing the last valid checkpoint", () => {
    const { options, store } = fixture();
    const competitor = openDraftStore(options);
    store.save("first writer", 1);
    expect(() => competitor.save("stale writer", 1)).toThrow("another process");
    expect(openDraftStore(options).checkpoint?.text).toBe("first writer");
    writeFileSync(`${store.path}.lock`, "", { mode: 0o600 });
    expect(() => store.save("contested", 2)).toThrow("locked");
    expect(openDraftStore(options).checkpoint?.text).toBe("first writer");
    expect(readdirSync(dirname(store.path)).some(name => name.endsWith(".tmp"))).toBe(false);
  });
  test("rejects symlink targets and permissive files without touching unrelated data", () => {
    const { options, store } = fixture(); store.save("saved", 1);
    const unrelated = join(options.home, "unrelated"); writeFileSync(unrelated, "private");
    rmSync(store.path); symlinkSync(unrelated, store.path);
    expect(() => store.save("overwrite", 2)).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("private");
    rmSync(store.path); writeFileSync(store.path, "{}", { mode: 0o644 });
    expect(() => openDraftStore(options)).toThrow("private regular file");
    chmodSync(store.path, 0o600);
  });
  test("never serializes sensitive commands or callbacks, and excludes credential UI text", () => {
    const { store } = fixture(); store.save("ordinary", 1);
    const inputs = ["/login codex --code secret-callback", "hello\n/login openai secret", "https://localhost/callback?code=secret&state=nonce", "sk-123456789secret", "Bearer super-secret"];
    inputs.forEach((text, index) => expect(store.save(text, index + 2)).toBe(false));
    expect(readFileSync(store.path, "utf8")).not.toContain("secret");
    expect(isOrdinaryDraft("ordinary text while credential entry is open", true)).toBe(false);
    expect(isOrdinaryDraft("ordinary leaked-value", false, ["leaked-value"])).toBe(false);
    expect(isOrdinaryDraft("ordinary multiline\ninput")).toBe(true);
  });
});
