import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import type { AssistantMessage, UserMessage } from "../src/conversation/types.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import {
  MAX_BRANCH_TREE_NODES,
  TuiController,
  branchTreePreviewForRecord,
  buildBranchTreeSnapshot,
} from "../src/tui/controller.ts";
import { formatBranchTree, isBranchTreeCommandInput } from "../src/tui/app.ts";
import { dispatchEditorInput, parseSlashCommand } from "../src/tui/commands.ts";
import { emptyBranchState } from "../src/session/branches.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

/** Create a uniquely identified user record. */
function user(id: string): UserMessage {
  return { type: "user", id, content: [{ type: "text", text: id }] };
}

/** Create a completed assistant reply or a pending tool-call group. */
function assistant(id: string, call?: string): AssistantMessage {
  return {
    type: "assistant",
    id,
    content: call
      ? [{ type: "tool_call", id: call, name: "read", arguments: { path: "note.txt" } }]
      : [{ type: "text", text: id }],
  };
}

/** Bind a filesystem fixture to a canonical primary-root identity. */
function workspace(root: string) {
  return { root, launchCwd: root, extraRoots: [] as string[] };
}

/** Return only authoritative entry IDs for concise ancestry assertions. */
function ids(session: Session): string[] {
  return session.items.map((item) => item.id);
}

/** Create a controller with a scripted model for deterministic branch-tree tests. */
function controllerFor(
  session: Session,
  sessionId: string,
  dir: string,
  model: ReturnType<typeof createScriptedModel>,
) {
  const ws = workspace(dir);
  return new TuiController({
    session,
    model,
    contextManager: createContextManager(ws),
    tools: createToolRegistry([readTool]),
    workspace: ws,
    provider: "scripted",
    modelId: "scripted",
    sessionId,
  });
}

test("tree renders parent/child relationships with stable IDs and bounded previews", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const branch = session.forkBranch("B", "same label");
    session.append(user("C"), assistant("D"));
    session.selectBranch("main");
    session.append(user("X"), assistant("Y"));
    // Labels may repeat; only exact IDs select.
    expect(branch).not.toBe("main");
    const controller = controllerFor(session, "tree-ids", dir, createScriptedModel({ text: "ok" }));
    try {
      expect(controller.isBranchTreeOpen()).toBe(false);
      expect(controller.branchTreeSnapshot()).toBeUndefined();
      expect(controller.openBranchTree()).toBe(true);
      const tree = controller.branchTreeSnapshot()!;
      expect(tree.rootId).toBe(session.rootId);
      expect(tree.activeBranchId).toBe("main");
      expect(tree.totalNodeCount).toBe(7);
      expect(tree.truncated).toBe(false);
      expect(tree.nodes.map((node) => node.id)).toContain(session.rootId);
      for (const id of ["A", "B", "C", "D", "X", "Y"]) {
        expect(tree.nodes.map((node) => node.id)).toContain(id);
      }
      // Parent/child links survive divergent histories.
      const byId = new Map(tree.nodes.map((node) => [node.id, node] as const));
      expect(byId.get("A")?.parentId).toBe(session.rootId);
      expect(byId.get("B")?.parentId).toBe("A");
      expect(byId.get("C")?.parentId).toBe("B");
      expect(byId.get("X")?.parentId).toBe("B");
      expect(byId.get("C")?.depth).toBe((byId.get("B")?.depth ?? 0) + 1);
      // Active head is marked; both heads are marked with stable branch IDs.
      expect(byId.get("Y")?.isActiveHead).toBe(true);
      expect(byId.get("Y")?.isHead).toBe(true);
      expect(byId.get("D")?.isHead).toBe(true);
      expect(byId.get("D")?.headBranchIds).toEqual([branch]);
      expect(byId.get("Y")?.headBranchIds).toEqual(["main"]);
      // Complete-turn boundaries are eligible fork points.
      expect(byId.get(session.rootId)?.isForkPoint).toBe(true);
      expect(byId.get("B")?.isForkPoint).toBe(true);
      expect(byId.get("D")?.isForkPoint).toBe(true);
      expect(byId.get("Y")?.isForkPoint).toBe(true);
      // Previews are bounded and renderer-free.
      for (const node of tree.nodes) {
        expect(node.preview.length).toBeLessThanOrEqual(121);
      }
      expect(branchTreePreviewForRecord(undefined)).toBe("(empty conversation root)");
      expect(branchTreePreviewForRecord(user("long"), 5).length).toBeLessThanOrEqual(6);
      // Stable IDs: labels and prefixes never select.
      expect(controller.focusBranchTreeBranch("same label")).toBe(false);
      expect(controller.focusBranchTreeBranch(branch.slice(0, 8))).toBe(false);
      expect(controller.selectBranchTreeNode("missing")).toBe(false);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe(tree.selectedId);
      expect(controller.focusBranchTreeBranch(branch)).toBe(true);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe("D");
      // Previewing a sibling never changes durable state or persistence.
      const beforeBranches = session.listBranches().length;
      const preview = controller.previewBranchTreeNode("D");
      expect(preview.map((entry) => entry.text)).toEqual(["A", "B", "C", "D"]);
      expect(session.activeBranchId).toBe("main");
      expect(session.listBranches()).toHaveLength(beforeBranches);
      expect(controller.snapshot().branchId).toBe("main");
    } finally {
      controller.dispose();
    }
  });
});

test("keyboard navigation moves selection between branches and fork points without persisting", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const branch = session.forkBranch("B", "alt");
    session.append(user("C"), assistant("D"));
    session.selectBranch("main");
    session.append(user("X"), assistant("Y"));
    const controller = controllerFor(session, "tree-nav", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      // Selection starts at the durable active head, separate from it.
      expect(controller.branchTreeSnapshot()?.selectedId).toBe("Y");
      expect(controller.snapshot().branchId).toBe("main");
      expect(controller.moveBranchTreeSelection(-1)).toBe(true);
      const moved = controller.branchTreeSnapshot()?.selectedId;
      expect(moved).not.toBe("Y");
      expect(controller.snapshot().branchId).toBe("main");
      // Jump to fork points in display order.
      expect(controller.selectBranchTreeNode(session.rootId)).toBe(true);
      expect(controller.focusBranchTreeForkPoint(1)).toBe(true);
      const forked = controller.branchTreeSnapshot()!;
      const forkNode = forked.nodes.find((node) => node.id === forked.selectedId);
      expect(forkNode?.isForkPoint).toBe(true);
      expect(controller.focusBranchTreeForkPoint(-1)).toBe(true);
      // Branch-head focus uses stable branch IDs.
      expect(controller.focusBranchTreeBranch(branch)).toBe(true);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe("D");
      // Confirming a head switches without replaying tools.
      expect(controller.confirmBranchTreeSelection()).toBe(true);
      expect(session.activeBranchId).toBe(branch);
      expect(ids(session)).toEqual(["A", "B", "C", "D"]);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "C")).toBe(true);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "X")).toBe(false);
      // Confirming a fork point forks at that complete turn.
      controller.selectBranchTreeNode("B");
      expect(controller.confirmBranchTreeSelection("from-tree")).toBe(true);
      const forkedId = session.activeBranchId;
      expect(forkedId).not.toBe(branch);
      expect(forkedId).not.toBe("main");
      expect(ids(session)).toEqual(["A", "B"]);
      expect(session.listBranches().find((entry) => entry.id === forkedId)?.name).toBe("from-tree");
      // Confirming a non-boundary reports its boundary without losing either branch.
      session.append(user("mid"), assistant("call", "c1"));
      controller.refreshBranchTree();
      controller.selectBranchTreeNode("A");
      const headsBefore = session.listBranches().map((entry) => entry.headId).join(",");
      expect(controller.confirmBranchTreeSelection()).toBe(false);
      expect(session.listBranches().map((entry) => entry.headId).join(",")).toBe(headsBefore);
      expect(controller.snapshot().transcript.some((entry) => entry.kind === "error")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("branch isolation rebuilds transcript and model context without replaying tools", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const branch = session.forkBranch("B", "C path");
    session.append(user("C"), assistant("C-done"));
    session.selectBranch("main");
    session.append(user("X"), assistant("X-done"));
    const controller = controllerFor(session, "tree-iso", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      // Preview shows the other path while the durable branch stays put.
      const preview = controller.previewBranchTreeNode("C-done");
      expect(preview.map((entry) => entry.text)).toEqual(["A", "B", "C", "C-done"]);
      expect(session.activeBranchId).toBe("main");
      expect(controller.activateBranchTreeBranch(branch)).toBe(true);
      expect(ids(session)).toEqual(["A", "B", "C", "C-done"]);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "C-done")).toBe(true);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "X-done")).toBe(false);
      // Continuing on the selected branch sees only its ancestry.
      let seen: string[] = [];
      controller.setModel(
        createScriptedModel({
          responses: [
            (request) => {
              seen = request.items.map((item) => item.id);
              return { text: "continued" };
            },
          ],
        }),
        "scripted",
        "scripted",
      );
      await controller.submit("continue C");
      expect(seen).toContain("C-done");
      expect(seen).not.toContain("X-done");
      expect(seen).not.toContain("X");
      // Switching back isolates the other path.
      expect(controller.activateBranchTreeBranch("main")).toBe(true);
      expect(ids(session).includes("C-done")).toBe(false);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "C-done")).toBe(false);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "X-done")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("compacted branches render markers without blending hidden history into siblings", async () => {
  await withTempDir(async (dir) => {
    const session = createSession(
      [user("u"), assistant("a"), user("u2"), assistant("a2")],
      [],
    );
    const sibling = session.forkBranch("a2", "compacted");
    session.append({ type: "compaction", id: "s1", firstKeptId: "u2", summary: "SIBLING SUMMARY" });
    session.append(user("after"), assistant("after-done"));
    session.selectBranch("main");
    const controller = controllerFor(session, "tree-compact", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      const tree = controller.branchTreeSnapshot()!;
      const summary = tree.nodes.find((node) => node.id === "s1");
      expect(summary?.kind).toBe("compaction");
      expect(summary?.preview).toContain("Compacted:");
      expect(summary?.preview).toContain("SIBLING SUMMARY");
      expect(summary?.isForkPoint).toBe(true);
      // Transcript rebuild keeps the marker on its own branch only.
      expect(controller.activateBranchTreeBranch(sibling)).toBe(true);
      const compacted = controller.snapshot().transcript;
      expect(compacted.some((entry) => entry.text.includes("SIBLING SUMMARY"))).toBe(true);
      expect(compacted.some((entry) => entry.text.includes("Context compacted"))).toBe(true);
      expect(controller.activateBranchTreeBranch("main")).toBe(true);
      const plain = controller.snapshot().transcript;
      expect(plain.some((entry) => entry.text.includes("SIBLING SUMMARY"))).toBe(false);
      // Previews are branch-local: the main preview never contains the sibling summary.
      expect(controller.previewBranchTreeNode("a2").some((entry) => entry.text.includes("SIBLING"))).toBe(false);
      expect(
        controller.previewBranchTreeNode("after-done").some((entry) => entry.text.includes("SIBLING")),
      ).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("busy turns reject switch and fork while preview stays side-effect-free", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("u"), assistant("a")], []);
    const controller = controllerFor(
      session,
      "tree-busy",
      dir,
      createScriptedModel({ waitForAbort: true, text: "never" }),
    );
    try {
      controller.openBranchTree();
      const pending = controller.submit("long task");
      await Bun.sleep(20);
      expect(controller.running).toBe(true);
      // Browsing and preview remain available while the turn owns the session.
      expect(controller.moveBranchTreeSelection(-1)).toBe(true);
      const selected = controller.branchTreeSnapshot()?.selectedId;
      expect(typeof selected).toBe("string");
      const branchesBefore = session.listBranches().length;
      expect(controller.previewBranchTreeNode(selected).length).toBeGreaterThanOrEqual(0);
      expect(session.listBranches()).toHaveLength(branchesBefore);
      // Switch, fork, confirm and textual commands all refuse with a busy notice.
      expect(controller.activateBranchTreeBranch("main")).toBe(false);
      expect(controller.forkBranchTreeNode("a", "busy-fork")).toBe(false);
      expect(controller.confirmBranchTreeSelection()).toBe(false);
      expect(controller.branchCommand("switch main")).toBe(false);
      expect(session.listBranches()).toHaveLength(branchesBefore);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "Wait for this turn · Esc stop")).toBe(true);
      // Cancellation stays explicit; the settled tree then accepts branch changes.
      controller.cancel();
      await pending;
      expect(controller.running).toBe(false);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "Cancelled.")).toBe(true);
      controller.refreshBranchTree();
      expect(controller.branchCommand("switch main")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("missing targets preserve ancestry and explicit fork selection can fork a shared head", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const controller = controllerFor(session, "tree-error", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      const transcriptBefore = JSON.stringify(controller.snapshot().transcript);
      expect(controller.activateBranchTreeBranch("missing")).toBe(false);
      expect(controller.forkBranchTreeNode("missing")).toBe(false);
      expect(controller.forkBranchTreeNode("A")).toBe(false);
      expect(controller.selectBranchTreeNode("missing")).toBe(false);
      expect(() => controller.previewBranchTreeNode("missing")).toThrow("Missing session parent or head");
      expect(session.activeBranchId).toBe("main");
      expect(ids(session)).toEqual(["A", "B"]);
      expect(controller.snapshot().branchId).toBe("main");
      expect(controller.snapshot().transcript.some((entry) => entry.kind === "error")).toBe(true);
      // Shared heads remain independently selectable; selecting a node explicitly creates a new fork.
      const first = session.forkBranch("B", "same");
      session.selectBranch("main");
      const second = session.forkBranch("B", "same");
      session.append(user("C"), assistant("D"));
      controller.refreshBranchTree();
      session.selectBranch(second);
      controller.replaceSession(session, "tree-error");
      controller.openBranchTree();
      controller.refreshBranchTree();
      // main and first still share head B while the active branch moved on.
      controller.selectBranchTreeNode("B");
      expect(controller.confirmBranchTreeSelection("new named path")).toBe(true);
      expect(session.activeBranchId).not.toBe(second);
      expect(session.listBranches().find(branch => branch.active)?.name).toBe("new named path");
      expect(controller.focusBranchTreeBranch(first)).toBe(true);
      expect(controller.confirmBranchTreeSelection()).toBe(true);
      expect(session.activeBranchId).toBe(first);
      expect(transcriptBefore.length).toBeGreaterThan(0);
      expect(first).not.toBe(second);
    } finally {
      controller.dispose();
    }
  });
});

test("resume restores the active branch and rejects unknown branches without switching", async () => {
  await withTempDir(async (dir) => {
    const directory = `${dir}/sessions`;
    const ws = workspace(dir);
    const session = await createJsonlSession({ directory, workspace: ws });
    session.append(user("u"), assistant("a"));
    const branch = session.forkBranch("a", "resumed");
    session.append(user("b"), assistant("b-done"));
    const controller = controllerFor(session, session.header.id, dir, createScriptedModel({ text: "ok" }));
    try {
      const resumed = await loadJsonlSession({ directory, id: session.header.id, branchId: branch });
      expect(resumed.activeBranchId).toBe(branch);
      expect(ids(resumed)).toEqual(["u", "a", "b", "b-done"]);
      controller.replaceSession(resumed, resumed.header.id);
      controller.openBranchTree();
      expect(controller.snapshot().branchId).toBe(branch);
      expect(controller.branchTreeSnapshot()?.activeBranchId).toBe(branch);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "b-done")).toBe(true);
      // A missing branch never silently chooses another head.
      await expect(loadJsonlSession({ directory, id: session.header.id, branchId: "missing" })).rejects.toThrow(
        "Unknown branch ID",
      );
      expect(controller.snapshot().branchId).toBe(branch);
      expect(ids(controller.snapshot().branchTree ? session : session)).toEqual(["u", "a", "b", "b-done"]);
    } finally {
      controller.dispose();
    }
  });
});

test("large histories use bounded rendering with visible heads and previews", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([], []);
    for (let i = 0; i < 160; i++) {
      session.append(user(`u-${i}`), assistant(`a-${i}`));
    }
    const controller = controllerFor(session, "tree-scale", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      const tree = controller.branchTreeSnapshot()!;
      expect(tree.totalNodeCount).toBe(321);
      expect(tree.truncated).toBe(true);
      expect(tree.nodes.length).toBeLessThanOrEqual(MAX_BRANCH_TREE_NODES);
      expect(tree.nodes.length).toBeGreaterThan(0);
      const seen = new Set(tree.nodes.map((node) => node.id));
      expect(seen.has(session.rootId)).toBe(true);
      const head = session.listBranches()[0]!.headId;
      expect(seen.has(head)).toBe(true);
      expect(seen.has(tree.selectedId)).toBe(true);
      for (const node of tree.nodes) {
        expect(node.preview.length).toBeLessThanOrEqual(121);
      }
      const built = buildBranchTreeSnapshot(session, head, { maxNodes: 20, previewChars: 10 });
      expect(built.nodes.length).toBeLessThanOrEqual(20);
      expect(built.truncated).toBe(true);
      for (const node of built.nodes) {
        expect(node.preview.length).toBeLessThanOrEqual(11);
      }
    } finally {
      controller.dispose();
    }
  });
});

test("branch-tree layout smoke check marks selection and the active head", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const branch = session.forkBranch("B", "alt");
    session.append(user("C"), assistant("D"));
    session.selectBranch("main");
    const controller = controllerFor(session, "tree-layout", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      controller.focusBranchTreeBranch(branch);
      const tree = controller.branchTreeSnapshot()!;
      const text = formatBranchTree(tree);
      expect(text).toContain("main");
      expect(text).toContain(branch);
      expect(text).toContain(tree.rootId);
      expect(text).toContain(">"); // selected row
      expect(text).toContain("*"); // active branch/head
      expect(text).toContain("[fork]"); // complete-turn boundary
    } finally {
      controller.dispose();
    }
  });
});

test("resume without branchId restores the persisted active head", async () => {
  await withTempDir(async (dir) => {
    const directory = join(dir, "sessions");
    const ws = workspace(dir);
    const session = await createJsonlSession({ directory, workspace: ws });
    session.append(user("u"), assistant("a"));
    const branch = session.forkBranch("a", "resumed");
    session.append(user("b"), assistant("b-done"));
    expect(session.activeBranchId).toBe(branch);
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    expect(resumed.activeBranchId).toBe(branch);
    expect(ids(resumed)).toEqual(["u", "a", "b", "b-done"]);
    const controller = controllerFor(resumed, resumed.header.id, dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      expect(controller.snapshot().branchId).toBe(branch);
      expect(controller.branchTreeSnapshot()?.activeBranchId).toBe(branch);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "b-done")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("corrupt persisted graph reports an error and keeps the previous valid branch", async () => {
  await withTempDir(async (dir) => {
    const directory = join(dir, "sessions");
    const ws = workspace(dir);
    const session = await createJsonlSession({ directory, workspace: ws });
    session.append(user("u"), assistant("a"));
    const branch = session.forkBranch("a", "kept");
    session.append(user("b"), assistant("b-done"));
    const controller = controllerFor(session, session.header.id, dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      expect(controller.snapshot().branchId).toBe(branch);
      const transcriptBefore = JSON.stringify(controller.snapshot().transcript);
      const itemsBefore = ids(session);
      const path = join(directory, `${session.header.id}.jsonl`);
      const valid = await readFile(path, "utf8");
      const corrupt = { type: "branch_append", version: 1, branchId: "main", entries: [{ parentId: "missing", item: { type: "user", id: "bad", content: [{ type: "text", text: "bad" }] } }] };
      await writeFile(path, `${valid}${JSON.stringify(corrupt)}\n`, "utf8");
      await expect(loadJsonlSession({ directory, id: session.header.id })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(`${valid}${JSON.stringify(corrupt)}\n`);
      expect(controller.snapshot().branchId).toBe(branch);
      expect(session.activeBranchId).toBe(branch);
      expect(ids(session)).toEqual(itemsBefore);
      expect(JSON.stringify(controller.snapshot().transcript)).toBe(transcriptBefore);
      expect(controller.snapshot().transcript.some((entry) => entry.text === "b-done")).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

test("corrupt ancestry surfaces branchTreeError without switching branches or model context", async () => {
  await withTempDir(async (dir) => {
    const state = emptyBranchState("corrupt-root");
    (state.entries as Map<string, { parentId: string; item: ReturnType<typeof user> }>).set("orphan", { parentId: "missing-parent", item: user("orphan") });
    (state.branches as Map<string, { id: string; headId: string }>).set("bad", { id: "bad", headId: "orphan" });
    const corrupt = createSession([], [], { state });
    expect(corrupt.activeBranchId).toBe("main");
    const itemsBefore = corrupt.items.map((item) => item.id);
    const controller = controllerFor(corrupt, "tree-corrupt", dir, createScriptedModel({ text: "ok" }));
    try {
      expect(controller.openBranchTree()).toBe(true);
      const transcriptBefore = JSON.stringify(controller.snapshot().transcript);
      const snapshot = controller.snapshot();
      expect(snapshot.branchTree).toBeUndefined();
      expect(snapshot.branchTreeError).toMatch(/Missing session parent or head/);
      expect(snapshot.branchId).toBe("main");
      expect(corrupt.activeBranchId).toBe("main");
      expect(corrupt.items.map((item) => item.id)).toEqual(itemsBefore);
      expect(JSON.stringify(controller.snapshot().transcript)).toBe(transcriptBefore);
      expect(() => controller.branchTreeSnapshot()).toThrow(/Missing session parent or head/);
      expect(controller.snapshot().branchId).toBe("main");
    } finally {
      controller.dispose();
    }
  });
});

test("select rejects ancestry-broken IDs without moving preview selection", async () => {
  await withTempDir(async (dir) => {
    const base = createSession([user("A"), assistant("B")], []);
    const withOrphan = { ...base, entries: [...base.entries, { parentId: "missing-parent", item: user("orphan") }] };
    const controller = controllerFor(withOrphan, "tree-select", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      const selectedBefore = controller.branchTreeSnapshot()?.selectedId;
      expect(typeof selectedBefore).toBe("string");
      expect(controller.selectBranchTreeNode("orphan")).toBe(false);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe(selectedBefore);
      expect(controller.snapshot().branchId).toBe("main");
      expect(() => controller.previewBranchTreeNode("orphan")).toThrow(/Missing session parent/);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe(selectedBefore);
      expect(controller.selectBranchTreeNode("A")).toBe(true);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe("A");
    } finally {
      controller.dispose();
    }
  });
});

test("branch-tree slash input routes to commands instead of becoming a fork name", async () => {
  await withTempDir(async (dir) => {
    const session = createSession([user("A"), assistant("B")], []);
    const controller = controllerFor(session, "tree-slash", dir, createScriptedModel({ text: "ok" }));
    try {
      controller.openBranchTree();
      const selectedBefore = controller.branchTreeSnapshot()?.selectedId;
      expect(typeof selectedBefore).toBe("string");
      const branchCount = session.listBranches().length;
      // Routing decision mirrors the TUI Enter handler while the tree is open.
      expect(isBranchTreeCommandInput("/help")).toBe(true);
      expect(isBranchTreeCommandInput("  /branch list")).toBe(true);
      expect(isBranchTreeCommandInput("my fork")).toBe(false);
      expect(isBranchTreeCommandInput("")).toBe(false);
      expect(parseSlashCommand("/help")).not.toBeNull();
      // The fixed path dispatches slash input as a command, never as a fork name.
      let commanded: string | undefined;
      const input = "/help";
      if (isBranchTreeCommandInput(input)) {
        await dispatchEditorInput(input, controller, async (command) => { commanded = command.name; return true; });
      } else {
        controller.confirmBranchTreeSelection(input);
      }
      expect(commanded).toBe("help");
      expect(session.listBranches()).toHaveLength(branchCount);
      expect(session.listBranches().some((branch) => branch.name === "/help")).toBe(false);
      expect(controller.branchTreeSnapshot()?.selectedId).toBe(selectedBefore);
    } finally {
      controller.dispose();
    }
  });
});

test("capped tree keeps at most maxNodes when heads outnumber the limit", () => {
  const session = createSession([], []);
  const turns = 30;
  for (let i = 0; i < turns; i++) session.append(user(`u-${i}`), assistant(`a-${i}`));
  for (let i = 0; i < turns; i++) {
    session.forkBranch(`a-${i}`, `fork-${i}`);
    session.selectBranch("main");
  }
  const distinctHeads = new Set(session.listBranches().map((branch) => branch.headId));
  expect(distinctHeads.size).toBeGreaterThan(20);
  const maxNodes = 20;
  const built = buildBranchTreeSnapshot(session, undefined, { maxNodes });
  expect(built.nodes.length).toBeLessThanOrEqual(maxNodes);
  const seen = new Set(built.nodes.map((node) => node.id));
  expect(seen.has(session.rootId)).toBe(true);
  const activeHead = session.listBranches().find((branch) => branch.id === session.activeBranchId)?.headId;
  expect(typeof activeHead).toBe("string");
  expect(seen.has(activeHead!)).toBe(true);
  expect(seen.has(built.selectedId)).toBe(true);
  expect(built.truncated).toBe(true);
});

test("named fork compaction persists branch-local summary and reload displays the authoritative selected path", async () => {
  await withTempDir(async dir => {
    const directory = join(dir, "sessions");
    const session = await createJsonlSession({ directory, workspace: workspace(dir) });
    session.append(user("u"), assistant("a"), user("u2"), assistant("a2"));
    const controller = controllerFor(session, session.header.id, dir, createScriptedModel());
    try {
      controller.openBranchTree();
      controller.toggleBranchTreeAction();
      expect(controller.confirmBranchTreeSelection("summary path")).toBe(true);
      const fork = session.activeBranchId;
      session.append({ type: "compaction", id: "summary", firstKeptId: "u2", summary: "ONLY ON FORK" });
      session.append(user("after"), assistant("done"));
      expect(controller.activateBranchTreeBranch("main")).toBe(true);
      expect(session.items.some(item => item.type === "compaction")).toBe(false);
      const mainReload = await loadJsonlSession({ directory, id: session.header.id });
      controller.replaceSession(mainReload, session.header.id);
      expect(controller.branchTreeSnapshot()?.activeBranchId).toBe("main");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("ONLY ON FORK"))).toBe(false);
      controller.focusBranchTreeBranch(fork);
      expect(controller.confirmBranchTreeSelection()).toBe(true);
      const forkReload = await loadJsonlSession({ directory, id: session.header.id });
      controller.replaceSession(forkReload, session.header.id);
      expect(controller.branchTreeSnapshot()?.activeBranchId).toBe(fork);
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("ONLY ON FORK"))).toBe(true);
      expect(forkReload.items.map(item => item.id)).toEqual(["u", "a", "u2", "a2", "summary", "after", "done"]);
    } finally { controller.dispose(); }
  });
});
