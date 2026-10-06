import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import { createSession } from "../src/session/session.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import type {
  AssistantMessage,
  ConversationItem,
  SessionRecord,
  UserMessage,
} from "../src/conversation/types.ts";
import { withTempDir } from "./helpers.ts";

test("session stores user, assistant, thinking, and tool-call content", () => {
  const session = createSession();
  const user: UserMessage = {
    type: "user",
    id: "u1",
    content: [{ type: "text", text: "look at src/foo.ts" }],
  };
  const assistant: AssistantMessage = {
    type: "assistant",
    id: "a1",
    content: [
      {
        type: "thinking",
        text: "I should read the file",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      { type: "text", text: "Reading it now." },
      {
        type: "tool_call",
        id: "call-1",
        name: "read",
        arguments: { path: "src/foo.ts" },
      },
    ],
    providerMetadata: { anthropic: { stop_reason: "tool_use" } },
  };

  session.append(user);
  session.append(assistant);

  expect(session.items).toEqual([user, assistant]);
  const stored = session.items[1] as AssistantMessage;
  expect(stored.content[0]).toEqual(assistant.content[0]);
  expect(stored.content[2]).toEqual(assistant.content[2]);
});

test("stable system prompt is assembled separately from environment context", async () => {
  const workspace = {
    root: "/tmp/project",
    launchCwd: "/tmp/project/pkg",
    extraRoots: [],
  };
  const session = createSession([
    {
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "hello" }],
    },
  ]);
  const prepared = await createContextManager(workspace, {
    clock: { now: () => Date.parse("2026-06-14T23:30:00Z") },
    timeZone: "Europe/Berlin",
  }).prepare(session);

  expect(prepared.systemPrompt).toBe(STABLE_SYSTEM_PROMPT);
  expect(prepared.systemPrompt.includes("/tmp/project")).toBe(false);
  expect(prepared.context).toEqual([
    {
      name: "environment",
      content: [
        "Workspace root: /tmp/project",
        "Launch directory: /tmp/project/pkg",
      ].join("\n"),
    },
    {
      name: "schway-local-date",
      content: "Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)",
    },
  ]);
  expect(prepared.items).toEqual(session.items as ConversationItem[]);
});

/** Workspace with project instructions and a model-visible skill so every Schway section can appear. */
async function richWorkspace(dir: string) {
  await writeFile(join(dir, "AGENTS.md"), "PROJECT_RULE\n");
  await mkdir(join(dir, ".agents/skills/demo"), { recursive: true });
  await writeFile(join(dir, ".agents/skills/demo/SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSkill body\n");
  return resolveWorkspace(dir);
}

function userItem(id: string, text = id): UserMessage {
  return { type: "user", id, content: [{ type: "text", text }] };
}

const BERLIN = { timeZone: "Europe/Berlin" } as const;

for (const summary of [false, true]) {
  for (const skill of [false, true]) {
    test(`local date is the last Schway section (summary ${summary ? "on" : "off"}, active skill ${skill ? "on" : "off"})`, async () => {
      await withTempDir(async dir => {
        const workspace = await richWorkspace(dir);
        const records: SessionRecord[] = [userItem("u1"), { type: "assistant", id: "a1", content: [{ type: "text", text: "ok" }] }, userItem("u2")];
        if (summary) records.push({ type: "compaction", id: "c1", summary: "Earlier work", firstKeptId: "u2", tokensBefore: 1 });
        const manager = createContextManager(workspace, { home: join(dir, "home"), clock: { now: () => Date.parse("2026-06-15T08:00:00Z") }, ...BERLIN });
        if (skill) manager.setActiveSkill({ name: "demo", body: "Skill body", source: ".agents/skills/demo/SKILL.md", scope: "project", dir });
        const prepared = await manager.prepare(createSession(records));
        expect(prepared.context.map(section => section.name)).toEqual([
          "environment",
          ...(summary ? ["summary"] : []),
          "project-instructions",
          "available-skills",
          ...(skill ? ["active-skill"] : []),
          "schway-local-date",
        ]);
        expect(prepared.context.at(-1)!.content).toBe("Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)");
      });
    });
  }
}

test("a turn keeps the date captured at its start, and the next turn reads the clock again", async () => {
  let now = Date.parse("2026-06-15T21:50:00Z"); // 23:50 in Berlin
  let reads = 0;
  const manager = createContextManager({ root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] }, {
    clock: { now: () => { reads++; return now; } }, ...BERLIN,
  });
  const session = createSession([userItem("u1")]);
  const finish = manager.beginTurn();
  const first = await manager.prepare(session);
  now = Date.parse("2026-06-15T22:10:00Z"); // 00:10 the next day in Berlin
  const second = await manager.prepare(session);
  expect(second.context).toEqual(first.context);
  expect(first.context.at(-1)!.content).toBe("Current date: 2026-06-15 (Monday)\nTime zone: Europe/Berlin (UTC+02:00)");
  expect(reads).toBe(1);
  finish();

  const finishNext = manager.beginTurn();
  const next = await manager.prepare(session);
  finishNext();
  expect(next.context.at(-1)!.content).toBe("Current date: 2026-06-16 (Tuesday)\nTime zone: Europe/Berlin (UTC+02:00)");
  expect(next.context.slice(0, -1)).toEqual(first.context.slice(0, -1));
  expect(next.systemPrompt).toBe(first.systemPrompt);
});

test("a stale turn cleanup cannot clear a later turn's captured date", async () => {
  let now = Date.parse("2026-06-15T10:00:00Z");
  const manager = createContextManager({ root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] }, { clock: { now: () => now }, ...BERLIN });
  const finishFirst = manager.beginTurn();
  manager.beginTurn();
  finishFirst();
  now = Date.parse("2026-06-17T10:00:00Z");
  const prepared = await manager.prepare(createSession([userItem("u1")]));
  expect(prepared.context.at(-1)!.content).toContain("2026-06-15");
});

test("prepare outside a managed turn reads the clock each time", async () => {
  let now = Date.parse("2026-06-15T10:00:00Z");
  const manager = createContextManager({ root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] }, { clock: { now: () => now }, ...BERLIN });
  const session = createSession([userItem("u1")]);
  expect((await manager.prepare(session)).context.at(-1)!.content).toContain("2026-06-15 (Monday)");
  now = Date.parse("2026-06-16T10:00:00Z");
  expect((await manager.prepare(session)).context.at(-1)!.content).toContain("2026-06-16 (Tuesday)");
});

test("default clock and zone, or an unknown zone, still produce a day-granular date", async () => {
  const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  const session = createSession([userItem("u1")]);
  const byDefault = (await createContextManager(workspace).prepare(session)).context.at(-1)!;
  expect(byDefault.name).toBe("schway-local-date");
  expect(byDefault.content).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \((Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\)\nTime zone: (\S+ \()?UTC[+-]\d{2}:\d{2}\)?$/);
  const unknown = (await createContextManager(workspace, { timeZone: "Not/A_Zone", clock: { now: () => Date.parse("2026-06-15T12:00:00Z") } }).prepare(session)).context.at(-1)!;
  expect(unknown.content).toMatch(/^Current date: 2026-06-1[45] \(\w+day\)\nTime zone: UTC[+-]\d{2}:\d{2}$/);
});
