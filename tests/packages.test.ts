import { expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inc } from "semver";
import { version } from "../package.json";
import { runCli } from "../src/cli/main.ts";
import { parseConfigObject, readConfigFile, userConfigPath } from "../src/config/config.ts";
import { createContextManager } from "../src/context/manager.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { discoverPackages, inspectPackages } from "../src/packages/packages.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { discoverSkills, prepareSkillInvocation } from "../src/skills/skills.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { invokeSkillTurn } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import type { Workspace } from "../src/workspace/workspace.ts";
import { withIsolatedCliDirs } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

/** Write only the enabled package list to an isolated scope's configuration. */
async function configure(root: string, packages: string[]): Promise<void> {
  await Bun.write(join(root, ".schway/config.json"), JSON.stringify({ packages }));
}

test("package inspection retains the exact config observation and still inspects the other scope", async () => withIsolatedCliDirs(async ({ home, work: workspace }) => {
  const path = userConfigPath(home);
  await Bun.write(path, '{"approval":{"mode":"readonly"}}');
  const observation = await readConfigFile(path);
  await configure(home, ["new-global-package"]);
  await configure(workspace, ["independent-project-package"]);
  const inspection = await inspectPackages({ home, workspaceRoot: workspace, configFiles: new Map([[path, observation]]) });
  expect(inspection.issues).toEqual([
    { scope: "global", kind: "configuration", configDiagnostics: [expect.objectContaining({ source: path, path: "approval.mode", category: "enum" })] },
    { scope: "project", name: "independent-project-package", kind: "missing" },
  ]);
  expect(inspection.diagnostics.join("\n")).not.toContain("new-global-package");
}));

/** Materialize an installed package fixture with its declared manifest and requested files. */
async function installed(root: string, name: string, manifest: unknown, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, "node_modules", name);
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", ...manifest as object }));
  for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
  return dir;
}

/** Build valid model-eligible skill metadata and a supplied instruction body. */
function skill(name: string, body = `Instructions for ${name}`): string {
  return `---\nname: ${name}\ndescription: Use ${name}\n---\n${body}\n`;
}

/** Build an initializer exposing one named tool and interactive command. */
function extension(name: string): string {
  return `export default ctx => {
    ctx.registerTool({ name: '${name}', description: 'Packaged tool', execution: 'parallel', inputSchema: { type: 'object' },
      execute: async (_, { workspace }) => ({ content: '${name} in ' + workspace.root }) });
    ctx.registerCommand({ name: '${name}-command', description: 'Packaged command', execute: () => '${name}' });
  };`;
}

/** Bind an isolated workspace fixture to one primary root without attachments. */
function workspace(root: string): Workspace { return { root, launchCwd: root, extraRoots: [] }; }

test("global and project package commands retain owning enabled names independently of module paths", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const globalDir = await installed(join(home, ".schway"), "@team/greeting-pkg", { schway: { extensions: ["nested/arbitrary.ts"] } }, {
      "nested/arbitrary.ts": "export default ctx => ctx.registerCommand({ name: 'global-greet', description: 'Say hello globally', execute() {} });",
    });
    const projectDir = await installed(work, "greeting-pkg", { schway: { extensions: ["nested/arbitrary.ts"] } }, {
      "nested/arbitrary.ts": "export default ctx => ctx.registerCommand({ name: 'greet', description: 'Say hello', execute() {} });",
    });
    await configure(home, ["@team/greeting-pkg"]);
    await configure(work, ["greeting-pkg"]);
    const loaded = await loadExtensions({ modules: [], workspace: workspace(work), home, tools: createToolRegistry() });
    try {
      expect(loaded.runtime.commandList()).toEqual([
        { name: "global-greet", description: "Say hello globally", source: await realpath(join(globalDir, "nested/arbitrary.ts")), packageName: "@team/greeting-pkg" },
        { name: "greet", description: "Say hello", source: await realpath(join(projectDir, "nested/arbitrary.ts")), packageName: "greeting-pkg" },
      ]);
      expect(loaded.runtime.commandList().every(command => Object.isFrozen(command))).toBe(true);
    } finally { loaded.runtime.dispose(); }
  });
});

test("package enablement config accepts npm names and rejects executable specifiers, duplicates, and invalid types", () => {
  expect(parseConfigObject({ packages: ["@scope/skills", "my-tools"] }, "config")).toEqual({ packages: ["@scope/skills", "my-tools"] });
  for (const packages of ["pkg", [1], ["pkg", "pkg"], ["../pkg"], ["pkg@latest"], ["https://example.test/p.tgz"], ["file:pkg"], [""], ["@scope/../other"]]) {
    expect(parseConfigObject({ packages }, "config")).toHaveProperty("error");
  }
});

test("enabled packages resolve exclusively in their own installation scope with ordinary npm guidance", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await installed(work, "present", { schway: { skills: [] } });
    await configure(home, ["present"]);
    await expect(discoverPackages({ workspaceRoot: work, home })).rejects.toThrow(`npm install --prefix ${JSON.stringify(join(home, ".schway"))} present`);
    await configure(home, []);
    await configure(work, ["missing"]);
    await expect(discoverPackages({ workspaceRoot: work, home })).rejects.toThrow('project package "missing"');
    expect(await Bun.file(join(work, "node_modules/missing/package.json")).exists()).toBe(false);
  });
});

test("skills-only packages never execute main, lifecycle scripts, or undeclared and unconfigured modules", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const marker = join(work, "must-not-run");
    const code = `await Bun.write(${JSON.stringify(marker)}, 'bad'); throw Error('unexpected execution');`;
    await installed(work, "skills-only", { main: "main.ts", scripts: { postinstall: "touch must-not-run" }, schway: { skills: ["skills/guide"] } }, {
      "main.ts": code, "undeclared.ts": code, "skills/guide/SKILL.md": skill("guide"),
    });
    await installed(work, "disabled", { schway: { extensions: ["main.ts"] } }, { "main.ts": code });
    await configure(work, ["skills-only"]);
    const loaded = await loadExtensions({ modules: [], workspace: workspace(work), home, tools: createToolRegistry() });
    expect((await discoverSkills({ workspaceRoot: work, home })).skills.map(skill => skill.name)).toEqual(["guide"]);
    loaded.runtime.dispose();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

const invalidManifests: Array<[string, unknown, string]> = [
  ["missing manifest", {}, "schway manifest object"],
  ["array manifest", { schway: [] }, "schway manifest object"],
  ["unknown capability", { schway: { extension: [] } }, "accepts only"],
  ["wrong entry type", { schway: { extensions: [5] } }, "array of nonempty"],
  ["absolute entry", { schway: { extensions: ["/tmp/main.ts"] } }, "escapes"],
  ["relative escape", { schway: { extensions: ["../main.ts"] } }, "escapes"],
  ["missing entry", { schway: { extensions: ["missing.ts"] } }, "missing"],
  ["directory module", { schway: { extensions: ["skill"] } }, "module file"],
  ["file skill", { schway: { skills: ["main.ts"] } }, "skill directory"],
  ["missing skill file", { schway: { skills: ["empty"] } }, "missing SKILL.md"],
  ["incompatible peer", { schway: { extensions: ["main.ts"] }, peerDependencies: { schway: ">=99" } }, `installed Schway is ${version}`],
  ["malformed peer", { schway: { extensions: ["main.ts"] }, peerDependencies: { schway: 42 } }, "Invalid Schway peer range"],
  ["bundled harness", { schway: { extensions: ["main.ts"] }, dependencies: { schway: "*" } }, "peerDependencies instead"],
  ...["garbage", "workspace:*", "latest", "not valid semver", `>=${version} garbage`, `npm:schway@^${version}`, "file:../schway", ""].map(range => [
    `malformed peer ${JSON.stringify(range)}`, { schway: { extensions: ["main.ts"] }, peerDependencies: { schway: range } }, "Invalid Schway peer range",
  ] as [string, unknown, string]),
];
for (const [name, manifest, reason] of invalidManifests) {
  test(`${name} fails with package source before any enabled code executes`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      const marker = join(work, "early-import");
      await installed(work, "first", { schway: { extensions: ["main.ts"] } }, { "main.ts": `await Bun.write(${JSON.stringify(marker)}, 'bad'); export default () => {};` });
      const dir = await installed(work, "bad", manifest, { "main.ts": "export default () => {};", "skill/SKILL.md": skill("guide") });
      await mkdir(join(dir, "empty"));
      await configure(work, ["first", "bad"]);
      const error = await loadExtensions({ modules: [], workspace: workspace(work), home, tools: createToolRegistry() }).then(() => null, error => error);
      expect(String(error)).toContain('project package "bad"');
      expect(String(error)).toContain(reason);
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });
}

for (const range of [`^${version}`, `~${version}`, `>=${version} <${inc(version, "minor")}`, `99.x || ${version}`, `${version} - ${inc(version, "minor")}`, ...(version.includes("-") ? [] : ["*"])]) {
  test(`valid npm peer range ${range} enables a compatible installed package`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await installed(work, "compatible", { schway: { skills: [] }, peerDependencies: { schway: range } });
      await configure(work, ["compatible"]);
      expect((await discoverPackages({ workspaceRoot: work, home })).map(pkg => pkg.name)).toEqual(["compatible"]);
    });
  });
}

for (const declaration of [
  { optionalDependencies: { schway: "99.0.0" } },
  { bundleDependencies: ["schway"] },
  { bundledDependencies: ["schway"] },
  { bundleDependencies: true, dependencies: { schway: "99.0.0" } },
  { bundledDependencies: true, optionalDependencies: { schway: "99.0.0" } },
]) {
  test(`second harness declaration ${JSON.stringify(declaration)} fails before importing its nested API`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      const marker = join(work, "nested-api-ran");
      const dir = await installed(work, "second-harness", { ...declaration, peerDependencies: { schway: `^${version}` }, schway: { extensions: ["main.ts"] } }, {
        "main.ts": "import { defineExtension } from 'schway/extensions'; export default defineExtension(() => {});",
      });
      await installed(dir, "schway", { version: "99.0.0", exports: { "./extensions": "./api.js" } }, {
        "api.js": `await Bun.write(${JSON.stringify(marker)}, 'bad'); export const defineExtension = fn => fn;`,
      });
      await configure(work, ["second-harness"]);
      const error = await loadExtensions({ modules: [], workspace: workspace(work), home, tools: createToolRegistry() }).then(() => null, error => error);
      expect(String(error)).toContain('project package "second-harness"');
      expect(String(error)).toContain("peerDependencies instead");
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });
}

test("canonical containment rejects symlink escapes in executable and skill declarations", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const dir = await installed(work, "escape", { schway: { extensions: ["linked.ts"] } });
    await Bun.write(join(work, "outside.ts"), "export default () => {};");
    await symlink(join(work, "outside.ts"), join(dir, "linked.ts"));
    await configure(work, ["escape"]);
    await expect(discoverPackages({ workspaceRoot: work, home })).rejects.toThrow("canonical package root");
    await Bun.write(join(dir, "package.json"), JSON.stringify({ schway: { skills: ["guide"] } }));
    await mkdir(join(dir, "guide"));
    await Bun.write(join(work, "outside.md"), skill("guide"));
    await symlink(join(work, "outside.md"), join(dir, "guide/SKILL.md"));
    await expect(discoverPackages({ workspaceRoot: work, home })).rejects.toThrow("inside the package root");
  });
});

for (const failure of ["missing", "directory"] as const) {
  test(`a packaged skill becoming ${failure} after manifest validation reports a diagnostic and preserves remaining skills`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await installed(work, "read-failure", { schway: { skills: ["unavailable", "available"] } }, {
        "unavailable/SKILL.md": skill("unavailable"), "available/SKILL.md": skill("available"),
      });
      await configure(work, ["read-failure"]);
      const packages = await discoverPackages({ workspaceRoot: work, home });
      const unavailableFile = join(packages[0]!.skills[0]!, "SKILL.md");
      await rm(unavailableFile);
      // A directory makes readFile fail even under root, avoiding permission-dependent fixtures.
      if (failure === "directory") await mkdir(unavailableFile);
      const discovered = await discoverSkills({ workspaceRoot: work, home, packages });
      expect(discovered.skills.map(entry => entry.name)).toEqual(["available"]);
      expect(discovered.skills[0]!.skillFile).toBe(await realpath(join(packages[0]!.skills[1]!, "SKILL.md")));
      expect(discovered.diagnostics).toEqual([{
        source: `${packages[0]!.source}: ${unavailableFile}`, reason: "SKILL.md cannot be read",
      }]);
      // Fresh manifest validation still rejects unavailable or non-file declared entrypoints.
      await expect(discoverPackages({ workspaceRoot: work, home })).rejects.toThrow("SKILL.md");
      const controller = new AbortController();
      const cancelled = new Error("Skill discovery cancelled");
      controller.abort(cancelled);
      await expect(discoverSkills({ workspaceRoot: work, home, packages, signal: controller.signal })).rejects.toBe(cancelled);
    });
  });
}

test("all four skill precedence tiers work independently of package enablement order", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const local = join(work, ".agents/skills/guide/SKILL.md");
    const global = join(home, ".schway/skills/guide/SKILL.md");
    await Bun.write(local, skill("guide", "project-local"));
    await Bun.write(global, skill("guide", "global-local"));
    await installed(work, "project-skills", { schway: { skills: ["guide"] } }, { "guide/SKILL.md": skill("guide", "project-package") });
    await installed(join(home, ".schway"), "global-skills", { schway: { skills: ["guide"] } }, { "guide/SKILL.md": skill("guide", "global-package") });
    await configure(work, ["project-skills"]);
    await configure(home, ["global-skills"]);
    for (const winner of ["project-local", "project-package", "global-local", "global-package"]) {
      const invocation = await prepareSkillInvocation({ workspaceRoot: work, home, name: "guide" });
      expect(invocation).toMatchObject({ ok: true, body: winner });
      if (winner === "project-local") await rm(local);
      if (winner === "project-package") await configure(work, []);
      if (winner === "global-local") await rm(global);
    }
  });
});

test("same-tier package ambiguity blocks lower fallbacks while a higher local skill can shadow it", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    for (const name of ["one", "two"]) await installed(work, name, { schway: { skills: ["guide"] } }, { "guide/SKILL.md": skill("guide", name) });
    await configure(work, ["one", "two"]);
    await Bun.write(join(home, ".schway/skills/guide/SKILL.md"), skill("guide", "fallback"));
    const discovery = await discoverSkills({ workspaceRoot: work, home });
    expect(discovery.skills).toHaveLength(0);
    expect(discovery.ambiguous).toHaveLength(1);
    expect(discovery.ambiguous[0]!.sources.join(" ")).toContain('package "one"');
    expect(discovery.ambiguous[0]!.sources.join(" ")).toContain('package "two"');
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "guide" })).toMatchObject({ ok: false });
    await Bun.write(join(work, ".agents/skills/guide/SKILL.md"), skill("guide", "local"));
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "guide" })).toMatchObject({ ok: true, body: "local" });
  });
});

test("canonical executable duplicates across packages and CLI fail before import with both owners", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const marker = join(work, "duplicate-ran");
    const dir = await installed(work, "shared", { schway: { extensions: ["main.ts"] } }, { "main.ts": `await Bun.write(${JSON.stringify(marker)}, 'bad'); export default () => {};` });
    await configure(work, ["shared"]);
    await mkdir(join(home, ".schway/node_modules"), { recursive: true });
    await symlink(dir, join(home, ".schway/node_modules/global-alias"));
    await configure(home, ["global-alias"]);
    let error = await loadExtensions({ modules: [], workspace: workspace(work), home, tools: createToolRegistry() }).catch(error => error);
    expect(String(error)).toContain('global package "global-alias"');
    expect(String(error)).toContain('project package "shared"');
    await configure(home, []);
    error = await loadExtensions({ modules: [join(dir, "main.ts")], workspace: workspace(work), home, tools: createToolRegistry() }).catch(error => error);
    expect(String(error)).toContain("CLI module");
    expect(String(error)).toContain('project package "shared"');
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("global package, project package, manifest, and CLI order govern actual request hooks", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const module = (name: string) => `export default ctx => ctx.beforeModel(request => ({ ...request, systemPrompt: request.systemPrompt + '|${name}' }));`;
    for (const [root, name, entries] of [[join(home, ".schway"), "global-one", ["g1", "g2"]], [join(home, ".schway"), "global-two", ["g3"]], [work, "project", ["p1", "p2"]]] as const) {
      await installed(root, name, { schway: { extensions: entries.map(entry => `${entry}.ts`) } }, Object.fromEntries(entries.map(entry => [`${entry}.ts`, module(entry)])));
    }
    await configure(home, ["global-one", "global-two"]);
    await configure(work, ["project"]);
    await Bun.write(join(work, "local.ts"), module("cli"));
    let requests = 0;
    const code = await runCli(["-p", "hello", "--extension", "local.ts"], { cwd: work, env: { HOME: home }, stdout: { write() {} }, stderr: { write(text) { throw Error(text); } },
      model: createScriptedModel({ responses: [request => { requests++; expect(request.systemPrompt).toEndWith("|g1|g2|g3|p1|p2|cli"); return { text: "done" }; }] }),
    });
    expect(code).toBe(0);
    expect(requests).toBe(1);
  });
});

for (const mode of ["headless", "interactive"] as const) {
  test(`${mode} packaged skill invocation and custom tool share the real loop without persisting bodies`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await installed(work, "mixed", { peerDependencies: { schway: `^${version}` }, schway: { skills: ["guide"], extensions: ["main.ts"] } }, {
        "guide/SKILL.md": skill("guide", "PACKAGED SKILL BODY"), "main.ts": extension("packaged"),
      });
      await configure(work, ["mixed"]);
      const expectedRoot = mode === "headless" ? await realpath(work) : work;
      let calls = 0;
      const model = createScriptedModel({ responses: [request => {
        calls++;
        expect(request.context.find(section => section.name === "active-skill")?.content).toContain("PACKAGED SKILL BODY");
        expect(request.items[0]).toMatchObject({ content: [{ text: "/guide extra args" }] });
        expect(request.tools?.some(tool => tool.name === "packaged")).toBe(true);
        return { toolCalls: [{ id: "package-call", name: "packaged", arguments: {} }] };
      }, request => {
        calls++;
        expect(request.items.filter(item => item.type === "tool_result")).toMatchObject([{ toolCallId: "package-call", isError: false, content: `packaged in ${expectedRoot}` }]);
        return { text: "done" };
      }] });
      if (mode === "headless") {
        let error = "";
        expect(await runCli(["-p", "/guide extra args"], { cwd: work, env: { HOME: home }, model, stdout: { write() {} }, stderr: { write(text) { error += text; } } })).toBe(0);
        expect(error).toBe("");
      } else {
        const activeWorkspace = workspace(work);
        const loaded = await loadExtensions({ modules: [], workspace: activeWorkspace, home, tools: createToolRegistry() });
        const session = createSession();
        const manager = createContextManager(activeWorkspace, { home });
        const controller = new TuiController({ session, sessionId: "interactive", model, contextManager: manager, workspace: activeWorkspace, home,
          tools: loaded.tools, extensions: loaded.runtime, provider: "scripted", modelId: "scripted" });
        try {
          await invokeSkillTurn({ name: "guide", args: "extra args", raw: "/guide extra args" }, { controller, home, skillScope: { manager, workspaceRoot: work } });
          expect(controller.snapshot().status).toBe("idle");
          expect(JSON.stringify(session.items)).not.toContain("PACKAGED SKILL BODY");
          expect((await manager.prepare(session)).context.some(section => section.name === "active-skill")).toBe(false);
        } finally { controller.dispose(); }
      }
      expect(calls).toBe(2);
    });
  });
}

test("packaged skills activate through the model tool with metadata-only initial context", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await installed(work, "skills", { schway: { skills: ["guide"] } }, { "guide/SKILL.md": skill("guide", "ACTIVATED BODY") });
    await configure(work, ["skills"]);
    const model = createScriptedModel({ responses: [request => {
      expect(JSON.stringify(request.context)).toContain("Use guide");
      expect(JSON.stringify(request.context)).not.toContain("ACTIVATED BODY");
      return { toolCalls: [{ id: "activate", name: "activate_skill", arguments: { name: "guide" } }] };
    }, request => {
      expect(request.context.find(section => section.name === "active-skill")?.content).toContain("ACTIVATED BODY");
      return { text: "done" };
    }] });
    expect(await runCli(["-p", "use guide"], { cwd: work, env: { HOME: home }, model, stdout: { write() {} }, stderr: { write(text) { throw Error(text); } } })).toBe(0);
  });
});

test("package modules resolve their own installed dependencies from the original package directory", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const dir = await installed(work, "owner", { dependencies: { "owned-helper": "1.0.0" }, bundleDependencies: true, schway: { extensions: ["main.ts"] } }, {
      "main.ts": "import message from 'owned-helper'; export default ctx => ctx.registerPrompt({ name: 'owned-dependency', content: message });",
    });
    await installed(dir, "owned-helper", { main: "index.js" }, { "index.js": "export default 'Loaded from package dependency';" });
    await configure(work, ["owner"]);
    let calls = 0;
    const model = createScriptedModel({ responses: [request => {
      calls++;
      expect(request.context).toContainEqual({ name: "owned-dependency", content: "Loaded from package dependency" });
      return { text: "done" };
    }] });
    expect(await runCli(["-p", "hello"], { cwd: work, env: { HOME: home }, model, stdout: { write() {} }, stderr: { write(text) { throw Error(text); } } })).toBe(0);
    expect(calls).toBe(1);
  });
});

test("headless resume discovers configured packages in the saved workspace instead of launch cwd", async () => {
  await withIsolatedCliDirs(async ({ work, home, root }) => {
    await installed(work, "saved", { schway: { extensions: ["main.ts"] } }, { "main.ts": extension("saved") });
    await configure(work, ["saved"]);
    const launched = join(root, "launched");
    await mkdir(launched);
    await configure(launched, ["missing-in-launch"]);
    const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: workspace(work) });
    let calls = 0;
    const model = createScriptedModel({ responses: [request => {
      calls++;
      expect(request.tools?.some(tool => tool.name === "saved")).toBe(true);
      return { text: "done" };
    }] });
    expect(await runCli(["-p", "hello", "--resume", session.header.id], { cwd: launched, env: { HOME: home }, model, stdout: { write() {} }, stderr: { write(text) { throw Error(text); } } })).toBe(0);
    expect(calls).toBe(1);
  });
});

for (const mode of ["headless", "interactive"]) {
  test(`${mode} invalid configured package fails startup before constructing a model or session`, async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await configure(work, ["missing"]);
      let loads = 0;
      let diagnostic = "";
      expect(await runCli(mode === "headless" ? ["-p", "hello"] : [], {
        cwd: work, env: { HOME: home }, stdout: { write() {} }, stderr: { write(text) { diagnostic += text; } },
        terminal: { stdin: mode === "interactive", stdout: mode === "interactive" },
        createModel: async () => { loads++; return createScriptedModel(); },
      })).toBe(1);
      expect(diagnostic).toContain('Missing project package "missing"');
      expect(diagnostic).toContain("npm install --prefix");
      expect(loads).toBe(0);
      expect(await Bun.file(join(home, ".schway/sessions")).exists()).toBe(false);
    });
  });
}

test("interactive workspace switches stage fresh tools and skills, retaining the old runtime on failure and cancellation", async () => {
  await withIsolatedCliDirs(async ({ work, home, root }) => {
    const other = join(root, "other");
    await mkdir(other);
    await installed(work, "old", { schway: { extensions: ["main.ts"], skills: ["old-guide"] } }, { "main.ts": extension("old"), "old-guide/SKILL.md": skill("old-guide") });
    await configure(work, ["old"]);
    const nextDir = await installed(other, "next", { schway: { extensions: ["main.ts"], skills: ["next-guide"] } }, { "main.ts": extension("next"), "next-guide/SKILL.md": skill("next-guide") });
    await configure(other, ["next"]);
    const baseTools = createToolRegistry();
    const load = (ws: ReturnType<typeof workspace>, signal?: AbortSignal) => loadExtensions({ modules: [], workspace: ws, home, tools: baseTools, signal });
    const old = await load(workspace(work));
    const controller = new TuiController({ session: createSession(), sessionId: "old", contextManager: createContextManager(workspace(work), { home }), tools: old.tools, extensions: old.runtime,
      workspace: workspace(work), home, provider: "scripted", modelId: "scripted", loadWorkspaceExtensions: load });
    try {
      await configure(other, ["missing"]);
      expect(await controller.switchSession(createSession(), "failed", { workspace: workspace(other), contextManager: createContextManager(workspace(other), { home }) })).toBe(false);
      expect(controller.snapshot().sessionId).toBe("old");
      expect(old.runtime.signal.aborted).toBe(false);
      expect(controller.extensionCommands().map(command => command.name)).toEqual(["old-command"]);

      // A failed initializer must dispose the staged runtime without publishing its registrations.
      await Bun.write(join(nextDir, "throw.ts"), `export let signal; export default ctx => {
        signal = ctx.signal;
        ctx.registerTool({ name: 'partial', description: 'Partial', execution: 'parallel', inputSchema: {type: 'object'}, execute: () => ({content:'bad'}) });
        throw Error('package initializer failed');
      };`);
      await Bun.write(join(nextDir, "package.json"), JSON.stringify({ schway: { extensions: ["throw.ts"] } }));
      await configure(other, ["next"]);
      expect(await controller.switchSession(createSession(), "thrown", { workspace: workspace(other), contextManager: createContextManager(workspace(other), { home }) })).toBe(false);
      expect(controller.snapshot().sessionId).toBe("old");
      expect(old.runtime.signal.aborted).toBe(false);
      expect((await import(pathToFileURL(join(nextDir, "throw.ts")).href)).signal.aborted).toBe(true);

      const waiting = join(nextDir, "waiting");
      await Bun.write(join(nextDir, "hang.ts"), `export let signal; export let late; export default async ctx => { signal = ctx.signal; late = () => ctx.registerTool({ name: 'partial', description: 'Partial', execution: 'parallel', inputSchema: {type: 'object'}, execute: () => ({content:'bad'}) }); late(); await Bun.write(${JSON.stringify(waiting)}, 'ready'); await new Promise(() => {}); };`);
      await Bun.write(join(nextDir, "package.json"), JSON.stringify({ schway: { extensions: ["hang.ts"] } }));
      await configure(other, ["next"]);
      const switching = controller.switchSession(createSession(), "cancelled", { workspace: workspace(other), contextManager: createContextManager(workspace(other), { home }) });
      for (let attempt = 0; attempt < 200 && !await Bun.file(waiting).exists(); attempt++) await Bun.sleep(1);
      expect(await Bun.file(waiting).exists()).toBe(true);
      controller.cancel();
      expect(await switching).toBe(false);
      await controller.waitForIdle();
      expect(controller.snapshot().sessionId).toBe("old");
      expect(old.runtime.signal.aborted).toBe(false);
      expect(baseTools.definitions()).toEqual([]);
      const cancelled = await import(pathToFileURL(join(nextDir, "hang.ts")).href);
      expect(cancelled.signal.aborted).toBe(true);
      expect(() => cancelled.late()).toThrow("registration is closed");

      await Bun.write(join(nextDir, "package.json"), JSON.stringify({ schway: { extensions: ["main.ts"], skills: ["next-guide"] } }));
      const manager = createContextManager(workspace(other), { home });
      expect(await controller.switchSession(createSession(), "next", { workspace: workspace(other), contextManager: manager })).toBe(true);
      expect(old.runtime.signal.aborted).toBe(true);
      expect(controller.extensionCommands().map(command => command.name)).toEqual(["next-command"]);
      expect((await discoverSkills({ workspaceRoot: other, home })).skills.map(skill => skill.name)).toEqual(["next-guide"]);
      let calls = 0;
      controller.setModel(createScriptedModel({ responses: [request => {
        calls++;
        expect(request.tools?.map(tool => tool.name)).toContain("next");
        expect(request.tools?.map(tool => tool.name)).not.toContain("old");
        expect(request.tools?.map(tool => tool.name)).not.toContain("partial");
        expect(JSON.stringify(request.context)).toContain("next-guide");
        expect(JSON.stringify(request.context)).not.toContain("old-guide");
        return { text: "done" };
      }] }), "scripted", "scripted");
      await controller.submit("next workspace");
      expect(calls).toBe(1);
      // Rebinding to the original workspace does not retain the previous project's tools.
      expect(await controller.switchSession(createSession(), "new", { workspace: workspace(work), contextManager: createContextManager(workspace(work), { home }) })).toBe(true);
      expect(controller.extensionCommands().map(command => command.name)).toEqual(["old-command"]);
    } finally { controller.dispose(); }
  });
});
