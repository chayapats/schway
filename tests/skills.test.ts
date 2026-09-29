import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import {
  ACTIVE_SKILL_SECTION_NAME,
  AVAILABLE_SKILLS_SECTION_NAME,
  SKILL_BODY_LIMIT_CHARS,
  discoverSkills,
  formatSkillsListing,
  isSkillNameToken,
  loadSkillBody,
  parseSkillFile,
  prepareSkillInvocation,
  readSkillResource,
  resolveSkillInvocation,
  splitSlashCommand,
} from "../src/skills/skills.ts";
import type { Model, ModelRequest } from "../src/model/model.ts";
import { createSession } from "../src/session/session.ts";
import {
  listSessions,
  loadJsonlSession,
  sessionsDirectory,
} from "../src/session/jsonl.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import {
  BUILT_IN_COMMAND_NAMES,
  helpText,
  parseSkillInvocation,
  parseSlashCommand,
} from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import { invokeSkillTurn } from "../src/tui/app.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

/** Write a SKILL.md fixture; frontmatter is inserted verbatim between fences. */
async function writeSkill(
  skillsDir: string,
  dirName: string,
  frontmatter: string,
  body: string,
): Promise<string> {
  const dir = join(skillsDir, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  return dir;
}

/** Standard project skills dir for a workspace root. */
async function projectSkillsDir(root: string): Promise<string> {
  const dir = join(root, ".agents", "skills");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Isolated user-global skills dir wired as HOME. */
async function globalSkillsDir(home: string): Promise<string> {
  const dir = join(home, ".schway", "skills");
  await mkdir(dir, { recursive: true });
  return dir;
}

function workspaceFor(dir: string) {
  return { root: dir, launchCwd: dir, extraRoots: [] as string[] };
}

const REVIEW_BODY = "REVIEW_BODY_MARKER: critique every diff hunk before approving.";
const REVIEW_FRONTMATTER = "name: review\ndescription: Review code diffs carefully.";

const GREET_FRONTMATTER = "name: greet\ndescription: Greet the user.";

test("discovery exposes metadata only and lists model-eligible skills in context", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(discovery.diagnostics).toEqual([]);
    expect(JSON.stringify(discovery).includes("REVIEW_BODY_MARKER")).toBe(false);

    const prepared = await createContextManager(workspaceFor(dir)).prepare(
      createSession(),
    );
    const names = prepared.context.map((section) => section.name);
    expect(names).toContain(AVAILABLE_SKILLS_SECTION_NAME);
    expect(names).not.toContain(ACTIVE_SKILL_SECTION_NAME);
    const section = prepared.context.find(
      (entry) => entry.name === AVAILABLE_SKILLS_SECTION_NAME,
    )!;
    expect(section.content).toContain("review");
    expect(section.content).toContain("/<skill-name>");
    expect(section.content.includes("REVIEW_BODY_MARKER")).toBe(false);
  });
});

test("project definitions override global definitions of the same name", async () => {
  await withTempDir(async (dir) => {
    const home = await mkdtemp(join(tmpdir(), "schway-home-"));
    try {
      const project = await projectSkillsDir(dir);
      await writeSkill(project, "greet", GREET_FRONTMATTER, "PROJECT_GREET_BODY_MARKER wins.");
      const global = await globalSkillsDir(home);
      await writeSkill(global, "greet", GREET_FRONTMATTER, "GLOBAL_GREET_BODY_MARKER loses.");
      const discovery = await discoverSkills({ workspaceRoot: dir, home });
      expect(discovery.skills.map((skill) => skill.name)).toEqual(["greet"]);
      expect(discovery.skills[0]!.scope).toBe("project");

      const invocation = await prepareSkillInvocation({
        workspaceRoot: dir,
        home,
        name: "greet",
      });
      expect(invocation.ok).toBe(true);
      if (!invocation.ok) {
        return;
      }
      expect(invocation.body.includes("PROJECT_GREET_BODY_MARKER")).toBe(true);
      expect(invocation.body.includes("GLOBAL_GREET_BODY_MARKER")).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("same-level duplicates are ambiguous and leave other skills usable", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "alias-a", "name: dup\ndescription: First claimant.", "FIRST_DUP_BODY");
    await writeSkill(skills, "alias-b", "name: dup\ndescription: Second claimant.", "SECOND_DUP_BODY");
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(discovery.ambiguous.map((entry) => entry.name)).toEqual(["dup"]);
    expect(discovery.ambiguous[0]!.sources).toHaveLength(2);
    expect(
      discovery.diagnostics.some((entry) => entry.reason.includes("does not match directory")),
    ).toBe(true);

    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "dup" });
    expect(invocation.ok).toBe(false);
    if (invocation.ok) {
      return;
    }
    expect(invocation.error).toContain("ambiguous");
    expect(invocation.error).toContain("alias-a");
    expect(invocation.error).toContain("alias-b");
    const listing = formatSkillsListing(discovery);
    expect(listing).toContain("Ambiguous skill 'dup'");
    expect(listing).toContain("review");

    const valid = await prepareSkillInvocation({ workspaceRoot: dir, name: "review" });
    expect(valid.ok).toBe(true);
  });
});

test("malformed skills report source and reason while valid skills stay usable", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    await writeSkill(skills, "nodesc", "name: nodesc", "Body without a description.");
    await writeSkill(skills, "badname", "name: 'Bad Name!'\ndescription: Bad name.", "Body.");
    await writeSkill(skills, "noflag", "name: noflag\ndescription: Bad flag.\ndisable-model-invocation: maybe", "Body.");
    await writeSkill(skills, "empty", "name: empty\ndescription: Empty body.", "   \n");
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(discovery.diagnostics.length).toBe(4);
    for (const diagnostic of discovery.diagnostics) {
      expect(diagnostic.source.length).toBeGreaterThan(0);
      expect(diagnostic.reason.length).toBeGreaterThan(0);
    }
    const listing = formatSkillsListing(discovery);
    expect(listing).toContain("Invalid skill");
    expect(listing).toContain("review");
  });
});

test("built-in command collisions are explained and never silently shadow", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "compact", "name: compact\ndescription: Fake compact.", "COLLIDING_BODY_MARKER");
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(discovery.collisions.map((entry) => entry.name)).toEqual(["compact"]);

    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "compact" });
    expect(invocation.ok).toBe(false);
    if (invocation.ok) {
      return;
    }
    expect(invocation.error).toContain("collides with built-in /compact");
    expect(invocation.error).toContain("rename");
    const listing = formatSkillsListing(discovery);
    expect(listing).toContain("collides with built-in /compact");

    const prepared = await createContextManager(workspaceFor(dir)).prepare(
      createSession(),
    );
    expect(JSON.stringify(prepared).includes("COLLIDING_BODY_MARKER")).toBe(false);
  });
});

test("user-only skills stay listed for users but out of the model-facing section", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(
      skills,
      "deploy",
      "name: deploy\ndescription: Deploy by hand.\ndisable-model-invocation: true",
      "DEPLOY_BODY_MARKER: run the checklist yourself.",
    );
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills.map((skill) => skill.name).sort()).toEqual(["deploy", "review"]);
    expect(discovery.skills.find((skill) => skill.name === "deploy")!.userOnly).toBe(true);

    const prepared = await createContextManager(workspaceFor(dir)).prepare(
      createSession(),
    );
    const section = prepared.context.find(
      (entry) => entry.name === AVAILABLE_SKILLS_SECTION_NAME,
    )!;
    expect(section.content).toContain("review");
    expect(section.content.includes("deploy")).toBe(false);

    const listing = formatSkillsListing(discovery);
    expect(listing).toContain("deploy (user-only)");

    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "deploy" });
    expect(invocation.ok).toBe(true);
  });
});

test("frontmatter supports folded descriptions, quotes, and the user-only alias", () => {
  const folded = parseSkillFile(
    "---\nname: review\ndescription: >\n  Careful line one\n  line two\n---\nBody text.\n",
  );
  expect(folded.ok).toBe(true);
  if (!folded.ok) {
    return;
  }
  expect(folded.value.description).toBe("Careful line one line two");
  expect(folded.value.body).toBe("Body text.\n");

  const quoted = parseSkillFile('---\nname: "review"\ndescription: \'Hi.\'\n---\nBody.\n');
  expect(quoted.ok).toBe(true);

  const alias = parseSkillFile(
    "---\nname: deploy\ndescription: Manual.\nuser-only: true\n---\nBody.\n",
  );
  expect(alias.ok).toBe(true);
  if (!alias.ok) {
    return;
  }
  expect(alias.value.userOnly).toBe(true);

  expect(parseSkillFile("no frontmatter here").ok).toBe(false);
  expect(parseSkillFile("---\nname: x\n").ok).toBe(false);
  expect(parseSkillFile("---\nname: Upper\ndescription: D.\n---\nB.\n").ok).toBe(false);
});

test("oversize bodies fail invocation with the documented limit", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "huge", "name: huge\ndescription: Too big.", `x${"y".repeat(SKILL_BODY_LIMIT_CHARS)}`);
    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "huge" });
    expect(invocation.ok).toBe(false);
    if (invocation.ok) {
      return;
    }
    expect(invocation.error).toContain(`${SKILL_BODY_LIMIT_CHARS}`);
    expect(invocation.error).toContain("The model turn was not started");
  });
});

test("a body deleted after discovery fails activation without a model turn", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    const skill = discovery.skills[0]!;
    await rm(skill.dir, { recursive: true, force: true });
    const loaded = await loadSkillBody(skill);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      return;
    }
    expect(loaded.error).toContain("cannot read body");
    expect(loaded.error).toContain("not started");
  });
});

test("skill resources resolve inside the skill dir and load only on demand", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, `${REVIEW_BODY}\nSee scripts/check.sh.`);
    const scripts = join(skills, "review", "scripts");
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, "check.sh"), "RESOURCE_MARKER_SCRIPT\n");
    const discovery = await discoverSkills({ workspaceRoot: dir });
    const skill = discovery.skills[0]!;

    const prepared = await createContextManager(workspaceFor(dir)).prepare(
      createSession(),
    );
    expect(JSON.stringify(prepared).includes("RESOURCE_MARKER_SCRIPT")).toBe(false);

    const loaded = await readSkillResource(skill, "scripts/check.sh");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.content).toContain("RESOURCE_MARKER_SCRIPT");
    expect((await readSkillResource(skill, "../outside.txt")).ok).toBe(false);
    const absolute = await readSkillResource(skill, join(dir, "x.txt"));
    expect(absolute.ok).toBe(false);
  });
});

test("real-loop invocation injects body plus arguments without persisting the body", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    await writeFile(join(dir, "AGENTS.md"), "PROJECT_RULE_MARKER\n");
    const workspace = workspaceFor(dir);
    const session = createSession();
    const manager = createContextManager(workspace);
    const requests: ModelRequest[] = [];
    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "review" });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) {
      return;
    }
    manager.setActiveSkill({
      name: invocation.skill.name,
      body: invocation.body,
      source: invocation.skill.displayPath,
      scope: invocation.skill.scope,
      dir: invocation.skill.dir,
    });
    session.append({
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "/review check the auth flow" }],
    });
    try {
      for await (const _event of runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            (request: ModelRequest) => {
              requests.push(request);
              return { text: "reviewed" };
            },
          ],
        }),
        contextManager: manager,
        tools: createToolRegistry([readTool]),
        workspace,
      })) {
        // Drain the turn; assertions inspect the captured request below.
      }
    } finally {
      manager.clearActiveSkill();
    }
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const active = request.context.find((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME);
    expect(active?.content).toContain("REVIEW_BODY_MARKER");
    expect(active?.content).toContain("Source:");
    const instructions = request.context.find((entry) => entry.name === "project-instructions");
    expect(instructions?.content).toContain("PROJECT_RULE_MARKER");
    const userText = request.items
      .filter((item) => item.type === "user")
      .map((item) => item.content.map((block) => block.text).join(""))
      .join("\n");
    expect(userText).toContain("/review check the auth flow");
    const durable = JSON.stringify(session.items);
    expect(durable.includes("REVIEW_BODY_MARKER")).toBe(false);
    expect(durable).toContain("/review check the auth flow");
  });
});

test("activation clears after the turn so ordinary turns and resumes start clean", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const workspace = workspaceFor(dir);
    const session = createSession();
    const manager = createContextManager(workspace);
    const controller = new TuiController({
      session,
      model: createScriptedModel({ responses: [{ text: "one" }, { text: "two" }] }),
      contextManager: manager,
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-skill-life",
    });
    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "review" });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) {
      return;
    }
    manager.setActiveSkill({
      name: invocation.skill.name,
      body: invocation.body,
      source: invocation.skill.displayPath,
      scope: invocation.skill.scope,
      dir: invocation.skill.dir,
    });
    try {
      await controller.submit("/review first pass");
    } finally {
      manager.clearActiveSkill();
    }
    await controller.submit("ordinary follow-up");
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe("idle");
    const durable = JSON.stringify(session.items);
    expect(durable.includes("REVIEW_BODY_MARKER")).toBe(false);

    const fresh = createContextManager(workspace);
    const resumed = await fresh.prepare(session);
    expect(
      resumed.context.some((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME),
    ).toBe(false);
  });
});

test("cancellation clears the active skill before the next turn", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const workspace = workspaceFor(dir);
    const manager = createContextManager(workspace);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ waitForAbort: true, text: "never" }),
      contextManager: manager,
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-skill-cancel",
    });
    const invocation = await prepareSkillInvocation({ workspaceRoot: dir, name: "review" });
    expect(invocation.ok).toBe(true);
    if (!invocation.ok) {
      return;
    }
    manager.setActiveSkill({
      name: invocation.skill.name,
      body: invocation.body,
      source: invocation.skill.displayPath,
      scope: invocation.skill.scope,
      dir: invocation.skill.dir,
    });
    const pending = controller.submit("/review long task");
    await Bun.sleep(20);
    controller.cancel();
    try {
      await pending;
    } finally {
      manager.clearActiveSkill();
    }
    const check = await manager.prepare(createSession());
    expect(check.context.some((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME)).toBe(false);
  });
});

test("compaction keeps the active skill for the rest of its turn", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const workspace = workspaceFor(dir);
    const manager = createContextManager(workspace);
    manager.setActiveSkill({
      name: "review",
      body: REVIEW_BODY,
      source: "test",
      scope: "project",
      dir,
    });
    await manager.compact(
      createSession(),
      createScriptedModel({ text: "summary" }),
      { reason: "manual" },
    );
    const prepared = await manager.prepare(createSession());
    const active = prepared.context.find((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME);
    expect(active?.content).toContain("REVIEW_BODY_MARKER");
    manager.clearActiveSkill();
  });
});

test("slash dispatch reserves builtins and routes skill invocations", () => {
  expect(parseSlashCommand("/skills")?.name).toBe("skills");
  expect(parseSlashCommand("/Skills")?.name).toBe("skills");
  expect(parseSkillInvocation("/review check it")).toEqual({
    name: "review",
    args: "check it",
    raw: "/review check it",
  });
  expect(parseSkillInvocation("/compact now")).toBe(null);
  expect(parseSkillInvocation("ordinary prompt")).toBe(null);
  expect(BUILT_IN_COMMAND_NAMES).toContain("skills");
  const help = helpText();
  expect(help).toContain("/skills");
  expect(help).toContain("/<skill-name>");
});

test("splitSlashCommand handles headless prompts without TUI imports", () => {
  expect(splitSlashCommand("/greet hello")?.name).toBe("greet");
  expect(splitSlashCommand("/greet hello")?.args).toBe("hello");
  expect(splitSlashCommand("  /Skills  ")?.name).toBe("skills");
  expect(splitSlashCommand("hello")).toBe(null);
  expect(splitSlashCommand("/")).toBe(null);
});

test("unknown skill names resolve with an explicit available list", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const discovery = await discoverSkills({ workspaceRoot: dir });
    const resolved = resolveSkillInvocation(discovery, "nope");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.kind).toBe("unknown");
    expect(resolved.error).toContain("Unknown skill 'nope'");
    expect(resolved.error).toContain("review");
  });
});

/** Capture writes so headless skill tests can assert stdout and stderr. */
function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

/** Run headless schway with an isolated HOME and working directory. */
async function runHeadless(
  argv: string[],
  options: { home: string; cwd: string; model?: Model; env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli(argv, {
    stdout,
    stderr,
    env: { HOME: options.home, ...(options.env ?? {}) },
    cwd: options.cwd,
    model: options.model,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

test("headless /skills lists without calling a model or creating a session", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    const skills = await projectSkillsDir(project);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const result = await runHeadless(["-p", "/skills"], { home, cwd: project });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("review");
    expect(result.stdout.includes("REVIEW_BODY_MARKER")).toBe(false);
    expect(result.stderr).toBe("");
    expect(await listSessions(sessionsDirectory(home))).toEqual([]);
  });
});

test("headless skill invocation reaches the model with body plus arguments", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    const skills = await projectSkillsDir(project);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const requests: ModelRequest[] = [];
    const result = await runHeadless(["-p", "/review check the auth flow"], {
      home,
      cwd: project,
      model: createScriptedModel({
        responses: [
          (request: ModelRequest) => {
            requests.push(request);
            return { text: "reviewed" };
          },
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("reviewed");
    expect(requests).toHaveLength(1);
    const active = requests[0]!.context.find((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME);
    expect(active?.content).toContain("REVIEW_BODY_MARKER");
    const userText = requests[0]!.items
      .filter((item) => item.type === "user")
      .map((item) => item.content.map((block) => block.text).join(""))
      .join("\n");
    expect(userText).toContain("/review check the auth flow");

    const listed = await listSessions(sessionsDirectory(home));
    expect(listed).toHaveLength(1);
    const loaded = await loadJsonlSession({ directory: sessionsDirectory(home), id: listed[0]!.id });
    const durable = JSON.stringify(loaded.items);
    expect(durable.includes("REVIEW_BODY_MARKER")).toBe(false);
    expect(durable).toContain("/review check the auth flow");
  });
});

test("headless unknown skills and missing bodies fail without a model turn", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    const skills = await projectSkillsDir(project);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);

    const unknown = await runHeadless(["-p", "/nope", "--provider", "openai", "--model", "gpt-5.4"], { home, cwd: project });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown skill 'nope'");

    await writeSkill(skills, "alias-a", "name: dup\ndescription: First.", "FIRST");
    await writeSkill(skills, "alias-b", "name: dup\ndescription: Second.", "SECOND");
    const requests: ModelRequest[] = [];
    const ambiguous = await runHeadless(["-p", "/dup args here"], {
      home,
      cwd: project,
      model: createScriptedModel({
        responses: [
          (request: ModelRequest) => {
            requests.push(request);
            return { text: "should never run" };
          },
        ],
      }),
    });
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous");
    expect(requests).toHaveLength(0);
  });
});

test("headless built-in prompts keep ordinary prompt behavior", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    const result = await runHeadless(["-p", "/model foo"], {
      home,
      cwd: dir,
      model: createScriptedModel({ text: "ordinary" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ordinary");
  });
});

test("skill name tokens accept directory-style names and reject prompt text", () => {
  expect(isSkillNameToken("review")).toBe(true);
  expect(isSkillNameToken("to-spec")).toBe(true);
  expect(isSkillNameToken("a")).toBe(true);
  expect(isSkillNameToken("!!!")).toBe(false);
  expect(isSkillNameToken("/etc/hosts")).toBe(false);
  expect(isSkillNameToken("")).toBe(false);
  expect(isSkillNameToken("-")).toBe(false);
  expect(isSkillNameToken("Upper")).toBe(false);
  expect(isSkillNameToken("a".repeat(64))).toBe(true);
  expect(isSkillNameToken("a".repeat(65))).toBe(false);
});

test("headless invalid slash tokens flow as ordinary prompts", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    for (const prompt of ["/!!! hello", "/etc/hosts content"]) {
      const requests: ModelRequest[] = [];
      const result = await runHeadless(["-p", prompt], {
        home,
        cwd: dir,
        model: createScriptedModel({
          responses: [
            (request: ModelRequest) => {
              requests.push(request);
              return { text: "ordinary" };
            },
          ],
        }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ordinary");
      expect(result.stderr).toBe("");
      expect(requests).toHaveLength(1);
      expect(
        requests[0]!.context.some((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME),
      ).toBe(false);
    }
  });
});

test("unreadable skills directories surface a diagnostic instead of silence", async () => {
  await withTempDir(async (dir) => {
    const agents = join(dir, ".agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "skills"), "not a directory");
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills).toEqual([]);
    expect(discovery.diagnostics.length).toBeGreaterThan(0);
    const diagnostic = discovery.diagnostics[0]!;
    expect(diagnostic.source).toContain(join(".agents", "skills"));
    expect(diagnostic.reason).toContain("cannot list project skills directory");
    expect(formatSkillsListing(discovery)).toContain("Invalid skill");
  });
});

test("missing skills directories stay silent while other scopes report", async () => {
  await withTempDir(async (dir) => {
    const discovery = await discoverSkills({ workspaceRoot: dir });
    expect(discovery.skills).toEqual([]);
    expect(discovery.diagnostics).toEqual([]);
  });
});

test("a skill turn starting while another turn runs is refused without activating", async () => {
  await withTempDir(async (dir) => {
    const skills = await projectSkillsDir(dir);
    await writeSkill(skills, "review", REVIEW_FRONTMATTER, REVIEW_BODY);
    const workspace = workspaceFor(dir);
    const session = createSession();
    const manager = createContextManager(workspace);
    const controller = new TuiController({
      session,
      model: createScriptedModel({ waitForAbort: true, text: "never" }),
      contextManager: manager,
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-skill-race",
    });
    const invoked = invokeSkillTurn(
      { name: "review", args: "", raw: "/review" },
      { controller, home: dir, skillScope: { manager, workspaceRoot: dir } },
    );
    const other = controller.submit("other prompt");
    await invoked;
    controller.cancel();
    await other;
    const snapshot = controller.snapshot();
    expect(
      snapshot.transcript.some((entry) => entry.text.includes("Already running")),
    ).toBe(true);
    const userTexts = session.items
      .filter((item) => item.type === "user")
      .flatMap((item) => item.content.map((block) => block.text));
    expect(userTexts).toEqual(["other prompt"]);
    const check = await manager.prepare(createSession());
    expect(check.context.some((entry) => entry.name === ACTIVE_SKILL_SECTION_NAME)).toBe(
      false,
    );
  });
});
