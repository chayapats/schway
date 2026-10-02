import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { discoverSessions, SESSION_FORMAT_VERSION } from "../src/session/jsonl.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { version as packageVersion } from "../package.json";

const fixtureRoot = join(import.meta.dir, "fixtures/sessions");
const versions = (await readdir(fixtureRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

/** Describe branch selection and model-visible evidence written by one installed release. */
interface FixtureExpectation {
  sessionId: string;
  mainBranchId: string;
  alternateBranchId: string;
  version: number;
  markers: { main: string; alternate: string; summary: string };
  hasUndo: boolean;
  undoNote?: string;
}

for (const version of versions) test(`published ${version} session discovers and resumes both branches without rewriting bytes`, async () => {
  const fixture = join(fixtureRoot, version);
  const expected: FixtureExpectation = JSON.parse(await readFile(join(fixture, "expect.json"), "utf8"));
  expect((await readdir(fixture)).sort()).toEqual([`${expected.sessionId}.jsonl`, "expect.json"].sort());
  const checkedIn = await readFile(join(fixture, `${expected.sessionId}.jsonl`), "utf8");
  expect(checkedIn).toContain("__SCHWAY_FIXTURE_WORKSPACE__");
  const header = JSON.parse(checkedIn.split("\n")[0]!);
  expect(header.id).toBe(expected.sessionId);
  expect(header.version).toBe(expected.version);
  expect(header.version).toBeLessThanOrEqual(SESSION_FORMAT_VERSION);
  expect(checkedIn.includes('"type":"turn_undo"')).toBe(expected.hasUndo);
  await withTempDir(async temporary => {
    const home = join(temporary, "home");
    // Exercise JSON escaping as well as canonicalized workspace identity.
    const workspacePath = join(temporary, 'workspace "quoted" path');
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    const directory = join(home, ".schway/sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${expected.sessionId}.jsonl`);
    const original = checkedIn.replaceAll("__SCHWAY_FIXTURE_WORKSPACE__", JSON.stringify(workspace).slice(1, -1));
    await writeFile(path, original);
    const rows = await discoverSessions(directory, 0, home);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(expected.sessionId);
    expect(rows[0]?.state).not.toBe("Unsupported history · use a compatible Schway build");
    expect(rows[0]?.state).toBe("Ready");
    for (const branch of [undefined, expected.mainBranchId, expected.alternateBranchId]) {
      let requests = 0, stdout = "", stderr = "";
      const model = createScriptedModel({ responses: [request => {
        requests++;
        const items = JSON.stringify(request.items);
        if (branch === expected.alternateBranchId) {
          expect(items).toContain(expected.markers.alternate);
          expect(items).not.toContain(expected.markers.main);
        } else {
          expect(items).toContain(expected.markers.main);
          expect(items).not.toContain(expected.markers.alternate);
          expect(request.context.some(entry => entry.content.includes(expected.markers.summary))).toBe(true);
          if (expected.hasUndo) {
            expect(expected.undoNote).toBeString();
            expect(items).toContain(expected.undoNote!);
          }
        }
        return { text: "Continued" };
      }] });
      const before = await readFile(path, "utf8");
      const code = await runCli(["-p", "continue", "--resume", expected.sessionId, "--json", ...(branch ? ["--branch", branch] : [])], {
        model, cwd: workspace, env: { HOME: home },
        stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      });
      expect(code, stderr).toBe(0);
      expect(requests).toBe(1);
      expect(stdout.trim().split("\n").map(line => JSON.parse(line)).some(event => event.type === "agent.finished")).toBe(true);
      const after = await readFile(path, "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after.startsWith(original)).toBe(true);
      expect(after.length).toBeGreaterThan(before.length);
    }
  });
  expect(await readFile(join(fixture, `${expected.sessionId}.jsonl`), "utf8")).toBe(checkedIn);
});

test("every changelog release from 0.4.0 has a committed session fixture", async () => {
  const changelog = await readFile(join(import.meta.dir, "../CHANGELOG.md"), "utf8");
  const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map(match => match[1]!);
  expect(versions).toEqual(expect.arrayContaining(["0.4.0", "0.5.0", "0.6.0"]));
  for (const version of releases) {
    if (Bun.semver.order(version, "0.4.0") >= 0) expect(versions, `Missing ${version} fixture`).toContain(version);
  }
});

test("the package version has its own changelog heading", async () => {
  const changelog = await readFile(join(import.meta.dir, "../CHANGELOG.md"), "utf8");
  expect(changelog.split("\n").some(line => line === `## [${packageVersion}]` || line.startsWith(`## [${packageVersion}] - `))).toBe(true);
});
