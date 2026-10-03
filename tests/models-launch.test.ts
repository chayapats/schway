import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODELS_HELP } from "../src/cli/models.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const entry = new URL("../src/cli/main.ts", import.meta.url).pathname;

/** Keep stdin open, drain both output pipes concurrently, and reap every executable within a hard deadline. */
async function launch(args: string[], cwd: string, env: Record<string, string>, preload: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, entry, ...args], {
    cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 8000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (expired) throw new Error("Model listing exceeded its cleanup deadline");
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

/** Deny execution, secure storage and mutation, with one optional in-process catalog protocol fixture. */
async function guards(root: string, options: {
  setupFree?: boolean;
  remote?: { url: string; key: string; header?: string; signal?: "SIGINT" | "SIGTERM" };
  configRead?: string;
} = {}): Promise<string> {
  const path = join(root, "models-preload.ts");
  await writeFile(path, `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
const options = ${JSON.stringify(options)};
Bun.plugin({name:"models-isolation", setup(build) {
  build.onLoad({filter:/[\\/]src[\\/](?:tui|tools|session|undo)[\\/]/}, () => { throw new Error("Forbidden execution module"); });
  build.onLoad({filter:/[\\/]src[\\/]model[\\/](?:loader\\.ts|providers[\\/])/}, () => { throw new Error("Forbidden provider module"); });
  build.onLoad({filter:/[\\/]src[\\/](?:cli[\\/]runtime|agent[\\/]loop|config[\\/]interactive-memory)\\.ts$/}, () => { throw new Error("Forbidden application setup"); });
}});
Object.defineProperty(Bun, "secrets", {value:Object.fromEntries(["get", "set", "delete"].map(name => [name, () => { throw new Error("Forbidden credentials"); }]))});
let requests = 0, configReads = 0;
globalThis.fetch = async (url, init) => {
  requests++;
  if (!options.remote || requests !== 1) throw new Error("Forbidden network");
  const headers = new Headers(init?.headers);
  if (String(url) !== options.remote.url || headers.get("authorization") !== "Bearer " + options.remote.key
    || (options.remote.header && headers.get("x-fixture") !== options.remote.header)) throw new Error("Wrong catalog connection");
  if (options.remote.signal) return new Response(new ReadableStream({start(controller) {
    init.signal.addEventListener("abort", () => controller.error(new Error("Fixture body aborted")), {once:true});
    process.kill(process.pid, options.remote.signal);
  }}));
  return Response.json({data:[{id:"fixture-z"}, {id:"fixture-a"}, {id:"fixture-z"}]});
};
const realRead = fs.readFile;
mock.module("node:fs/promises", () => ({ ...fs,
  ...Object.fromEntries(["appendFile", "writeFile", "mkdir", "rm", "rename", "unlink", "truncate", "chmod", "copyFile"].map(name => [name, () => { throw new Error("Forbidden mutation: " + name); }])),
  readFile: (...args) => {
    const path = String(args[0]);
    if (options.setupFree || /[\\/](?:ui-state\\.json|sessions|drafts|undo)(?:[\\/]|$)/.test(path)) throw new Error("Forbidden setup read");
    if (path === options.configRead) configReads++;
    return realRead(...args);
  },
}));
process.on("exit", () => {
  if (requests !== (options.remote ? 1 : 0) || (options.configRead && configReads !== 1)) process.exitCode = 97;
});
`);
  return path;
}

/** Capture application-state names and bytes, excluding the runtime's ordinary transpiler cache. */
async function snapshot(root: string): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(item.parentPath, item.name), relative = path.slice(root.length);
    if (relative === "/.bun" || relative.startsWith("/.bun/")) continue;
    result[relative] = item.isDirectory() ? null : (await readFile(path)).toString("base64");
  }
  return result;
}

test("real models help and strict usage complete before HOME, setup reads, stdin, credentials or network", async () => {
  await withTempDir(async root => {
    const preload = await guards(root, { setupFree: true }), env = buildIsolatedCliEnv(root, { HOME: undefined });
    for (const args of [["--help"], ["-h"], ["list", "--help"], ["list", "-h", "--env-file", "missing"]]) {
      expect(await launch(["models", ...args], root, env, preload)).toEqual({ exit: 0, stdout: MODELS_HELP, stderr: "" });
    }
    for (const args of [[], ["delete"], ["--help", "--version"], ["list", "--version"], ["list", "-p", ""],
      ["list", "--model", "private-value"], ["list", "--help", "--debug"], ["list", "--filter", ""],
      ["list", "--limit", "1"], ["list", "--body", "private-value"], ["list", "--resume", "private-value"]]) {
      const result = await launch(["models", ...args], root, env, preload);
      expect(result.exit).toBe(2); expect(result.stdout).toBe("");
      expect(result.stderr).toContain("models"); expect(result.stderr).not.toContain("private-value");
    }
    for (const args of [["--version", "models", "list"], ["--help", "--version", "models", "list"]]) {
      const result = await launch(args, root, env, preload);
      expect(result.exit).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("--version");
    }
  });
});

test("real offline models resolve every explicit route without credentials, providers, execution or state writes", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), work = join(root, "work");
    await mkdir(home); await mkdir(work);
    const preload = await guards(root), before = await snapshot(home), env = buildIsolatedCliEnv(home);
    for (const [flags, provider, route] of [
      [[], "openai", "unresolved"],
      [["--provider", "openai", "--openai-auth", "api-key"], "openai", "api-key"],
      [["--provider", "openai", "--openai-auth", "codex"], "openai", "codex"],
      [["--provider", "xai"], "xai", "unresolved"],
      [["--provider", "xai", "--xai-auth", "api-key"], "xai", "api-key"],
      [["--provider", "xai", "--xai-auth", "grok"], "xai", "grok"],
      [["--provider", "openai-compatible", "--base-url", "https://fixture.invalid/v1", "--auth", "none"], "openai-compatible", "compatible"],
    ] as const) {
      const result = await launch(["models", "list", "--offline", "--json", ...flags], work, env, preload);
      expect(result.exit, result.stderr).toBe(0); expect(result.stderr).toBe("");
      const catalog = JSON.parse(result.stdout);
      expect(catalog).toMatchObject({ schemaVersion: 1, provider, route, source: "builtin", status: "complete" });
      expect(catalog.warnings.join(" ")).toContain("unverified");
      if (provider === "openai-compatible") expect(catalog.models).toEqual([]);
    }
    const filtered = await launch(["models", "list", "--offline", "--json", "--filter=--version"], work, env, preload);
    expect(filtered.exit).toBe(0); expect(JSON.parse(filtered.stdout).models).toEqual([]);
    expect(JSON.parse(filtered.stdout).warnings.join(" ")).toContain("--filter");
    expect(await snapshot(home)).toEqual(before); expect(await readdir(work)).toEqual([]);
  });
});

test("real model listing reads canonical workspace config and explicit env files while keeping process HOME and profile identity", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), work = join(root, "work"), nested = join(work, "nested"), alias = join(root, "alias"), otherHome = join(root, "other-home");
    await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(join(work, ".git"), { recursive: true });
    await mkdir(join(work, ".schway")); await mkdir(nested); await symlink(nested, alias);
    await mkdir(join(otherHome, ".schway"), { recursive: true }); await writeFile(join(otherHome, ".schway/config.json"), "must not load");
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ provider: "openai", model: "gpt-4o", thinking: "xhigh",
      profiles: { fixture: { baseUrl: "https://wrong.invalid/v1", credentialEnv: "SERVICE_AUTH", auth: "required", model: "execution-only" } } }));
    await writeFile(join(work, ".schway/config.json"), JSON.stringify({ profile: "fixture", profiles: {
      fixture: { baseUrl: "https://fixture.invalid/v1", credentialEnv: "SERVICE_AUTH", auth: "required", headers: { "X-Fixture": "project" } },
    } }));
    await writeFile(join(nested, ".env"), "SERVICE_AUTH=implicit-must-not-load\n");
    await writeFile(join(nested, "first.env"), `HOME=${otherHome}\nSERVICE_AUTH=first-key\n`);
    await writeFile(join(nested, "second.env"), "SERVICE_AUTH=last-key\n");
    for (const name of ["ui-state.json", "sessions/saved", "drafts/saved", "undo/saved"]) {
      const path = join(home, ".schway", name); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "private saved state");
    }
    const beforeHome = await snapshot(home), beforeWork = await snapshot(work);
    const preload = await guards(root, { remote: { url: "https://fixture.invalid/v1/models", key: "last-key", header: "runtime" } });
    const result = await launch(["models", "list", "--env-file", "first.env", "--env-file", "second.env", "--header", "X-Fixture:runtime", "--json"],
      alias, buildIsolatedCliEnv(home, { SERVICE_AUTH: "ambient-key", OPENAI_API_KEY: "unselected-key" }), preload);
    expect(result.exit, result.stderr).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ provider: "openai-compatible", profile: "fixture", route: "compatible", source: "remote", status: "complete",
      models: [{ id: "fixture-a" }, { id: "fixture-z" }] });
    for (const secret of ["last-key", "ambient-key", "unselected-key", "runtime", "https://"]) expect(result.stdout).not.toContain(secret);
    expect(await snapshot(home)).toEqual(beforeHome); expect(await snapshot(work)).toEqual(beforeWork);
  });
});

test("real models diagnostics redact known secrets before long source labels are truncated", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"); await mkdir(home);
    const secret = "private-catalog-credential-" + "s".repeat(45);
    let prefix = root;
    while (prefix.length < 480) prefix = join(prefix, "p".repeat(Math.min(180, 479 - prefix.length)));
    const work = join(prefix, secret); await mkdir(join(work, ".schway"), { recursive: true });
    const config = join(work, ".schway/config.json"), preload = await guards(root);
    for (const source of ["runtime", "header", "environment", "profile"] as const) {
      await writeFile(config, JSON.stringify({ maxTurns: -1, ...(source === "profile" ? { profiles: {
        fixture: { baseUrl: "https://fixture.invalid/v1", credentialEnv: "SERVICE_AUTH" },
      } } : {}) }));
      const flags = source === "runtime" ? ["--api-key", ` ${secret} `] : source === "header" ? ["--header", `Authorization:Bearer ${secret}`] : [];
      const env = buildIsolatedCliEnv(home, source === "environment" ? { CUSTOM_SECRET: ` ${secret} ` } : source === "profile" ? { SERVICE_AUTH: ` ${secret} ` } : {});
      const result = await launch(["models", "list", "--offline", "--json", ...flags], work, env, preload);
      expect(result.exit).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ provider: null, route: "unresolved", status: "error", models: [] });
      expect(result.stderr).toContain("maxTurns"); expect(result.stderr).toContain("***");
      expect(result.stdout + result.stderr).not.toContain("private-catalog");
      expect(result.stdout + result.stderr).not.toContain(secret); expect(result.stderr).not.toContain("\u001b");
    }
  });
});

test("real models report both invalid scopes safely and deduplicate one physical config", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), work = join(root, "work"), secret = "private-profile-identity";
    await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(join(work, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ maxTurns: -1 }));
    await writeFile(join(work, ".schway/config.json"), JSON.stringify({ thinking: "private-invalid-value" }));
    const preload = await guards(root), env = buildIsolatedCliEnv(home);
    const invalid = await launch(["models", "list", "--json"], work, env, preload);
    expect(invalid.exit).toBe(1); expect(JSON.parse(invalid.stdout).warnings).toHaveLength(1);
    expect(invalid.stderr).toContain("maxTurns"); expect(invalid.stderr).toContain("thinking"); expect(invalid.stderr).not.toContain("private-invalid-value");
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ profile: secret, profiles: {
      fixture: { baseUrl: "https://fixture.invalid/v1", credentialEnv: "SERVICE_AUTH" },
    } }));
    const sameFileGuard = await guards(root, { configRead: join(home, ".schway/config.json") });
    const unresolved = await launch(["models", "list", "--offline", "--json"], home,
      buildIsolatedCliEnv(home, { SERVICE_AUTH: secret }), sameFileGuard);
    expect(unresolved.exit).toBe(1); expect(JSON.parse(unresolved.stdout).status).toBe("error");
    expect(unresolved.stderr).toMatch(/profile/i); expect(unresolved.stdout + unresolved.stderr).not.toContain(secret);
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ maxTurns: -1 }));
    const sameInvalid = await launch(["models", "list", "--json"], home, env, sameFileGuard);
    expect(sameInvalid.exit).toBe(1); expect(sameInvalid.stderr.match(/Invalid config at/g)).toHaveLength(1);
  });
});

test("real models setup errors keep one operational envelope and actionable stderr", async () => {
  await withTempDir(async root => {
    const preload = await guards(root);
    for (const [args, env, guidance] of [
      [["--offline"], buildIsolatedCliEnv(root, { HOME: undefined }), "Set HOME"],
      [["--env-file", "private-missing-file"], buildIsolatedCliEnv(root), "Check --env-file"],
    ] as const) {
      const result = await launch(["models", "list", "--json", ...args], root, env, preload);
      expect(result.exit).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, provider: null, route: "unresolved", status: "error", models: [] });
      expect(result.stderr).toContain(guidance); expect(result.stdout + result.stderr).not.toContain("private-missing-file");
    }
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(`real ${signal} during catalog body consumption exits once without state writes or route fallback`, async () => {
    await withTempDir(async root => {
      const home = join(root, "home"), work = join(root, "work"); await mkdir(home); await mkdir(work);
      const preload = await guards(root, { remote: { url: "https://fixture.invalid/v1/models", key: "runtime-key", signal } });
      const result = await launch(["models", "list", "--provider", "openai-compatible", "--base-url", "https://fixture.invalid/v1", "--api-key", "runtime-key", "--json"],
        work, buildIsolatedCliEnv(home), preload);
      expect(result.exit, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ route: "compatible", source: "remote", status: "error", models: [] });
      expect(result.stderr).toMatch(/cancel/i); expect(result.stdout + result.stderr).not.toContain("runtime-key");
      expect(await snapshot(home)).toEqual({}); expect(await readdir(work)).toEqual([]);
    });
  });
}
