import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContextManager } from "../src/context/manager.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { dispatchEditorInput, helpText, type SlashCommandName } from "../src/tui/commands.ts";
import { BUILT_IN_COMMAND_ORDER, COMMAND_DESCRIPTIONS, commandCatalog, paletteChoices } from "../src/tui/command-catalog.ts";
import { keyboardGuideAvailability } from "../src/tui/palette.ts";
import type { SkillDiscovery } from "../src/skills/skills.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

async function commandFixture(dir: string, body: string, secrets: string[] = [], options: Partial<TuiControllerOptions> = {}) {
  await Bun.write(join(dir, "commands.ts"), body);
  const path = await realpath(join(dir, "commands.ts"));
  const workspace = await resolveWorkspace(dir);
  const home = join(dir, "home");
  const loaded = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry(), secrets, home });
  const module = await import(pathToFileURL(path).href);
  const session = createSession();
  const requests: string[] = [];
  const controller = new TuiController({
    ...loaded, extensions: loaded.runtime, home, workspace, session, sessionId: "commands", secrets,
    provider: "scripted", modelId: "scripted", contextManager: createContextManager(workspace, { home }),
    model: createScriptedModel({ responses: [request => {
      requests.push(...request.items.filter(item => item.type === "user").flatMap(item => item.content.map(block => block.text)));
      return { text: "normal loop response" };
    }] }), ...options,
  });
  return { ...loaded, module, session, requests, controller, path };
}

const noBuiltin = async () => { throw new Error("Unexpected builtin dispatch"); };

test("the curated built-in order covers descriptions and the slash-command union exactly once", () => {
  const coversSlashCommands: Exclude<SlashCommandName, typeof BUILT_IN_COMMAND_ORDER[number]> extends never ? true : false = true;
  expect(coversSlashCommands).toBe(true);
  expect(BUILT_IN_COMMAND_ORDER).toEqual([
    "model", "new", "clear", "sessions", "changes", "undo", "compact", "resume", "branch", "thinking", "context", "skills",
    "add-dir", "config", "theme", "session", "login", "logout", "help", "quit", "delete-session",
  ]);
  expect(Object.keys(COMMAND_DESCRIPTIONS).sort()).toEqual([...BUILT_IN_COMMAND_ORDER].sort());
  expect(new Set(BUILT_IN_COMMAND_ORDER).size).toBe(BUILT_IN_COMMAND_ORDER.length);
  expect(commandCatalog([]).map(entry => entry.name)).toEqual([...BUILT_IN_COMMAND_ORDER]);
  expect(Object.fromEntries(["model", "new", "sessions", "changes", "compact", "delete-session"].map(name => [name, COMMAND_DESCRIPTIONS[name as SlashCommandName]])))
    .toEqual({ model: "Choose model", new: "Start a new conversation", sessions: "Open saved work", changes: "Review changes", compact: "Summarize to free context", "delete-session": "Delete a saved session" });
});

test("catalog groups skills and unavailable entries before extension owners and destructive built-ins", () => {
  const skills: SkillDiscovery = {
    skills: [{ name: "study", description: "Study the plan", scope: "project", userOnly: true, dir: "/skills/study", skillFile: "/skills/study/SKILL.md", displayPath: "study" }],
    collisions: [{ name: "theme", command: "theme", source: "/skills/theme/SKILL.md" }],
    ambiguous: [{ name: "duplicate", sources: ["first", "second"] }],
    diagnostics: [{ source: "invalid-one", reason: "Repair the first skill" }, { source: "invalid-two", reason: "Repair the second skill" }],
  };
  const entries = commandCatalog([
    { name: "greet", description: "Say hello", source: "/modules/arbitrary.ts", packageName: "greeting-pkg" },
    { name: "local", description: "Local action", source: "/modules/local.ts" },
  ], skills);
  expect(entries.map(entry => entry.name)).toEqual([
    ...BUILT_IN_COMMAND_ORDER.slice(0, -1).filter(name => name !== "theme"), "theme", "study", "theme", "duplicate", "unavailable", "unavailable", "greet", "local", "delete-session",
  ]);
  expect(entries.filter(entry => entry.group === "skills").map(entry => entry.name))
    .toEqual(["theme", "study", "theme", "duplicate", "unavailable", "unavailable"]);
  expect(entries.filter(entry => entry.id.startsWith("collision:") || entry.id.startsWith("ambiguous:") || entry.id.startsWith("diagnostic:")).every(entry => entry.insertion === "")).toBe(true);
  expect(entries.filter(entry => entry.id.startsWith("diagnostic:")).map(entry => entry.description))
    .toEqual(["Repair the first skill", "Repair the second skill"]);
  expect(entries.find(entry => entry.id === "builtin:theme")?.available).toBe(false);
  expect(entries.find(entry => entry.name === "study")?.source).toBe("project skill · user-only");
  expect(entries.find(entry => entry.name === "greet")?.provenance).toBe("greeting-pkg");
  expect(entries.find(entry => entry.name === "greet")?.source).toBe("extension /modules/arbitrary.ts");
  expect(entries.find(entry => entry.name === "local")?.provenance).toBe("local.ts");
  expect(entries.filter(entry => entry.destructive).map(entry => entry.name)).toEqual(["delete-session"]);
  expect(entries.at(-1)?.group).toBe("destructive");
  expect(entries.find(entry => entry.name === "logout")?.destructive).toBe(false);
});

test("CLI commands retain their canonical identity and use the module filename as display provenance", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export default ctx => ctx.registerCommand({ name: 'greet', description: 'Say hello', execute() {} });`);
    try {
      const command = fixture.runtime.command("greet")!;
      expect(command.source).toBe(fixture.path);
      expect(command.packageName).toBeUndefined();
      expect(Object.isFrozen(command)).toBe(true);
      expect(commandCatalog([command]).find(entry => entry.name === "greet"))
        .toMatchObject({ id: `extension:${fixture.path}:greet`, provenance: "commands.ts", source: `extension ${fixture.path}` });
    } finally { fixture.controller.dispose(); }
  });
});

test("extension help and editor dispatch preserve raw arguments and submit one ordinary user turn", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export default ctx => {
      ctx.registerCommand({ name: 'ask', description: 'Ask a question', arguments: '<question>',
        execute(args, command) { command.submitPrompt('Question: ' + args); return 'Sending question'; } });
    };`);
    try {
      expect(helpText(fixture.controller.extensionCommands())).toContain(`/ask <question> - Ask a question [extension: ${fixture.path}]`);
      let editor = '/ask "two words"  remaining';
      expect(await dispatchEditorInput(editor, fixture.controller, noBuiltin, () => { editor = ""; })).toBe(true);
      expect(editor).toBe("");
      expect(fixture.requests).toEqual(['Question: "two words"  remaining']);
      expect(fixture.session.items.filter(item => item.type === "user")).toHaveLength(1);
      expect(fixture.controller.snapshot().transcript.map(entry => entry.text)).toEqual([
        "Sending question", 'Question: "two words"  remaining', "normal loop response",
      ]);
    } finally { fixture.controller.dispose(); }
  });
});

test("busy editor commands retain input without invoking their handler", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export let calls = 0; export default ctx => {
      ctx.registerCommand({ name: 'ping', description: 'Ping', execute() { calls++; return 'pong'; } });
    };`);
    fixture.controller.setModel(createScriptedModel({ waitForAbort: true }), "scripted", "waiting");
    const turn = fixture.controller.submit("wait");
    let editor = "/ping keep these arguments";
    expect(await dispatchEditorInput(editor, fixture.controller, noBuiltin, () => { editor = ""; })).toBe(false);
    expect(editor).toBe("/ping keep these arguments");
    expect(fixture.module.calls).toBe(0);
    expect(fixture.controller.snapshot().transcript.at(-1)?.text).toContain("Command not run · Esc stop · /ping retry");
    fixture.controller.cancel();
    await turn;
    expect(await dispatchEditorInput(editor, fixture.controller, noBuiltin)).toBe(true);
    expect(fixture.module.calls).toBe(1);
    fixture.controller.dispose();
  });
});

for (const action of ["cancel", "dispose", "replaceSession"] as const) {
  test(`${action} aborts a hanging command, settles controller ownership, and closes retained prompt capabilities`, async () => {
    await withTempDir(async dir => {
      const fixture = await commandFixture(dir, `let start; export const started = new Promise(resolve => start = resolve);
        export let retained; export let signal; export default ctx => {
          ctx.registerCommand({ name: 'wait', description: 'Wait', execute(args, command) {
            retained = command.submitPrompt; signal = command.signal; start(); return new Promise(() => {});
          } });
          ctx.registerCommand({ name: 'ping', description: 'Ping', execute() { return 'pong'; } });
        };`);
      const command = fixture.controller.runExtensionCommand("wait", "");
      await fixture.module.started;
      expect(fixture.controller.branchCommand(`fork ${fixture.session.rootId}`)).toBe(false);
      expect(fixture.session.listBranches()).toHaveLength(1);
      if (action === "replaceSession") fixture.controller.replaceSession(createSession(), "new");
      else fixture.controller[action]();
      await command;
      await fixture.controller.waitForIdle();
      expect(fixture.module.signal.aborted).toBe(true);
      expect(fixture.controller.running).toBe(false);
      expect(() => fixture.module.retained("too late")).toThrow("closed");
      expect(fixture.requests).toEqual([]);
      if (action === "cancel") {
        expect(fixture.controller.snapshot().transcript.at(-1)?.text).toContain("Cancelled");
        await fixture.controller.runExtensionCommand("ping", "");
        expect(fixture.controller.snapshot().transcript.at(-1)?.text).toBe("pong");
      } else {
        expect(fixture.controller.snapshot().transcript.some(entry => entry.text.includes("Cancelled"))).toBe(false);
      }
      fixture.controller.dispose();
    });
  });
}

test("command failures discard queued prompts, redact and bound diagnostics, and leave a usable editor", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export default ctx => {
      ctx.registerCommand({ name: 'broken', description: 'Broken', execute(args, command) {
        command.submitPrompt('must not run'); throw new Error('private-key ' + 'x'.repeat(60000));
      } });
      ctx.registerCommand({ name: 'large', description: 'Large', execute() { return 'private-key ' + 'x'.repeat(60000); } });
    };`, ["private-key"]);
    await dispatchEditorInput("/broken", fixture.controller, noBuiltin);
    const error = fixture.controller.snapshot().transcript.at(-1)!.text;
    expect(error).toContain(fixture.path);
    expect(error).toContain("/broken");
    expect(error).not.toContain("private-key");
    expect(error.length).toBeLessThanOrEqual(50_000);
    expect(fixture.requests).toEqual([]);
    expect(fixture.controller.running).toBe(false);
    await dispatchEditorInput("/large", fixture.controller, noBuiltin);
    expect(fixture.controller.snapshot().transcript.at(-1)!.text.length).toBeLessThanOrEqual(50_000);
    await dispatchEditorInput("ordinary prompt", fixture.controller, noBuiltin);
    expect(fixture.requests).toEqual(["ordinary prompt"]);
    fixture.controller.dispose();
  });
});

test("command owners collide with built-ins, skills and each other independent of registration order", async () => {
  await withTempDir(async dir => {
    const workspace = await resolveWorkspace(dir);
    const declaration = (name: string) => `export default ctx => ctx.registerCommand({ name: '${name}', description: 'Command', execute() {} });`;
    await Bun.write(join(dir, "core.ts"), declaration("help"));
    await expect(loadExtensions({ modules: ["core.ts"], workspace, tools: createToolRegistry() })).rejects.toThrow("Schway built-in /help");
    await Bun.write(join(dir, "clear.ts"), declaration("clear"));
    await expect(loadExtensions({ modules: ["clear.ts"], workspace, tools: createToolRegistry() })).rejects.toThrow("Schway built-in /clear");
    for (const file of ["first.ts", "second.ts"]) await Bun.write(join(dir, file), declaration("duplicate"));
    for (const modules of [["first.ts", "second.ts"], ["second.ts", "first.ts"]]) {
      const result = loadExtensions({ modules, workspace, tools: createToolRegistry() });
      await expect(result).rejects.toThrow("first.ts");
      await expect(result).rejects.toThrow("second.ts");
    }
    const skill = join(dir, ".agents/skills/duplicate/SKILL.md");
    await mkdir(join(dir, ".agents/skills/duplicate"), { recursive: true });
    await Bun.write(skill, "---\nname: duplicate\ndescription: Existing skill\n---\nDo the task.");
    const result = loadExtensions({ modules: ["first.ts"], workspace, tools: createToolRegistry() });
    await expect(result).rejects.toThrow("first.ts");
    await expect(result).rejects.toThrow("SKILL.md");
  });
});

test("newly discovered skill collisions fail commands after session replacement without selecting a winner", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export let ran = false; export default ctx => {
      ctx.registerCommand({ name: 'same', description: 'Command', execute() { ran = true; } });
    };`);
    await mkdir(join(dir, ".agents/skills/same"), { recursive: true });
    await Bun.write(join(dir, ".agents/skills/same/SKILL.md"), "---\nname: same\ndescription: Newly installed\n---\nTask.");
    fixture.controller.replaceSession(createSession(), "resumed");
    let editor = "/same keep this";
    let accepted = 0;
    expect(await dispatchEditorInput(editor, fixture.controller, noBuiltin, () => { accepted++; editor = ""; })).toBe(false);
    expect(editor).toBe("/same keep this");
    expect(accepted).toBe(0);
    expect(fixture.module.ran).toBe(false);
    expect(fixture.controller.snapshot().transcript.at(-1)?.text).toContain("conflicts with skill");
    expect(fixture.controller.inspectNoticeDetails()).toBe(true);
    expect(fixture.controller.snapshot().transcript.at(-1)?.text).toContain(fixture.path);
    expect(fixture.requests).toEqual([]);
    fixture.controller.dispose();
  });
});

for (const name of ["undefined", "42", "null"]) {
  test(`malformed JavaScript command name ${name} fails atomically even if initializer catches it`, async () => {
    await withTempDir(async dir => {
      const path = join(dir, "malformed.ts");
      await Bun.write(path, `export let disposed = 0; export let signal;
        export default ctx => { signal = ctx.signal; ctx.onDispose(() => { disposed++; });
          ctx.registerTool({ name: 'staged', description: 'Staged', execution: 'parallel', inputSchema: {type: 'object'}, execute() {} });
          try { ctx.registerCommand({ name: ${name}, description: 'Bad', execute() {} }); } catch {}
        };`);
      const tools = createToolRegistry();
      await expect(loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools })).rejects.toThrow("Command name");
      const module = await import(pathToFileURL(await realpath(path)).href);
      expect(tools.definitions()).toEqual([]);
      expect(module.disposed).toBe(1);
      expect(module.signal.aborted).toBe(true);
    });
  });
}


test("unified controller discovery exposes two extensions, user-only skills and collisions without execution", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export let calls = 0; export default ctx => {
      for (const name of ['ping', 'pong']) ctx.registerCommand({ name, description: 'Unicode 日本語', execute() { calls++; } });
    };`);
    try {
      for (const name of ["study", "manual", "theme", "ping"]) {
        await mkdir(join(dir, ".agents/skills", name), { recursive: true });
        await Bun.write(join(dir, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Metadata only\ndisable-model-invocation: ${name === "manual"}\n---\n${"BODY".repeat(100_000)}`);
      }
      await fixture.controller.refreshCommands();
      const choices = fixture.controller.commandChoices("/");
      expect(choices.find(entry => entry.name === "study")?.source).toBe("project skill");
      expect(choices.find(entry => entry.name === "manual")?.source).toContain("user-only");
      expect(choices.filter(entry => entry.name === "ping")).toHaveLength(2);
      expect(choices.filter(entry => entry.name === "theme").every(entry => !entry.available)).toBe(true);
      expect(choices.find(entry => entry.name === "pong")?.source).toContain("extension");
      expect(choices.filter(entry => entry.name === "ping" || entry.name === "theme").every(entry => entry.group === "skills")).toBe(true);
      expect(choices.findIndex(entry => entry.name === "pong")).toBeGreaterThan(choices.findLastIndex(entry => entry.group === "skills"));
      let accepted = false;
      expect(await dispatchEditorInput("/theme dark", fixture.controller, noBuiltin, () => { accepted = true; })).toBe(false);
      expect(await dispatchEditorInput("/ping", fixture.controller, noBuiltin)).toBe(false);
      expect(await dispatchEditorInput("/thmee", fixture.controller, noBuiltin)).toBe(false);
      expect(fixture.controller.snapshot().transcript.at(-1)?.text).toContain("/thinking");
      expect(accepted).toBe(false); expect(fixture.module.calls).toBe(0); expect(fixture.requests).toEqual([]);
      expect(fixture.controller.commandChoices("/login ").map(entry => entry.insertion)).toEqual(["/login openai", "/login xai", "/login openai-compatible", "/login codex", "/login grok"]);
    } finally { fixture.controller.dispose(); }
  });
});

test("controller ranks command names before searchable descriptions, package provenance and skill sources", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export default ctx => {
      ctx.registerCommand({ name: 'check', description: 'Inspect sessions', execute() {} });
      ctx.registerCommand({ name: 'session-helper', description: 'Handle saved work', execute() {} });
    };`);
    try {
      const skillDir = join(dir, ".agents/skills/guide");
      await mkdir(skillDir, { recursive: true });
      await Bun.write(join(skillDir, "SKILL.md"), "---\nname: guide\ndescription: Review plan\ndisable-model-invocation: true\n---\nTask");
      await fixture.controller.refreshCommands();
      const all = fixture.controller.commandChoices("/");
      expect(all.map(entry => entry.name)).toEqual([...BUILT_IN_COMMAND_ORDER.slice(0, -1), "guide", "check", "session-helper", "delete-session"]);
      expect(fixture.controller.commandChoices("/ses").map(entry => entry.name)).toEqual(["sessions", "session", "session-helper", "delete-session"]);
      // Help searches the live palette ranker; keyboard rows are excluded so the command ordering is pinned.
      const availability = keyboardGuideAvailability({ running: false, toolApproval: false, inspectable: true, details: true });
      const help = (query: string) => paletteChoices(all, availability, query).filter(row => row.kind === "command").map(row => row.name);
      // Additional source-only subsequence matches depend on the temporary path; the leading ranking stays fixed.
      expect(help("sessions").slice(0, 3)).toEqual(["sessions", "check", "session"]);
      expect(help("user-only")).toEqual(["guide"]);
      expect(help("project skill")).toEqual(["guide"]);
      expect(help(fixture.path)).toEqual(["check", "session-helper"]);
    } finally { fixture.controller.dispose(); }
  });
});


test("session changes fence in-flight command validation and busy dispatch skips discovery", async () => {
  await withTempDir(async dir => {
    const fixture = await commandFixture(dir, `export let calls = 0; export default ctx => {
      ctx.registerCommand({ name: 'ping', description: 'Ping', execute() { calls++; } });
    };`);
    try {
      const dispatch = dispatchEditorInput("/ping", fixture.controller, noBuiltin);
      fixture.controller.replaceSession(createSession(), "new-session");
      expect(await dispatch).toBe(false); expect(fixture.module.calls).toBe(0);
      fixture.controller.setModel(createScriptedModel({ waitForAbort: true }), "scripted", "waiting");
      const turn = fixture.controller.submit("wait");
      const original = fixture.controller.commandCollision;
      fixture.controller.commandCollision = async () => { throw new Error("Busy dispatch must not discover"); };
      expect(await dispatchEditorInput("/ping", fixture.controller, noBuiltin)).toBe(false);
      fixture.controller.commandCollision = original;
      fixture.controller.cancel(); await turn;
    } finally { fixture.controller.dispose(); }
  });
});


test("enabled extension replacement refreshes command discovery through the actual session switch", async () => {
  await withTempDir(async dir => {
    await mkdir(join(dir, "next-workspace"));
    const workspace = await resolveWorkspace(join(dir, "next-workspace"));
    await Bun.write(join(dir, "next.ts"), `export default ctx => ctx.registerCommand({ name: 'next', description: 'New action', execute() {} });`);
    const fixture = await commandFixture(dir, `export default ctx => ctx.registerCommand({ name: 'previous', description: 'Old action', execute() {} });`, [], {
      loadWorkspaceExtensions: async () => { const loaded = await loadExtensions({ modules: [join(dir, "next.ts")], workspace, home: join(dir, "home"), tools: createToolRegistry() }); return { tools: loaded.tools, runtime: loaded.runtime }; },
    });
    try {
      await mkdir(join(dir, ".agents/skills/old-skill"), { recursive: true });
      await Bun.write(join(dir, ".agents/skills/old-skill/SKILL.md"), "---\nname: old-skill\ndescription: Previous workspace\n---\nbody");
      await fixture.controller.refreshCommands();
      expect(fixture.controller.commandChoices("/old-skill")).toHaveLength(1);
      expect(fixture.controller.commandChoices("/previous")).toHaveLength(1);
      expect(await fixture.controller.switchSession(createSession(), "replacement", { workspace, contextManager: createContextManager(workspace) })).toBe(true);
      expect(fixture.controller.commandChoices("/old-skill")).toHaveLength(0);
      await fixture.controller.refreshCommands();
      expect(fixture.controller.commandChoices("/previous")).toHaveLength(0);
      expect(fixture.controller.commandChoices("/next")[0]?.name).toBe("next");
    } finally { fixture.controller.dispose(); }
  });
});
