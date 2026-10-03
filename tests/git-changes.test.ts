import { expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { TuiController } from "../src/tui/controller.ts";
import { parseGitDiff } from "../src/text/diff.ts";
import { parseSlashCommand, helpText } from "../src/tui/commands.ts";
import {
  captureGitSnapshot,
  compareGitSnapshots,
  formatGitStatus,
  formatGitDiffPreview,
  inspectGitStatus,
  getGitDiffPreview,
  parseGitChangeTracking,
  DEFAULT_GIT_CHANGE_TRACKING,
} from "../src/workspace/git.ts";
import {
  parseConfigObject,
  resolveSettings,
  DEFAULT_GIT_CHANGE_TRACKING as CONFIG_DEFAULT,
} from "../src/config/config.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

test("real untracked previews keep literal source separate from a multiline filename footer", async () => {
  await withTempDir(async root => {
    const initialized = Bun.spawnSync(["git", "init", "-q"], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    expect(initialized.exitCode).toBe(0);
    const path = "multi\nline.txt";
    const prefix = "hello\n... truncated at SOURCE CONTENT\nmore source\n";
    await writeFile(join(root, path), `${prefix}additional text beyond the preview`);
    const preview = await getGitDiffPreview(root, path, prefix.length);
    if ("error" in preview) throw new Error(preview.error);
    const cliDiff = `Untracked:\n${prefix}\n… truncated at ${prefix.length} chars. Use git diff --no-index /dev/null -- ${path} in ${root} for the full content.`;
    expect(preview.diff).toBe(cliDiff);
    expect(formatGitDiffPreview(preview)).toBe(`Diff for ${path}:\n${cliDiff}\nPreview truncated. Use git diff in the workspace for full content.`);
    expect(parseGitDiff(preview)).toEqual([
      { sign: "+", line: 1, text: "hello" },
      { sign: "+", line: 2, text: "... truncated at SOURCE CONTENT" },
      { sign: "+", line: 3, text: "more source" },
      { sign: " ", text: "Preview truncated · use git diff for full content" },
    ]);
    const tiny = await getGitDiffPreview(root, path, 5);
    if ("error" in tiny) throw new Error(tiny.error);
    expect(parseGitDiff(tiny)).toEqual([
      { sign: "+", line: 1, text: "hello" },
      { sign: " ", text: "Preview truncated · use git diff for full content" },
    ]);
    const literal = "hello\n… truncated at SOURCE CONTENT\nmore source\n";
    await writeFile(join(root, path), literal);
    const complete = await getGitDiffPreview(root, path);
    if ("error" in complete) throw new Error(complete.error);
    expect(complete.diff).toBe(`Untracked:\n${literal}`);
    expect(parseGitDiff(complete)).toEqual([
      { sign: "+", line: 1, text: "hello" },
      { sign: "+", line: 2, text: "… truncated at SOURCE CONTENT" },
      { sign: "+", line: 3, text: "more source" },
    ]);
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
  return out.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.test");
  await git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "tracked.txt"), "original\n");
  await git(dir, "add", "tracked.txt");
  await git(dir, "commit", "-qm", "initial");
}

function workspaceFor(dir: string) {
  return { root: dir, launchCwd: dir, extraRoots: [] as string[] };
}

function controllerFor(dir: string, mode: "off" | "on-demand" | "snapshot", model: ReturnType<typeof createScriptedModel>) {
  const workspace = workspaceFor(dir);
  const session = createSession();
  return new TuiController({
    session,
    model,
    contextManager: createContextManager(workspace),
    tools: createToolRegistry([readTool, writeTool]),
    workspace,
    provider: "scripted",
    modelId: "scripted",
    sessionId: "sess-changes",
    changeTracking: mode,
  });
}

function lastDetails(controller: TuiController): string {
  expect(controller.inspectNoticeDetails()).toBe(true);
  return lastNotice(controller);
}

function lastNotice(controller: TuiController): string {
  const entries = controller.snapshot().transcript;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === "system") return entries[i]!.text;
  }
  return "";
}

test("git.changeTracking defaults to on-demand and validates modes", () => {
  expect(DEFAULT_GIT_CHANGE_TRACKING).toBe("on-demand");
  expect(CONFIG_DEFAULT).toBe("on-demand");
  expect(parseGitChangeTracking("off")).toBe("off");
  expect(parseGitChangeTracking("on-demand")).toBe("on-demand");
  expect(parseGitChangeTracking("snapshot")).toBe("snapshot");
  expect(parseGitChangeTracking("auto")).toEqual({ error: expect.any(String) });
  expect(parseConfigObject({}, "test")).toEqual({});
  const valid = parseConfigObject({ git: { changeTracking: "snapshot" } }, "test");
  expect(valid).toEqual({ git: { changeTracking: "snapshot" } });
  const invalid = parseConfigObject({ git: { changeTracking: "auto" } }, "test");
  expect("error" in invalid).toBe(true);
  const extra = parseConfigObject({ git: { changeTracking: "off", extra: true } }, "test");
  expect("error" in extra).toBe(true);
  const resolved = resolveSettings({});
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.gitChangeTracking).toBe("on-demand");
  const snap = resolveSettings({ user: { git: { changeTracking: "snapshot" } } });
  if ("error" in snap) throw new Error(snap.error);
  expect(snap.gitChangeTracking).toBe("snapshot");
});

test("/changes is a builtin slash command with help", () => {
  expect(parseSlashCommand("/changes")?.name).toBe("changes");
  expect(parseSlashCommand("/changes status")?.name).toBe("changes");
  expect(parseSlashCommand("/changes diff -- foo.txt")?.name).toBe("changes");
  expect(helpText()).toContain("/changes");
});

test("on-demand status shows branch, HEAD, and dirty state", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "tracked.txt"), "modified\n");
    const status = await inspectGitStatus(dir);
    if ("error" in status) throw new Error(status.error);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.dirty).toBe(true);
    expect(status.head.length).toBe(40);
    expect(status.detached).toBe(false);
    const text = formatGitStatus(status);
    expect(text).toContain("Branch:");
    expect(text).toContain("HEAD:");
    expect(text).toContain("tracked.txt");
  });
});

test("non-Git workspace and detached HEAD display without blocking", async () => {
  await withTempDir(async (dir) => {
    const plain = await inspectGitStatus(dir);
    if ("error" in plain) throw new Error("non-git should not error");
    expect(plain.isGit).toBe(false);
    expect(formatGitStatus(plain)).toContain("Not a Git workspace");
    const controller = controllerFor(dir, "on-demand", createScriptedModel({ text: "ok" }));
    expect(await controller.changesCommand("")).toBe(true);
    expect(lastNotice(controller)).toContain("Not a Git workspace");

    await withTempDir(async (repo) => {
      await initRepo(repo);
      await git(repo, "checkout", "--detach", "-q");
      const status = await inspectGitStatus(repo);
      if ("error" in status) throw new Error(status.error);
      expect(status.isGit).toBe(true);
      if (!status.isGit) return;
      expect(status.detached).toBe(true);
      expect(formatGitStatus(status)).toContain("detached HEAD");
      const detached = controllerFor(repo, "on-demand", createScriptedModel({ text: "ok" }));
      expect(await detached.changesCommand("status")).toBe(true);
      expect(lastDetails(detached)).toContain("detached HEAD");
    });
  });
});

test("staged, unstaged, untracked, deleted, renamed, and binary variants are useful", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    // Deleted (unstaged): commit first so later staging is not swept into the commit.
    await writeFile(join(dir, "victim.txt"), "gone\n");
    await git(dir, "add", "victim.txt");
    await git(dir, "commit", "-qm", "victim");
    await rm(join(dir, "victim.txt"));
    // Renamed (staged).
    await writeFile(join(dir, "rename-me.txt"), "rename\n");
    await git(dir, "add", "rename-me.txt");
    await git(dir, "commit", "-qm", "rename source");
    await git(dir, "mv", "rename-me.txt", "renamed.txt");
    // Staged modification last so no later commit sweeps it.
    await writeFile(join(dir, "tracked.txt"), "staged change\n");
    await git(dir, "add", "tracked.txt");
    // Untracked addition.
    await writeFile(join(dir, "new-untracked.txt"), "hello\n");
    // Binary addition.
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));
    const status = await inspectGitStatus(dir);
    if ("error" in status) throw new Error(status.error);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    const paths = status.files.map((f) => f.path);
    expect(paths).toContain("tracked.txt");
    expect(paths).toContain("new-untracked.txt");
    expect(paths).toContain("victim.txt");
    expect(paths.some((p) => p === "renamed.txt")).toBe(true);
    expect(paths).toContain("blob.bin");
    const binary = status.files.find((f) => f.path === "blob.bin");
    expect(binary?.binary).toBe(true);
    const untracked = status.files.find((f) => f.path === "new-untracked.txt");
    expect(untracked?.untracked).toBe(true);
    const text = formatGitStatus(status);
    expect(text).toContain("[binary]");
    expect(text).toContain("untracked");
    const preview = await getGitDiffPreview(dir, "tracked.txt");
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.diff).toContain("staged change");
    expect(preview.diff).toContain("Staged:");
    const untrackedPreview = await getGitDiffPreview(dir, "new-untracked.txt");
    if ("error" in untrackedPreview) throw new Error(untrackedPreview.error);
    expect(untrackedPreview.diff).toContain("hello");
    expect(untrackedPreview.diff).toContain("Untracked:");
  });
});

test("rename links origPath to updated pre-existing instead of new plus resolved", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const base = "line1\nline2\nline3\nline4\nline5\n";
    await writeFile(join(dir, "old.txt"), base);
    await git(dir, "add", "old.txt");
    await git(dir, "commit", "-qm", "old");
    await writeFile(join(dir, "old.txt"), `${base}line6\n`);
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    expect(before.entries.map((entry) => entry.path)).toContain("old.txt");
    await git(dir, "mv", "old.txt", "new.txt");
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const moved = after.entries.find((entry) => entry.path === "new.txt");
    expect(moved?.origPath).toBe("old.txt");
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.updatedPreExisting).toContain("new.txt");
    expect(comparison.newChanges).not.toContain("new.txt");
    expect(comparison.resolved ?? []).not.toContain("old.txt");
  });
});

test("off performs no tracking and on-demand keeps status output on demand", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const off = controllerFor(dir, "off", createScriptedModel({ text: "done" }));
    expect(await off.changesCommand("")).toBe(true);
    expect(lastNotice(off)).toContain("Change tracking is off");
    await off.submit("hello");
    expect(await off.changesCommand("")).toBe(true);
    expect(lastNotice(off)).toContain("Change tracking is off");

    const demand = controllerFor(dir, "on-demand", createScriptedModel({ text: "done" }));
    await demand.submit("hello");
    expect(demand.snapshot().status).toBe("idle");
    expect(await demand.changesCommand("")).toBe(true);
    const notice = lastDetails(demand);
    expect(notice).toContain("Change tracking: on-demand");
    expect(notice).not.toContain("Baseline");
    expect(notice).not.toContain("Snapshot comparison");
  });
});

test("snapshot distinguishes pre-existing dirt from new turn edits", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    // Pre-existing dirty baseline.
    await writeFile(join(dir, "tracked.txt"), "pre-existing edit\n");
    const controller = controllerFor(
      dir,
      "snapshot",
      createScriptedModel({
        responses: [
          { toolCalls: [{ id: "w1", name: "write", arguments: { path: "turn-new.txt", content: "turn edit\n" } }] },
          { text: "done" },
        ],
      }),
    );
    await controller.submit("make a change");
    expect(controller.snapshot().status).toBe("idle");
    expect(await controller.changesCommand("")).toBe(true);
    const notice = lastDetails(controller);
    expect(notice).toContain("Snapshot comparison");
    expect(notice).toContain("turn-new.txt");
    expect(notice).toContain("Pre-existing");
    // Direct hash comparison also separates the two.
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    await writeFile(join(dir, "another.txt"), "more\n");
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.newChanges).toContain("another.txt");
    expect(comparison.preExistingUnchanged).toContain("tracked.txt");
    expect(comparison.preExistingUnchanged).toContain("turn-new.txt");
  });
});

test("failed turns report settled edits and failed snapshots are explicit, not clean", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "pre.txt"), "pre\n");
    const failing = controllerFor(
      dir,
      "snapshot",
      createScriptedModel({
        responses: [
          { toolCalls: [{ id: "w1", name: "write", arguments: { path: "partial.txt", content: "partial\n" } }] },
          { error: "boom" },
        ],
      }),
    );
    await failing.submit("fail please");
    expect(failing.snapshot().status).toBe("error");
    expect(await failing.changesCommand("")).toBe(true);
    const notice = lastDetails(failing);
    expect(notice).toContain("Change tracking: snapshot");
    expect(notice).toContain("partial.txt");
    expect(notice).not.toContain("Snapshot unavailable");

    // Non-Git snapshot capture fails explicitly.
    await withTempDir(async (plain) => {
      const bad = await captureGitSnapshot(plain);
      expect("error" in bad).toBe(true);
      const snapshotMode = controllerFor(plain, "snapshot", createScriptedModel({ text: "ok" }));
      await snapshotMode.submit("hello");
      expect(await snapshotMode.changesCommand("")).toBe(true);
      const text = lastDetails(snapshotMode);
      expect(text).toContain("Not a Git workspace");
    });
  });
});

test("cancelled turns capture settled partial state", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const controller = controllerFor(dir, "snapshot", createScriptedModel({ waitForAbort: true }));
    const turn = controller.submit("slow turn");
    await Bun.sleep(50);
    controller.cancel();
    await turn;
    await controller.waitForIdle();
    expect(await controller.changesCommand("")).toBe(true);
    const notice = lastDetails(controller);
    expect(notice).toContain("Change tracking: snapshot");
  });
});

test("inspection leaves index, HEAD, branches, config, and files unchanged", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "tracked.txt"), "dirty\n");
    const beforeHead = await git(dir, "rev-parse", "HEAD");
    const beforeBranches = await git(dir, "branch", "--list");
    const beforeIndex = await git(dir, "diff", "--cached", "--name-only");
    const beforeConfig = await git(dir, "config", "--list");
    const beforeContent = await readFile(join(dir, "tracked.txt"), "utf8");
    const controller = controllerFor(dir, "on-demand", createScriptedModel({ text: "ok" }));
    expect(await controller.changesCommand("status")).toBe(true);
    expect(await controller.changesCommand("diff")).toBe(true);
    await inspectGitStatus(dir);
    await captureGitSnapshot(dir);
    await getGitDiffPreview(dir);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(dir, "branch", "--list")).toBe(beforeBranches);
    expect(await git(dir, "diff", "--cached", "--name-only")).toBe(beforeIndex);
    expect(await git(dir, "config", "--list")).toBe(beforeConfig);
    expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe(beforeContent);
  });
});

test("bounded summaries truncate large change sets explicitly", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 60; i++) {
      await writeFile(join(dir, `bulk-${i}.txt`), `file ${i}\n`);
    }
    const status = await inspectGitStatus(dir);
    if ("error" in status) throw new Error(status.error);
    expect(status.isGit).toBe(true);
    if (!status.isGit) return;
    expect(status.truncated).toBe(true);
    expect(status.files.length).toBeLessThanOrEqual(50);
    expect(formatGitStatus(status)).toContain("Showing 50 files of 60 files");
  });
});

test("resume shows current state without claiming a retained snapshot", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const first = controllerFor(dir, "snapshot", createScriptedModel({ text: "done" }));
    await first.submit("one");
    expect(await first.changesCommand("")).toBe(true);
    expect(lastDetails(first)).toContain("Snapshot comparison");

    const workspace = workspaceFor(dir);
    const second = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-resumed",
      changeTracking: "snapshot",
    });
    expect(await second.changesCommand("")).toBe(true);
    const notice = lastDetails(second);
    expect(notice).toContain("No retained snapshot");
    expect(notice).not.toContain("Baseline ");
  });
});

test("inspection ignores ambient GIT_DIR-style overrides", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "requested-marker.txt"), "requested\n");
    await withTempDir(async (other) => {
      await initRepo(other);
      await writeFile(join(other, "other-marker.txt"), "other\n");
      const expectedHead = await git(dir, "rev-parse", "HEAD");
      const saved = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
        GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
        GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      };
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = join(other, ".git", "index");
      process.env.GIT_OBJECT_DIRECTORY = join(other, ".git", "objects");
      process.env.GIT_COMMON_DIR = join(other, ".git");
      try {
        const status = await inspectGitStatus(dir);
        if ("error" in status) throw new Error(status.error);
        expect(status.isGit).toBe(true);
        if (!status.isGit) return;
        expect(status.root).toBe(await git(dir, "rev-parse", "--show-toplevel"));
        expect(status.head).toBe(expectedHead);
        const paths = status.files.map((file) => file.path);
        expect(paths).toContain("requested-marker.txt");
        expect(paths).not.toContain("other-marker.txt");
        const snapshot = await captureGitSnapshot(dir);
        if ("error" in snapshot) throw new Error(snapshot.error);
        expect(snapshot.root).toBe(status.root);
        expect(snapshot.head).toBe(expectedHead);
        expect(snapshot.entries.map((entry) => entry.path)).toContain("requested-marker.txt");
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});

test("stale baseline capture does not repopulate a replaced session", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const controller = controllerFor(dir, "snapshot", createScriptedModel({ text: "ok" }));
    const access = controller as unknown as {
      activeAbort?: AbortController;
      captureTurnBaseline(signal: AbortSignal): Promise<void>;
    };
    const owner = new AbortController();
    access.activeAbort = owner;
    const pending = access.captureTurnBaseline(owner.signal);
    controller.replaceSession(createSession(), "replaced");
    await pending;
    expect(await controller.changesCommand("")).toBe(true);
    const notice = lastDetails(controller);
    expect(notice).toContain("No retained snapshot");
    expect(notice).not.toContain("Snapshot unavailable");
  });
  await withTempDir(async (plain) => {
    const controller = controllerFor(plain, "snapshot", createScriptedModel({ text: "ok" }));
    const access = controller as unknown as {
      activeAbort?: AbortController;
      captureTurnBaseline(signal: AbortSignal): Promise<void>;
    };
    const owner = new AbortController();
    access.activeAbort = owner;
    const pending = access.captureTurnBaseline(owner.signal);
    controller.replaceSession(createSession(), "replaced-plain");
    await pending;
    expect(await controller.changesCommand("")).toBe(true);
    expect(lastNotice(controller)).not.toContain("Snapshot unavailable");
  });
});

test("snapshot lists untracked directory contents so turn edits stay visible", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await mkdir(join(dir, "scratch"), { recursive: true });
    await writeFile(join(dir, "scratch", "old.txt"), "pre-existing\n");
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    expect(before.entries.map((entry) => entry.path)).toContain("scratch/old.txt");
    await writeFile(join(dir, "scratch", "turn.txt"), "turn edit\n");
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.newChanges).toContain("scratch/turn.txt");
    expect(comparison.preExistingUnchanged).toContain("scratch/old.txt");
  });
});

test("large snapshots compare complete entry lists with display-only truncation", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 210; i++) {
      await writeFile(join(dir, `wide-${i}.txt`), `file ${i}\n`);
    }
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    expect(before.truncated).toBe(true);
    expect(before.entries.length).toBe(before.totalFiles);
    expect(before.entries.length).toBeGreaterThan(200);
    await writeFile(join(dir, "wide-0.txt"), "changed\n");
    await writeFile(join(dir, "wide-new.txt"), "new\n");
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.newChanges).toContain("wide-new.txt");
    expect(comparison.updatedPreExisting).toContain("wide-0.txt");
    expect(comparison.preExistingUnchanged).toContain("wide-1.txt");
    expect(comparison.newChanges).not.toContain("wide-1.txt");
  });
});

test("missing git leaves turns usable and the next submit recovers", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    const controller = controllerFor(dir, "snapshot", createScriptedModel({ responses: [{ text: "first" }, { text: "second" }] }));
    const realSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("spawn git ENOENT");
    }) as typeof Bun.spawn;
    try {
      const snapshot = await captureGitSnapshot(dir);
      expect("error" in snapshot).toBe(true);
      if ("error" in snapshot) expect(snapshot.error).toContain("unavailable");
      await controller.submit("hello without git");
      expect(controller.snapshot().status).toBe("idle");
      expect(controller.running).toBe(false);
      expect(await controller.changesCommand("")).toBe(true);
      expect(lastNotice(controller)).toContain("Snapshot unavailable");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = realSpawn;
    }
    await controller.submit("hello with git back");
    expect(controller.snapshot().status).toBe("idle");
    expect(await controller.changesCommand("")).toBe(true);
    expect(lastDetails(controller)).toContain("Snapshot comparison");
  });
});

test("staged rename with further unstaged edit stays linked as updated", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "plain.txt"), "same content\n");
    await git(dir, "add", "plain.txt");
    await git(dir, "commit", "-qm", "plain");
    // Dirty at baseline so the later rename links back to a retained entry.
    await writeFile(join(dir, "plain.txt"), "same content\nbaseline edit\n");
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    await git(dir, "mv", "plain.txt", "moved.txt");
    await writeFile(join(dir, "moved.txt"), "same content\nplus an unstaged edit\n");
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const moved = after.entries.find((entry) => entry.path === "moved.txt");
    expect(moved?.origPath).toBe("plain.txt");
    expect(moved?.staged).toBe("R");
    expect(moved?.unstaged).toBe("M");
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.updatedPreExisting).toContain("moved.txt");
    expect(comparison.newChanges).not.toContain("moved.txt");
    expect(comparison.resolved ?? []).not.toContain("plain.txt");
  });
});

test("worktree-only move reports deleted plus untracked without dropping entries", async () => {
  await withTempDir(async (dir) => {
    await initRepo(dir);
    await writeFile(join(dir, "plain.txt"), "same content\n");
    await git(dir, "add", "plain.txt");
    await git(dir, "commit", "-qm", "plain");
    // Pre-existing dirt plus a clean file, so the turn move is separable.
    await writeFile(join(dir, "tracked.txt"), "pre-existing edit\n");
    const before = await captureGitSnapshot(dir);
    if ("error" in before) throw new Error(before.error);
    // No staging: Git reports a deletion plus an untracked path with no rename linkage.
    await rename(join(dir, "plain.txt"), join(dir, "moved.txt"));
    const after = await captureGitSnapshot(dir);
    if ("error" in after) throw new Error(after.error);
    const paths = after.entries.map((entry) => entry.path);
    expect(paths).toContain("plain.txt");
    expect(paths).toContain("moved.txt");
    const comparison = compareGitSnapshots(before, after);
    if ("error" in comparison) throw new Error(comparison.error);
    expect(comparison.newChanges).toContain("plain.txt");
    expect(comparison.newChanges).toContain("moved.txt");
    expect(comparison.preExistingUnchanged).toContain("tracked.txt");
  });
});


test("diff command keeps Git headers behind requested details without losing source", async () => {
  await withTempDir(async dir => {
    await initRepo(dir);
    await writeFile(join(dir, "tracked.txt"), "replacement\n");
    const controller = controllerFor(dir, "on-demand", createScriptedModel({ text: "ok" }));
    expect(await controller.changesCommand("diff tracked.txt")).toBe(true);
    const primary = lastNotice(controller);
    expect(primary).toContain("1 - original");
    expect(primary).toContain("1 + replacement");
    expect(primary).not.toMatch(/diff --git|index [0-9a-f]{7,}|@@ -|--- a\/|\+\+\+ b\//);
    expect(primary).toContain("F2 details");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(lastNotice(controller)).toContain("diff --git");
    controller.dispose();
  });
});

test("unscoped diff labels each file without exposing raw patch headers", async () => {
  await withTempDir(async dir => {
    await initRepo(dir);
    await writeFile(join(dir, "second file.txt"), "second original\n");
    await git(dir, "add", "second file.txt"); await git(dir, "commit", "-qm", "second");
    await writeFile(join(dir, "tracked.txt"), "first replacement\n");
    await writeFile(join(dir, "second file.txt"), "second replacement\n");
    await git(dir, "add", "second file.txt");
    const controller = controllerFor(dir, "on-demand", createScriptedModel({ text: "ok" }));
    expect(await controller.changesCommand("diff")).toBe(true);
    const primary = lastNotice(controller);
    expect(primary).toContain("Staged changes\nFile: second file.txt\n1 - second original\n1 + second replacement");
    expect(primary).toContain("Unstaged changes\nFile: tracked.txt\n1 - original\n1 + first replacement");
    expect(primary).not.toMatch(/diff --git|index [0-9a-f]{7,}|@@ -|--- a\/|\+\+\+ b\//);
    controller.dispose();
  });
});

test("path-scoped diff distinguishes staged and unstaged edits to the same file", async () => {
  await withTempDir(async dir => {
    await initRepo(dir);
    await writeFile(join(dir, "tracked.txt"), "staged replacement\n");
    await git(dir, "add", "tracked.txt");
    await writeFile(join(dir, "tracked.txt"), "unstaged replacement\n");
    const controller = controllerFor(dir, "on-demand", createScriptedModel({ text: "ok" }));
    expect(await controller.changesCommand("diff tracked.txt")).toBe(true);
    const primary = lastNotice(controller);
    expect(primary).toContain("Unstaged changes\n1 - staged replacement\n1 + unstaged replacement");
    expect(primary).toContain("Staged changes\n1 - original\n1 + staged replacement");
    expect(primary).not.toContain("diff --git");
    controller.dispose();
  });
});
