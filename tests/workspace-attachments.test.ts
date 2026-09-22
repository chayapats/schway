import { expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { discoverSkills, prepareSkillInvocation } from "../src/skills/skills.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { bashTool } from "../src/tools/bash.ts";
import { lsTool } from "../src/tools/ls.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { dispatchEditorInput, parseSlashCommand } from "../src/tui/commands.ts";
import { invokeSkillTurn } from "../src/tui/app.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { addWorkspaceRoots, restoreWorkspace, type Workspace } from "../src/workspace/workspace.ts";
import { withTempDir as withRawTempDir, makeDir, makeSymlink } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";
import type { ModelRequest } from "../src/model/model.ts";

/** Match real application workspaces, including macOS's canonical temporary directory prefix. */
async function withTempDir(run: (directory: string) => Promise<void>) {
  return withRawTempDir(async directory => run(await realpath(directory)));
}

/** Create a valid skill whose distinct body makes activation visible in captured requests. */
async function skill(root: string, name: string, body = "ATTACHED_SKILL_BODY") {
  const directory = await makeDir(join(root, ".agents", "skills", name));
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Attached workflow\n---\n${body}\n`);
  return directory;
}

/** Build the standard scripted controller while retaining its session and context manager for assertions. */
function controllerFor(workspace: Workspace, responses: ScriptedTurnFactory[] = [{ text: "done" }], session = createSession()) {
  const manager = createContextManager(workspace);
  const controller = new TuiController({
    session, workspace, contextManager: manager, model: createScriptedModel({ responses }),
    tools: createToolRegistry([readTool, writeTool, bashTool, lsTool, findTool, grepTool]),
    sessionId: "fixture", provider: "scripted", modelId: "scripted",
  });
  return { controller, manager, session };
}

/** Select the volatile project instruction text for a captured model request. */
function instructions(request: ModelRequest) {
  return request.context.find(section => section.name === "project-instructions")?.content ?? "";
}

test("attachment operands use the primary root, deduplicate realpath aliases, and reject invalid batches atomically", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const launchCwd = await makeDir(join(root, "nested"));
    const extra = await makeDir(join(dir, "extra"));
    await makeSymlink(extra, join(root, "alias"));
    await writeFile(join(root, "file"), "not a directory");
    const initial = { root, launchCwd, extraRoots: [] };
    const attached = await addWorkspaceRoots(initial, ["../extra", "alias", "../extra", "."]);
    expect(attached).toEqual({ root, launchCwd, extraRoots: [extra] });
    expect(initial.extraRoots).toEqual([]);
    for (const invalid of ["missing", "file", " "]) {
      await expect(addWorkspaceRoots(initial, ["../extra", invalid])).rejects.toThrow();
      expect(initial.extraRoots).toEqual([]);
    }
    const abort = new AbortController();
    abort.abort();
    await expect(addWorkspaceRoots(initial, [extra], abort.signal)).rejects.toThrow();
    expect(initial.extraRoots).toEqual([]);
  });
});

test("an inaccessible directory rejects the entire attachment batch", async () => {
  await withTempDir(async root => {
    const valid = await makeDir(join(root, "valid"));
    const denied = await makeDir(join(root, "denied"));
    const workspace = { root, launchCwd: root, extraRoots: [] };
    await chmod(denied, 0);
    try {
      await expect(addWorkspaceRoots(workspace, [valid, denied])).rejects.toThrow("Cannot attach directory");
      expect(workspace.extraRoots).toEqual([]);
    } finally { await chmod(denied, 0o700); }
  });
});

test("CLI and slash parsers expose repeatable attachments and reject empty operands", () => {
  expect(parseArgs(["--add-dir", "../one", "--add-dir=../two"]))
    .toEqual({ args: { json: false, help: false, addDirs: ["../one", "../two"] } });
  for (const args of [["--add-dir"], ["--add-dir="], ["--add-dir", "--json"]]) expect(parseArgs(args)).toHaveProperty("error");
  expect(parseSlashCommand("/add-dir ../project with spaces")).toEqual({ name: "add-dir", args: "../project with spaces", raw: "/add-dir ../project with spaces" });
});

test("attached local skills share primary precedence, preserve canonical resources, and block fallback on ambiguity", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    const home = await makeDir(join(dir, "home"));
    const extraSkill = await skill(extra, "helper");
    const global = await makeDir(join(home, ".schway", "skills", "helper"));
    await writeFile(join(global, "SKILL.md"), "---\nname: helper\ndescription: global\n---\nGLOBAL_BODY");
    const prepared = await prepareSkillInvocation({ workspaceRoot: root, extraRoots: [extra], home, name: "helper" });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) { expect(prepared.skill.dir).toBe(extraSkill); expect(prepared.body).toContain("ATTACHED_SKILL_BODY"); }
    await skill(root, "helper", "PRIMARY_BODY");
    const discovery = await discoverSkills({ workspaceRoot: root, extraRoots: [extra, extra], home });
    expect(discovery.skills).toEqual([]);
    expect(discovery.ambiguous).toHaveLength(1);
    expect(discovery.ambiguous[0]?.sources).toHaveLength(2);
    expect(await prepareSkillInvocation({ workspaceRoot: root, extraRoots: [extra], home, name: "helper" })).toMatchObject({ ok: false, error: expect.stringContaining("ambiguous") });
  });
});

test("real loop scopes instructions to extra A, primary defaults, sibling B, and resets at the next user turn", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const a = await makeDir(join(dir, "a"));
    const b = await makeDir(join(dir, "b"));
    const nested = await makeDir(join(a, "nested"));
    for (const [path, rule] of [[root, "PRIMARY_RULE"], [a, "A_RULE"], [b, "B_RULE"], [nested, "A_NESTED_RULE"]]) {
      await writeFile(join(path!, "AGENTS.md"), rule!);
      await writeFile(join(path!, "file"), "data");
    }
    await makeSymlink(nested, join(root, "alias"));
    const requests: ModelRequest[] = [];
    const calls = [
      { id: "a", name: "read", arguments: { path: "alias/file" } },
      { id: "primary", name: "ls", arguments: {} },
      { id: "b", name: "read", arguments: { path: join(b, "file") } },
    ];
    const responses: ScriptedTurnFactory[] = calls.map(call => request => { requests.push(request); return { toolCalls: [call] }; });
    responses.push(request => { requests.push(request); return { text: "done" }; }, request => { requests.push(request); return { text: "new turn" }; });
    const { controller } = controllerFor({ root, launchCwd: root, extraRoots: [a, b] }, responses);
    await controller.submit("inspect projects");
    await controller.submit("ordinary primary work");
    expect(requests).toHaveLength(5);
    expect(instructions(requests[0]!)).toBe("Source: AGENTS.md\nPRIMARY_RULE");
    expect(instructions(requests[1]!)).toContain("A_RULE");
    expect(instructions(requests[1]!)).toContain("A_NESTED_RULE");
    expect(instructions(requests[1]!)).not.toContain("B_RULE");
    expect(instructions(requests[2]!)).toContain("PRIMARY_RULE");
    expect(instructions(requests[2]!)).not.toContain("A_RULE");
    expect(instructions(requests[3]!)).toContain("B_RULE");
    expect(instructions(requests[3]!)).not.toContain("A_RULE");
    expect(instructions(requests[4]!)).toContain("PRIMARY_RULE");
    expect(instructions(requests[4]!)).not.toContain("B_RULE");
    controller.dispose();
  });
});

test.each(["find", "grep", "bash"])("%s with no directory returns instruction scope to the primary root", async name => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    await writeFile(join(extra, "AGENTS.md"), "EXTRA_RULE");
    await writeFile(join(extra, "file"), "data");
    await writeFile(join(root, "AGENTS.md"), "PRIMARY_RULE");
    let last: ModelRequest | undefined;
    const { controller } = controllerFor({ root, launchCwd: root, extraRoots: [extra] }, [
      { toolCalls: [{ id: "read", name: "read", arguments: { path: join(extra, "file") } }] },
      { toolCalls: [{ id: "default", name, arguments: name === "bash" ? { command: "pwd" } : { pattern: "file" } }] },
      request => { last = request; return { text: "done" }; },
    ]);
    await controller.submit("inspect");
    expect(instructions(last!)).toContain("PRIMARY_RULE");
    expect(instructions(last!)).not.toContain("EXTRA_RULE");
    controller.dispose();
  });
});

test("real loop keeps relative read/write/bash on primary after attachments and shell cd; absolute outside paths remain allowed", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    const outside = await makeDir(join(dir, "unattached"));
    await writeFile(join(root, "input"), "PRIMARY_CONTENT");
    await writeFile(join(extra, "input"), "EXTRA_CONTENT");
    const { controller, session } = controllerFor({ root, launchCwd: root, extraRoots: [extra] }, [
      { toolCalls: [{ id: "cd", name: "bash", arguments: { command: `cd '${extra}' && pwd` } }] },
      { toolCalls: [{ id: "write", name: "write", arguments: { path: "output", content: "PRIMARY_WRITE" } }] },
      { toolCalls: [{ id: "read", name: "read", arguments: { path: "input" } }] },
      { toolCalls: [{ id: "pwd", name: "bash", arguments: { command: "pwd" } }] },
      { toolCalls: [{ id: "outside", name: "write", arguments: { path: join(outside, "output"), content: "ALLOWED" } }] },
      { text: "done" },
    ]);
    await controller.submit("use files");
    expect(await readFile(join(root, "output"), "utf8")).toBe("PRIMARY_WRITE");
    expect(await Bun.file(join(extra, "output")).exists()).toBe(false);
    expect(await readFile(join(outside, "output"), "utf8")).toBe("ALLOWED");
    expect(session.items.find(item => item.type === "tool_result" && item.toolCallId === "read")).toMatchObject({ content: expect.stringContaining("PRIMARY_CONTENT") });
    expect(session.items.find(item => item.type === "tool_result" && item.toolCallId === "pwd")).toMatchObject({ content: expect.stringContaining(root) });
    controller.dispose();
  });
});

test("controller attachments persist outside conversation history, activate attached skills, and survive resume without dynamic bodies", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    const home = await makeDir(join(dir, "home"));
    const directory = join(dir, "sessions");
    await skill(extra, "helper");
    await makeSymlink(extra, join(root, "alias"));
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const session = await createJsonlSession({ directory, workspace });
    const captured: ModelRequest[] = [];
    const { controller, manager } = controllerFor(workspace, [request => { captured.push(request); return { toolCalls: [{ id: "activate", name: "activate_skill", arguments: { name: "helper" } }] }; }, request => { captured.push(request); return { text: "done" }; }, request => { captured.push(request); return { text: "invoked" }; }], session);
    await dispatchEditorInput("/add-dir alias", controller, async command => { await controller.addDirectories([command.args]); });
    expect(controller.describeConfig()).toContain(extra);
    expect(session.items).toHaveLength(0);
    await controller.submit("use helper");
    expect(captured[1]?.context.find(section => section.name === "active-skill")?.content).toContain("ATTACHED_SKILL_BODY");
    await invokeSkillTurn({ name: "helper", args: "", raw: "/helper" }, { controller, home, skillScope: { manager, workspaceRoot: root } });
    expect(captured[2]?.context.find(section => section.name === "active-skill")?.content).toContain("ATTACHED_SKILL_BODY");
    const text = await readFile(join(directory, `${session.header.id}.jsonl`), "utf8");
    expect(text).not.toContain("ATTACHED_SKILL_BODY");
    expect(text).not.toContain('"name":"environment"');
    const records = text.trim().split("\n").map(line => JSON.parse(line));
    const metadata = records.find(record => record.type === "workspace_roots");
    expect(metadata).toEqual({ type: "workspace_roots", version: 1, extraRoots: [extra] });
    expect(records.find(record => record.type === "user").parentId).toBe(session.header.id);
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    expect(resumed.header.extraRoots).toEqual([]);
    expect(resumed.metadata.extraRoots).toEqual([extra]);
    const restored = await restoreWorkspace({ root: resumed.header.workspaceRoot, launchCwd: resumed.header.launchCwd, extraRoots: [...resumed.metadata.extraRoots] });
    const prepared = await createContextManager(restored.workspace).prepare(resumed);
    expect(prepared.context.filter(section => section.name === "environment")).toHaveLength(1);
    expect(prepared.context[0]?.content).toContain(`Attached root: ${extra}`);
    expect(prepared.context.some(section => section.name === "active-skill")).toBe(false);
    controller.dispose();
  });
});

test("controller reserves idle ownership before asynchronous validation and cancellation leaves roots/history unchanged", async () => {
  await withTempDir(async dir => {
    const extra = await makeDir(join(dir, "extra"));
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const { controller, session } = controllerFor(workspace);
    const pending = controller.addDirectories([extra]);
    expect(controller.running).toBe(true);
    await controller.submit("must not start during validation");
    expect(await controller.addDirectories([extra])).toBe(false);
    controller.cancel();
    expect(await pending).toBe(false);
    await controller.waitForIdle();
    expect(workspace.extraRoots).toEqual([]);
    expect(session.metadata.extraRoots).toEqual([]);
    expect(session.items).toEqual([]);
    expect(controller.running).toBe(false);
    expect(controller.snapshot().transcript.map(entry => entry.text).join("\n")).toContain("Busy: /add-dir");
    expect(await controller.addDirectories([extra])).toBe(true);
    controller.dispose();
  });
});

test("busy turns, invalid batches and persistence failures cannot publish root changes", async () => {
  await withTempDir(async dir => {
    const extra = await makeDir(join(dir, "extra"));
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const { controller } = controllerFor(workspace, [{ waitForAbort: true }]);
    const turn = controller.submit("wait");
    expect(await controller.addDirectories([extra])).toBe(false);
    controller.cancel();
    await turn;
    expect(await controller.addDirectories([extra, "missing"])).toBe(false);
    expect(workspace.extraRoots).toEqual([]);
    controller.dispose();
    const session = createSession();
    session.setExtraRoots = () => { throw new Error("storage full"); };
    const failing = controllerFor(workspace, [], session).controller;
    expect(await failing.addDirectories([extra])).toBe(false);
    expect(workspace.extraRoots).toEqual([]);
    expect(failing.describeConfig()).toContain("Attached roots: none");
    failing.dispose();
  });
});

test("unavailable saved roots stay durable while usable primary and newly attached context continue", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const missing = await makeDir(join(dir, "missing"));
    const valid = await makeDir(join(dir, "valid"));
    const directory = join(dir, "sessions");
    const session = await createJsonlSession({ directory, workspace: { root, launchCwd: root, extraRoots: [missing] } });
    await rm(missing, { recursive: true });
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    const restored = await restoreWorkspace({ root, launchCwd: root, extraRoots: [...resumed.metadata.extraRoots] });
    expect(restored.diagnostics.join()).toContain("Saved attachment unavailable");
    expect(restored.workspace).toEqual({ root, launchCwd: root, extraRoots: [] });
    const { controller } = controllerFor(restored.workspace, [], resumed);
    expect(controller.describeConfig()).toContain(`Unavailable saved roots: ${missing}`);
    expect(await controller.addDirectories([valid])).toBe(true);
    expect(resumed.metadata.extraRoots).toEqual([missing, valid]);
    const prepared = await createContextManager(restored.workspace).prepare(resumed);
    expect(prepared.context[0]?.content).not.toContain(missing);
    await mkdir(missing);
    expect(await controller.addDirectories([missing])).toBe(true);
    expect(controller.workspaceIdentity()?.extraRoots).toEqual([valid, missing]);
    controller.dispose();
  });
});

test("v1 upgrades append metadata without changing headers, records or conversation ancestry", async () => {
  await withTempDir(async directory => {
    const header = { type: "session", version: 1, id: "legacy", createdAt: "2026-01-01", workspaceRoot: directory, launchCwd: directory, extraRoots: [] };
    const user = { type: "user", id: "u1", content: [{ type: "text", text: "old" }], parentId: "legacy" };
    const prefix = `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`;
    const path = join(directory, "legacy.jsonl");
    await writeFile(path, prefix);
    const loaded = await loadJsonlSession({ directory, id: "legacy" });
    loaded.setExtraRoots(["/saved/extra"]);
    loaded.append({ type: "user", id: "u2", content: [{ type: "text", text: "new" }] });
    const text = await readFile(path, "utf8");
    expect(text.startsWith(prefix)).toBe(true);
    const records = text.trim().split("\n").map(line => JSON.parse(line));
    expect(records[2]).toEqual({ type: "session_format", version: 2 });
    expect(records[4].parentId).toBe("u1");
    const resumed = await loadJsonlSession({ directory, id: "legacy" });
    expect(resumed.metadata.extraRoots).toEqual(["/saved/extra"]);
    expect(resumed.items.map(item => item.id)).toEqual(["u1", "u2"]);
    resumed.setExtraRoots(["/saved/extra", "/saved/another"]);
    expect((await readFile(path, "utf8")).match(/session_format/g)).toHaveLength(1);
  });
});

test.each(["", '{"type":"workspace_roots","version":1,"extraRoots":['])
  ("upgrade-only and truncated metadata crashes preserve prior roots and allow recovery (%s)", async tail => {
    await withTempDir(async directory => {
      const header = { type: "session", version: 1, id: "legacy", createdAt: "2026-01-01", workspaceRoot: directory, launchCwd: directory, extraRoots: ["/old"] };
      const prefix = `${JSON.stringify(header)}\n${JSON.stringify({ type: "session_format", version: 2 })}\n`;
      const path = join(directory, "legacy.jsonl");
      await writeFile(path, prefix + tail);
      const loaded = await loadJsonlSession({ directory, id: "legacy" });
      expect(loaded.metadata.extraRoots).toEqual(["/old"]);
      expect(await readFile(path, "utf8")).toBe(prefix);
      loaded.setExtraRoots(["/old", "/new"]);
      expect((await loadJsonlSession({ directory, id: "legacy" })).metadata.extraRoots).toEqual(["/old", "/new"]);
      expect((await readFile(path, "utf8")).match(/session_format/g)).toHaveLength(1);
    });
  });

test.each([{ type: "session_format", version: 99 }, { type: "workspace_roots", version: 99, extraRoots: [] }])
  ("unknown semantic metadata versions fail without truncating saved history (%j)", async record => {
    await withTempDir(async directory => {
      const session = await createJsonlSession({ directory, workspace: { root: directory, launchCwd: directory, extraRoots: [] } });
      const path = join(directory, `${session.header.id}.jsonl`);
      await appendFile(path, `${JSON.stringify(record)}\n`);
      const text = await readFile(path, "utf8");
      await expect(loadJsonlSession({ directory, id: session.header.id })).rejects.toThrow(/Unsupported/);
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });

test("headless CLI validates attachment batches before model calls and preserves resumed roots and primary identity", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    const home = await makeDir(join(dir, "home"));
    const directory = join(home, ".schway", "sessions");
    const session = await createJsonlSession({ directory, workspace: { root, launchCwd: root, extraRoots: [] } });
    await skill(extra, "helper");
    const outputs: string[] = [];
    let captured: ModelRequest | undefined;
    const io = { cwd: home, env: { HOME: home }, stdout: { write(text: string) { outputs.push(text); } }, stderr: { write(text: string) { outputs.push(text); } }, model: createScriptedModel({ responses: [request => { captured = request; return { text: "done" }; }] }) };
    expect(await runCli(["--resume", session.header.id, "--add-dir", "../extra", "--add-dir", "missing", "-p", "fail"], io)).toBe(1);
    expect(captured).toBeUndefined();
    expect((await loadJsonlSession({ directory, id: session.header.id })).metadata.extraRoots).toEqual([]);
    expect(await runCli(["--resume", session.header.id, "--add-dir", "../extra", "--add-dir", "../extra", "-p", "/helper"], io)).toBe(0);
    expect(captured?.context.find(section => section.name === "active-skill")?.content).toContain("ATTACHED_SKILL_BODY");
    expect(captured?.context[0]?.content).toContain(`Workspace root: ${root}`);
    expect((await loadJsonlSession({ directory, id: session.header.id })).metadata.extraRoots).toEqual([extra]);
    await rm(extra, { recursive: true });
    io.model = createScriptedModel({ text: "still usable" });
    expect(await runCli(["--resume", session.header.id, "-p", "continue"], io)).toBe(0);
    expect(outputs.join()).toContain("Saved attachment unavailable");
    expect((await loadJsonlSession({ directory, id: session.header.id })).metadata.extraRoots).toEqual([extra]);
  });
});

test("extension command collision lookup uses attachments added after extension registration", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    await skill(extra, "helper");
    await writeFile(join(root, "extension.ts"), `export default (api) => api.registerCommand({ name: "helper", description: "fixture", execute: () => "SHOULD_NOT_RUN" });`);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const loaded = await loadExtensions({ modules: ["extension.ts"], workspace, tools: createToolRegistry([]), secrets: [] });
    const controller = new TuiController({ session: createSession(), contextManager: createContextManager(workspace), workspace, tools: loaded.tools, extensions: loaded.runtime, sessionId: "fixture", provider: "scripted", modelId: "scripted" });
    await controller.addDirectories([extra]);
    await controller.runExtensionCommand("helper", "");
    const text = controller.snapshot().transcript.map(entry => entry.text).join("\n");
    expect(text).toContain("conflicts with skill");
    expect(text).not.toContain("SHOULD_NOT_RUN");
    controller.dispose();
  });
});


test("new-file instruction scope follows an existing symlink ancestor into the attached project", async () => {
  await withTempDir(async dir => {
    const root = await makeDir(join(dir, "primary"));
    const extra = await makeDir(join(dir, "extra"));
    await writeFile(join(extra, "AGENTS.md"), "EXTRA_WRITE_RULE");
    await makeSymlink(extra, join(root, "alias"));
    const session = createSession([{ type: "assistant", id: "attempt", content: [{ type: "tool_call", id: "write", name: "write", arguments: { path: "alias/new-file", content: "new" } }] }]);
    const prepared = await createContextManager({ root, launchCwd: root, extraRoots: [extra] }).prepare(session);
    expect(prepared.context.find(section => section.name === "project-instructions")?.content).toContain("EXTRA_WRITE_RULE");
  });
});

test("session replacement fences pending attachment validation from both sessions", async () => {
  await withTempDir(async root => {
    const extra = await makeDir(join(root, "extra"));
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const { controller, session } = controllerFor(workspace);
    const pending = controller.addDirectories([extra]);
    const replacement = createSession();
    const nextWorkspace = { root, launchCwd: root, extraRoots: [] };
    controller.replaceSession(replacement, "replacement", { workspace: nextWorkspace, contextManager: createContextManager(nextWorkspace) });
    expect(await pending).toBe(false);
    expect(session.metadata.extraRoots).toEqual([]);
    expect(replacement.metadata.extraRoots).toEqual([]);
    expect(controller.workspaceIdentity()?.extraRoots).toEqual([]);
    controller.dispose();
  });
});
