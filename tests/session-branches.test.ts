import { expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { AssistantMessage, SessionRecord, UserMessage } from "../src/conversation/types.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { TuiController } from "../src/tui/controller.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { RESERVED_SKILL_NAMES } from "../src/skills/skills.ts";
import { decodeStoredLine, withIsolatedCliDirs, withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

/** Create a uniquely identified user record with inspectable content. */
function user(id: string): UserMessage { return { type: "user", id, content: [{ type: "text", text: id }] }; }
/** Create a completed assistant reply or a pending call group. */
function assistant(id: string, call?: string): AssistantMessage {
  return { type: "assistant", id, content: call ? [{ type: "tool_call", id: call, name: "read", arguments: { path: "note.txt" } }] : [{ type: "text", text: id }] };
}
/** Bind a filesystem fixture to a canonical primary-root identity. */
function workspace(root: string) { return { root, launchCwd: root, extraRoots: [] as string[] }; }
/** Return only authoritative entry IDs for concise ancestry assertions. */
function ids(session: Session): string[] { return session.items.map(item => item.id); }
/** Serialize one atomic append operation for corruption and crash fixtures. */
function append(branchId: string, parentId: string, item: SessionRecord) {
  return { type: "branch_append", version: 1, branchId, entries: [{ parentId, item }] };
}

test("forks retain siblings, expose complete boundaries, and select exact IDs while labels remain non-selectors", () => {
  const session = createSession([user("A"), assistant("B")], ["/shared"]);
  const branch = session.forkBranch("B", "same label");
  session.append(user("C"), assistant("D"));
  session.selectBranch("main");
  session.append(user("X"), assistant("Y"));
  expect(ids(session)).toEqual(["A", "B", "X", "Y"]);
  session.selectBranch(branch);
  expect(ids(session)).toEqual(["A", "B", "C", "D"]);
  expect(session.entries.map(entry => entry.item.id)).toEqual(["A", "B", "C", "D", "X", "Y"]);
  expect(session.listBranches().find(entry => entry.id === branch)).toMatchObject({ active: true, headId: "D", forkPoints: [session.rootId, "B", "D"] });
  expect(() => session.selectBranch("same label")).toThrow("Unknown branch ID");
  expect(() => session.selectBranch(branch.slice(0, 8))).toThrow("Unknown branch ID");
  expect(() => session.forkBranch("A")).toThrow("complete user-turn boundary");
  expect(() => session.forkBranch("missing")).toThrow("Missing session parent or head");
  expect(session.activeBranchId).toBe(branch);
  const empty = session.forkBranch(session.rootId, "same label");
  expect(session.activeBranchId).toBe(empty);
  expect(session.items).toEqual([]);
  session.setExtraRoots(["/changed"]);
  session.selectBranch("main");
  expect(session.metadata.extraRoots).toEqual(["/changed"]);
});

test("partial call groups and settled results are not terminal user-turn fork boundaries", () => {
  const session = createSession([user("u"), assistant("call", "c")]);
  expect(() => session.forkBranch("call")).toThrow("complete user-turn boundary");
  session.append({ type: "tool_result", id: "r", toolCallId: "c", content: "done", isError: false });
  expect(() => session.forkBranch("r")).toThrow("complete user-turn boundary");
  session.append({ type: "compaction", id: "mid-summary", firstKeptId: "u", summary: "still mid-turn" });
  expect(() => session.forkBranch("mid-summary")).toThrow("complete user-turn boundary");
  session.append(assistant("final"));
  expect(session.forkBranch("final")).not.toBe("main");
});

test("duplicate entry IDs, unmatched results and invalid compaction boundaries reject the whole append before storage", () => {
  let writes = 0;
  const session = createSession([user("u"), assistant("a")], [], { writeOperation() { writes++; } });
  const cases: SessionRecord[][] = [
    [user("")],
    [user("new"), assistant("a")],
    [{ type: "tool_result", id: "r", toolCallId: "missing", content: "bad", isError: false }],
    [{ type: "compaction", id: "s", firstKeptId: "a", summary: "mid-turn" }],
    [{ type: "compaction", id: "s", firstKeptId: "missing", summary: "missing" }],
    [{ type: "compaction", id: "s", firstKeptId: "u", parentCompactionId: "missing", summary: "missing prior" }],
  ];
  for (const records of cases) expect(() => session.append(...records)).toThrow();
  expect(writes).toBe(0);
  expect(ids(session)).toEqual(["u", "a"]);
  expect(() => createSession([user("")])).toThrow("Session entry ID must be nonempty text");
  const failing = createSession([user("u"), assistant("a")], [], { writeOperation() { throw Error("storage unavailable"); } });
  expect(() => failing.forkBranch("a")).toThrow("storage unavailable");
  expect(failing.activeBranchId).toBe("main");
  expect(failing.listBranches()).toHaveLength(1);
});

test("path-local pairing permits historical call ID reuse but never cross-group or duplicate results", () => {
  const result = (id: string): SessionRecord => ({ type: "tool_result", id, toolCallId: "reused", content: "ok", isError: false });
  const session = createSession([user("u"), assistant("a", "reused"), result("r"), assistant("done"), user("next"), assistant("next-call", "reused")]);
  expect(() => session.append(user("too-early"))).toThrow("Unsettled tool calls");
  session.append(result("next-result"));
  expect(() => session.append(result("duplicate"))).toThrow("Unmatched or duplicate");
  const duplicate = assistant("bad");
  duplicate.content = [assistant("unused", "duplicate").content[0]!, assistant("unused", "duplicate").content[0]!];
  expect(() => session.append(duplicate)).toThrow("Ambiguous tool call");
});

test("compaction references cannot retain orphan results, rewind history, or cross sibling summaries", () => {
  const session = createSession([user("u"), assistant("call", "c"),
    { type: "tool_result", id: "r", toolCallId: "c", content: "ok", isError: false }, assistant("a"), user("u2"), assistant("a2")]);
  expect(() => session.append({ type: "compaction", id: "bad", firstKeptId: "r", summary: "orphan" })).toThrow("firstKeptId");
  const sibling = session.forkBranch("a2");
  session.append({ type: "compaction", id: "summary", firstKeptId: "u2", summary: "summarized u" });
  expect(() => session.append({ type: "compaction", id: "rewind", firstKeptId: "u", parentCompactionId: "summary", summary: "rewind" })).toThrow("rewinds");
  session.append(user("sibling-user"), assistant("sibling-final"));
  session.selectBranch("main");
  expect(() => session.append({ type: "compaction", id: "cross", firstKeptId: "u2", parentCompactionId: "summary", summary: "wrong branch" })).toThrow("prior summary");
  expect(() => session.append({ type: "compaction", id: "cross", firstKeptId: "sibling-user", summary: "wrong branch" })).toThrow("firstKeptId");
  expect(() => session.append(user("sibling-user"))).toThrow("Duplicate session entry ID");
  session.selectBranch(sibling);
  expect(session.listBranches().find(branch => branch.id === sibling)?.forkPoints).toContain("summary");
});

for (const shape of ["v1", "v2", "v1-upgraded-v2"] as const) {
  test(`${shape} preserves original bytes, restores one default branch, and migrates append-only`, async () => {
    await withTempDir(async directory => {
      const header = { type: "session", version: shape === "v2" ? 2 : 1, id: "legacy", createdAt: "2026-01-01", workspaceRoot: directory, launchCwd: directory, extraRoots: [] };
      const records: unknown[] = [header, { ...user("u"), parentId: "legacy" }, { ...assistant("a"), parentId: "u" }];
      if (shape === "v1-upgraded-v2") records.push({ type: "session_format", version: 2 }, { type: "workspace_roots", version: 1, extraRoots: ["/saved"] });
      const prefix = records.map(record => " " + JSON.stringify(record) + " ").join("\n\n") + "\n";
      const path = join(directory, "legacy.jsonl");
      await writeFile(path, prefix);
      const loaded = await loadJsonlSession({ directory, id: "legacy" });
      expect(ids(loaded)).toEqual(["u", "a"]);
      expect(loaded.listBranches()).toMatchObject([{ id: "main", headId: "a", active: true }]);
      expect(await readFile(path, "utf8")).toBe(prefix);
      const fork = loaded.forkBranch("a", "new path");
      loaded.append(user("new"), assistant("reply"));
      loaded.setExtraRoots(["/shared"]);
      const text = await readFile(path, "utf8");
      expect(text.startsWith(prefix)).toBe(true);
      expect(text.slice(prefix.length)).toContain('"type":"session_format","version":3');
      const original = await loadJsonlSession({ directory, id: "legacy", branchId: "main" });
      expect(ids(original)).toEqual(["u", "a"]);
      expect(original.metadata.extraRoots).toEqual(["/shared"]);
      expect(ids(await loadJsonlSession({ directory, id: "legacy", branchId: fork }))).toEqual(["u", "a", "new", "reply"]);
    });
  });
}

test("torn final operations retain the previous whole graph; invalid requested branch causes no repair writes", async () => {
  await withTempDir(async directory => {
    const session = await createJsonlSession({ directory, workspace: workspace(directory) });
    session.append(user("u"), assistant("a"));
    const path = join(directory, `${session.header.id}.jsonl`);
    const valid = await readFile(path, "utf8");
    const torn = valid + '{"type":"branch_fork","version":1,"branchId":"half"';
    await writeFile(path, torn);
    await expect(loadJsonlSession({ directory, id: session.header.id, branchId: "missing" })).rejects.toThrow("Unknown branch ID");
    expect(await readFile(path, "utf8")).toBe(torn);
    const loaded = await loadJsonlSession({ directory, id: session.header.id });
    expect(ids(loaded)).toEqual(["u", "a"]);
    expect(loaded.listBranches()).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(valid);
    expect(() => loaded.append(user(""))).toThrow("Session entry ID must be nonempty text");
    expect(loaded.listBranches()[0]?.headId).toBe("a");
    // Serialization fails before appending a partial batch or publishing any head.
    const bad = assistant("bad", "bad-call");
    if (bad.content[0]?.type === "tool_call") bad.content[0].arguments = { invalid: 1n };
    expect(() => loaded.append(bad)).toThrow();
    expect(await readFile(path, "utf8")).toBe(valid);
    expect(ids(loaded)).toEqual(["u", "a"]);
  });
});

test("failed disk writes fence every subsequent mutation until the session is reloaded", async () => {
  await withTempDir(async directory => {
    const session = await createJsonlSession({ directory, workspace: workspace(directory) });
    session.append(user("u"), assistant("a"));
    const path = join(directory, `${session.header.id}.jsonl`);
    const backup = `${path}.saved`;
    const valid = await readFile(path, "utf8");
    await rename(path, backup);
    await mkdir(path);
    expect(() => session.append(user("failed"))).toThrow();
    expect(ids(session)).toEqual(["u", "a"]);
    await rm(path, { recursive: true });
    await rename(backup, path);
    expect(() => session.append(user("retry"))).toThrow("reload");
    expect(() => session.forkBranch("a")).toThrow("reload");
    expect(() => session.setExtraRoots(["/changed"])).toThrow("reload");
    expect(session.metadata.extraRoots).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(valid);
    const reloaded = await loadJsonlSession({ directory, id: session.header.id });
    reloaded.append(user("retry"), assistant("ok"));
    expect(ids(await loadJsonlSession({ directory, id: session.header.id }))).toEqual(["u", "a", "retry", "ok"]);
  });
});

test("an interrupted append after a legacy upgrade retains its prior bytes and never repeats the marker", async () => {
  await withTempDir(async directory => {
    for (const version of [1, 2]) {
      const id = `legacy-${version}`;
      const records = [{ type: "session", version, id, createdAt: "2026-01-01", workspaceRoot: directory, launchCwd: directory, extraRoots: [] },
        { ...user("u"), parentId: id }, { ...assistant("a"), parentId: "u" }, { type: "session_format", version: 3 }];
      const prefix = records.map(record => JSON.stringify(record)).join("\n") + "\n";
      const path = join(directory, `${id}.jsonl`);
      await writeFile(path, prefix + '{"type":"branch_append","version":1,"branchId":"main","entries":[');
      const loaded = await loadJsonlSession({ directory, id });
      expect(ids(loaded)).toEqual(["u", "a"]);
      expect(await readFile(path, "utf8")).toBe(prefix);
      loaded.append(user("next"), assistant("done"));
      const text = await readFile(path, "utf8");
      expect(text.startsWith(prefix)).toBe(true);
      expect(text.match(/"type":"session_format"/g)).toHaveLength(1);
      expect(ids(await loadJsonlSession({ directory, id }))).toEqual(["u", "a", "next", "done"]);
    }
  });
});

test("interior corruption cannot be bypassed by selecting a different branch", async () => {
  await withTempDir(async directory => {
    const session = await createJsonlSession({ directory, workspace: workspace(directory) });
    session.append(user("u"), assistant("a"));
    const sibling = session.forkBranch("a");
    const path = join(directory, `${session.header.id}.jsonl`);
    const prefix = await readFile(path, "utf8");
    const select = JSON.stringify({ type: "branch_select", version: 1, branchId: "main", settlements: [] });
    for (const damaged of ['{"torn":', JSON.stringify(append(sibling, "missing", user("bad")))]) {
      const text = prefix + damaged + "\n" + select + "\n";
      await writeFile(path, text);
      await expect(loadJsonlSession({ directory, id: session.header.id, branchId: "main" })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});

for (const malformed of [
  append("main", "missing", user("later")),
  append("main", "a", user("u")),
  append("main", "cycle", user("cycle")),
  { type: "branch_fork", version: 1, branchId: "bad-head", headId: "missing" },
  { type: "branch_fork", version: 1, branchId: "main", headId: "a" },
  { type: "branch_select", version: 1, branchId: "missing", settlements: [] },
  append("main", "a", { type: "tool_result", id: "bad-result", toolCallId: "absent", content: "bad", isError: false }),
  append("main", "a", { type: "compaction", id: "bad-summary", firstKeptId: "a", summary: "orphan" }),
  append("main", "a", { type: "compaction", id: "bad-summary", firstKeptId: "u", parentCompactionId: "", summary: "invalid reference" }),
  { type: "session_format", version: 2 },
  { type: "session_format", version: 3 },
  { type: "session_format", version: 99 },
]) {
  test(`semantic corruption remains an error even in the final line: ${JSON.stringify(malformed)}`, async () => {
    await withTempDir(async directory => {
      const session = await createJsonlSession({ directory, workspace: workspace(directory) });
      session.append(user("u"), assistant("a"));
      const path = join(directory, `${session.header.id}.jsonl`);
      const corrupt = await readFile(path, "utf8") + JSON.stringify(malformed) + "\n";
      await writeFile(path, corrupt);
      await expect(loadJsonlSession({ directory, id: session.header.id })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(corrupt);
    });
  });
}

test("resume and switching settle only the selected branch, even when siblings reuse the same call ID", async () => {
  await withTempDir(async directory => {
    const session = await createJsonlSession({ directory, workspace: workspace(directory) });
    session.append(user("u"), assistant("a"));
    const sibling = session.forkBranch("a");
    session.append(user("sibling-user"), assistant("sibling-call", "same-call"));
    session.selectBranch("main");
    session.append(user("main-user"), assistant("main-call", "same-call"));
    const loaded = await loadJsonlSession({ directory, id: session.header.id, branchId: "main" });
    expect(loaded.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    expect(loaded.entries.filter(entry => entry.item.type === "tool_result")).toHaveLength(1);
    const path = join(directory, `${session.header.id}.jsonl`);
    const mainResults = (await readFile(path, "utf8")).trimEnd().split("\n").flatMap(decodeStoredLine).filter(item => item.type === "tool_result");
    expect(mainResults).toMatchObject([{ parentId: "main-call", toolCallId: "same-call", isError: true }]);
    loaded.selectBranch(sibling);
    expect(loaded.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    expect(loaded.entries.filter(entry => entry.item.type === "tool_result")).toHaveLength(2);
    const repeated = await loadJsonlSession({ directory, id: session.header.id, branchId: sibling });
    expect(repeated.entries.filter(entry => entry.item.type === "tool_result")).toHaveLength(2);
    const allResults = (await readFile(path, "utf8")).trimEnd().split("\n").flatMap(decodeStoredLine).filter(item => item.type === "tool_result");
    expect(allResults).toMatchObject([
      { parentId: "main-call", toolCallId: "same-call", isError: true },
      { parentId: "sibling-call", toolCallId: "same-call", isError: true },
    ]);
    expect(await Bun.file(join(directory, "note.txt")).exists()).toBe(false);
  });
});

test("real divergent file-reading loops and compaction reload only selected ancestry without replaying a non-idempotent tool", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const directory = join(home, ".schway/sessions");
    const ws = workspace(work);
    const session = await createJsonlSession({ directory, workspace: ws });
    let executions = 0;
    const once: ToolDefinition = { name: "increment", description: "Increment once", inputSchema: { type: "object" }, execution: "exclusive",
      execute: async () => { executions++; return { content: String(executions) }; } };
    const tools = createToolRegistry([once, readTool]);
    const manager = createContextManager(ws, { home, keepTurns: 1 });
    session.append(user("A"));
    await collect(runAgentLoop({ session, workspace: ws, contextManager: manager, tools,
      model: createScriptedModel({ responses: [{ toolCalls: [{ id: "once", name: "increment", arguments: {} }] }, { message: assistant("B") }] }) }));
    const branch = session.forkBranch("B", "C path");
    await Bun.write(join(work, "note.txt"), "C branch file content");
    session.append(user("C"));
    await collect(runAgentLoop({ session, workspace: ws, contextManager: manager, tools,
      model: createScriptedModel({ responses: [request => {
        expect(request.items.some(item => item.id === "B")).toBe(true);
        return { toolCalls: [{ id: "read-c", name: "read", arguments: { path: "note.txt" } }] };
      }, request => { expect(JSON.stringify(request.items)).toContain("C branch file content"); return { message: assistant("C-done") }; }] }) }));
    session.append(user("D"), assistant("D-done"));
    const compacted = await manager.compact(session, createScriptedModel({ responses: [request => {
      expect(JSON.stringify(request.items)).toContain("Tool call increment");
      expect(JSON.stringify(request.items)).toContain("C branch file content");
      return { text: "C PATH SUMMARY: C branch file content" };
    }] }), { reason: "manual" });
    expect(compacted).not.toBeNull();
    session.selectBranch("main");
    await Bun.write(join(work, "note.txt"), "X branch file content");
    session.append(user("X"));
    await collect(runAgentLoop({ session, workspace: ws, contextManager: manager, tools,
      model: createScriptedModel({ responses: [request => {
        expect(request.items.some(item => item.id === "B")).toBe(true);
        expect(JSON.stringify(request)).not.toContain("C branch");
        expect(JSON.stringify(request)).not.toContain("C PATH SUMMARY");
        return { toolCalls: [{ id: "read-x", name: "read", arguments: { path: "note.txt" } }] };
      }, request => { expect(JSON.stringify(request.items)).toContain("X branch file content"); return { message: assistant("X-done") }; }] }) }));
    expect(executions).toBe(1);
    for (const [id, expected, excluded] of [[branch, "C branch file content", "X branch file content"], ["main", "X branch file content", "C branch file content"]]) {
      const loaded = await loadJsonlSession({ directory, id: session.header.id, branchId: id });
      const prepared = await manager.prepare(loaded);
      expect(JSON.stringify(prepared)).toContain(expected);
      expect(JSON.stringify(prepared)).not.toContain(excluded);
      expect(prepared.context.some(section => section.content.startsWith("C PATH SUMMARY"))).toBe(id === branch);
    }
    expect(executions).toBe(1);
    expect(await Bun.file(join(work, "note.txt")).text()).toBe("X branch file content");
  });
});

test("loop and compaction leases prevent branch switches through cancellation and release after settling", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const session = createSession([user("u"), assistant("a"), user("u2"), assistant("a2")]);
    const sibling = session.forkBranch("a");
    session.selectBranch("main");
    const manager = createContextManager(workspace(work), { home, keepTurns: 1 });
    const abort = new AbortController();
    const running = collect(runAgentLoop({ session, contextManager: manager, model: createScriptedModel({ waitForAbort: true }), signal: abort.signal }));
    expect(() => session.selectBranch(sibling)).toThrow("busy");
    abort.abort();
    await running;
    expect(session.busy).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled = new AbortController();
    const compacting = manager.compact(session, { provider: "fixture", id: "fixture", async *stream() {
      await gate;
      yield { type: "message_complete", message: assistant("late-summary") };
    } }, { reason: "manual", signal: cancelled.signal });
    expect(() => session.forkBranch("a")).toThrow("busy");
    cancelled.abort();
    release();
    expect(await compacting).toBeNull();
    expect(session.items.some(item => item.type === "compaction")).toBe(false);
    session.selectBranch(sibling);
    expect(session.activeBranchId).toBe(sibling);
  });
});

test("an accepted running tool holds the branch lease through abort until its one result is persisted", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const ws = workspace(work);
    const directory = join(home, ".schway/sessions");
    const session = await createJsonlSession({ directory, workspace: ws });
    session.append(user("u"), assistant("a"));
    const sibling = session.forkBranch("a");
    session.selectBranch("main");
    session.append(user("tool-turn"));
    let started!: () => void;
    const accepted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let executions = 0;
    const slow: ToolDefinition = { name: "slow", description: "Wait before settling", execution: "exclusive", inputSchema: { type: "object" },
      async execute() { executions++; started(); await gate; return { content: "settled after abort" }; } };
    const abort = new AbortController();
    const running = collect(runAgentLoop({ session, workspace: ws, contextManager: createContextManager(ws, { home }),
      tools: createToolRegistry([slow]), signal: abort.signal,
      model: createScriptedModel({ responses: [{ toolCalls: [{ id: "delayed", name: "slow", arguments: {} }] }] }) }));
    await accepted;
    abort.abort();
    expect(session.busy).toBe(true);
    expect(() => session.selectBranch(sibling)).toThrow("busy");
    expect(() => session.forkBranch("a")).toThrow("busy");
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(0);
    release();
    const events = await running;
    expect(events.at(-1)).toMatchObject({ type: "agent.finished", reason: "cancelled" });
    expect(session.busy).toBe(false);
    const loaded = await loadJsonlSession({ directory, id: session.header.id });
    expect(loaded.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    loaded.selectBranch(sibling);
    expect(loaded.items.filter(item => item.type === "tool_result")).toHaveLength(0);
    expect(executions).toBe(1);
  });
});

test("CLI branch selection and interactive commands use exact saved identities with idle and skill guards", async () => {
  expect(parseArgs(["--branch", "main"])).toEqual({ error: "--branch requires --resume <session-id>" });
  expect(parseArgs(["--resume", "session", "--branch="])).toEqual({ error: "Missing value for --branch" });
  expect(RESERVED_SKILL_NAMES).toContain("branch");
  await withIsolatedCliDirs(async ({ work, home }) => {
    const ws = workspace(work);
    const session = await createJsonlSession({ directory: join(home, ".schway/sessions"), workspace: ws });
    session.append(user("u"), assistant("a"));
    const manager = createContextManager(ws, { home });
    const controller = new TuiController({ session, sessionId: session.header.id, contextManager: manager, workspace: ws, provider: "scripted", modelId: "scripted" });
    await dispatchEditorInput("/branch fork a alternate", controller, async command => controller.branchCommand(command.args));
    const branch = session.activeBranchId;
    session.append(user("only-on-alternate"), assistant("alternate-done"));
    expect(controller.branchCommand("switch main")).toBe(true);
    expect(controller.branchCommand("list")).toBe(true);
    expect(controller.snapshot().transcript.some(entry => entry.text.includes(branch))).toBe(true);
    const release = session.acquireOperation();
    expect(controller.branchCommand(`switch ${branch}`)).toBe(false);
    release();
    manager.setActiveSkill({ name: "temporary", body: "BODY MUST CLEAR", source: "fixture", dir: work, scope: "project" });
    expect(controller.branchCommand(`switch ${branch}`)).toBe(true);
    let interactiveRequests = 0;
    controller.setModel(createScriptedModel({ responses: [request => {
      interactiveRequests++;
      expect(JSON.stringify(request.items)).toContain("only-on-alternate");
      expect(JSON.stringify(request.context)).not.toContain("BODY MUST CLEAR");
      return { text: "interactive continuation" };
    }] }), "scripted", "scripted");
    await controller.submit("Continue interactively");
    expect(interactiveRequests).toBe(1);
    expect(controller.branchCommand("switch main")).toBe(true);
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("interactive continuation"))).toBe(false);
    let requests = 0;
    const status = await runCli(["--resume", session.header.id, "--branch", branch, "-p", "continue"], {
      cwd: work, env: { HOME: home }, stdout: { write() {} }, stderr: { write(text) { throw Error(text); } },
      model: createScriptedModel({ responses: [request => { requests++; expect(JSON.stringify(request.items)).toContain("only-on-alternate"); return { text: "continued" }; }] }),
    });
    expect(status).toBe(0);
    expect(requests).toBe(1);
    controller.dispose();
  });
});

test("branch transcript rebuild pairs reused tool IDs within their chronological call groups", () => {
  const calls = assistant("first-calls", "same");
  calls.content.push({ type: "tool_call", id: "parallel", name: "read", arguments: { path: "other.txt" } });
  const session = createSession([user("u"), calls,
    { type: "tool_result", id: "parallel-result", toolCallId: "parallel", content: "PARALLEL SUCCESS", isError: false },
    { type: "tool_result", id: "first-result", toolCallId: "same", content: "FIRST SUCCESS", isError: false }, assistant("done")]);
  const sibling = session.forkBranch("done");
  session.selectBranch("main");
  session.append(user("next"), assistant("interrupted-call", "same"));
  session.selectBranch(sibling);
  const ws = workspace("/fixture");
  const controller = new TuiController({ session, sessionId: "fixture", workspace: ws,
    contextManager: createContextManager(ws), provider: "scripted", modelId: "scripted" });
  try {
    expect(controller.branchCommand("switch main")).toBe(true);
    const toolRows = controller.snapshot().transcript.filter(entry => entry.kind === "tool");
    expect(toolRows.map(entry => [entry.toolCallId, entry.toolStatus, entry.text])).toEqual([
      ["same", "success", "FIRST SUCCESS"],
      ["parallel", "success", "PARALLEL SUCCESS"],
      ["same", "error", "Tool call interrupted before a result was persisted"],
    ]);
    expect(new Set(toolRows.map(entry => entry.id)).size).toBe(3);
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(3);
    expect(controller.branchCommand(`switch ${sibling}`)).toBe(true);
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "tool").map(entry => entry.text)).toEqual(["FIRST SUCCESS", "PARALLEL SUCCESS"]);
    expect(session.entries.filter(entry => entry.item.type === "tool_result")).toHaveLength(3);
  } finally { controller.dispose(); }
});


test("legacy format 3 upgrades once only when an undo is appended, preserving branches", async () => {
  await withTempDir(async root => {
    const directory = join(root, "sessions");
    const initial = await createJsonlSession({ directory, workspace: workspace(root) });
    const path = join(directory, `${initial.header.id}.jsonl`);
    const header = { ...initial.header, version: 3 };
    const original = JSON.stringify(header) + "\n";
    await writeFile(path, original);
    const session = await loadJsonlSession({ directory, id: header.id });
    expect(await readFile(path, "utf8")).toBe(original);
    session.append(user("legacy-u"), assistant("legacy-a"));
    expect(await readFile(path, "utf8")).not.toContain('"session_format"');
    const branch = session.forkBranch("legacy-a");
    const undo = { type: "turn_undo" as const, id: "undo", turnId: "legacy-u", turnNumber: 1,
      reverted: [{ path: "note.txt", action: "restored" as const }], skipped: [], note: "Undo note" };
    session.append(undo);
    session.append(user("next"), assistant("next-a"));
    const text = await readFile(path, "utf8");
    expect(text.split('"type":"session_format","version":4')).toHaveLength(2);
    expect(text.indexOf('"type":"session_format"')).toBeLessThan(text.indexOf('"type":"turn_undo"'));
    const resumed = await loadJsonlSession({ directory, id: header.id });
    expect(resumed.activeBranchId).toBe(branch);
    expect(resumed.items.find(item => item.id === "undo")).toEqual(undo);
    await writeFile(path, original + JSON.stringify(append("main", header.id, undo)) + "\n");
    await expect(loadJsonlSession({ directory, id: header.id })).rejects.toThrow("Session file contains a malformed record");
    await writeFile(path, JSON.stringify({ ...header, version: 5 }) + "\n");
    await expect(loadJsonlSession({ directory, id: header.id })).rejects.toThrow("Unsupported session format version 5. This Schway build reads versions 1, 2, 3 and 4.");
    await writeFile(path, text + '{"type":"branch_append","entries":[{"item":{"type":"turn_undo"');
    await loadJsonlSession({ directory, id: header.id });
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
