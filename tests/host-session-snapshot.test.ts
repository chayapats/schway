import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHost, hostCapabilities, type HostOptions, type HostSessionReference } from "schway/host";
import { SESSION_FORMAT_VERSION } from "../src/session/jsonl.ts";
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

test("capabilities advertise the session-snapshot contract", () => {
  expect(hostCapabilities().snapshotContract).toBe("schway.host.session-snapshot/v1");
});

test("quiesced snapshot restores in a fresh store and resumes one ancestry without replaying tools", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    let executions = 0;
    const tool = { name: "read_note", description: "Fixture read", execution: "parallel" as const, effect: "read-only" as const,
      inputSchema: { type: "object" }, async execute() { executions++; return { content: "fixture-note" }; } };
    const toolHost = await createHost({ ...config, tools: { policy: "exact", hostedLookup: "off", definitions: [tool] } });
    const first = await toolHost.createSession();
    const firstRun = await first.submit({ text: "โครงการแรก" }, createScriptedModel({ responses: [
      { toolCalls: [{ id: "call-1", name: "read_note", arguments: {} }] },
      { text: "persisted" },
    ] }));
    expect(firstRun.outcome).toBe("completed");
    expect(executions).toBe(1);
    const firstRef = first.reference;
    await first.close();
    const second = await toolHost.createSession();
    const secondRun = await second.submit({ text: "second context" }, createScriptedModel({ text: "second-saved" }));
    expect(secondRun.outcome).toBe("completed");
    const secondRef = second.reference;
    await second.close();
    await toolHost.close();

    const snapshot = await host.snapshotSessions([firstRef, secondRef]);
    expect(snapshot.snapshotContract).toBe("schway.host.session-snapshot/v1");
    expect(snapshot.nativeFormatVersion).toBe(SESSION_FORMAT_VERSION);
    expect(snapshot.sessions).toHaveLength(2);
    for (const session of snapshot.sessions) {
      expect(session.workspaceRoot).toBe(config.workspaceRoot);
      expect(session.retired).toBe(false);
      const kinds = session.artifacts.map(artifact => artifact.kind);
      expect(kinds).toContain("conversation");
      for (const artifact of session.artifacts) {
        expect(artifact.size).toBeGreaterThan(0);
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        const decoded = Buffer.from(artifact.dataBase64, "base64");
        expect(decoded.length).toBe(artifact.size);
        const { createHash } = await import("node:crypto");
        expect(createHash("sha256").update(decoded).digest("hex")).toBe(artifact.sha256);
      }
    }
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(config.sessionDirectory);
    expect(text).not.toContain(config.homeDirectory);
    expect(text.toLowerCase()).not.toContain("sk-");
    // Leases are never captured.
    expect(text).not.toContain("host-lease");
    expect(host.validateSessionSnapshot(snapshot).status).toBe("valid");

    // Fresh store with the same workspace identity restores without running models or tools.
    const freshDir = join(dir, "fresh");
    const freshConfig = await options(freshDir);
    // Restore requires the matching workspace root; point the fresh store at the same workspace.
    const matching = { ...freshConfig, workspaceRoot: config.workspaceRoot };
    const fresh = await createHost(matching);
    const restored = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") throw new Error("Expected restored");
    expect(restored.sessions).toHaveLength(2);
    expect(restored.nextAction.length).toBeGreaterThan(0);
    // No tool ran during restore.
    expect(executions).toBe(1);
    const reopened = await fresh.openSession(firstRef);
    const completed = reopened.reference;
    expect(completed).toEqual(firstRef);
    // Resume the captured ancestry with a fresh scripted model; history is data, not replay.
    const continued = await reopened.submit({ text: "ทำต่อ" }, createScriptedModel({ text: "continued" }));
    expect(continued.outcome).toBe("completed");
    expect(executions).toBe(1);
    await reopened.close();
    await fresh.close();
    await host.close();
  });
});

test("open handle and admitted run block snapshot with busy before copying", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await expect(host.snapshotSessions([reference])).rejects.toMatchObject({ code: "busy" });
    expect(await Bun.file(join(config.sessionDirectory, `${reference.id}.jsonl`)).exists()).toBe(true);
    const pending = session.submit({ text: "busy run" }, createScriptedModel({ waitForAbort: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(host.snapshotSessions([reference])).rejects.toMatchObject({ code: "busy" });
    session.cancel();
    expect((await pending).outcome).toBe("cancelled");
    await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions).toHaveLength(1);
    await host.close();
  });
});

test("unknown writer and symlink alias block snapshot with busy or conflict", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    const leasePath = join(config.sessionDirectory, `${reference.id}.host-lease`);
    await Bun.write(leasePath, JSON.stringify({ version: 1, host: "another-machine", pid: 123, token: crypto.randomUUID() }));
    await expect(host.snapshotSessions([reference])).rejects.toMatchObject({ code: "busy" });
    await unlink(leasePath);
    const source = join(config.sessionDirectory, `${reference.id}.jsonl`);
    const before = await readFile(source, "utf8");
    const outside = join(dir, "outside.jsonl");
    await Bun.write(outside, before);
    await unlink(source);
    await symlink(outside, source);
    await expect(host.snapshotSessions([reference])).rejects.toMatchObject({ code: "conflict" });
    await unlink(source);
    await Bun.write(source, before);
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions).toHaveLength(1);
    await host.close();
  });
});

test("retirement and deletion races have explicit conflict semantics with ledger filtering", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const first = await host.createSession();
    await first.submit({ text: "keep" }, createScriptedModel({ text: "ok" }));
    const keepRef = first.reference;
    await first.close();
    const second = await host.createSession();
    const dropRef = second.reference;
    await second.close();
    await host.retireSession(dropRef);
    // Snapshot records the retired tombstone by default.
    const full = await host.snapshotSessions([keepRef, dropRef]);
    expect(full.sessions).toHaveLength(2);
    expect(full.sessions.find(session => session.id === dropRef.id)?.retired).toBe(true);
    // Deletion-ledger filtering excludes retired refs before activation.
    const filtered = await host.snapshotSessions([keepRef, dropRef], { excludeRetired: true });
    expect(filtered.sessions.map(session => session.id)).toEqual([keepRef.id]);
    // Restore filtering skips retired tombstones.
    const freshDir = join(dir, "fresh-ledger");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const restored = await fresh.restoreSessionSnapshot(structuredClone(full), { excludeRetired: true });
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") throw new Error("Expected restored");
    expect(restored.sessions.map(session => session.id)).toEqual([keepRef.id]);
    await expect(fresh.openSession(dropRef)).rejects.toMatchObject({ code: "storage" });
    await fresh.close();
    // Without filtering the retired tombstone is restored and stays closed.
    const freshDir2 = join(dir, "fresh-retired");
    const freshConfig2 = await options(freshDir2);
    const fresh2 = await createHost({ ...freshConfig2, workspaceRoot: config.workspaceRoot });
    const restored2 = await fresh2.restoreSessionSnapshot(structuredClone(full));
    expect(restored2.status).toBe("restored");
    await expect(fresh2.openSession(dropRef)).rejects.toMatchObject({ code: "closed" });
    await fresh2.close();
    await host.close();
  });
});

test("missing, corrupt, incompatible and incomplete snapshots quarantine without activation", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.submit({ text: "quarantine me" }, createScriptedModel({ text: "ok" }));
    const reference = session.reference;
    await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    // Missing conversation artifact.
    const missing = structuredClone(snapshot);
    (missing.sessions[0] as unknown as { artifacts: unknown[] }).artifacts = (missing.sessions[0]!.artifacts as unknown[]).filter(
      artifact => (artifact as { kind: string }).kind !== "conversation");
    expect(host.validateSessionSnapshot(missing).status).toBe("quarantined");
    const freshMissing = await createHost(await options(join(dir, "fresh-missing")));
    expect((await freshMissing.restoreSessionSnapshot(missing, undefined)).status).toBe("quarantined");
    await freshMissing.close();
    // Corrupt bytes fail the integrity check.
    const corrupt = structuredClone(snapshot);
    const conversation = (corrupt.sessions[0]!.artifacts as { kind: string; dataBase64: string; size: number; sha256: string }[])
      .find(artifact => artifact.kind === "conversation")!;
    conversation.dataBase64 = Buffer.from("tampered-bytes").toString("base64");
    expect(host.validateSessionSnapshot(corrupt)).toMatchObject({ status: "quarantined" });
    // Incompatible native version quarantines.
    const future = structuredClone(snapshot);
    (future as { nativeFormatVersion: number }).nativeFormatVersion = SESSION_FORMAT_VERSION + 1;
    expect(host.validateSessionSnapshot(future)).toMatchObject({ status: "quarantined", reason: "unsupported-version" });
    // Incomplete shape quarantines.
    expect(host.validateSessionSnapshot({})).toMatchObject({ status: "quarantined" });
    // Restoring the corrupt set leaves no partial activation and runs nothing.
    const freshDir = join(dir, "fresh-quarantine");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const quarantined = await fresh.restoreSessionSnapshot(corrupt);
    expect(quarantined.status).toBe("quarantined");
    if (quarantined.status !== "quarantined") throw new Error("Expected quarantined");
    expect(quarantined.nextAction.length).toBeGreaterThan(0);
    expect(await Bun.file(join(freshConfig.sessionDirectory, `${reference.id}.jsonl`)).exists()).toBe(false);
    await expect(fresh.openSession(reference)).rejects.toMatchObject({ code: "storage" });
    await fresh.close();
    await host.close();
  });
});

test("older supported native versions restore through forward-only migration", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const id = crypto.randomUUID();
    const header = { type: "session", version: 1, id, createdAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: config.workspaceRoot, launchCwd: config.workspaceRoot, extraRoots: [] };
    const user = { type: "user", id: "u-legacy", content: [{ type: "text", text: "legacy work" }] };
    const assistant = { type: "assistant", id: "a-legacy", content: [{ type: "text", text: "legacy reply" }] };
    const lines = [JSON.stringify(header),
      JSON.stringify({ ...user, parentId: id }),
      JSON.stringify({ ...assistant, parentId: "u-legacy" })].join("\n") + "\n";
    await Bun.write(join(config.sessionDirectory, `${id}.jsonl`), lines);
    const reference: HostSessionReference = { id, branchId: "main" };
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions[0]!.nativeFormatVersion).toBe(1);
    expect(host.validateSessionSnapshot(snapshot).status).toBe("valid");
    const freshDir = join(dir, "fresh-legacy");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const restored = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(restored.status).toBe("restored");
    const reopened = await fresh.openSession(reference);
    // Forward migration preserved the legacy ancestry without replaying tools.
    const text = await readFile(join(freshConfig.sessionDirectory, `${id}.jsonl`), "utf8");
    expect(text).toContain("legacy work");
    await reopened.close();
    await fresh.close();
    await host.close();
  });
});

test("restore is idempotent for identical targets and conflicts on mismatch", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.submit({ text: "original" }, createScriptedModel({ text: "ok" }));
    const reference = session.reference;
    await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    const freshDir = join(dir, "fresh-conflict");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const first = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(first.status).toBe("restored");
    const second = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(second.status).toBe("restored");
    expect(second.nextAction).toContain("Reopen");
    await Bun.write(join(freshConfig.sessionDirectory, `${reference.id}.jsonl`), "forged-by-outside\n");
    const third = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(third).toMatchObject({ status: "quarantined", reason: "conflict" });
    if (third.status !== "quarantined") throw new Error("Expected quarantined");
    expect(third.nextAction).toBe("Snapshot quarantined. Delete the existing sessions, then retry restore.");
    await fresh.close();
    await host.close();
  });
});

test("workspace-mismatched snapshots quarantine without touching the store", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.close();
    const snapshot = await host.snapshotSessions([session.reference]);
    const otherDir = join(dir, "other");
    const otherConfig = await options(otherDir);
    const other = await createHost(otherConfig);
    expect(other.validateSessionSnapshot(snapshot)).toMatchObject({ status: "quarantined", reason: "workspace-mismatch" });
    const result = await other.restoreSessionSnapshot(structuredClone(snapshot));
    expect(result).toMatchObject({ status: "quarantined", reason: "workspace-mismatch" });
    expect(await Bun.file(join(otherConfig.sessionDirectory, `${session.reference.id}.jsonl`)).exists()).toBe(false);
    await other.close();
    await host.close();
  });
});

test("snapshot manifest carries stable refs and sanitized diagnostics", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const completed = await session.submit({ text: "sanitized" }, createScriptedModel({ text: "ok" }));
    expect(completed.outcome).toBe("completed");
    const reference = session.reference;
    await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions[0]).toMatchObject({ id: reference.id, branchId: reference.branchId });
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("sk-");
    await expect(host.snapshotSessions([{ id: "../escape", branchId: "main" }])).rejects.toMatchObject({ code: "invalid-reference" });
    await expect(host.snapshotSessions([])).rejects.toMatchObject({ code: "invalid-input" });
    await expect(host.snapshotSessions([reference], { excludeRetired: "yes" } as unknown as { excludeRetired: boolean })).rejects.toMatchObject({ code: "invalid-input" });
    await host.close();
  });
});

test("metadata symlink blocks snapshot through the pinned descriptor", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.submit({ text: "meta-symlink" }, createScriptedModel({ text: "ok" }));
    const reference = session.reference;
    await session.close();
    const metaPath = join(config.sessionDirectory, `${reference.id}.jsonl.meta`);
    const before = await Bun.file(metaPath).exists() ? await readFile(metaPath) : undefined;
    const outside = join(dir, "outside.meta");
    await Bun.write(outside, "unowned-metadata");
    try { await unlink(metaPath); } catch { /* Missing metadata still exercises the alias path. */ }
    await symlink(outside, metaPath);
    await expect(host.snapshotSessions([reference])).rejects.toMatchObject({ code: "conflict" });
    await unlink(metaPath);
    if (before !== undefined) await Bun.write(metaPath, before);
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions).toHaveLength(1);
    await host.close();
  });
});

test("mutated bytes after validation quarantine on restore without throwing", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.submit({ text: "mutate me" }, createScriptedModel({ text: "ok" }));
    const reference = session.reference;
    await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    expect(host.validateSessionSnapshot(snapshot).status).toBe("valid");
    const tampered = structuredClone(snapshot);
    const entry = (tampered.sessions[0]!.artifacts as { kind: string; dataBase64: string; size: number; sha256: string }[])
      .find(artifact => artifact.kind === "conversation")!;
    entry.dataBase64 = Buffer.from("tampered-bytes").toString("base64");
    const freshDir = join(dir, "fresh-mutated");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const result = await fresh.restoreSessionSnapshot(tampered);
    expect(result.status).toBe("quarantined");
    if (result.status !== "quarantined") throw new Error("Expected quarantined");
    expect(result.reason).toBe("corrupt");
    expect(await Bun.file(join(freshConfig.sessionDirectory, `${reference.id}.jsonl`)).exists()).toBe(false);
    const missing = structuredClone(snapshot);
    (missing.sessions[0] as unknown as { artifacts: unknown[] }).artifacts = [];
    const missingResult = await fresh.restoreSessionSnapshot(missing);
    expect(missingResult.status).toBe("quarantined");
    await fresh.close();
    await host.close();
  });
});

test("partial guidance resumes and busy guidance closes first", async () => {
  const { snapshotGuidance } = await import("../src/host/snapshot.ts");
  expect(snapshotGuidance("partial")).toBe("Snapshot partly restored. Retry restore to resume.");
  expect(snapshotGuidance("quarantined", "conflict")).toBe("Snapshot quarantined. Close the session and retry restore.");
  expect(snapshotGuidance("quarantined", "conflict", "target-exists")).toBe("Snapshot quarantined. Delete the existing sessions, then retry restore.");
  expect(snapshotGuidance("valid")).toBe("Snapshot valid. Restore into a fresh store to continue.");
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const first = await host.createSession();
    await first.submit({ text: "one" }, createScriptedModel({ text: "ok" }));
    const firstRef = first.reference;
    await first.close();
    const second = await host.createSession();
    await second.submit({ text: "two" }, createScriptedModel({ text: "ok" }));
    const secondRef = second.reference;
    await second.close();
    const full = await host.snapshotSessions([firstRef, secondRef]);
    const freshDir = join(dir, "fresh-resume");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const single = structuredClone(full) as unknown as { sessions: unknown[] };
    single.sessions = [single.sessions[0]];
    const one = await fresh.restoreSessionSnapshot(single);
    expect(one.status).toBe("restored");
    const resumed = await fresh.restoreSessionSnapshot(structuredClone(full));
    expect(resumed.status).toBe("restored");
    if (resumed.status !== "restored") throw new Error("Expected restored");
    expect(resumed.sessions.map(entry => entry.id).sort()).toEqual([firstRef.id, secondRef.id].sort());
    const busyHost = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const opened = await busyHost.openSession(firstRef);
    const busyResult = await busyHost.restoreSessionSnapshot(structuredClone(full));
    expect(busyResult).toMatchObject({ status: "quarantined", reason: "conflict" });
    if (busyResult.status !== "quarantined") throw new Error("Expected quarantined");
    expect(busyResult.nextAction).toBe("Snapshot quarantined. Close the session and retry restore.");
    await opened.close();
    await busyHost.close();
    await fresh.close();
    await host.close();
  });
});

test("oversized totals quarantine before decoding without huge allocation", async () => {
  const { validateSnapshotShape, MAX_SNAPSHOT_TOTAL_BYTES, MAX_SNAPSHOT_ARTIFACT_BYTES } = await import("../src/host/snapshot.ts");
  const { hashSnapshotBytes } = await import("../src/host/snapshot.ts");
  const tiny = Buffer.from("x");
  const tinyBase64 = tiny.toString("base64");
  const tinyHash = hashSnapshotBytes(tiny);
  const perSession = 32 * 1024 * 1024;
  const count = Math.ceil((MAX_SNAPSHOT_TOTAL_BYTES + 1) / perSession);
  expect(count).toBeLessThanOrEqual(64);
  const sessions = Array.from({ length: count }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    return {
      id,
      branchId: "main",
      workspaceRoot: "/work",
      headerCreatedAt: "2026-01-01T00:00:00.000Z",
      nativeFormatVersion: 4,
      retired: false,
      artifacts: [{ kind: "conversation", size: perSession, sha256: tinyHash, dataBase64: tinyBase64 }],
    };
  });
  const oversized = {
    snapshotContract: "schway.host.session-snapshot/v1",
    nativeFormatVersion: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    sessions,
  };
  expect(perSession).toBeLessThanOrEqual(MAX_SNAPSHOT_ARTIFACT_BYTES);
  const verdict = validateSnapshotShape(oversized);
  expect(verdict.status).toBe("quarantined");
});

test("snapshot shape rejects empty sets, unknown keys and relative roots", async () => {
  const { validateSnapshotShape } = await import("../src/host/snapshot.ts");
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    await session.close();
    const snapshot = structuredClone(await host.snapshotSessions([session.reference]));
    expect(validateSnapshotShape({ ...snapshot, sessions: [] })).toMatchObject({ status: "quarantined", reason: "incomplete" });
    expect(validateSnapshotShape({ ...snapshot, extra: 1 })).toMatchObject({ status: "quarantined", reason: "incomplete" });
    const badSession = structuredClone(snapshot);
    (badSession.sessions[0] as unknown as Record<string, unknown>)["extra"] = 1;
    expect(validateSnapshotShape(badSession)).toMatchObject({ status: "quarantined", reason: "incomplete" });
    const badArtifact = structuredClone(snapshot);
    ((badArtifact.sessions[0]!.artifacts as unknown[])[0] as Record<string, unknown>)["extra"] = 1;
    expect(validateSnapshotShape(badArtifact)).toMatchObject({ status: "quarantined" });
    const relative = structuredClone(snapshot);
    (relative.sessions[0] as unknown as Record<string, unknown>)["workspaceRoot"] = "relative/root";
    expect(validateSnapshotShape(relative)).toMatchObject({ status: "quarantined", reason: "incomplete" });
    const emptyRoot = structuredClone(snapshot);
    (emptyRoot.sessions[0] as unknown as Record<string, unknown>)["workspaceRoot"] = "";
    expect(validateSnapshotShape(emptyRoot)).toMatchObject({ status: "quarantined", reason: "incomplete" });
    await host.close();
  });
});

test("legacy restore keeps raw bytes until the next append", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const id = crypto.randomUUID();
    const header = { type: "session", version: 1, id, createdAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: config.workspaceRoot, launchCwd: config.workspaceRoot, extraRoots: [] };
    const user = { type: "user", id: "u-lazy", content: [{ type: "text", text: "legacy work" }] };
    const assistant = { type: "assistant", id: "a-lazy", content: [{ type: "text", text: "legacy reply" }] };
    const lines = [JSON.stringify(header),
      JSON.stringify({ ...user, parentId: id }),
      JSON.stringify({ ...assistant, parentId: "u-lazy" })].join("\n") + "\n";
    await Bun.write(join(config.sessionDirectory, `${id}.jsonl`), lines);
    const reference: HostSessionReference = { id, branchId: "main" };
    const snapshot = await host.snapshotSessions([reference]);
    const freshDir = join(dir, "fresh-lazy");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const restored = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(restored.status).toBe("restored");
    const expected = Buffer.from(snapshot.sessions[0]!.artifacts.find(artifact => artifact.kind === "conversation")!.dataBase64, "base64");
    expect(await readFile(join(freshConfig.sessionDirectory, `${id}.jsonl`))).toEqual(expected);
    const reopened = await fresh.openSession(reference);
    expect(await readFile(join(freshConfig.sessionDirectory, `${id}.jsonl`))).toEqual(expected);
    await reopened.close();
    await fresh.close();
    await host.close();
  });
});

test("restored retired tombstones populate the in-memory closed set", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    const host = await createHost(config);
    const session = await host.createSession();
    const reference = session.reference;
    await session.close();
    await host.retireSession(reference);
    const snapshot = await host.snapshotSessions([reference]);
    expect(snapshot.sessions[0]!.retired).toBe(true);
    const freshDir = join(dir, "fresh-remember");
    const freshConfig = await options(freshDir);
    const fresh = await createHost({ ...freshConfig, workspaceRoot: config.workspaceRoot });
    const restored = await fresh.restoreSessionSnapshot(structuredClone(snapshot));
    expect(restored.status).toBe("restored");
    await expect(fresh.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    await unlink(join(freshConfig.sessionDirectory, `${reference.id}.host-retired`));
    await expect(fresh.openSession(reference)).rejects.toMatchObject({ code: "closed" });
    await fresh.close();
    await host.close();
  });
});
