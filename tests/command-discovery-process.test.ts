import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";

test("fresh command discovery reads bounded metadata and does not import provider SDKs", async () => {
  await withTempDir(async root => {
    const skill = join(root, ".agents/skills/study");
    await mkdir(skill, { recursive: true });
    await Bun.write(join(skill, "SKILL.md"), "---\nname: study\ndescription: Safe metadata\n---\n" + "BODY_SECRET".repeat(500_000));
    const source = join(import.meta.dir, "../src");
    const script = `
      import fs from "node:fs/promises";
      import { mock } from "bun:test";
      let metadataBytes = 0;
      const originalOpen = fs.open;
      const metadataOpen = async (...args) => {
        const file = await originalOpen(...args);
        if (String(args[0]).endsWith("SKILL.md")) {
          const originalRead = file.read.bind(file);
          file.read = async (...readArgs) => { const result = await originalRead(...readArgs); metadataBytes += result.bytesRead; return result; };
        }
        return file;
      };
      const originalReadFile = fs.readFile;
      const metadataReadFile = (...args) => { if (String(args[0]).endsWith("SKILL.md")) throw new Error("Whole-body read forbidden"); return originalReadFile(...args); };
      mock.module("node:fs/promises", () => ({ ...fs, open: metadataOpen, readFile: metadataReadFile }));
      const { TuiController } = await import(${JSON.stringify(join(source, "tui/controller.ts"))});
      const { createSession } = await import(${JSON.stringify(join(source, "session/session.ts"))});
      const { createContextManager } = await import(${JSON.stringify(join(source, "context/manager.ts"))});
      const workspace = { root: ${JSON.stringify(root)}, launchCwd: ${JSON.stringify(root)}, extraRoots: [] };
      const controller = new TuiController({ workspace, home: ${JSON.stringify(join(root, "home"))}, session: createSession(), sessionId: "discovery", provider: "scripted", modelId: "fixture", contextManager: createContextManager(workspace) });
      await controller.refreshCommands();
      const choices = controller.commandChoices("/study");
      const imported = Object.keys(require.cache).filter(path => /node_modules\\/(?:openai|@anthropic-ai)/.test(path));
      console.log(JSON.stringify({ names: choices.map(entry => entry.name), metadataBytes, imported }));
      controller.dispose();
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, env: { PATH: process.env.PATH, HOME: join(root, "home") }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(error).toBe("");
    const result = JSON.parse(output);
    expect(result.names).toEqual(["study"]); expect(result.metadataBytes).toBeGreaterThan(0); expect(result.metadataBytes).toBeLessThanOrEqual(512);
    expect(result.imported).toEqual([]);
  });
});


test("later command refresh fences an older dispatch collision check without accepting its command", async () => {
  await withTempDir(async root => {
    const source = join(import.meta.dir, "../src");
    const script = `
      import { mock } from "bun:test";
      const skillPath = ${JSON.stringify(join(source, "skills/skills.ts"))};
      const skills = await import(skillPath);
      const pending = [];
      mock.module(skillPath, () => ({ ...skills, discoverSkills: () => new Promise(resolve => pending.push(resolve)) }));
      const { TuiController } = await import(${JSON.stringify(join(source, "tui/controller.ts"))});
      const { dispatchEditorInput } = await import(${JSON.stringify(join(source, "tui/commands.ts"))});
      const { createSession } = await import(${JSON.stringify(join(source, "session/session.ts"))});
      const { createContextManager } = await import(${JSON.stringify(join(source, "context/manager.ts"))});
      const workspace = { root: ${JSON.stringify(root)}, launchCwd: ${JSON.stringify(root)}, extraRoots: [] };
      const controller = new TuiController({ workspace, home: ${JSON.stringify(join(root, "home"))}, session: createSession(), sessionId: "race", provider: "scripted", modelId: "fixture", contextManager: createContextManager(workspace) });
      let dispatched = 0, accepted = 0;
      const old = dispatchEditorInput("/help", controller, async () => { dispatched++; return true; }, () => accepted++);
      const refreshed = controller.refreshCommands();
      const empty = { skills: [], collisions: [], ambiguous: [], diagnostics: [] };
      pending[1]({ ...empty, collisions: [{ name: "help", command: "help", source: "new/SKILL.md" }] });
      const refreshResult = await refreshed;
      pending[0](empty);
      const result = await old;
      console.log(JSON.stringify({ result, refreshResult, dispatched, accepted, help: controller.commandChoices("/help"), notice: controller.snapshot().transcript.at(-1)?.text }));
      controller.dispose();
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, env: { PATH: process.env.PATH, HOME: join(root, "home") }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(error).toBe("");
    const result = JSON.parse(output);
    expect(result.refreshResult).toBe(true);
    expect(result.result).toBe(false);
    expect(result.dispatched).toBe(0); expect(result.accepted).toBe(0);
    expect(result.help).toHaveLength(2);
    expect(result.help.every((entry: { available: boolean }) => !entry.available)).toBe(true);
    expect(result.notice).toContain("Commands changed · Enter retry");
  });
});
