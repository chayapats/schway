import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { editTool } from "../src/tools/edit.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";

async function git(dir: string, ...args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...globalThis.process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(err);
  return out.trim();
}
async function repo(dir: string) {
  await git(dir, "init", "-q");
  await writeFile(join(dir, "prior.txt"), "original\n");
  await git(dir, "add", ".");
  await git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "baseline");
}
function controller(dir: string, responses: ScriptedTurn[], mode: "on-demand" | "snapshot" | "off" = "on-demand", onRuntimeEvent?: ConstructorParameters<typeof TuiController>[0]["onRuntimeEvent"]) {
  const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
  return new TuiController({ session: createSession(), workspace, sessionId: "review-fixture", provider: "scripted", modelId: "scripted", model: createScriptedModel({ responses }), contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool, editTool, readTool, bashTool]), changeTracking: mode, onRuntimeEvent });
}
const edit = { id: "edit", name: "write", arguments: { path: "edited.txt", content: "retained edit\n" } };

test("change mode names review beside a short status and keeps the origin in its explanation", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const configEditor = new ConfigEditor({ user: { git: { changeTracking: "on-demand" } } }, { user: join(dir, "user.json"), project: join(dir, "project.json") });
    const c = new TuiController({ session: createSession(), workspace, sessionId: "mode", provider: "scripted", modelId: "scripted", contextManager: createContextManager(workspace), configEditor });
    expect(await c.changesCommand("mode")).toBe(true);
    const notice = c.snapshot().transcript.at(-1)!.text;
    expect(notice).toBe("Change tracking: on-demand · /changes review · Ctrl+I details");
    expect(c.inspectNoticeDetails()).toBe(true);
    const details = c.snapshot().transcript.at(-1)!.text;
    expect(details).toContain("[user-global]");
    expect(details).toContain("paths and hashes before and after each turn, never file content");
    c.dispose();
  });
});

test("on-demand captures tool and shell files while excluding untouched pre-existing dirt", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    await writeFile(join(dir, "prior.txt"), "pre-existing dirt\n");
    const c = controller(dir, [{ toolCalls: [
      { id: "call_fixture_1", name: "write", arguments: { path: "./a.txt", content: "one\n" } },
      { id: "call_fixture_2", name: "bash", arguments: { command: "mkdir -p gen && printf 'generated\\n' > gen/out.json" } },
    ] }, { text: "done" }]);
    await c.submit("write and generate");
    expect(c.snapshot().outcome!.files).toEqual([
      { path: "a.txt", source: "tool", added: 1, removed: 0 },
      { path: "gen/out.json", source: "shell" },
    ]);
    c.dispose();
  });
});

test("turn elapsed time uses the activity clock and repeated tool paths accumulate known counts only", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    let now = 1000;
    const c = new TuiController({ session: createSession(), workspace, sessionId: "counts", provider: "scripted", modelId: "scripted", activityClock: () => now,
      onRuntimeEvent: event => { if (event.type === "agent.finished") now = 15000; },
      tools: createToolRegistry([writeTool, editTool]), contextManager: createContextManager(workspace),
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "w", name: "write", arguments: { path: "a.txt", content: "one\n" } }] },
        { toolCalls: [{ id: "e", name: "edit", arguments: { path: "./a.txt", edits: [{ oldText: "one", newText: "two\nthree" }] } }] },
        { toolCalls: [{ id: "overwrite", name: "write", arguments: { path: "prior.txt", content: "replacement\n" } }] },
        { text: "done" },
      ] }),
    });
    await c.submit("change files");
    expect(c.snapshot().outcome).toMatchObject({ elapsedMs: 14000, files: [
      { path: "a.txt", source: "tool", added: 3, removed: 1 }, { path: "prior.txt", source: "tool" },
    ] });
    expect(c.snapshot().outcome!.files[1]!.added).toBeUndefined();
    expect(c.snapshot().outcome!.files[1]!.removed).toBeUndefined();
    c.dispose();
  });
});

test("review caller separates completed edits, observed exits, and unsupported model verification prose", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ toolCalls: [edit, { id: "read", name: "read", arguments: { path: "prior.txt" } }, { id: "check", name: "bash", arguments: { command: "printf 'fixture check passed'", timeout: 1000 } }] }, { text: "All tests pass, trust me." }]);
    await c.submit("edit and check");
    const outcome = c.snapshot().outcome!;
    expect(outcome.reason).toBe("completed");
    expect(outcome.toolResults).toBe(3);
    expect(outcome.commands).toMatchObject([{ callId: "check", exitCode: 0 }]);
    expect(outcome.files).toEqual([{ path: "edited.txt", source: "tool", added: 1, removed: 0 }]);
    expect(c.snapshot().transcript.some(e => e.kind === "assistant" && e.text.includes("trust me"))).toBe(true);
    await c.changesCommand("review");
    expect(c.snapshot().changeReview!.heading).toBe("Review · turn 1");
    c.toggleReviewDetails();
    expect(c.snapshot().changeReview!.details).toContain("printf 'fixture check passed' → exit 0");
    expect(c.snapshot().changeReview!.details).not.toContain("check:");
    expect(c.snapshot().changeReview!.details).toContain("not a test-suite guarantee");
    expect(c.snapshot().changeReview!.files.map(f => f.path)).toContain("edited.txt");
    c.dispose();

    const prose = controller(dir, [{ text: "Tests passed. Exit code: 0." }]);
    await prose.submit("assert a check");
    expect(prose.snapshot().outcome!.commands).toEqual([]);
    await prose.openChangeReview();
    prose.toggleReviewDetails();
    expect(prose.snapshot().changeReview!.details).toContain("No command exit evidence");
    prose.dispose();
  });
});

test("failed check and cancelled turn retain edits and report independent evidence", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ toolCalls: [edit, { id: "failed-check", name: "bash", arguments: { command: "exit 7", timeout: 1000 } }] }, { text: "Tests pass." }], "snapshot");
    await c.submit("edit and fail check");
    expect(c.snapshot().outcome).toMatchObject({ reason: "completed", commands: [{ exitCode: 7 }] });
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.details).toContain("exit 7");
    expect(await readFile(join(dir, "edited.txt"), "utf8")).toContain("retained edit");
    c.dispose();

    let edited!: () => void;
    const wrote = new Promise<void>(resolve => { edited = resolve; });
    const cancel = controller(dir, [{ toolCalls: [edit] }, { waitForAbort: true }], "snapshot", event => { if (event.type === "tool.finished") edited(); });
    const task = cancel.submit("edit then wait");
    await wrote;
    cancel.cancel();
    await task;
    expect(cancel.snapshot().outcome!.reason).toBe("cancelled");
    await cancel.openChangeReview();
    expect(cancel.snapshot().changeReview!.details).toContain("Files remain changed after failure/cancellation");
    expect(await readFile(join(dir, "edited.txt"), "utf8")).toContain("retained edit");
    cancel.dispose();

    const fail = controller(dir, [{ toolCalls: [edit] }, { error: "fixture failure" }], "snapshot");
    await fail.submit("edit then fail");
    expect(fail.snapshot().outcome!.reason).toBe("failed");
    expect(await readFile(join(dir, "edited.txt"), "utf8")).toContain("retained edit");
    fail.dispose();
  });
});

test("snapshot review separates prior dirt from newly observed paths without exclusive attribution", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    await writeFile(join(dir, "prior.txt"), "pre-existing user edit\n");
    const c = controller(dir, [{ toolCalls: [edit] }, { text: "done" }], "snapshot");
    await c.submit("change a different file");
    await c.openChangeReview();
    const heading = c.snapshot().changeReview!.details;
    expect(heading).toContain("Pre-existing, unchanged by this turn (1):\n- prior.txt");
    expect(heading).toContain("New turn changes (1):\n- edited.txt");
    expect(heading).toContain("not exclusive Schway authorship");
    c.dispose();
  });
});

test("on-demand review marks concurrent external dirt unattributed and leaves Git state untouched", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const beforeHead = await git(dir, "rev-parse", "HEAD");
    const index = await readFile(join(dir, ".git", "index"));
    const c = controller(dir, [{ toolCalls: [edit] }, { text: "done" }], "on-demand", async event => {
      if (event.type === "tool.finished") await writeFile(join(dir, "external.txt"), "external edit");
    });
    await c.submit("edit");
    await c.openChangeReview();
    const review = c.snapshot().changeReview!;
    expect(review.files.map(f => f.path)).toContain("external.txt");
    expect(review.details).toContain("unattributed");
    expect(review.details).not.toContain("Shell-change detection unavailable");
    expect(review.details).toContain("New turn changes (2)");
    expect(review.heading).not.toContain("New turn changes");
    expect(await git(dir, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await readFile(join(dir, ".git", "index"))).toEqual(index);
    expect(c.gitChangeTracking()).toBe("on-demand");
    c.dispose();
  });
});

test("read-only no-change, non-Git and off review are explicit and remain useful", async () => {
  await withTempDir(async dir => {
    const c = controller(dir, [{ text: "read-only answer" }]);
    await c.submit("explain");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.detail).toContain("Non-Git workspace");
    expect(c.snapshot().outcome!.reason).toBe("completed");
    c.dispose();
    await repo(dir);
    const clean = controller(dir, [{ toolCalls: [{ id: "read", name: "read", arguments: { path: "prior.txt" } }] }, { text: "read" }], "snapshot");
    await clean.submit("read");
    await clean.openChangeReview();
    expect(clean.snapshot().changeReview!.detail).toContain("No working-tree changes");
    expect(clean.snapshot().changeReview!.details).toContain("No new turn changes");
    expect(clean.snapshot().changeReview!.files).toEqual([]);
    clean.dispose();
    const off = controller(dir, [{ toolCalls: [edit] }, { text: "done" }], "off");
    await off.submit("write with tracking off");
    expect(off.snapshot().outcome!.files).toEqual([{ path: "edited.txt", source: "tool", added: 1, removed: 0 }]);
    await off.openChangeReview();
    expect(off.snapshot().changeReview!.detail).toContain("No Git state read");
    off.dispose();
  });
});


test("a successful bash invocation without a recorded exit remains unknown despite result prose", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const c = new TuiController({
      session: createSession(), workspace, sessionId: "missing-exit", provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ responses: [{ toolCalls: [{ id: "invocation", name: "bash", arguments: { command: "bun test", timeout: 1000 } }] }, { text: "All tests passed." }] }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([{ ...bashTool, execute: async () => ({ content: "Exit code: 0. Tests passed.", details: { command: "bun test" } }) }]),
    });
    await c.submit("check");
    expect(c.snapshot().outcome!.commands).toMatchObject([{ callId: "invocation", exitCode: null, status: "success" }]);
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.details).toContain("no exit observed");
    c.dispose();
  });
});

test("review treats selected glob and magic filenames and rename pairs as literal paths", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const originals = ["*.txt", ":(glob)*", "rename*.txt", "unrelated.txt"];
    for (const path of originals) await writeFile(join(dir, path), `before ${path}\n`);
    await git(dir, "add", ".");
    await git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "literal names");
    const c = controller(dir, [{ toolCalls: [{ id: "literal-paths", name: "bash", arguments: { command: "printf 'selected wildcard evidence\\n' > '*.txt'; printf 'selected magic evidence\\n' > ':(glob)*'; printf 'unrelated evidence must not appear\\n' > unrelated.txt; git --literal-pathspecs mv 'rename*.txt' 'moved?.txt'; printf 'untracked literal evidence\\n' > 'untracked?.txt'" } }] }, { text: "done" }]);
    await c.submit("review");
    await c.openChangeReview();
    for (const [path, expected] of [
      ["*.txt", "selected wildcard evidence"],
      [":(glob)*", "selected magic evidence"],
      ["moved?.txt", "Renamed from rename*.txt to moved?.txt"],
      ["untracked?.txt", "untracked literal evidence"],
    ]) {
      const review = c.snapshot().changeReview!;
      const index = review.files.findIndex(file => file.path === path);
      expect(index).toBeGreaterThanOrEqual(0);
      await c.selectReviewFile(index - review.selected);
      const detail = c.snapshot().changeReview!.detail;
      expect(detail).toContain(expected!);
      expect(detail).not.toContain("unrelated evidence must not appear");
      expect(detail).not.toContain("diff --git a/unrelated.txt");
    }
    c.dispose();
  });
});

test("review retains the turn list across later external edits and enumerates every observed nested path", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ toolCalls: [{ id: "nested", name: "write", arguments: { path: "new-dir/added.txt", content: "nested file evidence\n" } }] }, { text: "done" },
      { toolCalls: [{ id: "many-paths", name: "bash", arguments: { command: "for f in new-dir/[0-9]*.txt; do printf 'further change\\n' > \"$f\"; done" } }] }, { text: "updated" }]);
    await c.submit("create a nested file");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["new-dir/added.txt"]);
    expect(c.snapshot().changeReview!.detail).toContain("nested file evidence");
    for (let i = 0; i < 55; i++) await writeFile(join(dir, "new-dir", `${String(i).padStart(3, "0")}.txt`), `bounded file ${i}\n`);
    c.closeChangeReview();
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.files).toHaveLength(1);
    expect(c.snapshot().changeReview!.files[0]!.path).toBe("new-dir/added.txt");
    expect(c.snapshot().changeReview!.detail).toContain("nested file evidence");
    expect(c.snapshot().changeReview!.files.every(file => !file.path.endsWith("/"))).toBe(true);
    await c.submit("update all numbered files");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.files).toHaveLength(55);
    expect(c.snapshot().changeReview!.files.every(file => file.source === "shell")).toBe(true);
    await c.selectReviewFile(54);
    expect(c.snapshot().changeReview!.files[54]!.path).toBe("new-dir/054.txt");
    expect(c.snapshot().changeReview!.detail).toContain("further change");
    c.dispose();
  });
});

test("shell comparison includes updated and resolved dirt but excludes successful resolved file-tool paths", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    await writeFile(join(dir, "prior.txt"), "dirty\n");
    await writeFile(join(dir, "updated.txt"), "old dirt\n");
    const c = controller(dir, [{ toolCalls: [
      { id: "resolved", name: "bash", arguments: { command: "printf 'original\\n' > prior.txt; printf 'new dirt\\n' > updated.txt" } },
      { id: "absolute", name: "write", arguments: { path: join(dir, "tool.txt"), content: "tool\n" } },
      { id: "failed", name: "edit", arguments: { path: "prior.txt", edits: [{ oldText: "absent", newText: "ignored" }] } },
    ] }, { text: "done" }]);
    await c.submit("change working state");
    expect(c.snapshot().outcome!.files).toEqual([
      { path: "tool.txt", source: "tool", added: 1, removed: 0 },
      { path: "prior.txt", source: "shell" }, { path: "updated.txt", source: "shell" },
    ]);
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.details).toContain("No longer dirty (1):\n- prior.txt");
    expect(c.snapshot().changeReview!.details).toContain("Pre-existing files changed further (1):\n- updated.txt");
    c.dispose();
  });
});

test("default and snapshot capture twice before tools and after settling while off captures nothing", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    for (const mode of ["on-demand", "snapshot", "off"] as const) {
      const realSpawn = Bun.spawn;
      let roots = 0, rootsAtTool = -1;
      Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
        if (command[0] === "git" && command.includes("--show-toplevel")) roots++;
        return realSpawn(command, options);
      }) as typeof Bun.spawn;
      const c = controller(dir, [{ toolCalls: [{ id: "read", name: "read", arguments: { path: "prior.txt" } }] }, { text: "done" }], mode,
        event => { if (event.type === "tool.started") rootsAtTool = roots; });
      try {
        await c.submit("read");
        expect(rootsAtTool).toBe(mode === "off" ? 0 : 1);
        expect(roots).toBe(mode === "off" ? 0 : 2);
      } finally { Bun.spawn = realSpawn; c.dispose(); }
    }
  });
});

test("capture failure remains usable and explains missing shell detection only in details", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ text: "done despite Git failure" }]);
    const realSpawn = Bun.spawn;
    Bun.spawn = (() => { throw new Error("fixture Git capture error"); }) as typeof Bun.spawn;
    try { await c.submit("read"); } finally { Bun.spawn = realSpawn; }
    expect(c.snapshot().outcome!.reason).toBe("completed");
    expect(c.snapshot().outcome!.files).toEqual([]);
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.heading).toBe("Review · turn 1");
    expect(c.snapshot().changeReview!.detail).not.toContain("fixture Git capture error");
    expect(c.snapshot().changeReview!.details).toContain("Shell-change detection unavailable");
    expect(c.snapshot().changeReview!.details).toContain("fixture Git capture error");
    c.dispose();
  });
});

test("review keeps successful tool identity when a non-Git workspace gains an ancestor repository", async () => {
  await withTempDir(async dir => {
    const nested = join(dir, "nested");
    await mkdir(nested);
    const workspace = await resolveWorkspace(nested);
    expect(workspace.root).toBe(nested);
    const c = new TuiController({ session: createSession(), workspace, sessionId: "new-ancestor-repo", provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ responses: [{ toolCalls: [edit] }, { text: "done" }] }),
      contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool]),
    });
    try {
      await c.submit("write before Git exists");
      expect(c.snapshot().outcome!.files).toEqual([{ path: "edited.txt", source: "tool", added: 1, removed: 0 }]);
      await c.openChangeReview();
      expect(c.snapshot().changeReview!.detail).toContain("Non-Git workspace");
      c.closeChangeReview();
      await git(dir, "init", "-q");
      await writeFile(join(dir, "edited.txt"), "wrong root-file evidence\n");
      for (let visit = 0; visit < 2; visit++) {
        await c.openChangeReview();
        const review = c.snapshot().changeReview!;
        expect(review.detail).toContain("retained edit");
        expect(review.detail).not.toContain("wrong root-file evidence");
        expect(review.files).toEqual([{ path: "nested/edited.txt", source: "tool", added: 1, removed: 0 }]);
        c.closeChangeReview();
      }
      expect(c.snapshot().outcome!.files[0]!.path).toBe("edited.txt");
    } finally { c.dispose(); }
  });
});

test("dispose during either capture drops stale outcomes without starting tools after disposal", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    for (const capture of [1, 2]) {
      const c = controller(dir, [{ toolCalls: [edit] }, { text: "done" }]);
      const realSpawn = Bun.spawn;
      let roots = 0;
      Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
        const child = realSpawn(command, options);
        if (command[0] === "git" && command.includes("--show-toplevel") && ++roots === capture) c.dispose();
        return child;
      }) as typeof Bun.spawn;
      try { await c.submit("write"); } finally { Bun.spawn = realSpawn; }
      expect(c.snapshot().outcome).toBeUndefined();
      expect(c.snapshot().changeReview).toBeUndefined();
      expect(c.running).toBe(false);
      if (capture === 1) expect(c.snapshot().transcript.some(entry => entry.kind === "tool")).toBe(false);
    }
  });
});

test("review ordinal follows active-branch user records and switches clear retained outcomes", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const session = createSession();
    session.append({ type: "user", id: "earlier-user", content: [{ type: "text", text: "earlier" }] }, { type: "assistant", id: "earlier-answer", content: [{ type: "text", text: "done" }] });
    const original = session.activeBranchId;
    session.forkBranch("earlier-answer", "alternate");
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const c = new TuiController({ session, workspace, sessionId: "ordinal", provider: "scripted", modelId: "scripted", model: createScriptedModel(), contextManager: createContextManager(workspace) });
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.heading).toBe("No turn to review yet");
    c.closeChangeReview();
    await c.submit("second turn");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.heading).toBe("Review · turn 2");
    c.closeChangeReview();
    expect(c.branchCommand(`switch ${original}`)).toBe(true);
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.heading).toBe("No turn to review yet");
    expect(c.snapshot().changeReview!.files).toEqual([]);
    c.replaceSession(createSession(), "new-session");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.heading).toBe("No turn to review yet");
    c.dispose();
  });
});

test("retained failure diagnostics stay sanitized and clear with the next turn or conversation identity", async () => {
  await withTempDir(async dir => {
    for (const boundary of ["turn", "session", "branch"] as const) {
      const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
      const session = createSession();
      const c = new TuiController({ session, workspace, sessionId: "retained-diagnostic", provider: "scripted", modelId: "scripted", secrets: ["secret-sentinel"],
        model: createScriptedModel({ responses: [{ error: "retained fixture diagnostic secret-sentinel" }, { text: "next turn succeeded" }] }),
        contextManager: createContextManager(workspace),
      });
      await c.submit("fail");
      expect(c.keepEditingRecovery()).toBe(true);
      expect(c.inspectRecovery()).toBe(true);
      expect(c.snapshot().transcript.at(-1)!.text).toContain("retained fixture diagnostic");
      expect(c.snapshot().transcript.at(-1)!.text).not.toContain("secret-sentinel");
      await c.openChangeReview();
      expect(c.snapshot().changeReview!.details).toContain("retained fixture diagnostic");
      expect(c.snapshot().changeReview!.details).not.toContain("secret-sentinel");
      c.closeChangeReview();
      if (boundary === "session") c.replaceSession(createSession(), "replacement");
      if (boundary === "branch") expect(c.branchCommand(`fork ${session.rootId}`)).toBe(true);
      if (boundary !== "turn") {
        await c.openChangeReview();
        expect(c.snapshot().changeReview!.heading).toBe("No turn to review yet");
        expect(c.snapshot().changeReview!.details).toBe("");
      }
      await c.submit("continue with a new task");
      await c.openChangeReview();
      expect(c.snapshot().outcome!.reason).toBe("completed");
      expect(c.snapshot().changeReview!.details).not.toContain("retained fixture diagnostic");
      expect(c.snapshot().changeReview!.details).not.toContain("secret-sentinel");
      c.dispose();
    }
  });
});
