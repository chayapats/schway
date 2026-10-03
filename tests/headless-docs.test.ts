import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const repo = join(import.meta.dir, ".."), entry = join(repo, "src/cli/main.ts");
const preload = join(import.meta.dir, "fixtures/headless-docs-preload.ts");

function block(text: string, marker: string, language = "sh"): string {
  const following = text.split(`<!-- headless-${marker} -->\n\x60\x60\x60${language}\n`);
  expect(following).toHaveLength(2);
  return following[1]!.split("\n\x60\x60\x60")[0]!;
}

/** Execute the actual POSIX guide, feed deliberate choices, and reap its whole child group on deadline. */
async function guide(script: string, cwd: string, env: Record<string, string>, choices: { model?: string; session?: boolean } = {}) {
  const command = 'schway() { "$SCHWAY_DOCS_BUN" --no-env-file --preload "$SCHWAY_DOCS_PRELOAD" "$SCHWAY_DOCS_ENTRY" "$@"; }\n' + script;
  const child = spawn("bash", ["--norc", "-eu", "-c", command], { cwd,
    env: { ...env, SCHWAY_DOCS_BUN: process.execPath, SCHWAY_DOCS_ENTRY: entry, SCHWAY_DOCS_PRELOAD: preload },
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  const kill = () => {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  };
  let expired = false, suppliedSession = false;
  const timer = setTimeout(() => { expired = true; kill(); }, 12_000);
  child.stdin.on("error", () => { /* A rejected command can close stdin before consuming a prepared choice. */ });
  if (choices.model) child.stdin.write(`${choices.model}\n`);
  if (!choices.session) child.stdin.end();
  const drain = async (stream: NodeJS.ReadableStream, stderr: boolean) => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      text += decoder.decode(Buffer.from(chunk), { stream: true });
      const hint = stderr && choices.session && !suppliedSession && text.match(/^Session (\S+) · Resume with --resume \1\n/m);
      if (hint) { suppliedSession = true; child.stdin.end(`${hint[1]}\n`); }
    }
    return text + decoder.decode();
  };
  const streams = Promise.all([drain(child.stdout, false), drain(child.stderr, true)]);
  try {
    const [[stdout, stderr], exit] = await Promise.all([streams, exited]);
    expect(expired, "Documented command exceeded its deadline").toBe(false);
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(timer); child.stdin.destroy();
    kill();
    await Promise.allSettled([exited, streams]);
  }
}

async function environment(root: string, route: string) {
  const home = join(root, "home"), cwd = join(root, "work"), trace = join(root, "trace.jsonl");
  await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(cwd);
  const env = buildIsolatedCliEnv(home, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", SCHWAY_DOCS_ROUTE: route, SCHWAY_DOCS_TRACE: trace,
    ...(route === "codex" || route === "grok" ? { OPENAI_API_KEY: "fixture-openai-key", XAI_API_KEY: "fixture-xai-key" } : {}),
    ...(route === "compatible" ? { LOCAL_MODEL_KEY: "fixture-compatible-key" } : {}),
  });
  return { home, cwd, env, trace };
}

test("documented flows exclude Bash rc startup from piped stdin", async () => {
  await withTempDir(async root => {
    const { home, cwd, env } = await environment(root, "openai-api");
    await writeFile(join(home, ".bashrc"), 'printf "fixture Bash startup\\n" >&2\nprintf invoked > "$HOME/rc-invoked"\n');
    const result = await guide('schway -p "task" --provider openai --openai-auth api-key --model gpt-4.1 --show-session', cwd, env);
    const id = result.stderr.match(/^Session (\S+) · Resume with --resume \1$/m)?.[1];
    expect(id).toBeString();
    expect(result).toEqual({ exit: 0, stdout: "Hello world\n", stderr: `Session ${id} · Resume with --resume ${id}\n` });
    expect(await Bun.file(join(home, "rc-invoked")).exists()).toBe(false);
  });
});

for (const route of ["openai-api", "codex", "xai-api", "grok", "compatible"] as const) {
  test(`documented ${route} POSIX flow discovers, chooses, runs, lists and resumes exact saved work`, async () => {
    await withTempDir(async root => {
      const { home, cwd, env, trace } = await environment(root, route);
      const text = await readFile(join(repo, "docs/headless.md"), "utf8");
      if (route === "compatible") await writeFile(join(home, ".schway/config.json"), block(text, "config:compatible", "json"));
      const selected = route === "xai-api" || route === "grok" ? "grok-4.7" : route === "compatible" ? "fixture-selected" : "gpt-4.1";
      const result = await guide(block(text, `flow:${route}`), cwd, env, { model: selected, session: true });
      expect(result.exit, result.stderr).toBe(0);
      const hints = [...result.stderr.matchAll(/^Session (\S+) · Resume with --resume \1$/gm)];
      expect(hints).toHaveLength(2); expect(hints[1]![1]).toBe(hints[0]![1]);
      const id = hints[0]![1]!;
      expect(result.stdout).toContain(selected); expect(result.stdout).toContain(id);
      expect(result.stdout.match(/Hello world/g)).toHaveLength(2);
      const requests = (await readFile(trace, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
      const inference = requests.filter(row => row.kind === "inference");
      expect(inference).toHaveLength(2); expect(inference.every(row => row.route === route && row.model === selected)).toBe(true);
      expect(JSON.stringify(inference[1].input)).toContain("Explain this project");
      expect(JSON.stringify(inference[1].input)).toContain("Continue this explanation");
      expect(requests.filter(row => row.kind === "catalog").length).toBeGreaterThanOrEqual(1);
      if (route === "codex" || route === "grok") expect(requests.filter(row => row.kind === "credential").every(row => /subscription/.test(row.account))).toBe(true);
      const session = await loadJsonlSession({ directory: sessionsDirectory(home), id });
      expect(session.items.filter(item => item.type === "user")).toHaveLength(2);
      const saved = await readFile(join(sessionsDirectory(home), `${id}.jsonl`), "utf8");
      expect(saved + result.stdout + result.stderr).not.toMatch(/fixture-(?:openai-key|xai-key|compatible-key|codex-access|grok-access)/);
    });
  }, 20_000);
}

test("README flow is executable without saved model config, and placeholder IDs are never silently chosen", async () => {
  await withTempDir(async root => {
    const { cwd, env } = await environment(root, "openai-api");
    const readme = await readFile(join(repo, "README.md"), "utf8");
    expect((await guide(block(readme, "flow:readme"), cwd, env, { model: "gpt-4.1", session: true })).exit).toBe(0);
    const rejected = await guide('schway -p "task" --provider openai --openai-auth api-key --model "<id>" --show-session', cwd, env);
    expect(rejected.exit).toBe(1); expect(rejected.stdout).toBe("");
  });
}, 20_000);

test("sessions guide runs, lists, resumes and continues an exact conversation branch with its chosen route", async () => {
  await withTempDir(async root => {
    const { home, cwd, env, trace } = await environment(root, "openai-api");
    const text = await readFile(join(repo, "docs/sessions.md"), "utf8");
    const result = await guide(block(text, "flow:sessions"), cwd, env, { model: "gpt-4.1", session: true });
    expect(result.exit, result.stderr).toBe(0);
    const hints = [...result.stderr.matchAll(/^Session (\S+) · Resume with --resume \1$/gm)];
    expect(hints).toHaveLength(2); expect(hints[1]![1]).toBe(hints[0]![1]);
    const id = hints[0]![1]!;
    expect(result.stdout).toContain(id); expect(result.stdout.match(/Hello world/g)).toHaveLength(2);
    const session = await loadJsonlSession({ directory: sessionsDirectory(home), id });
    expect(session.items.filter(item => item.type === "user")).toHaveLength(2);
    const branch = session.forkBranch(session.items.at(-1)!.id, "documented alternative");
    const continued = await guide(block(text, "flow:sessions-branch"), cwd, { ...env, MODEL_ID: "gpt-4.1", SESSION_ID: id, BRANCH_ID: branch });
    expect(continued).toEqual({ exit: 0, stdout: "Hello world\n", stderr: `Session ${id} · Resume with --resume ${id}\n` });
    const restored = await loadJsonlSession({ directory: sessionsDirectory(home), id, branchId: branch });
    expect(restored.items.filter(item => item.type === "user")).toHaveLength(3);
    const calls = (await readFile(trace, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const inference = calls.filter(row => row.kind === "inference");
    expect(inference).toHaveLength(3); expect(inference.every(row => row.route === "openai-api" && row.model === "gpt-4.1")).toBe(true);
    expect(JSON.stringify(inference[2].input)).toContain("Start the migration");
    expect(JSON.stringify(inference[2].input)).toContain("Continue the migration");
    expect(JSON.stringify(inference[2].input)).toContain("Continue this approach");
    expect(result.stdout + result.stderr + continued.stdout + continued.stderr).not.toContain("fixture-openai-key");
  });
}, 20_000);

test("the shown saved config supplies its model, CLI overrides it, and JSONL extraction resumes safely", async () => {
  await withTempDir(async root => {
    const { home, cwd, env } = await environment(root, "openai-api");
    const text = await readFile(join(repo, "docs/headless.md"), "utf8");
    const config = JSON.parse(block(text, "config:saved", "json"));
    expect(config.model).toBe("<replace with your chosen exact ID>"); config.model = "gpt-4.1";
    await writeFile(join(home, ".schway/config.json"), JSON.stringify(config));
    expect((await guide(block(text, "flow:saved"), cwd, env, { session: true })).exit).toBe(0);
    await mkdir(join(cwd, ".schway"));
    await writeFile(join(cwd, ".schway/config.json"), JSON.stringify({ model: "wrong-project-model" }));
    const rejected = await guide('schway -p "task"', cwd, env);
    expect(rejected.exit).toBe(1);
    const result = await guide(block(text, "flow:jsonl"), cwd, { ...env, MODEL_ID: "gpt-4.1" });
    expect(result.exit, result.stderr).toBe(0); expect(result.stdout).toBe("Hello world\n");
    const rows = (await readFile(join(cwd, "task.jsonl"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const id = rows[0].sessionId;
    expect(rows[0].type).toBe("session.ready"); expect(typeof id).toBe("string");
    const session = await loadJsonlSession({ directory: sessionsDirectory(home), id });
    expect(session.items.filter(item => item.type === "user")).toHaveLength(2);
    expect(await readFile(join(cwd, ".schway/config.json"), "utf8")).toBe('{"model":"wrong-project-model"}');
  });
}, 20_000);

test("direct compatible route, doctor recovery and branch continuation use the explicitly chosen model", async () => {
  await withTempDir(async root => {
    const { home, cwd, env } = await environment(root, "compatible");
    const flags = '--provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth required --model fixture-selected';
    const io = { ...env, OPENAI_COMPATIBLE_API_KEY: "fixture-compatible-key" };
    expect((await guide(`schway doctor ${flags} --json`, cwd, io)).exit).toBe(0);
    const first = await guide(`schway -p "task" ${flags} --show-session`, cwd, io);
    expect(first.exit, first.stderr).toBe(0);
    const id = first.stderr.match(/^Session (\S+)/)![1]!;
    const session = await loadJsonlSession({ directory: sessionsDirectory(home), id });
    const branch = session.forkBranch(session.items.at(-1)!.id, "alternate");
    const resumed = await guide(`schway -p "Continue this branch" ${flags} --resume "$SESSION_ID" --branch "$BRANCH_ID" --show-session`, cwd,
      { ...io, SESSION_ID: id, BRANCH_ID: branch });
    expect(resumed.exit, resumed.stderr).toBe(0);
    expect((await loadJsonlSession({ directory: sessionsDirectory(home), id, branchId: branch })).items.filter(item => item.type === "user")).toHaveLength(2);
    const other = join(root, "other"); await mkdir(other);
    const otherTask = await guide(`schway -p "Other workspace" ${flags} --show-session`, other, io);
    expect(otherTask.exit, otherTask.stderr).toBe(0);
    const otherId = otherTask.stderr.match(/^Session (\S+)/)![1]!;
    const local = await guide("schway sessions list", cwd, io);
    expect(local.exit).toBe(0); expect(local.stdout).toContain(id); expect(local.stdout).not.toContain(otherId);
    const all = await guide("schway sessions list --all", cwd, io);
    expect(all.exit).toBe(0); expect(all.stdout).toContain(id); expect(all.stdout).toContain(otherId);
    const selected = await guide('schway sessions list --workspace "$OTHER_WORKSPACE"', cwd, { ...io, OTHER_WORKSPACE: other });
    expect(selected.exit).toBe(0); expect(selected.stdout).toContain(otherId); expect(selected.stdout).not.toContain(id);
  });
}, 20_000);

test("fresh headless commands ignore and preserve the remembered interactive billing route and model", async () => {
  await withTempDir(async root => {
    const { home, cwd, env, trace } = await environment(root, "openai-api");
    const memory = await InteractiveMemory.load(home, cwd);
    await memory.write({ provider: "xai", xaiAuth: "grok", model: "grok-4.7" }, undefined, true);
    const directory = join(home, ".schway/interactive");
    const names = (await readdir(directory, { recursive: true })).filter(name => name.endsWith(".json"));
    const before = await Promise.all(names.map(name => readFile(join(directory, name), "utf8")));
    const missing = await guide('schway -p "task" --show-session', cwd, env);
    expect(missing.exit).toBe(1); expect(missing.stdout).toBe(""); expect(missing.stderr).toContain("No model configured");
    expect(missing.stderr).not.toContain("Resume with"); expect(await Bun.file(trace).exists()).toBe(false);
    const explicit = await guide('schway -p "task" --provider openai --openai-auth api-key --model gpt-4.1 --show-session', cwd, env);
    expect(explicit.exit, explicit.stderr).toBe(0); expect(explicit.stdout).toBe("Hello world\n");
    expect(await Promise.all(names.map(name => readFile(join(directory, name), "utf8")))).toEqual(before);
    const calls = (await readFile(trace, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(row => row.kind === "credential").map(row => row.account)).toEqual(["api-key:openai"]);
    expect(calls.filter(row => row.kind === "inference").map(row => row.route)).toEqual(["openai-api"]);
  });
});

test("the owned guide pages link to the complete route flow and distinguish task JSONL from catalog objects", async () => {
  const headless = await readFile(join(repo, "docs/headless.md"), "utf8");
  for (const page of ["README.md", "docs/credentials.md", "docs/configuration.md", "docs/doctor.md", "docs/sessions.md"]) {
    expect(await readFile(join(repo, page), "utf8"), page).toContain("headless.md");
  }
  for (const target of ["credentials.md", "configuration.md", "doctor.md", "sessions.md"]) expect(headless).toContain(`](${target}`);
  expect(headless).toContain("POSIX shell"); expect(headless).toContain("session.ready");
  expect(headless).toContain("approval required; headless cannot ask");
  expect(headless).toContain("one versioned JSON"); expect(headless).not.toContain("models[0]");
});
