import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
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
  return new TuiController({ session: createSession(), workspace, sessionId: "review-fixture", provider: "scripted", modelId: "scripted", model: createScriptedModel({ responses }), contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool, readTool, bashTool]), changeTracking: mode, onRuntimeEvent });
}
const edit = { id: "edit", name: "write", arguments: { path: "edited.txt", content: "retained edit\n" } };

test("review caller separates completed edits, observed exits, and unsupported model verification prose", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ toolCalls: [edit, { id: "read", name: "read", arguments: { path: "prior.txt" } }, { id: "check", name: "bash", arguments: { command: "printf 'fixture check passed'", timeout: 1000 } }] }, { text: "All tests pass, trust me." }]);
    await c.submit("edit and check");
    const outcome = c.snapshot().outcome!;
    expect(outcome.reason).toBe("completed");
    expect(outcome.toolResults).toBe(3);
    expect(outcome.commands).toMatchObject([{ callId: "check", exitCode: 0 }]);
    expect(outcome.changes).toContain("not inspected");
    expect(c.snapshot().transcript.some(e => e.kind === "assistant" && e.text.includes("trust me"))).toBe(true);
    await c.changesCommand("review");
    expect(c.snapshot().changeReview!.heading).toContain("check:");
    expect(c.snapshot().changeReview!.heading).toContain("not a test-suite guarantee");
    expect(c.snapshot().changeReview!.files.map(f => f.path)).toContain("edited.txt");
    c.dispose();

    const prose = controller(dir, [{ text: "Tests passed. Exit code: 0." }]);
    await prose.submit("assert a check");
    expect(prose.snapshot().outcome!.commands).toEqual([]);
    await prose.openChangeReview();
    expect(prose.snapshot().changeReview!.heading).toContain("No command exit evidence");
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
    expect(c.snapshot().changeReview!.heading).toContain("exit 7");
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
    expect(cancel.snapshot().changeReview!.heading).toContain("Files remain changed after failure/cancellation");
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
    const heading = c.snapshot().changeReview!.heading;
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
    expect(review.heading).toContain("unattributed");
    expect(review.heading).toContain("Snapshot attribution unavailable (on-demand)");
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
    expect(c.snapshot().changeReview!.heading).toContain("Non-Git workspace");
    expect(c.snapshot().outcome!.reason).toBe("completed");
    c.dispose();
    await repo(dir);
    const clean = controller(dir, [{ toolCalls: [{ id: "read", name: "read", arguments: { path: "prior.txt" } }] }, { text: "read" }], "snapshot");
    await clean.submit("read");
    await clean.openChangeReview();
    expect(clean.snapshot().changeReview!.heading).toContain("No working-tree changes");
    expect(clean.snapshot().changeReview!.heading).toContain("No new turn changes");
    expect(clean.snapshot().changeReview!.files).toEqual([]);
    clean.dispose();
    const off = controller(dir, [{ text: "done" }], "off");
    await off.submit("read");
    await off.openChangeReview();
    expect(off.snapshot().changeReview!.heading).toContain("No Git state read");
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
    expect(c.snapshot().changeReview!.heading).toContain("no exit observed");
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
    await writeFile(join(dir, "*.txt"), "selected wildcard evidence\n");
    await writeFile(join(dir, ":(glob)*"), "selected magic evidence\n");
    await writeFile(join(dir, "unrelated.txt"), "unrelated evidence must not appear\n");
    await git(dir, "--literal-pathspecs", "mv", "rename*.txt", "moved?.txt");
    await writeFile(join(dir, "untracked?.txt"), "untracked literal evidence\n");
    const c = controller(dir, [{ text: "done" }]);
    await c.submit("review");
    await c.openChangeReview();
    for (const [path, expected] of [
      ["*.txt", "selected wildcard evidence"],
      [":(glob)*", "selected magic evidence"],
      ["moved?.txt", "rename to moved?.txt"],
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

test("review enumerates inspectable new-directory files and bounds large untracked lists", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [{ toolCalls: [{ id: "nested", name: "write", arguments: { path: "new-dir/added.txt", content: "nested file evidence\n" } }] }, { text: "done" }]);
    await c.submit("create a nested file");
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["new-dir/added.txt"]);
    expect(c.snapshot().changeReview!.detail).toContain("nested file evidence");
    for (let i = 0; i < 55; i++) await writeFile(join(dir, "new-dir", `${String(i).padStart(3, "0")}.txt`), `bounded file ${i}\n`);
    c.closeChangeReview();
    await c.openChangeReview();
    expect(c.snapshot().changeReview!.files).toHaveLength(50);
    expect(c.snapshot().changeReview!.heading).toContain("56 changed paths (list truncated)");
    expect(c.snapshot().changeReview!.detail).toContain("bounded file 0");
    expect(c.snapshot().changeReview!.files.every(file => !file.path.endsWith("/"))).toBe(true);
    c.dispose();
  });
});
