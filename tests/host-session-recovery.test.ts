import { expect, test } from "bun:test";
import { appendFile, link, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHost, hostCapabilities, type HostOptions, type HostRuntime, type HostSessionReference } from "schway/host";
import type { HostSessionInventoryOptions, HostSessionInventoryPage } from "../src/host/session-inventory.ts";
import { withTempDir, buildIsolatedCliEnv } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

// The integration owner adds this declaration to the public barrel in the batched PR.
type InventoryHost = HostRuntime & { listSessions(options?: HostSessionInventoryOptions): Promise<HostSessionInventoryPage> };
async function host(options: HostOptions): Promise<InventoryHost> { return await createHost(options) as InventoryHost; }

async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 2, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 100 } };
}

test("inventory pages discover live, retired and deleted identities without transcripts or model/tool work", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), owner = await host(config), recovery = await host(config);
    const first = await owner.createSession(), second = await owner.createSession(), third = await owner.createSession();
    await first.submit({ text: "transcript-secret" }, createScriptedModel({ text: "answer-secret" }));
    await second.close(); await owner.retireSession(second.reference);
    await third.close(); await owner.deleteSession(third.reference);
    const rows = []; let after: string | undefined;
    do {
      const page = await recovery.listSessions({ limit: 1, ...(after ? { after } : {}) });
      expect(page.sessions.length).toBeLessThanOrEqual(1); rows.push(...page.sessions); after = page.next;
    } while (after);
    expect(rows.length).toBe(3);
    expect(rows.map(row => row.reference.id)).toEqual(rows.map(row => row.reference.id).sort());
    expect(rows.find(row => row.reference.id === first.reference.id)?.state).toBe("active");
    expect(rows.find(row => row.reference.id === second.reference.id)?.state).toBe("retired");
    expect(rows.find(row => row.reference.id === third.reference.id)?.state).toBe("deleted");
    expect(JSON.stringify(rows)).not.toMatch(/transcript-secret|answer-secret|workspaceRoot|createdAt/);
    await expect(recovery.retireSession(first.reference)).rejects.toMatchObject({ code: "busy" });
    expect(await recovery.deleteSession(first.reference)).toMatchObject({ status: "blocked", reason: "busy" });
    await expect(recovery.snapshotSessions([first.reference])).rejects.toMatchObject({ code: "busy" });
    await first.close(); await owner.close();
    for (const row of rows) {
      if (row.state !== "deleted") await recovery.retireSession(row.reference);
      expect(["deleted", "already-deleted"]).toContain((await recovery.deleteSession(row.reference)).status);
      await expect(recovery.openSession(row.reference)).rejects.toMatchObject({ code: "closed" });
    }
    expect((await recovery.listSessions()).sessions.every(row => row.state === "deleted")).toBe(true);
    await recovery.close();
    await expect(recovery.listSessions()).rejects.toMatchObject({ code: "closed" });
  });
});

test("inventory scopes store/workspace, validates cursors and does not skip empty filtered pages", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), first = await host(config);
    const otherRoot = join(dir, "other"); await mkdir(otherRoot);
    const other = await host({ ...config, workspaceRoot: otherRoot });
    const foreign = await other.createSession(), own = await first.createSession();
    await foreign.close(); await own.close();
    const entries = []; let after: string | undefined;
    do {
      const page = await first.listSessions({ limit: 1, ...(after ? { after } : {}) });
      entries.push(...page.sessions); after = page.next;
    } while (after);
    expect(entries.map(entry => entry.reference)).toEqual([own.reference]);
    expect((await other.listSessions()).sessions.map(entry => entry.reference)).toEqual([foreign.reference]);
    expect((await (await host({ ...config, sessionDirectory: join(dir, "empty") })).listSessions()).sessions).toEqual([]);
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: NaN }, { after: "../escape" }, { after: "secret-cursor" }, { transcript: true }]) {
      await expect(first.listSessions(input as HostSessionInventoryOptions)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect((await first.listSessions({ after: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).sessions).toEqual([]);
    await first.close(); await other.close();
  });
});

for (const window of ["before-create", "before-app-commit", "after-app-commit"] as const) {
  test(`restart recovery after process crash ${window} converges without replay`, async () => {
    await withTempDir(async dir => {
      const config = await options(dir);
      // The parent models the already-persisted app intent; only after-app-commit stores a native reference.
      const intent: { native?: HostSessionReference } = {};
      const script = `import { createHost } from 'schway/host';
        const host = await createHost(${JSON.stringify(config)});
        ${window === "before-create" ? "console.log('{}');" : "const session = await host.createSession(); console.log(JSON.stringify(session.reference));"}
        await Bun.stdin.text();`;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { cwd: join(import.meta.dir, ".."),
        env: buildIsolatedCliEnv(config.homeDirectory), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        const reader = child.stdout.getReader();
        let output = "";
        while (!output.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error(await new Response(child.stderr).text()); output += new TextDecoder().decode(next.value); }
        reader.releaseLock();
        if (window === "after-app-commit") intent.native = JSON.parse(output);
        child.kill("SIGKILL"); await child.exited;
        const recovery = await host(config), discovered = (await recovery.listSessions()).sessions;
        if (window === "before-create") expect(discovered).toEqual([]);
        else {
          expect(discovered.length).toBe(1);
          const found = discovered[0]!;
          if (intent.native) expect(found.reference).toEqual(intent.native);
          // Positive dead-process lease evidence admits retirement; no session is reopened or run.
          await recovery.retireSession(found.reference);
          expect((await recovery.listSessions()).sessions[0]!.state).toBe("retired");
          expect((await recovery.deleteSession(found.reference)).status).toBe("deleted");
          expect((await recovery.deleteSession(found.reference)).status).toBe("already-deleted");
          await expect(recovery.openSession(found.reference)).rejects.toMatchObject({ code: "closed" });
        }
        await recovery.close();
      } finally { child.kill(); await child.exited; }
    });
  });
}

for (const window of ["retiring", "deleting", "deleted", "partial-header", "partial-retirement"] as const) {
  test(`restart fixture ${window} converges or reports a precise storage refusal`, async () => {
    await withTempDir(async dir => {
      const config = await options(dir), creator = await host(config), session = await creator.createSession();
      const ref = session.reference, path = join(config.sessionDirectory, `${ref.id}.jsonl`);
      await session.close(); await creator.close();
      if (window === "partial-header") await writeFile(path, '{"type":"session"');
      else if (window === "partial-retirement") await writeFile(join(config.sessionDirectory, `${ref.id}.host-retired`), '{"version":');
      else {
        const retire = await host(config); await retire.retireSession(ref); await retire.close();
        if (window === "deleting" || window === "deleted") await unlink(path);
        if (window === "deleting") await writeFile(`${path}.meta`, '{"title":"private"}');
      }
      const recovery = await host(config);
      if (window.startsWith("partial-")) await expect(recovery.listSessions()).rejects.toMatchObject({ code: "storage" });
      else {
        const found = (await recovery.listSessions()).sessions[0]!;
        expect(found.reference).toEqual(ref); expect(found.state).toBe(window === "retiring" ? "retired" : "deleted");
        await expect(recovery.openSession(found.reference)).rejects.toMatchObject({ code: "closed" });
        expect(["deleted", "already-deleted"]).toContain((await recovery.deleteSession(found.reference)).status);
        expect((await recovery.deleteSession(found.reference)).status).toBe("already-deleted");
      }
      await recovery.close();
    });
  });
}

test("discovery preserves torn transcripts and snapshot quarantine while refusing aliases", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), owner = await host(config), session = await owner.createSession();
    const ref = session.reference, path = join(config.sessionDirectory, `${ref.id}.jsonl`);
    await session.close();
    const snapshot = await owner.snapshotSessions([ref]);
    await appendFile(path, '{"type":"branch_append"');
    const before = await readFile(path, "utf8");
    expect((await owner.listSessions()).sessions[0]!.reference).toEqual(ref);
    expect(await readFile(path, "utf8")).toBe(before);
    await owner.deleteSession(ref);
    expect((await owner.restoreSessionSnapshot(snapshot)).status).toBe("quarantined");
    expect((await owner.listSessions()).sessions[0]!.state).toBe("deleted");
    const tombstone = join(config.sessionDirectory, `${ref.id}.host-retired`);
    const target = join(dir, "target"); await writeFile(target, "secret"); await unlink(tombstone); await symlink(target, tombstone);
    await expect(owner.listSessions()).rejects.toMatchObject({ code: "conflict" });
    await unlink(tombstone); await link(target, tombstone);
    await expect(owner.listSessions()).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(target, "utf8")).toBe("secret"); await owner.close();
  });
});

test("delete records retirement inside the cleanup transaction before removing the conversation", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), owner = await host(config), session = await owner.createSession();
    const ref = session.reference, path = join(config.sessionDirectory, `${ref.id}.jsonl`);
    await session.close();
    // Metadata removal fails after conversation removal, modelling interruption at that boundary.
    await mkdir(`${path}.meta`);
    expect((await owner.deleteSession(ref)).status).toBe("partial");
    expect(await Bun.file(path).exists()).toBe(false);
    expect((await owner.listSessions()).sessions).toEqual([{ reference: ref, state: "deleted" }]);
    await owner.close();
  });
});

test("inventory contract remains additive under release/v2", () => {
  expect(hostCapabilities().releaseContract).toBe("schway.host.release/v2");
});
