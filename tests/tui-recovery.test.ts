import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { credentialStoreError } from "../src/auth/store.ts";
import { createSession } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";

function controller(dir: string, responses: ScriptedTurnFactory[], session = createSession(), secrets: string[] = [], startupError?: string) {
  const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
  return new TuiController({ session, model: createScriptedModel({ responses }),
    contextManager: createContextManager(workspace), workspace, tools: createToolRegistry([readTool, writeTool]),
    provider: "scripted", modelId: "scripted", sessionId: "recovery-session", secrets, startupError,
    agentClock: { now: () => 0, sleep: async () => {} } });
}

test("accepted failed step continues with saved tool result and one user record", async () => {
  await withTempDir(async dir => {
    const session = createSession();
    const tui = controller(dir, [
      { toolCalls: [{ id: "write-once", name: "write", arguments: { path: "evidence.txt", content: "durable evidence" } }] },
      { error: "offline", code: "ENETUNREACH", chunks: ["partial"], throwAfter: "chunks" },
      { error: "offline", code: "ENETUNREACH" },
      { error: "offline", code: "ENETUNREACH" },
      request => {
        expect(request.items.some(item => item.type === "tool_result" && item.toolCallId === "write-once")).toBe(true);
        return { text: "continued" };
      },
    ], session, ["secret-sentinel"]);
    expect(await tui.submit("inspect evidence")).toBe(true);
    expect(tui.snapshot().recovery).toMatchObject({ category: "offline", accepted: true,
      actions: ["continue", "details", "keep-editing"] });
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    expect(await readFile(join(dir, "evidence.txt"), "utf8")).toBe("durable evidence");
    expect(await tui.continueRecovery()).toBe(true);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    expect(tui.snapshot().transcript.some(entry => entry.kind === "assistant" && entry.text === "continued")).toBe(true);
    expect(tui.snapshot().recovery).toBeUndefined();
  });
});

test("pre-acceptance unavailable model preserves the draft without a user record", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    const tui = new TuiController({ session, model: undefined, contextManager: createContextManager(workspace),
      workspace, provider: "scripted", modelId: "removed", sessionId: "preaccept-model",
      startupError: "unknown model removed" });
    let accepted = false;
    expect(await tui.submit("draft", () => { accepted = true; })).toBe(false);
    expect(accepted).toBe(false);
    expect(session.items).toHaveLength(0);
    expect(tui.snapshot().recovery).toMatchObject({ category: "model", accepted: false,
      actions: ["choose-model", "details", "keep-editing"] });
  });
});

test("startup diagnostics stay out of the primary row and optional details mask unknown payload fields", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const tui = new TuiController({ session: createSession(), model: undefined,
      contextManager: createContextManager(workspace), workspace, provider: "scripted", modelId: "broken",
      sessionId: "sensitive-startup", startupError: "Provider failed: Bearer opaque-startup-token\npayload: private customer text and address\nbody: private invoice records\ndata: private account notes\ntoken=unknown-token" });
    const primary = tui.snapshot().transcript.at(-1)?.text ?? "";
    expect(primary).toContain("provider could not be loaded");
    expect(primary).not.toContain("opaque-startup-token");
    expect(primary).not.toContain("private customer text");
    expect(tui.inspectRecovery()).toBe(true);
    const details = tui.snapshot().transcript.at(-1)?.text ?? "";
    expect(details).toContain("Bearer ***");
    expect(details).toContain("[provider payload redacted]");
    expect(details).not.toContain("opaque-startup-token");
    expect(details).not.toContain("private customer text");
    expect(details).not.toContain("private invoice records");
    expect(details).not.toContain("private account notes");
    expect(details).not.toContain("unknown-token");
  });
});

test("accepted provider diagnostics omit multiword payloads from both recovery views", async () => {
  await withTempDir(async dir => {
    const tui = controller(dir, [{ error: "request rejected\npayload: private customer text and address", status: 400 }]);
    await tui.submit("task");
    const primary = tui.snapshot().transcript.at(-1)?.text ?? "";
    expect(primary).not.toContain("private customer text");
    expect(tui.inspectRecovery()).toBe(true);
    const details = tui.snapshot().transcript.at(-1)?.text ?? "";
    expect(details).toContain("[provider payload redacted]");
    expect(details).not.toContain("private customer text");
    expect(details).not.toContain("address");
  });
});

test("locked credential storage offers retry without accepting the draft", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    let locked = true;
    const tui = new TuiController({ session, model: undefined, contextManager: createContextManager(workspace),
      workspace, provider: "scripted", modelId: "scripted", sessionId: "locked-credential-store",
      startupError: credentialStoreError("read"),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => locked
        ? { error: credentialStoreError("read") } : { model: createScriptedModel({ text: "ready" }) } } });
    expect(tui.snapshot().recovery).toMatchObject({ category: "credential-store",
      actions: ["retry-credentials", "details", "keep-editing"] });
    expect(await tui.submit("unsent task")).toBe(false);
    expect(session.items).toHaveLength(0);
    expect(await tui.retryCredentialRecovery()).toBe(false);
    expect(tui.snapshot().recovery?.category).toBe("credential-store");
    locked = false;
    expect(await tui.retryCredentialRecovery()).toBe(true);
    expect(session.items).toHaveLength(0);
    expect(await tui.submit("unsent task")).toBe(true);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("credential-store failure after acceptance repairs and continues the saved turn", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    const tui = new TuiController({ session, model: createScriptedModel({ error: credentialStoreError("read") }),
      contextManager: createContextManager(workspace), workspace, provider: "scripted", modelId: "scripted",
      sessionId: "accepted-locked-store",
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel({ text: "after unlock" }) }) } });
    await tui.submit("saved task");
    expect(tui.snapshot().recovery).toMatchObject({ category: "credential-store", accepted: true,
      actions: ["retry-credentials", "details", "keep-editing"] });
    expect(await tui.retryCredentialRecovery()).toBe(true);
    expect(tui.snapshot().recovery?.actions).toContain("continue");
    expect(await tui.continueRecovery()).toBe(true);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("provider categories expose only valid controls and optional redacted diagnostics", async () => {
  await withTempDir(async dir => {
    for (const [category, turn, actions] of [
      ["auth", { error: "expired credential secret-sentinel", status: 401 }, ["connect", "details", "keep-editing"]],
      ["model", { error: "unknown model secret-sentinel", status: 404 }, ["choose-model", "details", "keep-editing"]],
      ["provider", { error: "bad request secret-sentinel", status: 400 }, ["continue", "details", "keep-editing"]],
      ["offline", { error: "fetch failed secret-sentinel", code: "ENETUNREACH" }, ["continue", "details", "keep-editing"]],
      ["rate-limit", { error: "rate limit secret-sentinel", status: 429 }, ["continue", "details", "keep-editing"]],
    ] as const) {
      const count = category === "offline" || category === "rate-limit" ? 3 : 1;
      const tui = controller(dir, Array.from({ length: count }, () => turn), createSession(), ["secret-sentinel"]);
      await tui.submit(`test ${category}`);
      const recovery = tui.snapshot().recovery;
      expect(recovery?.category).toBe(category);
      expect(recovery?.actions).toEqual(actions);
      expect(JSON.stringify(tui.snapshot())).not.toContain("secret-sentinel");
      expect(tui.inspectRecovery()).toBe(true);
      expect(tui.snapshot().transcript.at(-1)?.text).toContain("***");
    }
  });
});

test("failed session write stops continuation and does not claim tool result was saved", async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, "evidence.txt"), "read result");
    let writes = 0;
    const session = createSession([], [], { writeOperation() { if (++writes === 3) throw new Error("locked store"); } });
    const tui = controller(dir, [{ toolCalls: [{ id: "call", name: "read", arguments: { path: "evidence.txt" } }] }], session);
    await tui.submit("read evidence");
    expect(tui.snapshot().recovery).toMatchObject({ category: "session-write", accepted: true,
      actions: ["details", "keep-editing"] });
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(0);
    expect(await tui.continueRecovery()).toBe(false);
    expect(tui.snapshot().transcript.some(entry => entry.text.includes("read result"))).toBe(true);
    expect(tui.snapshot().transcript.find(entry => entry.toolCallId === "call")?.text).toContain("result was not saved");
    let accepted = false;
    expect(await tui.submit("new draft", () => { accepted = true; })).toBe(false);
    expect(accepted).toBe(false);
    expect(writes).toBe(3);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
    const fresh = createSession();
    tui.replaceSession(fresh, "fresh-session");
    tui.setModel(createScriptedModel({ text: "fresh answer" }), "scripted", "scripted");
    expect(await tui.submit("new draft")).toBe(true);
    expect(fresh.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("recovery controls become stale after session replacement", async () => {
  await withTempDir(async dir => {
    const tui = controller(dir, [{ error: "expired", status: 401 }]);
    await tui.submit("task");
    expect(tui.snapshot().recovery).toBeDefined();
    tui.replaceSession(createSession(), "other-session");
    expect(tui.snapshot().recovery).toBeUndefined();
    expect(await tui.continueRecovery()).toBe(false);
  });
});

test("changing the active model outside repair disables an earlier operation's controls", async () => {
  await withTempDir(async dir => {
    const tui = controller(dir, [{ error: "temporary failure", status: 500 },
      { error: "temporary failure", status: 500 }, { error: "temporary failure", status: 500 }]);
    await tui.submit("task");
    expect(tui.snapshot().recovery?.actions).toContain("continue");
    tui.setModel(createScriptedModel({ text: "new identity" }), "scripted", "new-model");
    expect(tui.snapshot().recovery).toBeUndefined();
    expect(await tui.continueRecovery()).toBe(false);
  });
});

test("same adapter with changed provider, model ID, or profile stales recovery", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    for (const change of [
      { provider: "another", modelId: "scripted" },
      { provider: "scripted", modelId: "another" },
      { provider: "scripted", modelId: "scripted", profile: "another" },
    ]) {
      const model = createScriptedModel({ error: "bad request", status: 400 });
      const tui = new TuiController({ session: createSession(), model, contextManager: createContextManager(workspace),
        workspace, provider: "scripted", modelId: "scripted", sessionId: "same-adapter" });
      await tui.submit("task");
      expect(tui.snapshot().recovery).toBeDefined();
      tui.setModel(model, change.provider, change.modelId, change.profile);
      expect(tui.snapshot().recovery).toBeUndefined();
      expect(await tui.continueRecovery()).toBe(false);
    }
  });
});

test("a stale continuation cannot publish into a replacement session", async () => {
  await withTempDir(async dir => {
    const original = createSession();
    const tui = controller(dir, [
      { error: "temporary failure", status: 500 }, { error: "temporary failure", status: 500 },
      { error: "temporary failure", status: 500 }, { waitForAbort: true },
    ], original);
    await tui.submit("task");
    const pending = tui.continueRecovery();
    await new Promise(resolve => setTimeout(resolve, 1));
    const replacement = createSession();
    tui.replaceSession(replacement, "replacement-session");
    await pending;
    expect(replacement.items).toHaveLength(0);
    expect(tui.snapshot().sessionId).toBe("replacement-session");
    expect(tui.snapshot().recovery).toBeUndefined();
    expect(original.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("failed model repair keeps the turn and a successful repair enables continuation", async () => {
  await withTempDir(async dir => {
    const session = createSession();
    const tui = controller(dir, [{ error: "unknown model", status: 404 }], session);
    await tui.submit("task");
    expect(tui.snapshot().recovery?.actions).not.toContain("continue");
    expect(tui.openRecoveryRepair("choose-model")).toBe(true);
    tui.fail("Could not activate the selected model.");
    tui.closeModelPicker();
    expect(tui.snapshot().recovery?.actions).toContain("choose-model");
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);

    expect(tui.openRecoveryRepair("choose-model")).toBe(true);
    tui.setModel(createScriptedModel({ text: "after repair" }), "scripted", "replacement");
    tui.closeModelPicker();
    expect(tui.snapshot().recovery?.actions).toEqual(["continue", "details", "keep-editing"]);
    expect(await tui.continueRecovery()).toBe(true);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("cancelling a continuation retains its saved task for another explicit continuation", async () => {
  await withTempDir(async dir => {
    const session = createSession();
    const tui = controller(dir, [
      { error: "first outage", status: 500 }, { error: "first outage", status: 500 }, { error: "first outage", status: 500 },
      { waitForAbort: true },
    ], session);
    await tui.submit("task");
    const pending = tui.continueRecovery();
    await new Promise(resolve => setTimeout(resolve, 1));
    tui.cancel();
    expect(await pending).toBe(true);
    expect(tui.snapshot().status).toBe("idle");
    expect(tui.snapshot().recovery?.actions).toContain("continue");
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});
