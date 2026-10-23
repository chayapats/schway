import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, link, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createHost, hostCapabilities, type HostOptions, type HostSessionReference } from "schway/host";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted fixture operator", sections: [], sources: [{ id: "evidence", revision: "v1", content: "inert" }] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 } };
}

test("capabilities advertise the managed-session-data contract", () => {
  expect(hostCapabilities().dataContract).toBe("schway.host.managed-session-data/v1");
});

test("retire and delete remove owned artifacts and block reopen without resurrection", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const completed = await session.submit({ text: "forget me" }, createScriptedModel({ text: "saved" }));
    expect(completed.outcome).toBe("completed");
    const reference = session.reference;
    await session.close();
    await host.retireSession(reference);
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    const deleted = await host.deleteSession(reference);
    expect(deleted.status).toBe("deleted");
    if (deleted.status !== "deleted") throw new Error("Expected deleted");
    expect(deleted.session).toEqual(reference);
    expect(deleted.removed).toContain("conversation");
    expect(deleted.nextAction.length).toBeGreaterThan(0);
    expect(JSON.stringify(deleted)).not.toContain(config.sessionDirectory);
    expect(JSON.stringify(deleted)).not.toContain(config.homeDirectory);
    const path = join(config.sessionDirectory, `${reference.id}.jsonl`);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(`${path}.meta`).exists()).toBe(false);
    expect(await Bun.file(join(config.sessionDirectory, `${reference.id}.host-lease`)).exists()).toBe(false);
    expect(await Bun.file(join(config.sessionDirectory, `${reference.id}.host-retired`)).exists()).toBe(true);
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    const retry = await host.deleteSession(reference);
    expect(retry.status).toBe("already-deleted");
    await host.close();
  });
});

test("session handle retire fences later submit and reopen", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.submit({ text: "retire me" }, createScriptedModel({ text: "ok" }));
    await session.retire();
    await expect(session.submit({ text: "after" }, createScriptedModel())).rejects.toMatchObject({ code: "closed" });
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    const deleted = await host.deleteSession(reference);
    expect(["deleted", "already-deleted"]).toContain(deleted.status);
    await host.close();
  });
});

test("active handle blocks deletion without partial state", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    const before = await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8");
    const blocked = await host.deleteSession(reference);
    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") throw new Error("Expected blocked");
    expect(blocked.reason).toBe("busy");
    expect(await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8")).toBe(before);
    await expect(host.retireSession(reference)).rejects.toMatchObject({ code: "busy" });
    expect(await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8")).toBe(before);
    await session.close();
    await host.retireSession(reference);
    const deleted = await host.deleteSession(reference);
    expect(deleted.status).toBe("deleted");
    await host.close();
  });
});

test("admitted run blocks retire and delete until settlement", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const pending = session.submit({ text: "busy run" }, createScriptedModel({ waitForAbort: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const blocked = await host.deleteSession(session.reference);
    expect(blocked.status).toBe("blocked");
    await expect(session.retire()).rejects.toMatchObject({ code: "busy" });
    const path = join(config.sessionDirectory, `${session.reference.id}.jsonl`);
    expect(await Bun.file(path).exists()).toBe(true);
    session.cancel();
    expect((await pending).outcome).toBe("cancelled");
    await session.close();
    await host.retireSession(session.reference);
    expect((await host.deleteSession(session.reference)).status).toBe("deleted");
    await host.close();
  });
});

test("unknown and malformed owners stay busy without deleting", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    const before = await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8");
    const leasePath = join(config.sessionDirectory, `${reference.id}.host-lease`);
    for (const owner of ["{torn", "null", JSON.stringify({ version: 1, host: "another-machine", pid: 123, token: crypto.randomUUID() })]) {
      await Bun.write(leasePath, owner);
      const blocked = await host.deleteSession(reference);
      expect(blocked.status).toBe("blocked");
      expect(await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8")).toBe(before);
      expect(await readFile(leasePath, "utf8")).toBe(owner);
      await unlink(leasePath);
    }
    await mkdir(`${leasePath}.admission`);
    const gated = await host.deleteSession(reference);
    expect(gated.status).toBe("blocked");
    expect(await readFile(join(config.sessionDirectory, `${reference.id}.jsonl`), "utf8")).toBe(before);
    await rmdir(`${leasePath}.admission`);
    await host.close();
  });
});

test("traversal and malformed references are rejected without touching the store", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    for (const bad of [{ id: "../escape", branchId: "main" }, { id: "/absolute", branchId: "main" },
      { id: "not-a-uuid", branchId: "main" }, { id: "", branchId: "main" }] as HostSessionReference[]) {
      await expect(host.deleteSession(bad)).rejects.toMatchObject({ code: "invalid-reference" });
      await expect(host.retireSession(bad)).rejects.toMatchObject({ code: "invalid-reference" });
      await expect(host.openSession(bad)).rejects.toMatchObject({ code: "invalid-reference" });
    }
    await host.close();
  });
});

test("symlink and hardlink session files cannot escape and are never deleted", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    const source = join(config.sessionDirectory, `${reference.id}.jsonl`);
    const outside = join(dir, "outside.jsonl");
    await Bun.write(outside, "outside target");
    await unlink(source);
    await symlink(outside, source);
    const blocked = await host.deleteSession(reference);
    expect(blocked.status).toBe("blocked");
    if (blocked.status !== "blocked") throw new Error("Expected blocked");
    expect(blocked.reason).toBe("conflict");
    expect(await readFile(outside, "utf8")).toBe("outside target");
    await unlink(source);
    await Bun.write(source, "restored");
    await host.close();
    const owner = await createHost(config);
    const second = await owner.createSession();
    const secondRef = second.reference;
    await second.close();
    const secondSource = join(config.sessionDirectory, `${secondRef.id}.jsonl`);
    const aliasDir = join(dir, "alias");
    await mkdir(aliasDir);
    const aliasTarget = join(aliasDir, `${secondRef.id}.jsonl`);
    await link(secondSource, aliasTarget);
    await unlink(aliasTarget);
    await owner.close();
  });
});

test("unrelated global CLI sessions are never deleted", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const { createJsonlSession } = await import("../src/session/jsonl.ts");
    const { sessionsDirectory } = await import("../src/session/jsonl.ts");
    const cliHome = config.homeDirectory;
    const cliDir = sessionsDirectory(cliHome);
    await mkdir(cliDir, { recursive: true });
    const cli = await createJsonlSession({ directory: cliDir, workspace: { root: config.workspaceRoot, launchCwd: config.workspaceRoot, extraRoots: [] } });
    cli.append({ type: "user", id: "user-1", content: [{ type: "text", text: "cli work" }] });
    const cliId = cli.header.id;
    const cliPath = join(cliDir, `${cliId}.jsonl`);
    expect(await Bun.file(cliPath).exists()).toBe(true);
    const host = await createHost(config);
    const result = await host.deleteSession({ id: cliId, branchId: "main" });
    expect(result.status).toBe("already-deleted");
    expect(await Bun.file(cliPath).exists()).toBe(true);
    expect(await readFile(cliPath, "utf8")).toContain("cli work");
    await host.close();
  });
});

test("workspace-mismatched sessions are rejected without deletion", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    const otherDir = join(dir, "other");
    await mkdir(join(otherDir, "work"), { recursive: true });
    await mkdir(join(otherDir, "home"), { recursive: true });
    const foreign = await createHost({ ...config, workspaceRoot: join(otherDir, "work"), homeDirectory: join(otherDir, "home") });
    await expect(foreign.retireSession(reference)).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(foreign.deleteSession(reference)).rejects.toMatchObject({ code: "workspace-mismatch" });
    expect(await Bun.file(join(config.sessionDirectory, `${reference.id}.jsonl`)).exists()).toBe(true);
    await foreign.close();
    await host.close();
  });
});

test("injected metadata failure returns partial and retry completes", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.submit({ text: "partial" }, createScriptedModel({ text: "ok" }));
    const reference = session.reference;
    await session.close();
    const metaPath = join(config.sessionDirectory, `${reference.id}.jsonl.meta`);
    expect(await Bun.file(metaPath).exists()).toBe(true);
    await unlink(metaPath);
    await mkdir(metaPath);
    const partial = await host.deleteSession(reference);
    expect(partial.status).toBe("partial");
    if (partial.status !== "partial") throw new Error("Expected partial");
    expect(partial.remaining).toContain("metadata");
    expect(partial.removed).toContain("conversation");
    expect(partial.nextAction).toContain("Retry");
    expect(await Bun.file(join(config.sessionDirectory, `${reference.id}.jsonl`)).exists()).toBe(false);
    await rmdir(metaPath);
    const retry = await host.deleteSession(reference);
    expect(retry.status).toBe("already-deleted");
    await host.close();
  });
});

test("already-deleted retry is idempotent", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    expect((await host.deleteSession(reference)).status).toBe("deleted");
    expect((await host.deleteSession(reference)).status).toBe("already-deleted");
    expect((await host.deleteSession(reference)).status).toBe("already-deleted");
    await host.close();
  });
});

test("missing references report already-deleted without creating side effects", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const missing = { id: crypto.randomUUID(), branchId: "main" };
    const result = await host.deleteSession(missing);
    expect(result.status).toBe("already-deleted");
    expect(result.nextAction).toContain("Retry is safe");
    await expect(host.retireSession(missing)).rejects.toMatchObject({ code: "storage" });
    await host.close();
  });
});

test("delayed run completion cannot resurrect deleted history", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    const pending = session.submit({ text: "race" }, createScriptedModel({ waitForAbort: true, text: "late" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    const blocked = await host.deleteSession(reference);
    expect(blocked.status).toBe("blocked");
    session.cancel();
    expect((await pending).outcome).toBe("cancelled");
    await session.close();
    await host.retireSession(reference);
    const deleted = await host.deleteSession(reference);
    expect(deleted.status).toBe("deleted");
    const saved = await Bun.file(join(config.sessionDirectory, `${reference.id}.jsonl`)).exists();
    expect(saved).toBe(false);
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    await host.close();
  });
});

test("late admitted writer cannot publish after deletion", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const other = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.submit({ text: "before delete" }, createScriptedModel({ text: "ok" }));
    await session.close();
    const reopened = await other.openSession(reference);
    expect(reopened.reference).toEqual(reference);
    await reopened.close();
    const deleted = await host.deleteSession(reference);
    expect(deleted.status).toBe("deleted");
    await expect(other.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    await expect(host.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    await host.close();
    await other.close();
  });
});

test("deletion cleans owned history, draft, undo and lease artifacts", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.submit({ text: "with sidecars" }, createScriptedModel({ text: "ok" }));
    await session.close();
    const { openDraftStore } = await import("../src/drafts/store.ts");
    const { openUndoStore } = await import("../src/undo/store.ts");
    const { historyFilePath } = await import("../src/history/store.ts");
    openDraftStore({ home: config.homeDirectory, workspaceRoot: config.workspaceRoot, sessionId: reference.id }).save("unsent draft", 1);
    const witness = join(config.workspaceRoot, "witness.txt");
    await Bun.write(witness, "before");
    await openUndoStore({ home: config.homeDirectory }).capture({ sessionId: reference.id, turnId: "turn-1", turnNumber: 1 }, witness);
    await Bun.write(historyFilePath(config.homeDirectory, reference.id), JSON.stringify({ type: "history", version: 1, sessionId: reference.id, createdAt: new Date().toISOString() }) + "\n");
    const deleted = await host.deleteSession(reference);
    expect(deleted.status).toBe("deleted");
    if (deleted.status !== "deleted") throw new Error("Expected deleted");
    expect(deleted.removed).toContain("conversation");
    expect(await Bun.file(historyFilePath(config.homeDirectory, reference.id)).exists()).toBe(false);
    expect(await Bun.file(join(config.homeDirectory, ".schway", "undo", reference.id, "turns", "turn-1.json")).exists()).toBe(false);
    expect(openDraftStore({ home: config.homeDirectory, workspaceRoot: config.workspaceRoot, sessionId: reference.id }).checkpoint).toBeUndefined();
    await host.close();
  });
});

test("deletion status is sanitized and never promises remote erasure", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    const deleted = await host.deleteSession(reference);
    const text = JSON.stringify(deleted);
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("Bearer");
    expect(text.toLowerCase()).not.toContain("remote provider");
    expect(text.toLowerCase()).not.toContain("provider copy");
    await host.close();
  });
});
