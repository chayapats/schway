import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { parseSessionsArguments, runSessionsCommand, sessionsHelp } from "../src/cli/sessions.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { withTempDir } from "./helpers.ts";

async function run(args: string[], home?: string, cwd = home, extra: Record<string, string> = {}) {
  let stdout = "", stderr = "";
  const exit = await runSessionsCommand(args, { cwd, env: { HOME: home, ...extra }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { exit, stdout, stderr };
}

test("sessions parser defaults and strict allowlist are independent of ordinary launch arguments", () => {
  expect(parseSessionsArguments(["list"])).toEqual({ all: false, limit: 20, offset: 0, preview: false, json: false, help: false });
  expect(parseSessionsArguments(["list", "--all", "--limit=100", "--offset", "12", "--preview", "--json"])).toMatchObject({ all: true, limit: 100, offset: 12, preview: true, json: true });
  for (const args of [[], ["delete"], ["list", "--workspace", "/tmp", "--all"], ["list", "--limit", "0"], ["list", "--limit", "101"], ["list", "--offset", "-1"], ["list", "--offset", "1.5"], ["list", "--offset", "1e3"], ["list", "--offset", "9007199254740992"], ["list", "--workspace", ""], ["list", "--limit"], ["list", "--json=true"], ["list", "--all", "--all"]]) expect(() => parseSessionsArguments(args)).toThrow();
});

test("unknown and irrelevant flags reject with empty stdout before filesystem access", async () => {
  const statSpy = spyOn(fs, "stat").mockImplementation(async () => { throw new Error("storage access forbidden"); });
  const readdirSpy = spyOn(fs, "readdir").mockImplementation(async () => { throw new Error("storage access forbidden"); });
  try {
    for (const flag of ["-p", "--provider", "--model", "--api-key", "--route", "--profile", "--resume", "--branch", "--show-session", "--debug", "--delete", "--unknown"]) {
      const result = await run(["list", "--json", flag, "private-never-echo"], "/inaccessible");
      expect(result.exit).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("private-never-echo");
    }
    expect(statSpy).not.toHaveBeenCalled(); expect(readdirSpy).not.toHaveBeenCalled();
  } finally { statSpy.mockRestore(); readdirSpy.mockRestore(); }
});

test("help succeeds without HOME and explains exact resume, configuration, privacy and moving pages", async () => {
  for (const args of [["--help"], ["list", "--help"], ["list", "-h"]]) {
    const result = await run(args);
    expect(result.exit).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toBe(sessionsHelp());
  }
  expect(sessionsHelp()).toContain("configured model and route");
  expect(sessionsHelp()).toContain("--resume <session-id>");
  expect(sessionsHelp()).toContain("arbitrary secrets are not detected");
  expect(sessionsHelp()).toContain("offset pages");
});

test("human and JSON empty contracts create no state", async () => {
  await withTempDir(async home => {
    const plain = await run(["list"], home);
    expect(plain.exit).toBe(0); expect(plain.stderr).toBe("");
    expect(plain.stdout).toStartWith('No saved work · Run schway -p "<task>" to start\n');
    const result = await run(["list", "--json"], home);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, scope: { all: false, workspace: home }, limit: 20, offset: 0, hasMore: false, status: "complete", sessions: [], warnings: [] });
    expect(await fs.readdir(home)).toEqual([]);
  });
});

test("workspace aliases and nested launch directories use the same nearest Git root", async () => {
  await withTempDir(async home => {
    const root = join(home, "project"), sub = join(root, "sub"), alias = join(home, "alias"), other = join(home, "other");
    await fs.mkdir(join(root, ".git"), { recursive: true }); await fs.mkdir(sub); await fs.mkdir(other); await fs.symlink(root, alias);
    const own = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root, launchCwd: root, extraRoots: [] } });
    await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: other, launchCwd: other, extraRoots: [] } });
    for (const [cwd, args] of [[sub, ["list", "--json"]], [home, ["list", "--workspace", alias, "--json"]]] as const) {
      const result = await run([...args], home, cwd);
      const inventory = JSON.parse(result.stdout);
      expect(result.exit).toBe(0); expect(inventory.scope).toEqual({ all: false, workspace: root });
      expect(inventory.sessions.map((row: { id: string }) => row.id)).toEqual([own.header.id]);
    }
    const all = await run(["list", "--all", "--json"], home, "/missing-cwd-ignored-by-all");
    expect(all.exit).toBe(0); expect(JSON.parse(all.stdout).sessions).toHaveLength(2);
  });
});

test("operational failures keep JSON parseable and diagnostics actionable without raw paths", async () => {
  const missing = await run(["list", "--all", "--json"]);
  expect(missing.exit).toBe(1); expect(JSON.parse(missing.stdout).status).toBe("error"); expect(missing.stderr).toContain("Set HOME");
  await withTempDir(async home => {
    const badWorkspace = await run(["list", "--json", "--workspace", "/secret-path-do-not-echo"], home);
    expect(badWorkspace.exit).toBe(1); expect(JSON.parse(badWorkspace.stdout).status).toBe("error");
    expect(badWorkspace.stderr).not.toContain("secret-path-do-not-echo");
    await fs.mkdir(join(home, ".schway")); await fs.writeFile(sessionsDirectory(home), "invalid directory");
    const storage = await run(["list", "--all", "--json"], home);
    expect(storage.exit).toBe(1); expect(JSON.parse(storage.stdout).warnings).toHaveLength(1);
    expect(storage.stderr).toContain("Storage unavailable");
  });
});

test("known environment secrets are masked in excerpts and cannot leak through scope or row identity", async () => {
  await withTempDir(async home => {
    const secret = "environment-fixture-secret", root = join(home, secret);
    await fs.mkdir(root);
    const saved = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root, launchCwd: root, extraRoots: [] } });
    saved.append({ type: "user", id: "task", content: [{ type: "text", text: `ทำงาน ${secret}` }] });
    const result = await run(["list", "--preview", "--json"], home, root, { OPENAI_API_KEY: secret });
    expect(result.exit).toBe(1); expect(result.stdout + result.stderr).not.toContain(secret);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.sessions[0]).toMatchObject({ id: saved.header.id, preview: "ทำงาน ***" });
    expect(inventory.scope.workspace).toBeUndefined();
  });
});

for (const placement of ["id", "workspace", "preview", "raw-preview", "ansi-preview", "normalized-preview"] as const) {
  test(`plain and JSON inventories protect raw and trimmed environment credentials in ${placement}`, async () => {
    await withTempDir(async home => {
      const secret = placement === "normalized-preview" ? "opaque environment value" : "opaque-environment-value";
      const padded = `  ${secret}\n`;
      const root = join(home, placement === "workspace" ? secret : "workspace");
      await fs.mkdir(root);
      const id = placement === "id" ? `saved-${secret}` : "saved-exact-id";
      const value = placement === "raw-preview" ? padded : placement === "ansi-preview" ? "opaque-\u001b[31menvironment\u001b[0m-value"
        : placement === "normalized-preview" ? "opaque\t environment\nvalue" : secret;
      const text = [
        { type: "session", version: 1, id, workspaceRoot: root, launchCwd: root, extraRoots: [], createdAt: "2026-01-01T00:00:00Z" },
        { type: "user", id: "task", parentId: id, content: [{ type: "text", text: `ทำงาน ${value}` }] },
      ].map(record => JSON.stringify(record)).join("\n") + "\n";
      await fs.mkdir(sessionsDirectory(home), { recursive: true });
      const path = join(sessionsDirectory(home), `${id}.jsonl`);
      await fs.writeFile(path, text);
      for (const json of [false, true]) {
        const result = await run(["list", "--preview", ...(json ? ["--json"] : [])], home, root, { OPENAI_API_KEY: padded });
        expect(result.stdout + result.stderr).not.toContain(secret);
        expect(result.stdout + result.stderr).not.toContain("\u001b");
        expect(result.exit).toBe(placement === "id" || placement === "workspace" ? 1 : 0);
        if (json) {
          const inventory = JSON.parse(result.stdout);
          expect(inventory.sessions.map((row: { id: string }) => row.id)).toEqual(placement === "id" ? [] : [id]);
          if (placement === "workspace") {
            expect(inventory.scope.workspace).toBeUndefined();
            expect(inventory.sessions[0].workspaceRoot).toBeUndefined();
          }
          if (placement !== "id") expect(inventory.sessions[0].preview).toBe("ทำงาน ***");
        } else if (placement !== "id") expect(result.stdout).toContain("ทำงาน ***");
      }
      expect(await fs.readFile(path, "utf8")).toBe(text);
    });
  });
}

test("plain and JSON inventories suppress control-split credential previews without changing saved text", async () => {
  await withTempDir(async home => {
    const saved = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
    const credential = "private-credential-value";
    saved.append({ type: "user", id: "task", content: [{ type: "text", text: `Bea\u200brer\n${credential}` }] });
    const path = join(sessionsDirectory(home), `${saved.header.id}.jsonl`), before = await fs.readFile(path);
    for (const json of [false, true]) {
      const result = await run(["list", "--preview", ...(json ? ["--json"] : [])], home);
      expect(result.exit).toBe(0); expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(credential);
      if (json) {
        const row = JSON.parse(result.stdout).sessions[0];
        expect(row.id).toBe(saved.header.id); expect(row).not.toHaveProperty("preview");
      }
    }
    expect(await fs.readFile(path)).toEqual(before);
  });
});

test("isolated command import and listing avoid config, env files, provider/TUI loads, credentials and network", async () => {
  await withTempDir(async home => {
    await fs.writeFile(join(home, ".env"), "OPENAI_API_KEY=must-not-load\n");
    await fs.mkdir(join(home, ".schway")); await fs.writeFile(join(home, ".schway", "config.json"), "invalid-json");
    const module = new URL("../src/cli/sessions.ts", import.meta.url).pathname;
    const script = `
      Bun.plugin({name:"forbid-runtime", setup(build) {
        build.onLoad({filter:/\\/src\\/(?:tui|config|model|providers)\\//}, () => { throw new Error("Forbidden runtime module"); });
        build.onLoad({filter:/\\/src\\/auth\\/(?:store|credentials)\\.ts$/}, () => { throw new Error("Forbidden auth module"); });
      }});
      globalThis.fetch = () => { throw new Error("Forbidden network"); };
      Object.defineProperty(Bun, "secrets", {value:Object.fromEntries(["get", "set", "delete"].map(name => [name, () => { throw new Error("Forbidden credentials"); }]))});
      const {runSessionsCommand} = await import(${JSON.stringify(module)});
      process.exitCode = await runSessionsCommand(["list", "--all", "--json"], {env:{HOME:${JSON.stringify(home)}}, stdout:process.stdout, stderr:process.stderr});
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: home, stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(""); expect(exit).toBe(0); expect(JSON.parse(stdout).status).toBe("complete");
      expect(await fs.readFile(join(home, ".schway", "config.json"), "utf8")).toBe("invalid-json");
    } finally { clearTimeout(deadline); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  });
});
