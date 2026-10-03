import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectDraftCheckpoint } from "../src/drafts/inspection.ts";
import { createJsonlSession, inspectSessionTranscript, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { inventorySessions, sessionTaskPreview } from "../src/session/discovery.ts";
import { withTempDir } from "./helpers.ts";

const header = (id: string, root: string, version = 4, createdAt = "2025-01-01T00:00:00Z") => ({ type: "session", version, id, workspaceRoot: root, launchCwd: root, extraRoots: [], createdAt });
const user = (text = "งานภาษาไทย 🙂", id = "user") => ({ type: "user", id, content: [{ type: "text", text }] });
const append = (parentId: string, item: unknown, committedAt?: string) => ({ type: "branch_append", version: 1, branchId: "main", entries: [{ parentId, item }], ...(committedAt ? { committedAt } : {}) });
const transcript = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const options = (home: string) => ({ home, all: true, limit: 100, offset: 0 });

async function writeSession(home: string, id: string, text: string) {
  const directory = sessionsDirectory(home);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, `${id}.jsonl`), text);
}

async function draft(home: string, root: string, id: string, overrides: Record<string, unknown> = {}) {
  const directory = join(home, ".schway", "drafts");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(JSON.stringify([root, id])).digest("hex");
  const path = join(directory, `${name}.json`);
  await fs.writeFile(path, JSON.stringify({ version: 1, workspaceRoot: root, sessionId: id, generation: "fixture", text: "NEVER EXPOSE DRAFT CONTENT", savedAt: "2025-01-01", ...overrides }), { mode: 0o600 });
  return path;
}

test("global timestamp ordering and scope filtering precede pagination beyond 100 files", async () => {
  await withTempDir(async home => {
    for (let index = 0; index < 125; index++) {
      const id = `id-${String(index).padStart(3, "0")}`;
      await writeSession(home, id, transcript(header(id, index % 2 ? home : "/other", 4, new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString())));
    }
    await writeSession(home, "last-name-recent", transcript(header("last-name-recent", home, 4, "bad")));
    await fs.writeFile(join(sessionsDirectory(home), "last-name-recent.jsonl.meta"), JSON.stringify({ activityAt: "2025-02-01T00:00:00+02:00" }));
    const result = await inventorySessions({ ...options(home), all: false, workspace: home, limit: 2, offset: 1 });
    expect(result.status).toBe("complete");
    expect(result.sessions.map(row => row.id)).toEqual(["id-123", "id-121"]);
    expect(result.hasMore).toBe(true);
    expect((await inventorySessions({ ...options(home), all: false, workspace: home, limit: 1 })).sessions[0]?.id).toBe("last-name-recent");
  });
});

test("parsed instants sort correctly; invalid timestamps are omitted, unknowns and ties use exact IDs", async () => {
  await withTempDir(async home => {
    for (const [id, time] of [["late", "2025-01-01T00:30:00Z"], ["early", "2025-01-01T01:00:00+02:00"], ["a", "bad"], ["Z", "bad"], ["tie-b", "2025-01-01T00:30:00Z"]]) await writeSession(home, id!, transcript(header(id!, home, 4, time!)));
    const result = await inventorySessions(options(home));
    expect(result.sessions.map(row => row.id)).toEqual(["late", "tie-b", "early", "Z", "a"]);
    expect(JSON.stringify(result.sessions.at(-1))).not.toContain("createdAt");
  });
});

test("every row state follows precedence without repairing or revealing draft bytes", async () => {
  await withTempDir(async home => {
    const records: Record<string, string> = {
      ready: transcript(header("ready", home), append("ready", user())),
      legacy: transcript(header("legacy", home, 3), append("legacy", user())),
      interrupted: transcript(header("interrupted", home, 1), { type: "assistant", id: "call", parentId: "interrupted", content: [{ type: "tool_call", id: "tool", name: "read", arguments: {} }] }),
      empty: transcript(header("empty", home)),
      draft: transcript(header("draft", home)),
      partial: transcript(header("partial", home), append("partial", user("x".repeat(70000)))),
      unsupported: transcript(header("unsupported", home, 999)),
      corrupt: transcript(header("corrupt", home), { type: "bad-record" }),
      mismatch: transcript(header("somebody-else", home)),
      torn: transcript(header("torn", home)) + '{"partial":',
    };
    for (const [id, text] of Object.entries(records)) await writeSession(home, id, text);
    for (const id of ["draft", "unsupported", "corrupt", "interrupted", "legacy"]) await draft(home, home, id);
    await fs.mkdir(join(sessionsDirectory(home), "unreadable.jsonl"));
    const result = await inventorySessions({ ...options(home), preview: true });
    expect(result.status).toBe("partial");
    const states = Object.fromEntries(result.sessions.map(row => [row.id, row.state]));
    expect(states).toEqual({ ready: "ready", legacy: "legacy", interrupted: "interrupted", empty: "empty", draft: "draft", partial: "partial", unsupported: "unsupported", corrupt: "corrupt", mismatch: "corrupt", torn: "interrupted", unreadable: "unreadable" });
    expect(result.sessions.find(row => row.id === "partial")?.previewIncomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NEVER EXPOSE");
    for (const [id, text] of Object.entries(records)) expect(await fs.readFile(join(sessionsDirectory(home), `${id}.jsonl`), "utf8")).toBe(text);
    expect((await inventorySessions({ ...options(home), all: false, workspace: home })).sessions.some(row => row.id === "mismatch")).toBe(false);
  });
});

test("observed corruption outranks a truncated window; bounded validation alone is a complete inventory", async () => {
  await withTempDir(async home => {
    await writeSession(home, "bad", transcript(header("bad", home), { type: "unknown" }) + "x".repeat(70000));
    await writeSession(home, "large", transcript(header("large", home), append("large", user("x".repeat(70000)))));
    const result = await inventorySessions(options(home));
    expect(result.status).toBe("complete");
    expect(result.sessions.find(row => row.id === "bad")).toMatchObject({ state: "corrupt", previewIncomplete: true });
    expect(result.sessions.find(row => row.id === "large")).toMatchObject({ state: "partial", previewIncomplete: true });
  });
});

test("all supported legacy formats and forward transitions retain semantic validation", () => {
  for (const version of [1, 2, 3]) {
    const record = version < 3 ? { ...user(), parentId: "id" } : append("id", user());
    expect(inspectSessionTranscript(transcript(header("id", "/root", version), record), "id", false).state).toBe("legacy");
  }
  expect(inspectSessionTranscript(transcript(header("id", "/root", 1), { type: "session_format", version: 4 }, append("id", user())), "id", false).state).toBe("ready");
  expect(inspectSessionTranscript(transcript(header("id", "/root"), { type: "session_format", version: 99 }), "id", false).state).toBe("unsupported");
  expect(inspectSessionTranscript(transcript(header("id", "/root"), append("wrong-parent", user())), "id", false).state).toBe("corrupt");
});

test("published release histories remain discoverable without changing their durable bytes", async () => {
  await withTempDir(async home => {
    const expected: Record<string, "legacy" | "ready"> = {};
    const originals: Record<string, string> = {};
    for (const release of ["0.4.0", "0.5.0", "0.6.0", "1.0.0-rc.1"]) {
      const directory = new URL(`./fixtures/sessions/${release}/`, import.meta.url).pathname;
      const fixture = JSON.parse(await fs.readFile(join(directory, "expect.json"), "utf8"));
      const text = await fs.readFile(join(directory, `${fixture.sessionId}.jsonl`), "utf8");
      await writeSession(home, fixture.sessionId, text);
      originals[fixture.sessionId] = text;
      expected[fixture.sessionId] = fixture.version < 4 ? "legacy" : "ready";
    }
    const result = await inventorySessions(options(home));
    expect(result.status).toBe("complete");
    expect(Object.fromEntries(result.sessions.map(row => [row.id, row.state]))).toEqual(expected);
    for (const [id, text] of Object.entries(originals)) expect(await fs.readFile(join(sessionsDirectory(home), `${id}.jsonl`), "utf8")).toBe(text);
  });
});

test("captured names survive create/delete/update races without duplicates or repeated metadata reads", async () => {
  await withTempDir(async home => {
    for (const id of ["deleted", "updated", "stable"]) await writeSession(home, id, transcript(header(id, home)));
    const realRead = fs.readdir;
    const directorySpy = spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const names = await Reflect.apply(realRead, fs, args);
      await fs.unlink(join(sessionsDirectory(home), "deleted.jsonl"));
      await writeSession(home, "new", transcript(header("new", home)));
      await writeSession(home, "updated", transcript(header("updated", home, 4, "2030-01-01")));
      return names;
    }) as typeof fs.readdir);
    const realOpen = fs.open, opened: string[] = [];
    const openSpy = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return Reflect.apply(realOpen, fs, args); }) as typeof fs.open);
    try {
      const result = await inventorySessions(options(home));
      expect(directorySpy).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("partial");
      expect(result.sessions.map(row => row.id)).toEqual(["updated", "stable", "deleted"]);
      expect(result.sessions.at(-1)?.state).toBe("unreadable");
      expect(new Set(opened).size).toBe(opened.length);
    } finally { directorySpy.mockRestore(); openSpy.mockRestore(); }
  });
});

test("draft inspection preserves stale locks, recovery artifacts, undo and checkpoints even for deleted workspaces", async () => {
  await withTempDir(async home => {
    const root = join(home, "deleted-workspace");
    const path = await draft(home, root, "saved");
    const files = [path, `${path}.lock`, `${path}.recovery`, `${path}.stopped.tmp`, join(home, ".schway", "undo-evidence")];
    for (const file of files.slice(1)) await fs.writeFile(file, JSON.stringify({ pid: 999999999, token: "a".repeat(36), evidence: file }), { mode: 0o600 });
    const before = await Promise.all(files.map(file => fs.readFile(file)));
    expect(inspectDraftCheckpoint({ home, workspaceRoot: root, sessionId: "saved" })).toEqual({ status: "valid", workspaceRoot: root, sessionId: "saved", present: true });
    await writeSession(home, "saved", transcript(header("saved", root)));
    const result = await inventorySessions({ ...options(home), preview: true });
    expect(result.sessions[0]?.state).toBe("draft");
    expect(JSON.stringify(result)).not.toContain("NEVER EXPOSE");
    expect(await Promise.all(files.map(file => fs.readFile(file)))).toEqual(before);
  });
});

test("live workspace draft inspection leaves recoverable stale writer files and all saved bytes untouched", async () => {
  await withTempDir(async home => {
    const path = await draft(home, home, "saved");
    const token = "a".repeat(36);
    await fs.writeFile(`${path}.lock`, JSON.stringify({ pid: 999999999, token }), { mode: 0o600 });
    await fs.writeFile(`${path}.${token}.tmp`, "PRIVATE STOPPED WRITER TEXT", { mode: 0o600 });
    await fs.mkdir(join(home, ".schway", "undo"));
    await fs.writeFile(join(home, ".schway", "undo", "snapshot"), "original undo bytes");
    await writeSession(home, "saved", transcript(header("saved", home)));
    const snapshot = async (directory: string): Promise<Record<string, string>> => {
      const result: Record<string, string> = {};
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, await snapshot(file));
        else result[file] = (await fs.readFile(file)).toString("base64");
      }
      return result;
    };
    const before = await snapshot(home);
    const result = await inventorySessions({ ...options(home), preview: true });
    expect(result.status).toBe("complete"); expect(result.sessions[0]?.state).toBe("draft");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(await snapshot(home)).toEqual(before);
  });
});

test("read windows stay bounded and report in-place changes without exposing tool payloads", async () => {
  await withTempDir(async home => {
    const saved = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
    saved.append({ type: "user", id: "task", content: [{ type: "text", text: "safe task" }] });
    saved.append({ type: "assistant", id: "assistant", content: [{ type: "tool_call", id: "call", name: "read", arguments: { secret: "PRIVATE TOOL ARGUMENT" } }] });
    saved.append({ type: "tool_result", id: "result", toolCallId: "call", content: "PRIVATE TOOL RESULT", isError: false });
    saved.append({ type: "assistant", id: "large", content: [{ type: "text", text: "x".repeat(70000) }] });
    const file = join(sessionsDirectory(home), `${saved.header.id}.jsonl`);
    const realOpen = fs.open;
    const requested: number[] = [];
    const openSpy = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await Reflect.apply(realOpen, fs, args);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", { value: async (...readArgs: [Buffer, number, number, number]) => {
        requested.push(readArgs[2]);
        const result = await read(...readArgs);
        if (String(args[0]) === file) await fs.appendFile(file, "\n");
        return result;
      } });
      return handle;
    }) as typeof fs.open);
    try {
      const result = await inventorySessions({ ...options(home), preview: true });
      expect(result.status).toBe("partial"); expect(result.warnings).toContain("History changed · Retry for a fresh listing");
      expect(result.sessions[0]).toMatchObject({ state: "partial", preview: "safe task", previewIncomplete: true });
      expect(JSON.stringify(result)).not.toContain("PRIVATE TOOL");
      expect(Math.max(...requested)).toBe(65536);
      expect(requested.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(65536 + 2048);
    } finally { openSpy.mockRestore(); }
  });
});

test("cancellation after enumeration retains only completed rows with a truthful partial warning", async () => {
  await withTempDir(async home => {
    await writeSession(home, "saved", transcript(header("saved", home)));
    const controller = new AbortController(), realRead = fs.readdir;
    const directorySpy = spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await Reflect.apply(realRead, fs, args); controller.abort(); return entries;
    }) as typeof fs.readdir);
    try {
      const result = await inventorySessions({ ...options(home), signal: controller.signal });
      expect(result.status).toBe("partial"); expect(result.sessions).toEqual([]);
      expect(result.warnings).toContain("Listing cancelled · Retry sessions list");
    } finally { directorySpy.mockRestore(); }
  });
});

test("draft inspection reports cleared, oversized, nonprivate, malformed, mismatched and symlink envelopes honestly", async () => {
  await withTempDir(async home => {
    const inspect = () => inspectDraftCheckpoint({ home, workspaceRoot: home, sessionId: "id" });
    expect(inspect()).toEqual({ status: "missing" });
    const path = await draft(home, home, "id", { cleared: true, text: undefined });
    expect(inspect()).toMatchObject({ status: "valid", present: false });
    for (const content of ["not json", JSON.stringify({ version: 1, sessionId: "other", workspaceRoot: home, text: "secret", savedAt: "today" }), "x".repeat(4 * 1024 * 1024 + 1)]) {
      await fs.writeFile(path, content); expect(inspect()).toEqual({ status: "unverifiable" });
    }
    await draft(home, home, "id"); await fs.chmod(path, 0o644);
    expect(inspect()).toEqual({ status: "unverifiable" });
    await fs.unlink(path); await fs.symlink(join(home, "absent"), path);
    expect(inspect()).toEqual({ status: "unverifiable" });
    await writeSession(home, "id", transcript(header("id", home)));
    const result = await inventorySessions(options(home));
    expect(result.sessions[0]?.state).toBe("empty"); expect(result.status).toBe("partial");
  });
});

test("previews preserve Unicode, remove controls, suppress sensitive patterns and mask known secrets", () => {
  expect(sessionTaskPreview("ทำงาน\u0000ภาษาไทย\n🙂 value-known", ["value-known"])).toBe("ทำงาน ภาษาไทย 🙂 ***");
  expect(Array.from(sessionTaskPreview("🙂".repeat(170))!)).toHaveLength(160);
  expect(sessionTaskPreview("value-extended", ["value", "value-extended"])).toBe("***");
  expect(sessionTaskPreview("\u001b[31mงานภาษาไทย\u001b[0m")).toBe("งานภาษาไทย");
  for (const text of ["/login paste", "task\n/login private-value", "use Bearer private-value", "Bearer\u001b[31m private-value", "api\u0000_key=my-value", "https://local/callback?code=secret", "credential sk-abcdefghijk", "https://user:password@example.com", "oauth callback"]) expect(sessionTaskPreview(text)).toBeUndefined();
});

test("preview is absent by default and exact normal IDs round-trip into existing resume", async () => {
  await withTempDir(async home => {
    const saved = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
    saved.append({ type: "user", id: "task", content: [{ type: "text", text: "ทำงานภาษาไทย 🙂" }] });
    const normal = await inventorySessions(options(home));
    expect(JSON.stringify(normal)).not.toContain("preview\":");
    const preview = await inventorySessions({ ...options(home), preview: true });
    expect(preview.sessions[0]?.preview).toBe("ทำงานภาษาไทย 🙂");
    expect((await loadJsonlSession({ directory: sessionsDirectory(home), id: normal.sessions[0]!.id })).header.id).toBe(saved.header.id);
  });
});

test("privacy omissions preserve normal IDs and protect workspace scope without inventing resume tokens", async () => {
  await withTempDir(async home => {
    const secret = "fixture-known-value", root = `/workspace/${secret}`;
    for (const id of ["ordinary", secret, "sk-recognizedcredential", "control\u001bname"]) await writeSession(home, id, transcript(header(id, root)));
    const result = await inventorySessions({ ...options(home), workspace: root, all: false, secrets: [secret] });
    expect(result.status).toBe("partial");
    expect(result.sessions.map(row => row.id)).toEqual(["ordinary"]);
    expect(result.scope).toEqual({ all: false });
    expect(result.sessions[0]?.workspaceRoot).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("recognizedcredential");
  });
});

test("missing storage succeeds; inaccessible home, directory failure and cancellation remain operational", async () => {
  await withTempDir(async home => {
    expect((await inventorySessions(options(home))).status).toBe("complete");
    expect((await inventorySessions(options(join(home, "missing")))).status).toBe("error");
    await fs.mkdir(join(home, ".schway")); await fs.writeFile(sessionsDirectory(home), "not a directory");
    expect((await inventorySessions(options(home))).status).toBe("error");
    expect((await inventorySessions({ ...options(home), signal: AbortSignal.abort() })).warnings[0]).toContain("cancelled");
  });
});
