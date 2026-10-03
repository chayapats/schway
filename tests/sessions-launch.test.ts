import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionsHelp } from "../src/cli/sessions.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const entry = new URL("../src/cli/main.ts", import.meta.url).pathname;

/** Drain both pipes concurrently, keeping stdin open and reaping the executable on every exit path. */
async function launch(args: string[], cwd: string, env: Record<string, string>, preload: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, entry, ...args], {
    cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (expired) throw new Error("Session listing exceeded its cleanup deadline");
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(deadline); child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

/** Prevent ordinary setup and mutation; optionally deliver an OS signal during the first history read. */
async function guards(root: string): Promise<string> {
  const path = join(root, "listing-preload.ts");
  await writeFile(path, `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
Bun.plugin({name:"sessions-isolation", setup(build) {
  build.onLoad({filter:/[\\/]src[\\/](?:tui|config|model|providers)[\\/]/}, () => { throw new Error("Forbidden runtime module"); });
  build.onLoad({filter:/[\\/]src[\\/]cli[\\/]runtime\\.ts$/}, () => { throw new Error("Forbidden application setup"); });
  build.onLoad({filter:/[\\/]src[\\/]auth[\\/](?:store|credentials)\\.ts$/}, () => { throw new Error("Forbidden credential module"); });
}});
globalThis.fetch = () => { throw new Error("Forbidden network"); };
Object.defineProperty(Bun, "secrets", {value:Object.fromEntries(["get", "set", "delete"].map(name => [name, () => { throw new Error("Forbidden credentials"); }]))});
const realOpen = fs.open;
let signalled = false;
mock.module("node:fs/promises", () => ({ ...fs,
  ...Object.fromEntries(["appendFile", "writeFile", "mkdir", "rm", "rename", "unlink", "truncate", "chmod", "copyFile"].map(name => [name, () => { throw new Error("Forbidden mutation: " + name); }])),
  open: async (...args) => {
    const handle = await realOpen(...args);
    if (process.env.LISTING_SIGNAL && String(args[0]).endsWith(".jsonl")) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!signalled) { signalled = true; process.kill(process.pid, process.env.LISTING_SIGNAL); await Bun.sleep(20); }
        return result;
      };
    }
    return handle;
  },
}));
`);
  return path;
}

/** Capture every application-state name and byte without following external paths. */
async function snapshot(root: string): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(item.parentPath, item.name);
    result[path.slice(root.length)] = item.isDirectory() ? null : (await readFile(path)).toString("base64");
  }
  return result;
}

/** Create histories alongside invalid setup and stale state that discovery must leave untouched. */
async function savedWork(root: string) {
  const home = join(root, "home"), work = join(root, "work"), state = join(home, ".schway");
  await mkdir(join(state, "sessions"), { recursive: true }); await mkdir(work);
  await writeFile(join(state, "config.json"), "invalid config must not load");
  await writeFile(join(state, "ui-state.json"), "invalid remembered state must not load");
  await writeFile(join(work, ".env"), "OPENAI_API_KEY=not-loaded\n");
  for (const directory of ["drafts", "undo"]) {
    await mkdir(join(state, directory), { mode: 0o700 });
    for (const file of ["saved", "saved.lock", "saved.recovery", "saved.stopped.tmp"]) await writeFile(join(state, directory, file), "PRIVATE SAVED STATE", { mode: 0o600 });
  }
  for (const id of ["saved-a", "saved-b"]) {
    const records = [
      { type: "session", version: 1, id, createdAt: "2026-01-01T00:00:00Z", workspaceRoot: work, launchCwd: work, extraRoots: [] },
      { type: "user", id: "task", parentId: id, content: [{ type: "text", text: "ตรวจงานภาษาไทย 🙂" }] },
    ];
    await writeFile(join(state, "sessions", `${id}.jsonl`), records.map(value => JSON.stringify(value)).join("\n") + "\n");
  }
  return { home, work, state };
}

test("real sessions executable lists with redirected descriptors and no setup, credentials, network or saved-state mutation", async () => {
  await withTempDir(async root => {
    const { home, work, state } = await savedWork(root), preload = await guards(root);
    const before = await snapshot(state), env = buildIsolatedCliEnv(home);
    for (const args of [["sessions", "list", "--json"], ["sessions", "list", "--preview"], ["sessions", "list", "--preview", "--json"]]) {
      const result = await launch(args, work, env, preload);
      expect(result.exit, result.stderr).toBe(0); expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("PRIVATE"); expect(result.stdout).not.toContain("\u001b");
      if (args.includes("--json")) {
        const inventory = JSON.parse(result.stdout);
        expect(inventory).toMatchObject({ schemaVersion: 1, status: "complete", scope: { all: false, workspace: work } });
        expect(inventory.sessions.map((row: { id: string }) => row.id)).toEqual(["saved-a", "saved-b"]);
        if (args.includes("--preview")) expect(inventory.sessions[0].preview).toBe("ตรวจงานภาษาไทย 🙂");
        else expect(inventory.sessions[0]).not.toHaveProperty("preview");
      } else expect(result.stdout).toContain("ตรวจงานภาษาไทย 🙂");
    }
    expect(await snapshot(state)).toEqual(before);
    expect(await readFile(join(work, ".env"), "utf8")).toBe("OPENAI_API_KEY=not-loaded\n");
  });
});

test("real sessions help and usage errors need no HOME, terminal or application runtime", async () => {
  await withTempDir(async root => {
    const preload = await guards(root), env = buildIsolatedCliEnv(root, { HOME: undefined });
    expect(await launch(["sessions", "--help"], root, env, preload)).toEqual({ exit: 0, stdout: sessionsHelp(), stderr: "" });
    for (const args of [[], ["delete"], ["list", "--version"], ["list", "-p", ""], ["list", "--provider", "openai"], ["list", "--offset", "-1"]]) {
      const result = await launch(["sessions", ...args], root, env, preload);
      expect(result.exit).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).toMatch(/sessions|Use whole numbers/);
    }
    const missing = await launch(["sessions", "list", "--all", "--json"], root, env, preload);
    expect(missing.exit).toBe(1); expect(JSON.parse(missing.stdout).status).toBe("error"); expect(missing.stderr).toContain("Set HOME");
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(`real ${signal} retains completed inventory rows and exits without changing saved work`, async () => {
    await withTempDir(async root => {
      const { home, work, state } = await savedWork(root), preload = await guards(root), before = await snapshot(state);
      const result = await launch(["sessions", "list", "--all", "--json"], work, buildIsolatedCliEnv(home, { LISTING_SIGNAL: signal }), preload);
      expect(result.exit).toBe(1);
      const inventory = JSON.parse(result.stdout);
      expect(inventory.status).toBe("partial"); expect(inventory.sessions).toHaveLength(1);
      expect(inventory.sessions[0].state).toBe("legacy");
      expect(result.stderr).toBe("Listing cancelled · Retry sessions list\n");
      expect(await snapshot(state)).toEqual(before);
    });
  });
}
