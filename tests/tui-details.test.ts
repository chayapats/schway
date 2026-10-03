import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

function fixture(overrides: Partial<TuiControllerOptions> = {}) {
  const session = createSession();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session, workspace, sessionId: "details-session", provider: "scripted", modelId: "test",
    contextManager: createContextManager(workspace), model: createScriptedModel(), changeTracking: "off", ...overrides });
  return { controller, session };
}

test("retained notice availability exposes no diagnostics and inspection consumes them once", () => {
  const { controller, session } = fixture({ secrets: ["fixture-secret"] });
  try {
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    controller.notice("Saved locally · F2 details", "Local evidence: fixture-secret");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(true);
    expect(JSON.stringify(controller.snapshot())).not.toContain("Local evidence:");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Details · Esc keep editing\nLocal evidence: ***");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    const before = controller.snapshot().transcript.length;
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(controller.snapshot().transcript).toHaveLength(before);
    expect(session.items).toHaveLength(0);
  } finally { controller.dispose(); }
});

test("same-ID session replacement cannot revive retained notice details", () => {
  const { controller, session } = fixture();
  try {
    controller.notice("Original notice", "Original evidence");
    controller.replaceSession(createSession(), "details-session");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    controller.replaceSession(session, "details-session");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    const before = controller.snapshot().transcript.length;
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(controller.snapshot().transcript).toHaveLength(before);
  } finally { controller.dispose(); }
});

for (const action of ["command", "tree"] as const) test(`branch A→B→A through ${action} cannot revive retained notice details`, () => {
  const { controller, session } = fixture();
  try {
    const original = session.activeBranchId;
    const alternate = session.forkBranch(session.rootId, "alternate");
    session.selectBranch(original);
    controller.notice("Original notice", "Original evidence");
    const select = (id: string) => action === "command" ? controller.branchCommand(`switch ${id}`) : controller.activateBranchTreeBranch(id);
    expect(select(alternate)).toBe(true);
    // Do not inspect in the other branch: invalidation must happen at replacement, not on snapshot reads.
    expect(select(original)).toBe(true);
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("Original evidence"))).toBe(false);
  } finally { controller.dispose(); }
});

test("disposed controllers cannot expose retained or late notice details", () => {
  const { controller, session } = fixture();
  try {
    controller.notice("Original notice", "Original evidence");
    controller.dispose();
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    controller.notice("Late notice", "Late evidence");
    const before = controller.snapshot().transcript.length;
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(controller.snapshot().transcript).toHaveLength(before);
    expect(session.items).toHaveLength(0);
  } finally { controller.dispose(); }
});

test("notice evidence follows the latest detailed notice and ignores visible shortcut wording", () => {
  const { controller, session } = fixture();
  try {
    controller.notice("Ctrl+I details but no retained evidence");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    controller.notice("First notice", "Earlier evidence");
    controller.fail("Repair required · F2 details", "Latest evidence");
    controller.notice("An unrelated informational line");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(true);
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Details · Esc keep editing\nLatest evidence");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(session.items).toHaveLength(0);
  } finally { controller.dispose(); }
});

test("notice availability rejects a directly changed conversation branch before replacement", () => {
  const { controller, session } = fixture();
  try {
    controller.notice("Original notice", "Original evidence");
    session.forkBranch(session.rootId, "alternate");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    const before = controller.snapshot().transcript.length;
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(controller.snapshot().transcript).toHaveLength(before);
  } finally { controller.dispose(); }
});

for (const action of ["command", "tree"] as const) test(`fork through ${action} expires notice details on return`, () => {
  const { controller, session } = fixture();
  try {
    const original = session.activeBranchId;
    controller.notice("Original notice", "Original evidence");
    expect(action === "command" ? controller.branchCommand(`fork ${session.rootId} alternate`) : controller.forkBranchTreeNode(session.rootId, "alternate")).toBe(true);
    expect(controller.branchCommand(`switch ${original}`)).toBe(true);
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
  } finally { controller.dispose(); }
});

for (const failure of [false, true]) test(`staged session switch ${failure ? "failure preserves" : "success expires"} notice evidence`, async () => {
  const { controller, session } = fixture(failure ? { loadWorkspaceExtensions: async () => { throw new Error("fixture capability failure"); } } : {});
  const next = createSession();
  const workspace = { root: "/resumed", launchCwd: "/resumed/sub", extraRoots: ["/attached"] };
  const contextManager = createContextManager(workspace);
  try {
    controller.notice("Original notice", "Original evidence");
    expect(await controller.switchSession(next, "resumed-session", { workspace, contextManager })).toBe(!failure);
    expect(controller.snapshot().sessionId).toBe(failure ? "details-session" : "resumed-session");
    expect(controller.workspaceIdentity()?.root).toBe(failure ? "/project" : "/resumed");
    if (!failure) {
      expect(controller.workspaceIdentity()).toEqual(workspace);
      expect(controller.activeContextManager()).toBe(contextManager);
    }
    expect(controller.running).toBe(false);
    expect(controller.snapshot().noticeDetailsAvailable).toBe(failure);
    expect(controller.inspectNoticeDetails()).toBe(failure);
    if (failure) expect(controller.snapshot().transcript.at(-1)?.text).toContain("Original evidence");
    expect(session.items).toHaveLength(0);
    expect(next.items).toHaveLength(0);
  } finally { controller.dispose(); }
});

test("startup recovery exposes its existing action separately from retained notice diagnostics", () => {
  const { controller, session } = fixture({ model: undefined, startupError: "unknown model fixture-secret", secrets: ["fixture-secret"] });
  try {
    const recovery = controller.snapshot().recovery;
    expect(recovery).toMatchObject({ accepted: false, actions: ["choose-model", "details", "keep-editing"] });
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    controller.notice("Local notice", "Local evidence fixture-secret");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(true);
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().recovery).toEqual(recovery);
    expect(controller.inspectRecovery()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("unknown model ***");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(session.items).toHaveLength(0);
  } finally { controller.dispose(); }
});

test("consuming notice evidence preserves failed-outcome and newer unaccepted-recovery precedence", async () => {
  const { controller, session } = fixture({ model: createScriptedModel({ error: "accepted failure", status: 400 }) });
  try {
    await controller.submit("accepted task");
    const outcome = controller.snapshot().outcome;
    expect(outcome?.reason).toBe("failed");
    controller.notice("Local notice", "Local evidence");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().outcome).toEqual(outcome);
    expect(controller.inspectRecovery()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("accepted failure");
    controller.setModel(undefined, "scripted", "replacement");
    await controller.initializeStartup(async () => ({ error: "unknown model replacement" }));
    expect(controller.snapshot().recovery?.accepted).toBe(false);
    expect(controller.snapshot().outcome).toEqual(outcome);
    expect(controller.inspectRecovery()).toBe(true);
    const latest = controller.snapshot().transcript.at(-1)?.text;
    expect(latest).toContain("unknown model replacement");
    expect(latest).not.toContain("accepted failure");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
  } finally { controller.dispose(); }
});

test("a new accepted turn expires notice details without creating extra session records", async () => {
  const { controller, session } = fixture({ model: createScriptedModel({ text: "answer" }) });
  try {
    controller.notice("Local notice", "Earlier evidence");
    expect(controller.snapshot().noticeDetailsAvailable).toBe(true);
    expect(await controller.submit("task")).toBe(true);
    expect(controller.snapshot().noticeDetailsAvailable).toBe(false);
    expect(controller.inspectNoticeDetails()).toBe(false);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(controller.snapshot().outcome?.reason).toBe("completed");
  } finally { controller.dispose(); }
});
