import { expect, test } from "bun:test";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { discoverPackages } from "../src/packages/packages.ts";
import { listSessions, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { discoverSkills, prepareSkillInvocation } from "../src/skills/skills.ts";
import { buildIsolatedCliEnv, withIsolatedCliDirs } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";

const packageName = "schway-example-matt-workflow";
const packageSource = join(import.meta.dir, "../examples/packages/matt-workflow");
const roles = ["code-review", "grill-with-docs", "implement", "to-spec", "to-tickets"];

/** Run a local command with an isolated home and collect every process stream. */
async function command(argv: string[], cwd: string, home: string) {
  const process = Bun.spawn(argv, { cwd, env: buildIsolatedCliEnv(home), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
  return stdout;
}

/** Pack the actual example and install only its local tarball without scripts or registry access. */
async function install(work: string, home: string) {
  const output = await command(["npm", "pack", packageSource, "--offline", "--ignore-scripts", "--json"], work, home);
  const [packed] = JSON.parse(output) as Array<{ filename: string; files: Array<{ path: string }> }>;
  expect(packed!.files.map(file => file.path).sort()).toEqual([
    "README.md", "package.json", ...roles.map(role => `skills/${role}/SKILL.md`),
  ].sort());
  await command(["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(work, packed!.filename)], work, home);
  await configure(work, [packageName]);
}

/** Set the fixture's complete project package allowlist. */
async function configure(work: string, packages: string[]) {
  await Bun.write(join(work, ".schway/config.json"), JSON.stringify({ packages }));
}

test("the packed Matt workflow installs as five explicit skills with no executable capability", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await install(work, home);
    const packages = await discoverPackages({ workspaceRoot: work, home });
    expect(packages).toHaveLength(1);
    expect(packages[0]!.extensions).toEqual([]);
    const discovery = await discoverSkills({ workspaceRoot: work, home });
    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.skills.map(skill => skill.name).sort()).toEqual(roles);
    for (const name of roles) {
      expect(discovery.skills.find(skill => skill.name === name)).toMatchObject({ package: packageName, userOnly: true });
      expect(await prepareSkillInvocation({ workspaceRoot: work, home, name })).toMatchObject({ ok: true });
      expect(await prepareSkillInvocation({ workspaceRoot: work, home, name, modelInvocation: true })).toMatchObject({ ok: false });
    }
  });
}, 30_000);

/** Read one observed tool result, failing on missing or rejected calls. */
function result(request: ModelRequest, id: string, isError = false): string {
  const item = request.items.find(item => item.type === "tool_result" && item.toolCallId === id);
  expect(item?.type).toBe("tool_result");
  if (item?.type !== "tool_result") throw new Error("Missing tool result: " + id);
  expect(Boolean(item.isError)).toBe(isError);
  return item.content;
}

/** Submit a real CLI turn, checking explicit arguments and activation in every model request. */
async function turn(work: string, home: string, prompt: string, responses: ScriptedTurnFactory[], options: {
  resume?: string; signal?: AbortSignal; expectedExit?: number;
} = {}) {
  const name = prompt.startsWith("/") ? prompt.split(" ")[0]!.slice(1) : undefined;
  const invocation = name ? await prepareSkillInvocation({ workspaceRoot: work, home, name }) : undefined;
  if (invocation) expect(invocation.ok).toBe(true);
  let calls = 0;
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli([
    "-p", prompt, "--json", ...(options.resume ? ["--resume", options.resume] : []),
  ], {
    cwd: work, env: buildIsolatedCliEnv(home), signal: options.signal,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    model: createScriptedModel({ responses: responses.map(response => request => {
      calls++;
      const active = request.context.filter(section => section.name === "active-skill");
      expect(active).toHaveLength(invocation ? 1 : 0);
      if (invocation?.ok) expect(active[0]!.content).toContain(invocation.body);
      const latestUser = request.items.filter(item => item.type === "user").at(-1);
      expect(latestUser).toMatchObject({ content: [{ type: "text", text: prompt }] });
      expect(request.context.filter(section => section.name === "available-skills")).toEqual([]);
      return typeof response === "function" ? response(request) : response;
    }) }),
  });
  expect({ exitCode, stderr: exitCode === (options.expectedExit ?? 0) ? "" : stderr })
    .toEqual({ exitCode: options.expectedExit ?? 0, stderr: "" });
  expect(calls).toBe(responses.length);
  return stdout;
}

/** Build a native read request for a fixture artifact. */
function read(id: string, path: string) { return { id, name: "read", arguments: { path } }; }

/** Build a native write request for a fixture artifact. */
function write(id: string, path: string, content: string) { return { id, name: "write", arguments: { path, content } }; }

/** Verify a successful write before completing a scripted turn. */
function written(id: string): ScriptedTurnFactory {
  return request => { result(request, id); return { text: "Artifact written." }; };
}

const originalSource = 'export const greet = (name: string) => "Hello, " + name + "!";\n';
const fixedSource = 'export const greet = (name: string) => "Hello, " + (name.trim() || "world") + "!";\n';
const verification = [
  'import { expect, test } from "bun:test";',
  'import { greet } from "./greet.ts";',
  'test("A1 trims whitespace", () => expect(greet("  Ada  ")).toBe("Hello, Ada!"));',
  'test("A2 blank names greet world", () => { expect(greet("   ")).toBe("Hello, world!"); expect(greet("")).toBe("Hello, world!"); });',
  'test("A3 ordinary greeting", () => expect(greet("Lin")).toBe("Hello, Lin!"));',
].join("\n");
const reviewedVerification = verification.replace(
  'expect(greet("")).toBe("Hello, world!");',
  'expect(greet("")).toBe("Hello, world!"); expect(greet("\\t")).toBe("Hello, world!");',
);

test("offline CLI turns hand off artifacts and resolve a review finding through implementation", async () => {
  await withIsolatedCliDirs(async ({ work, home, sentinelPath, sentinelContent }) => {
    await install(work, home);
    await command(["git", "init", "--quiet"], work, home);
    await Bun.write(join(work, "README.md"), "Greeting fixture: greet(name: string) returns a punctuated greeting.\n");
    await Bun.write(join(work, "greet.ts"), originalSource);
    const draft = "# Decisions\nSource: README.md, greet.ts\nTask: normalize greeting names.\nQuestion: trim surrounding whitespace?\nQuestion: how should a blank name behave?\nStatus: awaiting user answers.\n";
    await turn(work, home, "/grill-with-docs Normalize greetings; read README.md and greet.ts; write workflow/decisions.md", [
      { toolCalls: [read("source-doc", "README.md"), read("source-code", "greet.ts")] },
      request => {
        expect(result(request, "source-doc")).toContain("greet(name: string)");
        expect(result(request, "source-code")).toContain(originalSource.trim());
        return { toolCalls: [write("draft", "workflow/decisions.md", draft)] };
      },
      request => { result(request, "draft"); return { text: "Trim surrounding whitespace? What should a blank name do?" }; },
    ]);
    const sessions = await listSessions(sessionsDirectory(home));
    expect(sessions).toHaveLength(1);
    const resume = sessions[0]!.id;
    expect(await Bun.file(join(work, "workflow/decisions.md")).text()).toBe(draft);

    const decisions = "# Resolved decisions\nSource: README.md, greet.ts\nTask: normalize greeting names.\nQ: trim surrounding whitespace? A: yes.\nQ: blank names? A: greet world.\nD1: trim names. D2: blank means world. D3: preserve punctuation and ordinary names.\nUnresolved: none.\nNext: /to-spec workflow/decisions.md workflow/spec.md\n";
    await turn(work, home, '/grill-with-docs workflow/decisions.md Answers: trim whitespace; blank names greet "world"; keep punctuation.', [
      { toolCalls: [read("prior-decisions", "workflow/decisions.md")] },
      request => {
        expect(result(request, "prior-decisions")).toContain("awaiting user answers");
        return { toolCalls: [write("decisions", "workflow/decisions.md", decisions)] };
      }, written("decisions"),
    ], { resume });

    // A resumed ordinary turn has no active body despite the preceding explicit invocation.
    await turn(work, home, "What is active?", [{ text: "No role has been activated this turn." }], { resume });
    const spec = "# Greeting specification\nDecisions: workflow/decisions.md D1, D2, D3.\nScope: greet.ts; no networking or external tracker.\nA1: '  Ada  ' changes from 'Hello,   Ada  !' to 'Hello, Ada!'.\nA2: '' and '   ' return 'Hello, world!'.\nA3: 'Lin' stays 'Hello, Lin!'.\nVerify: bun test greet.test.ts, all three tests pass.\nNext: /to-tickets workflow/spec.md workflow/tickets/\n";
    await turn(work, home, "/to-spec workflow/decisions.md workflow/spec.md", [
      { toolCalls: [read("read-decisions", "workflow/decisions.md")] },
      request => {
        expect(result(request, "read-decisions")).toContain("D2: blank means world");
        expect(result(request, "read-decisions")).toContain("Unresolved: none");
        return { toolCalls: [write("spec", "workflow/spec.md", spec)] };
      }, written("spec"),
    ], { resume });

    const ticket = "# T1: Normalize greeting names\nStatus: pending implementation.\nSpec: workflow/spec.md\nPrerequisites: greet(name: string) in greet.ts returns a punctuated greeting; no prior tickets.\nEdit scope: greet.ts and greet.test.ts.\nA1: trim surrounding whitespace; '  Ada  ' must return 'Hello, Ada!'.\nA2: both empty and whitespace-only strings return 'Hello, world!'.\nA3: ordinary 'Lin' still returns 'Hello, Lin!'.\nVerification: add three Bun tests in greet.test.ts; bun test greet.test.ts.\nNext: /implement workflow/tickets/T1.md workflow/spec.md\n";
    await turn(work, home, "/to-tickets workflow/spec.md workflow/tickets/", [
      { toolCalls: [read("read-spec", "workflow/spec.md")] },
      request => {
        expect(result(request, "read-spec")).toContain("A2: '' and '   ' return 'Hello, world!'");
        return { toolCalls: [
          write("ticket", "workflow/tickets/T1.md", ticket),
          write("index", "workflow/tickets/index.md", "# Local tracker\nT1: A1, A2, A3 — pending implementation; no prerequisites.\n"),
        ] };
      },
      request => { result(request, "ticket"); result(request, "index"); return { text: "Local ticket ready." }; },
    ], { resume });

    const testCall = (id: string) => ({ id, name: "bash", arguments: { command: "bun test greet.test.ts" } });
    await turn(work, home, "/implement workflow/tickets/T1.md workflow/spec.md", [
      { toolCalls: [read("read-ticket", "workflow/tickets/T1.md"), read("implementation-spec", "workflow/spec.md"), read("before", "greet.ts")] },
      request => {
        expect(result(request, "read-ticket")).toContain("no prior tickets");
        expect(result(request, "implementation-spec")).toContain("A3: 'Lin' stays 'Hello, Lin!'");
        expect(result(request, "before")).toContain(originalSource.trim());
        return { toolCalls: [write("tests", "greet.test.ts", verification)] };
      },
      request => { result(request, "tests"); return { toolCalls: [testCall("red")] }; },
      request => {
        expect(result(request, "red")).toContain("Exit code: 1");
        expect(result(request, "red")).toContain("2 fail");
        return { toolCalls: [{ id: "fix", name: "edit", arguments: { path: "greet.ts", edits: [{ oldText: originalSource, newText: fixedSource }] } }] };
      },
      request => { result(request, "fix"); return { toolCalls: [testCall("green")] }; },
      request => {
        expect(result(request, "green")).toContain("Exit code: 0");
        expect(result(request, "green")).toContain("3 pass");
        return { toolCalls: [write("implementation", "workflow/tickets/T1-implementation.md",
          "# T1 implementation\nChanged: greet.ts, greet.test.ts.\nA1, A2, A3: passed.\nbun test greet.test.ts: before exit 1 (1 pass, 2 fail); after exit 0 (3 pass, 0 fail).\nHuman dogfood: pending.\nNext: /code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md\n")] };
      }, written("implementation"),
    ], { resume });

    await turn(work, home, "/code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md", [
      { toolCalls: [
        read("review-spec", "workflow/spec.md"), read("review-ticket", "workflow/tickets/T1.md"),
        read("review-claim", "workflow/tickets/T1-implementation.md"), read("review-source", "greet.ts"), read("review-tests", "greet.test.ts"),
      ] },
      request => {
        expect(result(request, "review-spec")).toContain("A1:");
        expect(result(request, "review-ticket")).toContain("Edit scope: greet.ts and greet.test.ts");
        expect(result(request, "review-claim")).toContain("before exit 1");
        expect(result(request, "review-source")).toContain(fixedSource.trim());
        expect(result(request, "review-tests")).toContain('expect(greet("   ")).toBe("Hello, world!")');
        return { toolCalls: [testCall("review-check")] };
      },
      request => {
        expect(result(request, "review-check")).toContain("Exit code: 0");
        expect(result(request, "review-check")).toContain("3 pass");
        return { toolCalls: [write("review", "workflow/review.md",
          "# Review\nSpecification: A1 trimming passed; A2 behavior passed but tab-only whitespace has no regression test; A3 ordinary greeting passed.\nObserved: bun test greet.test.ts, exit 0, 3 pass, 0 fail.\nStandards: changes stay within T1 scope; no extra project standards in this fixture.\nFinding: A2 test coverage pending in greet.test.ts; add a tab-only input assertion within ticket scope.\nNext: /implement workflow/tickets/T1.md workflow/spec.md workflow/review.md\nLive-provider and human dogfood: pending, not evaluated.\n")] };
      }, written("review"),
    ], { resume });

    await turn(work, home, "/implement workflow/tickets/T1.md workflow/spec.md workflow/review.md", [
      { toolCalls: [
        read("followup-ticket", "workflow/tickets/T1.md"), read("followup-spec", "workflow/spec.md"),
        read("followup-review", "workflow/review.md"), read("followup-tests", "greet.test.ts"),
        read("followup-record", "workflow/tickets/T1-implementation.md"),
      ] },
      request => {
        expect(result(request, "followup-ticket")).toContain("Edit scope: greet.ts and greet.test.ts");
        expect(result(request, "followup-spec")).toContain("A2: '' and '   '");
        expect(result(request, "followup-review")).toContain("A2 test coverage pending in greet.test.ts");
        expect(result(request, "followup-tests")).toContain('expect(greet("   ")).toBe("Hello, world!")');
        expect(result(request, "followup-tests")).not.toContain('greet("\\t")');
        expect(result(request, "followup-record")).toContain("before exit 1");
        return { toolCalls: [{ id: "followup-edit", name: "edit", arguments: {
          path: "greet.test.ts", edits: [{ oldText: verification, newText: reviewedVerification }],
        } }] };
      },
      request => { result(request, "followup-edit"); return { toolCalls: [testCall("followup-check")] }; },
      request => {
        expect(result(request, "followup-check")).toContain("Exit code: 0");
        expect(result(request, "followup-check")).toContain("3 pass");
        return { toolCalls: [write("followup-record", "workflow/tickets/T1-implementation.md",
          "# T1 implementation\nChanged: greet.ts, greet.test.ts.\nA1, A2, A3: passed.\nbun test greet.test.ts: before exit 1 (1 pass, 2 fail); after exit 0 (3 pass, 0 fail).\nReview follow-up: A2 tab-only whitespace coverage was pending in greet.test.ts; added the assertion within ticket scope, then bun test greet.test.ts exited 0 (3 pass, 0 fail). Finding resolved.\nHuman dogfood: pending.\nNext: /code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md\n")] };
      }, written("followup-record"),
    ], { resume });

    await turn(work, home, "/code-review workflow/tickets/T1.md workflow/spec.md workflow/tickets/T1-implementation.md", [
      { toolCalls: [
        read("final-ticket", "workflow/tickets/T1.md"), read("final-spec", "workflow/spec.md"),
        read("final-record", "workflow/tickets/T1-implementation.md"),
        read("final-source", "greet.ts"), read("final-tests", "greet.test.ts"),
      ] },
      request => {
        expect(result(request, "final-ticket")).toContain("A2: both empty and whitespace-only strings");
        expect(result(request, "final-spec")).toContain("A2: '' and '   '");
        expect(result(request, "final-record")).toContain("Finding resolved");
        expect(result(request, "final-source")).toContain(fixedSource.trim());
        expect(result(request, "final-tests")).toContain('expect(greet("\\t")).toBe("Hello, world!")');
        return { toolCalls: [testCall("final-check")] };
      },
      request => {
        expect(result(request, "final-check")).toContain("Exit code: 0");
        return { toolCalls: [write("final-review", "workflow/review.md",
          "# Review\nSpecification: A1, A2, A3 passed.\nObserved: bun test greet.test.ts, exit 0, 3 pass, 0 fail.\nStandards: changes stay within T1 scope.\nFinding: A2 tab-only whitespace regression test added and verified; resolved.\nLive-provider and human dogfood: pending, not evaluated.\n")] };
      }, written("final-review"),
    ], { resume });

    expect(await Bun.file(join(work, "workflow/decisions.md")).text()).toBe(decisions);
    expect(await Bun.file(join(work, "workflow/spec.md")).text()).toBe(spec);
    expect(await Bun.file(join(work, "workflow/tickets/T1.md")).text()).toBe(ticket);
    expect(await Bun.file(join(work, "greet.ts")).text()).toBe(fixedSource);
    expect(await Bun.file(join(work, "greet.test.ts")).text()).toBe(reviewedVerification);
    expect(await Bun.file(join(work, "workflow/tickets/T1-implementation.md")).text()).toContain("Finding resolved");
    expect(await Bun.file(join(work, "workflow/review.md")).text()).toContain("3 pass, 0 fail");
    expect(await Bun.file(sentinelPath).text()).toBe(sentinelContent);

    // Removing only ordinary enablement preserves the base coding loop and all user artifacts.
    await configure(work, []);
    expect((await discoverSkills({ workspaceRoot: work, home })).skills).toEqual([]);
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "implement" })).toMatchObject({ ok: false });
    await turn(work, home, "Check the greeting with ordinary tools", [
      { toolCalls: [testCall("ordinary-check")] },
      request => { expect(result(request, "ordinary-check")).toContain("3 pass"); return { text: "Ordinary coding still works." }; },
    ], { resume });
    const persisted = await loadJsonlSession({ directory: sessionsDirectory(home), id: resume });
    expect(persisted.items.filter(item => item.type === "user")).toHaveLength(10);
    const packageSkill = await Bun.file(join(work, "node_modules", packageName, "skills/implement/SKILL.md")).text();
    const encodedBody = JSON.stringify(packageSkill.split("---")[2]!.trim()).slice(1, -1);
    expect(JSON.stringify(persisted.items)).not.toContain(encodedBody);
  });
}, 30_000);

test("packaged names retain project override and same-tier duplicate behavior", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await install(work, home);
    const copyName = "schway-example-matt-copy";
    await cp(join(work, "node_modules", packageName), join(work, "node_modules", copyName), { recursive: true });
    await configure(work, [packageName, copyName]);
    const duplicate = await discoverSkills({ workspaceRoot: work, home });
    expect(duplicate.skills).toEqual([]);
    expect(duplicate.ambiguous.map(skill => skill.name).sort()).toEqual(roles);
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "implement" })).toMatchObject({ ok: false });
    const override = join(work, ".agents/skills/implement/SKILL.md");
    await Bun.write(override, "---\nname: implement\ndescription: Project implementation policy.\ndisable-model-invocation: true\n---\nUse the project-local implementation policy.\n");
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "implement" }))
      .toMatchObject({ ok: true, body: "Use the project-local implementation policy." });
    await configure(work, [packageName]);
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "implement" }))
      .toMatchObject({ ok: true, body: "Use the project-local implementation policy." });
    await rm(override);
    expect(await prepareSkillInvocation({ workspaceRoot: work, home, name: "implement" }))
      .toMatchObject({ ok: true, skill: { package: packageName } });
  });
}, 30_000);

test("model activation cannot initiate a user-only workflow through the normal tool path", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    await install(work, home);
    await turn(work, home, "Start implementation", [
      { toolCalls: roles.map(name => ({ id: "denied-" + name, name: "activate_skill", arguments: { name } })) },
      request => {
        for (const name of roles) expect(result(request, "denied-" + name, true)).toContain("user-only");
        return { text: "These roles require explicit user invocation." };
      },
    ]);
    expect(await Bun.file(join(work, "workflow")).exists()).toBe(false);
  });
}, 30_000);

for (const failure of ["error", "cancelled"] as const) {
  test("an interrupted " + failure + " turn preserves artifacts and requires explicit reactivation", async () => {
    await withIsolatedCliDirs(async ({ work, home }) => {
      await install(work, home);
      const abort = new AbortController();
      await turn(work, home, "/grill-with-docs Normalize greetings; write workflow/decisions.md", [
        { toolCalls: [write("partial", "workflow/decisions.md", "Questions drafted; user answers pending.\n")] },
        request => {
          result(request, "partial");
          if (failure === "cancelled") { abort.abort(); return { waitForAbort: true }; }
          return { error: "Scripted provider failure", status: 400 };
        },
      ], { signal: abort.signal, expectedExit: 1 });
      expect(await Bun.file(join(work, "workflow/decisions.md")).text()).toContain("user answers pending");
      const [session] = await listSessions(sessionsDirectory(home));
      await turn(work, home, "Continue", [{ text: "The role requires a fresh explicit invocation." }], { resume: session!.id });
      await turn(work, home, "/grill-with-docs workflow/decisions.md Inspect interrupted work", [
        { toolCalls: [read("resume-artifact", "workflow/decisions.md")] },
        request => { expect(result(request, "resume-artifact")).toContain("user answers pending"); return { text: "Inspected partial work; answers still required." }; },
      ], { resume: session!.id });
      expect(await Bun.file(join(work, "workflow/spec.md")).exists()).toBe(false);
    });
  }, 30_000);
}
