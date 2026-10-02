import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Run a fixture subprocess and surface its complete failure evidence. */
async function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--from" || !args[1]) throw new Error("Usage: bun scripts/session-fixture.ts --from <npm-spec-or-tarball-path>");
const source = args[1].startsWith("file:") ? `file:${resolve(args[1].slice(5))}`
  : !args[1].includes("://") && (args[1].endsWith(".tgz") || args[1].startsWith(".") || args[1].startsWith("/")) ? resolve(args[1]) : args[1];
const temporary = await mkdtemp(join(tmpdir(), "schway-session-fixture-"));
try {
  const consumer = join(temporary, "consumer");
  const home = join(temporary, "home");
  const workspacePath = join(temporary, "workspace");
  await Promise.all([mkdir(consumer), mkdir(home), mkdir(workspacePath)]);
  const workspace = await realpath(workspacePath);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }));
  await run(["npm", "install", "--prefix", consumer, "--no-audit", "--no-fund", source], consumer);
  const installed = JSON.parse(await readFile(join(consumer, "node_modules/schway/package.json"), "utf8"));
  if (installed.name !== "schway" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(installed.version)) throw new Error("Expected an installed Schway release with a semver version");
  const scenario = await readFile(join(import.meta.dir, "../tests/fixtures/session-fixture-scenario.ts"), "utf8");
  const scenarioPath = join(consumer, "scenario.ts");
  await writeFile(scenarioPath, scenario.replaceAll("../../src/", "./node_modules/schway/src/"));
  await run([process.execPath, "--no-env-file", scenarioPath], workspace, {
    PATH: process.env.PATH, HOME: home, SCHWAY_FIXTURE_VERSION: installed.version,
  });
  const output = join(home, "fixture");
  const files = await readdir(output);
  const histories = files.filter(name => name.endsWith(".jsonl"));
  if (histories.length !== 1 || !files.includes("expect.json")) throw new Error("Scenario must produce exactly one history and expect.json");
  const bytes = await readFile(join(output, histories[0]!), "utf8");
  const escapedWorkspace = JSON.stringify(workspace).slice(1, -1);
  const destination = join(import.meta.dir, "../tests/fixtures/sessions", installed.version);
  // Refuse to overwrite reviewed published bytes accidentally.
  await mkdir(destination);
  await writeFile(join(destination, histories[0]!), bytes.replaceAll(escapedWorkspace, "__SCHWAY_FIXTURE_WORKSPACE__"));
  await writeFile(join(destination, "expect.json"), await readFile(join(output, "expect.json")));
  console.log(`Wrote ${installed.version} fixture to ${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
