import { expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { formatLocalDate } from "../src/context/date-section.ts";
import { createContextManager } from "../src/context/manager.ts";
import { hasBuiltinWebFetch, STABLE_SYSTEM_PROMPT, WEB_LOOKUP_GUIDANCE } from "../src/context/prompt.ts";
import type { Model, ModelRequest } from "../src/model/model.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { buildResponsesRequest } from "../src/model/providers/responses-stream.ts";
import { createSession } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { writeTool } from "../src/tools/write.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const at = (iso: string) => Date.parse(iso);

test("local date names the calendar day, weekday, zone and offset for each zone at the same instant", () => {
  const instant = at("2026-06-14T23:30:00Z");
  expect(formatLocalDate({ epochMs: instant, timeZone: "Europe/Berlin" }))
    .toBe("Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)");
  expect(formatLocalDate({ epochMs: instant, timeZone: "America/Los_Angeles" }))
    .toBe("Current date: 2026-06-14 (Sunday)\nTime zone: America/Los_Angeles (UTC-07:00)");
  expect(formatLocalDate({ epochMs: instant, timeZone: "Asia/Kathmandu" }))
    .toBe("Current date: 2026-06-15 (Monday)\nTime zone: Asia/Kathmandu (UTC+05:45)");
  expect(formatLocalDate({ epochMs: instant, timeZone: "UTC" }))
    .toBe("Current date: 2026-06-14 (Sunday)\nTime zone: UTC (UTC+00:00)");
});

test("both sides of a DST change keep the date and report the offset in effect", () => {
  const before = formatLocalDate({ epochMs: at("2026-03-29T00:30:00Z"), timeZone: "Europe/Berlin" });
  const after = formatLocalDate({ epochMs: at("2026-03-29T10:00:00Z"), timeZone: "Europe/Berlin" });
  expect(before).toBe("Current date: 2026-03-29 (Sunday)\nTime zone: Europe/Berlin (UTC+01:00)");
  expect(after).toBe("Current date: 2026-03-29 (Sunday)\nTime zone: Europe/Berlin (UTC+02:00)");
  expect(formatLocalDate({ epochMs: at("2026-11-01T05:30:00Z"), timeZone: "America/New_York" }))
    .toBe("Current date: 2026-11-01 (Sunday)\nTime zone: America/New_York (UTC-04:00)");
  expect(formatLocalDate({ epochMs: at("2026-11-01T06:30:00Z"), timeZone: "America/New_York" }))
    .toBe("Current date: 2026-11-01 (Sunday)\nTime zone: America/New_York (UTC-05:00)");
});

test("an unresolvable zone falls back to the host UTC offset without dropping the date", () => {
  const instant = at("2026-06-14T20:00:00Z");
  expect(formatLocalDate({ epochMs: instant, timeZone: "Not/A_Zone", hostOffsetMinutes: () => 330 }))
    .toBe("Current date: 2026-06-15 (Monday)\nTime zone: UTC+05:30");
  expect(formatLocalDate({ epochMs: instant, timeZone: undefined, hostOffsetMinutes: () => -210 }))
    .toBe("Current date: 2026-06-14 (Sunday)\nTime zone: UTC-03:30");
  expect(formatLocalDate({ epochMs: instant, timeZone: "", hostOffsetMinutes: () => 0 }))
    .toBe("Current date: 2026-06-14 (Sunday)\nTime zone: UTC+00:00");
  expect(formatLocalDate({ epochMs: instant, timeZone: undefined, hostOffsetMinutes: () => { throw new Error("no host zone"); } }))
    .toBe("Current date: 2026-06-14 (Sunday)\nTime zone: UTC+00:00");
});

test("the local date never carries a time of day", () => {
  const zones = ["Europe/Berlin", "America/Los_Angeles", "Asia/Kathmandu", "Pacific/Kiritimati", "Not/A_Zone"];
  for (const timeZone of zones) {
    const first = formatLocalDate({ epochMs: at("2026-06-15T12:00:00Z"), timeZone, hostOffsetMinutes: () => 60 });
    const withoutOffset = first.replace(/UTC[+-]\d{2}:\d{2}/g, "");
    expect(withoutOffset).not.toMatch(/\d{1,2}:\d{2}|\b(AM|PM)\b|T\d{2}/);
    expect(first.split("\n")).toHaveLength(2);
  }
  const zone = "Europe/Berlin";
  const startOfDay = formatLocalDate({ epochMs: at("2026-06-14T22:00:30Z"), timeZone: zone });
  const endOfDay = formatLocalDate({ epochMs: at("2026-06-15T21:59:30Z"), timeZone: zone });
  expect(endOfDay).toBe(startOfDay);
});

test("a non-finite instant still yields a well-formed date", () => {
  expect(formatLocalDate({ epochMs: Number.NaN, timeZone: "Europe/Berlin" }))
    .toMatch(/^Current date: \d{4}-\d{2}-\d{2} \(\w+day\)\nTime zone: Europe\/Berlin \(UTC\+0[12]:00\)$/);
});

const CORE_TOOLS = [readTool, writeTool, editTool, bashTool, grepTool, findTool, lsTool];

/** Stand-in for the built-in web_fetch definition until the real tool lands. */
const WEB_FETCH_STUB: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch one web page or API response.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  execution: "parallel",
  effect: "read-only",
  async execute() { return { content: "" }; },
};

test("the web-lookup line is added only when the built-in registry has web_fetch", async () => {
  await withTempDir(async dir => {
    const workspace = await resolveWorkspace(dir);
    const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "weather tomorrow?" }] }]);
    const builtins = createToolRegistry([...CORE_TOOLS, WEB_FETCH_STUB]);
    expect(hasBuiltinWebFetch(builtins.definitions())).toBe(true);
    const withTool = await createContextManager(workspace, { home: join(dir, "home"), webLookupGuidance: hasBuiltinWebFetch(builtins.definitions()) }).prepare(session);
    expect(withTool.systemPrompt).toBe(`${STABLE_SYSTEM_PROMPT}\n${WEB_LOOKUP_GUIDANCE}`);
    expect(withTool.systemPrompt.split("\n").filter(line => line.includes("web_fetch"))).toEqual([WEB_LOOKUP_GUIDANCE]);
    expect(WEB_LOOKUP_GUIDANCE).toContain("not curl against search-engine result pages");

    const coreOnly = createToolRegistry(CORE_TOOLS);
    expect(hasBuiltinWebFetch(coreOnly.definitions())).toBe(false);
    const withoutTool = await createContextManager(workspace, { home: join(dir, "home"), webLookupGuidance: hasBuiltinWebFetch(coreOnly.definitions()) }).prepare(session);
    expect(withoutTool.systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
    expect((await createContextManager(workspace).prepare(session)).systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
  });
});

test("SYSTEM.md replaces the base prompt including the web-lookup line, and APPEND_SYSTEM.md still follows", async () => {
  await withTempDir(async dir => {
    const workspace = await resolveWorkspace(dir);
    const home = join(dir, "home");
    const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "hi" }] }]);
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/APPEND_SYSTEM.md"), "Appended rule.\n");
    const appended = await createContextManager(workspace, { home, webLookupGuidance: true }).prepare(session);
    expect(appended.systemPrompt).toBe(`${STABLE_SYSTEM_PROMPT}\n${WEB_LOOKUP_GUIDANCE}\n\nAppended rule.`);
    await writeFile(join(home, ".schway/SYSTEM.md"), "Custom base.\n");
    const replaced = await createContextManager(workspace, { home, webLookupGuidance: true }).prepare(session);
    expect(replaced.systemPrompt).toBe("Custom base.\n\nAppended rule.");
    expect(replaced.systemPrompt).not.toContain("web_fetch");
  });
});

/** Chat Completions SSE chunk for the protocol fixture. */
function chatChunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: "grok-fixture", choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** One SSE response: a probe tool call for `round`, or final text when `round` is undefined. */
function chatResponse(round: number | undefined): Response {
  const chunks = round === undefined
    ? [chatChunk({ role: "assistant", content: "Done." }), chatChunk({}, "stop")]
    : [
      chatChunk({ role: "assistant", content: "" }),
      chatChunk({ tool_calls: [{ index: 0, id: `call_probe${round}`, type: "function", function: { name: "probe", arguments: `{"n":${round}}` } }] }),
      chatChunk({}, "tool_calls"),
    ];
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const PROBE_TOOL: ToolDefinition = {
  name: "probe",
  description: "Return a fixed probe result.",
  inputSchema: { type: "object", properties: { n: { type: "number" } } },
  execution: "parallel",
  effect: "read-only",
  async execute(input) { return { content: `probe ${(input as { n: number }).n}` }; },
};

/**
 * Run scripted user turns through the real loop and Chat Completions adapter, recording native requests
 * and wire bodies. The clock advances by `stepMs` on every provider request.
 */
async function runTurns(dir: string, turns: Array<{ start: number; toolRounds: number }>, stepMs: number) {
  const workspace = await resolveWorkspace(dir);
  let now = turns[0]!.start;
  const contextManager = createContextManager(workspace, { home: join(dir, "home"), clock: { now: () => now }, timeZone: "Europe/Berlin" });
  const script: Array<number | undefined> = [];
  for (const turn of turns) {
    for (let round = 1; round <= turn.toolRounds; round++) script.push(script.length + 1);
    script.push(undefined);
  }
  const chatBodies: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
  const inner = createOpenAICompatibleModel({
    baseUrl: "http://fixture.invalid/v1", model: "grok-fixture", auth: "none",
    fetch: async (_url, init) => {
      chatBodies.push(JSON.parse(String(init?.body)));
      now += stepMs;
      return chatResponse(script[chatBodies.length - 1]);
    },
  });
  const requests: ModelRequest[] = [];
  const turnOf: number[] = [];
  let currentTurn = 0;
  const model: Model = { provider: inner.provider, id: inner.id, stream(request) { requests.push(request); turnOf.push(currentTurn); return inner.stream(request); } };
  const session = createSession();
  for (const [index, turn] of turns.entries()) {
    currentTurn = index;
    if (index > 0) now = turn.start;
    session.append({ type: "user", id: `u${index}`, content: [{ type: "text", text: `question ${index}` }] });
    const events = await collect(runAgentLoop({ session, model, contextManager, workspace, tools: createToolRegistry([PROBE_TOOL]) }));
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  }
  const responses = requests.map(request => buildResponsesRequest({ model: "grok-4.7", maxOutputTokens: 8192, request, namespace: "xai" }));
  return { requests, turnOf, chatBodies, responses, session };
}

/** Assert that `next` strictly extends `previous` as JSON values. */
function expectStrictExtension(previous: readonly unknown[], next: readonly unknown[]) {
  expect(next.length).toBeGreaterThan(previous.length);
  expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
}

test("instructions, system message and tools stay byte-identical across rounds and same-day turns", async () => {
  await withTempDir(async dir => {
    const { requests, chatBodies, responses } = await runTurns(dir, [
      { start: Date.parse("2026-06-15T06:00:00Z"), toolRounds: 3 },
      { start: Date.parse("2026-06-15T15:00:00Z"), toolRounds: 1 },
    ], 47 * 60_000);
    expect(requests).toHaveLength(6);
    expect(chatBodies).toHaveLength(6);
    expect(requests[0]!.context.at(-1)).toEqual({ name: "schway-local-date", content: "Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)" });
    for (let i = 1; i < requests.length; i++) {
      expect(responses[i]!.instructions).toBe(responses[0]!.instructions);
      expect(JSON.stringify(responses[i]!.tools)).toBe(JSON.stringify(responses[0]!.tools));
      expectStrictExtension(responses[i - 1]!.input, responses[i]!.input);
      const [system, ...messages] = chatBodies[i]!.messages;
      const [firstSystem] = chatBodies[0]!.messages;
      expect(JSON.stringify(system)).toBe(JSON.stringify(firstSystem));
      expect(JSON.stringify(chatBodies[i]!.tools)).toBe(JSON.stringify(chatBodies[0]!.tools));
      expectStrictExtension(chatBodies[i - 1]!.messages.slice(1), messages);
    }
  });
});

test("a turn that crosses local midnight keeps its start date, and the next turn changes only the date section", async () => {
  await withTempDir(async dir => {
    const { requests, turnOf, chatBodies, responses } = await runTurns(dir, [
      { start: Date.parse("2026-06-15T21:30:00Z"), toolRounds: 3 }, // 23:30 Monday in Berlin
      { start: Date.parse("2026-06-15T22:45:00Z"), toolRounds: 0 }, // 00:45 Tuesday in Berlin
    ], 20 * 60_000);
    const dates = requests.map(request => request.context.find(section => section.name === "schway-local-date")!.content);
    const monday = "Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)";
    const tuesday = "Current date: 2026-06-16 (Tuesday)\nTime zone: Europe/Berlin (UTC+02:00)";
    expect(turnOf).toEqual([0, 0, 0, 0, 1]);
    expect(dates).toEqual([monday, monday, monday, monday, tuesday]);
    for (let i = 1; i < 4; i++) {
      expect(responses[i]!.instructions).toBe(responses[0]!.instructions);
      expect(JSON.stringify(chatBodies[i]!.messages[0])).toBe(JSON.stringify(chatBodies[0]!.messages[0]));
    }
    const next = requests[4]!;
    expect(next.systemPrompt).toBe(requests[0]!.systemPrompt);
    expect(next.context.slice(0, -1)).toEqual(requests[0]!.context.slice(0, -1));
    const marker = "<schway-local-date>";
    const before = responses[0]!.instructions, after = responses[4]!.instructions;
    expect(after.slice(0, after.indexOf(marker))).toBe(before.slice(0, before.indexOf(marker)));
    expect(after).not.toBe(before);
    expect(after.endsWith(`${marker}\n${tuesday}\n</schway-local-date>`)).toBe(true);
  });
});

test("headless runs send the local date without loading the TUI, never persist it, and steer to the built-in web_fetch", async () => {
  await withTempDir(async root => {
    const source = join(import.meta.dir, "../src");
    const home = join(root, "home"), work = join(root, "work");
    await mkdir(work, { recursive: true });
    const extension = join(root, "web-fetch-extension.ts");
    await writeFile(extension, `export default ctx => ctx.registerTool({ name: "web_fetch", description: "Extension fetch", inputSchema: { type: "object" }, execution: "parallel", effect: "read-only", execute: async () => ({ content: "" }) });`);
    const script = `
      const { runCli } = await import(${JSON.stringify(join(source, "cli/main.ts"))});
      const { createScriptedModel } = await import(${JSON.stringify(join(import.meta.dir, "helpers/scripted-model.ts"))});
      const { fakeCredentialStore } = await import(${JSON.stringify(join(import.meta.dir, "helpers/credential-store.ts"))});
      let seen;
      const model = createScriptedModel({ responses: [request => { seen = { systemPrompt: request.systemPrompt, context: request.context, tools: (request.tools ?? []).map(tool => tool.name) }; return { text: "ok" }; }] });
      let out = "", err = "";
      const io = { stdout: { write: chunk => { out += chunk; } }, stderr: { write: chunk => { err += chunk; } },
        env: { HOME: ${JSON.stringify(home)}, OPENAI_API_KEY: "sk-test" }, cwd: ${JSON.stringify(work)}, model, credentialStore: fakeCredentialStore() };
      const code = await runCli(["-p", "weather tomorrow?"], io);
      // web_fetch is built in (#318), so an extension cannot register its own and fails to load.
      let extensionErr = "";
      const extensionCode = await runCli(["-p", "weather tomorrow?", "--extension", ${JSON.stringify(extension)}], { ...io, stderr: { write: chunk => { extensionErr += chunk; } } });
      const tui = Object.keys(require.cache).filter(path => /[\\\\/]src[\\\\/]tui[\\\\/]|@opentui/.test(path));
      console.log(JSON.stringify({ code, err, seen, tui, extensionCode, extensionErr }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: work, env: { PATH: process.env.PATH, HOME: home, TZ: "Asia/Tokyo" }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    const result = JSON.parse(output) as { code: number; err: string; tui: string[]; extensionCode: number; extensionErr: string; seen: { systemPrompt: string; context: Array<{ name: string; content: string }>; tools: string[] } };
    expect(result.code, result.err).toBe(0);
    expect(result.tui).toEqual([]);
    expect(result.seen.tools).toContain("web_fetch");
    expect(result.seen.systemPrompt).toBe(`${STABLE_SYSTEM_PROMPT}\n${WEB_LOOKUP_GUIDANCE}`);
    expect(result.extensionCode).toBe(1);
    expect(result.extensionErr).toContain("Tool already registered: web_fetch");
    expect(result.extensionErr).toContain(basename(extension));
    const date = result.seen.context.at(-1)!;
    expect(date.name).toBe("schway-local-date");
    expect(date.content).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \(\w+day\)\nTime zone: Asia\/Tokyo \(UTC\+09:00\)$/);
    const sessions = join(home, ".schway", "sessions");
    const files = (await readdir(sessions)).filter(name => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const saved = await Bun.file(join(sessions, files[0]!)).text();
    expect(saved).toContain("weather tomorrow?");
    expect(saved).not.toContain("schway-local-date");
    expect(saved).not.toContain("Current date:");
  });
});

test("transport retries and overflow recovery reuse the turn's date across midnight", async () => {
  const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  let now = Date.parse("2026-06-15T21:55:00Z"); // 23:55 Monday in Berlin
  const contextManager = createContextManager(workspace, { keepTurns: 1, clock: { now: () => now }, timeZone: "Europe/Berlin" });
  const history = [];
  for (let i = 0; i < 4; i++) history.push(
    { type: "user" as const, id: `old-u${i}`, content: [{ type: "text" as const, text: `old ${i}` }] },
    { type: "assistant" as const, id: `old-a${i}`, content: [{ type: "text" as const, text: "past" }] },
  );
  const session = createSession([...history, { type: "user", id: "new", content: [{ type: "text", text: "new" }] }]);
  const dates: string[] = [];
  const dateOf = (request: ModelRequest) => request.context.find(section => section.name === "schway-local-date")?.content ?? "none";
  const model = createScriptedModel({ responses: [
    request => { dates.push(dateOf(request)); now += 10 * 60_000; return { error: "busy", status: 503 }; },
    request => { dates.push(dateOf(request)); now += 10 * 60_000; return { error: "context too long", code: "context_length_exceeded", status: 400 }; },
    request => { dates.push(dateOf(request)); return { text: "Coding summary" }; },
    request => { dates.push(dateOf(request)); return { text: "done" }; },
  ] });
  const events = await collect(runAgentLoop({ session, model, contextManager, clock: { now: () => 0, sleep: async () => {} } }));
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  const monday = "Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)";
  expect(dates).toEqual([monday, monday, "none", monday]);
});
