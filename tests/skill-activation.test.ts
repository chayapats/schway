import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { discoverSkills, loadSkillBody, SKILL_BODY_LIMIT_CHARS } from "../src/skills/skills.ts";
import { createActivateSkillTool } from "../src/skills/activate.ts";
import { executeToolCall } from "../src/tools/executor.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { invokeSkillTurn } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import type { ScriptedTurnFactory } from "./helpers/scripted-model.ts";

async function skillFile(root: string, name: string, body: string, flags = ""): Promise<string> {
  const dir = join(root, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, `---\nname: ${name}\ndescription: ${name} workflow.\n${flags}\n---\n${body}\n`);
  return path;
}

function workspaceFor(root: string) {
  return { root, launchCwd: root, extraRoots: [] as string[] };
}

function activation(id: string, name: string) {
  return { id, name: "activate_skill", arguments: { name } };
}

function activeBody(request: Pick<ModelRequest, "context">): string | undefined {
  const sections = request.context.filter((section) => section.name === "active-skill");
  expect(sections.length).toBeLessThanOrEqual(1);
  return sections[0]?.content;
}

for (const reason of ["error", "max_turns", "cancelled"] as const) {
  test(`model activation clears when a turn ends with ${reason}`, async () => {
    await withTempDir(async (root) => {
      await skillFile(root, "review", "REVIEW_BODY");
      const workspace = workspaceFor(root);
      const manager = createContextManager(workspace);
      const session = createSession();
      const abort = new AbortController();
      const events = [];
      for await (const event of runAgentLoop({
        workspace, session, contextManager: manager, signal: abort.signal,
        maxTurns: reason === "max_turns" ? 1 : undefined,
        model: createScriptedModel({ responses: [
          { toolCalls: [activation("active", "review")] },
          { error: "Provider rejected this request", status: 400 },
        ] }),
      })) {
        events.push(event);
        if (reason === "cancelled" && event.type === "tool.finished") abort.abort();
      }
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason });
      expect(session.items.filter((item) => item.type === "tool_result")).toHaveLength(1);
      expect(activeBody(await manager.prepare(session))).toBeUndefined();
    });
  });
}

test("unknown activation names have bounded errors even with a large discovered catalog", async () => {
  await withTempDir(async (root) => {
    for (let i = 0; i < 30; i++) {
      await skillFile(root, `skill-${String(i).padStart(2, "0")}-${"x".repeat(40)}`, "Catalog body");
    }
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const result = await executeToolCall({
      registry: createToolRegistry([createActivateSkillTool(manager)]), workspace,
      call: { type: "tool_call", ...activation("unknown", "unknown") },
    });
    expect(result.status).toBe("error");
    expect(result.result.content).toContain("Unknown skill");
    expect(result.result.content.length).toBeLessThanOrEqual(1_000);
  });
});

test("model activation adds one volatile body to the next request with project and system context", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "REVIEW_BODY_MARKER");
    await writeFile(join(root, "AGENTS.md"), "PROJECT_RULE_MARKER");
    const home = join(root, "home");
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway", "SYSTEM.md"), "CUSTOM_SYSTEM_MARKER");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace, { home });
    const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "Review this" }] }]);
    const tools = createToolRegistry();
    let inspected = false;
    const events = await collect(runAgentLoop({
      workspace, session, contextManager: manager, tools,
      model: createScriptedModel({ responses: [
        (request) => {
          expect(request.tools?.find((tool) => tool.name === "activate_skill")).toBeDefined();
          expect(JSON.stringify(request.context)).not.toContain("REVIEW_BODY_MARKER");
          return { toolCalls: [activation("activate", "review")] };
        },
        (request) => {
          inspected = true;
          expect(request.context.filter((section) => section.name === "active-skill")).toHaveLength(1);
          expect(JSON.stringify(request.context)).toContain("REVIEW_BODY_MARKER");
          expect(JSON.stringify(request.context)).toContain("PROJECT_RULE_MARKER");
          expect(request.systemPrompt).toContain("CUSTOM_SYSTEM_MARKER");
          expect(JSON.stringify(request.items)).not.toContain("REVIEW_BODY_MARKER");
          return { text: "Reviewed" };
        },
      ] }),
    }));
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    expect(inspected).toBe(true);
    expect(tools.definitions()).toHaveLength(0);
    const results = session.items.filter((item) => item.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toBe("Activated skill 'review' for this user turn.");
    expect(JSON.stringify(session.items)).not.toContain("REVIEW_BODY_MARKER");
    expect((await manager.prepare(session)).context.some((section) => section.name === "active-skill")).toBe(false);
  });
});

for (const reason of ["pressure", "overflow"] as const) {
  test(`${reason} compaction retains active context while persisted resume requires fresh activation`, async () => {
    await withTempDir(async (root) => {
      await skillFile(root, "review", `REVIEW_BODY_MARKER ${"x".repeat(5_000)}`);
      const workspace = workspaceFor(root);
      const manager = createContextManager(workspace, { keepTurns: 1, contextWindow: reason === "pressure" ? 1_000 : 100_000 });
      const directory = join(root, "sessions");
      const session = await createJsonlSession({ workspace, directory });
      session.append(
        { type: "user", id: "old-u", content: [{ type: "text", text: "Old goal" }] },
        { type: "assistant", id: "old-a", content: [{ type: "text", text: "Old progress" }] },
        { type: "user", id: "current", content: [{ type: "text", text: "Review" }] },
      );
      let afterCompaction = false;
      const responses: ScriptedTurnFactory[] = [{ toolCalls: [activation("active", "review")] }];
      if (reason === "overflow") {
        responses.push((request) => {
          expect(activeBody(request)).toContain("REVIEW_BODY_MARKER");
          return { error: "context too large", status: 400, code: "context_length_exceeded" };
        });
      }
      responses.push(
        (request) => {
          expect(request.systemPrompt).toContain("summarize");
          expect(JSON.stringify(request)).not.toContain("REVIEW_BODY_MARKER");
          return { text: "Older progress summarized." };
        },
        (request) => {
          afterCompaction = true;
          expect(activeBody(request)).toContain("REVIEW_BODY_MARKER");
          expect(request.context.find((section) => section.name === "summary")?.content).toBe("Older progress summarized.");
          expect(JSON.stringify(request.items)).not.toContain("REVIEW_BODY_MARKER");
          return { text: "Reviewed" };
        },
      );
      const events = await collect(runAgentLoop({ workspace, session, contextManager: manager, model: createScriptedModel({ responses }) }));
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(afterCompaction).toBe(true);
      expect(events.some((event) => event.type === "compaction.finished" && event.reason === reason && event.status === "completed")).toBe(true);
      expect(session.items.filter((item) => item.type === "compaction")).toHaveLength(1);
      const durable = await readFile(join(directory, `${session.header.id}.jsonl`), "utf8");
      expect(durable).toContain("activate_skill");
      expect(durable).not.toContain("REVIEW_BODY_MARKER");
      const resumed = await loadJsonlSession({ directory, id: session.header.id });
      resumed.append({ type: "user", id: "resumed-u", content: [{ type: "text", text: "Continue review" }] });
      const resumedManager = createContextManager(workspace);
      let reactivated = false;
      const resumedEvents = await collect(runAgentLoop({
        workspace, session: resumed, contextManager: resumedManager,
        model: createScriptedModel({ responses: [
          (request) => {
            expect(activeBody(request)).toBeUndefined();
            return { toolCalls: [activation("reactivated", "review")] };
          },
          (request) => {
            reactivated = true;
            expect(activeBody(request)).toContain("REVIEW_BODY_MARKER");
            return { text: "done" };
          },
        ] }),
      }));
      expect(resumedEvents.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(reactivated).toBe(true);
      expect(activeBody(await resumedManager.prepare(resumed))).toBeUndefined();
    });
  });
}

test("TUI cancellation drains every accepted sibling call and the next user turn starts without active context", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "REVIEW_BODY");
    await skillFile(root, "plan", "PLAN_BODY");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const session = createSession();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const tools = createToolRegistry([{
      name: "wait", description: "Wait at a test boundary", execution: "parallel", inputSchema: Type.Object({}),
      async execute() {
        started.resolve();
        await released.promise;
        return { content: "settled" };
      },
    }]);
    let secondTurn = false;
    const controller = new TuiController({
      workspace, session, contextManager: manager, tools,
      provider: "scripted", modelId: "scripted", sessionId: "cancel",
      model: createScriptedModel({ responses: [
        { toolCalls: [activation("first", "review"), { id: "waiting", name: "wait", arguments: {} }, activation("queued", "plan"), activation("unknown", "unknown")] },
        (request) => {
          secondTurn = true;
          expect(activeBody(request)).toBeUndefined();
          return { text: "Next turn" };
        },
      ] }),
    });
    const pending = controller.submit("First turn");
    await started.promise;
    controller.cancel();
    released.resolve();
    await pending;
    expect(session.items.filter((item) => item.type === "tool_result").map((item) => [item.toolCallId, item.content])).toEqual([
      ["first", "Activated skill 'review' for this user turn."], ["waiting", "settled"],
      ["queued", "Tool call cancelled"], ["unknown", "Tool call cancelled"],
    ]);
    expect(activeBody(await manager.prepare(session))).toBeUndefined();
    await controller.submit("Second turn");
    expect(secondTurn).toBe(true);
    expect(controller.snapshot().status).toBe("idle");
  });
});

test("an old cancelled turn cannot clear skill context or status belonging to a replacement session", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "REVIEW_BODY");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const old = createSession();
    const fresh = createSession();
    const oldStarted = Promise.withResolvers<void>();
    const releaseOld = Promise.withResolvers<void>();
    const newStarted = Promise.withResolvers<void>();
    const releaseNew = Promise.withResolvers<void>();
    let waits = 0;
    const tools = createToolRegistry([{
      name: "wait", description: "Wait at a test boundary", execution: "exclusive", inputSchema: Type.Object({}),
      async execute() {
        if (waits++ === 0) {
          oldStarted.resolve();
          await releaseOld.promise;
        } else {
          newStarted.resolve();
          await releaseNew.promise;
        }
        return { content: "settled" };
      },
    }]);
    let freshContext = false;
    const controller = new TuiController({
      workspace, session: old, contextManager: manager, tools,
      provider: "scripted", modelId: "scripted", sessionId: "old",
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "old-wait", name: "wait", arguments: {} }] },
        { toolCalls: [activation("new-active", "review"), { id: "new-wait", name: "wait", arguments: {} }] },
        (request) => {
          freshContext = true;
          expect(activeBody(request)).toContain("REVIEW_BODY");
          return { text: "Fresh completion" };
        },
      ] }),
    });
    const oldTurn = controller.submit("old");
    await oldStarted.promise;
    controller.replaceSession(fresh, "fresh", { contextManager: manager });
    const freshTurn = controller.submit("fresh");
    await newStarted.promise;
    releaseOld.resolve();
    await oldTurn;
    expect(controller.snapshot().status).toBe("running");
    expect(activeBody(await manager.prepare(fresh))).toContain("REVIEW_BODY");
    releaseNew.resolve();
    await freshTurn;
    expect(freshContext).toBe(true);
    expect(controller.snapshot().status).toBe("idle");
    expect(controller.snapshot().transcript.some((entry) => entry.text === "Cancelled.")).toBe(false);
    expect(old.items.filter((item) => item.type === "tool_result")).toHaveLength(1);
    expect(fresh.items.filter((item) => item.type === "tool_result")).toHaveLength(2);
    expect(activeBody(await manager.prepare(fresh))).toBeUndefined();
  });
});

test("exclusive activation rechecks eligibility, replaces one body, and keeps same-identity activation idempotent", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "ORIGINAL_BODY");
    await skillFile(root, "plan", "PLAN_BODY");
    await skillFile(root, "changed", "CHANGED_BODY");
    const removed = await skillFile(root, "removed", "REMOVED_BODY");
    await skillFile(root, "oversize", "x".repeat(SKILL_BODY_LIMIT_CHARS + 1));
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "work" }] }]);
    const tools = createToolRegistry([{
      name: "update_skills", description: "Update fixtures", execution: "parallel",
      inputSchema: Type.Object({}),
      async execute() {
        await skillFile(root, "review", "NEW_BODY");
        await skillFile(root, "changed", "CHANGED_BODY", "disable-model-invocation: true");
        await rm(removed);
        return { content: "Updated" };
      },
    }]);
    const seen: Array<string | undefined> = [];
    const events = await collect(runAgentLoop({
      workspace, session, contextManager: manager, tools,
      model: createScriptedModel({ responses: [
        { toolCalls: [activation("first", "review")] },
        (request) => {
          seen.push(activeBody(request));
          return { toolCalls: [
            { id: "update", name: "update_skills", arguments: {} },
            activation("repeat", "review"),
            activation("changed", "changed"),
          ] };
        },
        (request) => {
          seen.push(activeBody(request));
          return { toolCalls: [activation("replace", "plan"), activation("missing", "missing"), activation("oversize", "oversize"), activation("removed", "removed")] };
        },
        (request) => {
          seen.push(activeBody(request));
          return { text: "done" };
        },
      ] }),
    }));
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain("ORIGINAL_BODY");
    expect(seen[1]).toContain("ORIGINAL_BODY");
    expect(seen[1]).not.toContain("NEW_BODY");
    expect(seen[2]).toContain("PLAN_BODY");
    expect(seen[2]).not.toContain("ORIGINAL_BODY");
    const results = session.items.filter((item) => item.type === "tool_result");
    expect(results.map((item) => [item.toolCallId, item.isError])).toEqual([
      ["first", false], ["update", false], ["repeat", false], ["changed", true],
      ["replace", false], ["missing", true], ["oversize", true], ["removed", true],
    ]);
    expect(results[3]?.content).toContain("user-only");
    expect(results.every((item) => item.content.length <= 1_000)).toBe(true);
    const updateFinish = events.findIndex((event) => event.type === "tool.finished" && event.toolCallId === "update");
    const repeatStart = events.findIndex((event) => event.type === "tool.started" && event.toolCallId === "repeat");
    expect(repeatStart).toBeGreaterThan(updateFinish);
    expect(JSON.stringify(session.items)).not.toContain("ORIGINAL_BODY");
  });
});

test("the shared loader rejects stale eligibility, changed names, changed canonical sources, and unreadable bodies", async () => {
  await withTempDir(async (root) => {
    const path = await skillFile(root, "review", "REVIEW_BODY");
    const metadata = (await discoverSkills({ workspaceRoot: root })).skills[0]!;
    await skillFile(root, "review", "REVIEW_BODY", "disable-model-invocation: true");
    const disabled = await loadSkillBody(metadata, { modelInvocation: true });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error).toContain("user-only");
    expect((await loadSkillBody(metadata)).ok).toBe(true);
    await writeFile(path, "---\nname: renamed\ndescription: Changed.\n---\nRENAMED_BODY\n");
    const renamed = await loadSkillBody(metadata, { modelInvocation: true });
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error).toContain("changed on disk");
    const target = join(root, "replacement.md");
    await writeFile(target, "---\nname: review\ndescription: Replacement.\n---\nOTHER_BODY\n");
    await rm(path);
    await symlink(target, path);
    const moved = await loadSkillBody(metadata, { modelInvocation: true });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error).toContain("changed source");
    await rm(path);
    const missing = await loadSkillBody(metadata, { modelInvocation: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("cannot read body");
  });
});

test("cancelled activation settles with a bounded error and preserves previous context until turn cleanup", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "REVIEW_BODY");
    await skillFile(root, "plan", "PLAN_BODY");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    expect((await manager.activateSkill("review")).ok).toBe(true);
    const registry = createToolRegistry([createActivateSkillTool(manager)]);
    const abort = new AbortController();
    const pending = executeToolCall({
      registry, workspace, signal: abort.signal,
      call: { type: "tool_call", ...activation("cancelled", "plan") },
    });
    abort.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.result.content).toBe("Tool call cancelled");
    expect(activeBody(await manager.prepare(createSession()))).toContain("REVIEW_BODY");
    expect(activeBody(await manager.prepare(createSession()))).not.toContain("PLAN_BODY");
  });
});

test("new and resumed sessions clear pending and loaded activation even when the manager is reused", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "review", "REVIEW_BODY");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const original = createSession();
    const controller = new TuiController({
      session: original, contextManager: manager, tools: createToolRegistry(), workspace,
      model: createScriptedModel(), provider: "scripted", modelId: "scripted", sessionId: "old",
    });
    expect((await manager.activateSkill("review")).ok).toBe(true);
    controller.replaceSession(createSession(), "new");
    expect((await manager.prepare(original)).context.some((section) => section.name === "active-skill")).toBe(false);
    const pending = manager.activateSkill("review");
    controller.replaceSession(original, "resumed");
    expect((await pending).ok).toBe(false);
    expect((await manager.prepare(original)).context.some((section) => section.name === "active-skill")).toBe(false);
  });
});

test("explicit user-only activation survives rejected model replacements, including aliases and paths", async () => {
  await withTempDir(async (root) => {
    await skillFile(root, "deploy", "USER_ONLY_BODY", "disable-model-invocation: true");
    await skillFile(root, "secret", "OTHER_USER_ONLY_BODY", "user-only: true");
    await symlink(join(root, ".agents", "skills", "secret"), join(root, ".agents", "skills", "alias"));
    await skillFile(root, "review", "REVIEW_BODY");
    const workspace = workspaceFor(root);
    const manager = createContextManager(workspace);
    const session = createSession();
    let inspected = false;
    const controller = new TuiController({
      session, contextManager: manager, tools: createToolRegistry(), workspace,
      provider: "scripted", modelId: "scripted", sessionId: "user-only",
      model: createScriptedModel({ responses: [
        (request) => {
          expect(JSON.stringify(request.context)).toContain("USER_ONLY_BODY");
          const available = request.context.find((section) => section.name === "available-skills")?.content;
          expect(available).not.toContain("secret");
          expect(available).not.toContain("deploy");
          expect(available).toContain("activate_skill");
          return { toolCalls: [
            activation("same-user-only", "deploy"),
            activation("other-user-only", "secret"),
            activation("alias", "alias"),
            activation("path", ".agents/skills/secret/SKILL.md"),
            { id: "invalid", name: "activate_skill", arguments: { path: "secret" } },
          ] };
        },
        (request) => {
          inspected = true;
          expect(request.items.filter((item) => item.type === "tool_result").every((item) => item.isError)).toBe(true);
          expect(JSON.stringify(request.context)).toContain("USER_ONLY_BODY");
          expect(JSON.stringify(request.context)).not.toContain("OTHER_USER_ONLY_BODY");
          return { toolCalls: [activation("eligible", "review")] };
        },
        (request) => {
          expect(JSON.stringify(request.context)).toContain("REVIEW_BODY");
          expect(JSON.stringify(request.context)).not.toContain("USER_ONLY_BODY");
          return { text: "done" };
        },
      ] }),
    });
    await invokeSkillTurn({ name: "deploy", args: "release", raw: "/deploy release" }, {
      controller, home: join(root, "empty-home"), skillScope: { manager, workspaceRoot: root },
    });
    expect(inspected).toBe(true);
    expect(controller.snapshot().status).toBe("idle");
    const results = session.items.filter((item) => item.type === "tool_result");
    expect(results).toHaveLength(6);
    expect(results[0]?.content).toContain("user-only");
    expect(results[1]?.content).toContain("user-only");
    expect(results[5]?.isError).toBe(false);
    expect(JSON.stringify(session.items)).not.toContain("USER_ONLY_BODY");
  });
});
