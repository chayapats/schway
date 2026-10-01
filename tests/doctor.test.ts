import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, doctorExitCode, formatDoctor } from "../src/doctor/doctor.ts";
import { runCli } from "../src/cli/main.ts";
import { inspectPackages } from "../src/packages/packages.ts";
import type { CredentialStore } from "../src/auth/store.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "schway-doctor-")); dirs.push(root);
  const workspace = join(root, "work"); const home = join(root, "home");
  await mkdir(join(workspace, ".git"), { recursive: true }); await mkdir(home);
  return { root, workspace, home };
}
const args = { json: true, help: false };
const store = (value: string | null | Error): CredentialStore => ({
  get: async () => { if (value instanceof Error) throw value; return value; },
  set: async () => { throw Error("unexpected mutation"); },
  delete: async () => { throw Error("unexpected mutation"); },
});
const check = (report: Awaited<ReturnType<typeof diagnose>>, id: string) => report.checks.find(item => item.id === id);

for (const count of [1, 2]) test(`doctor renders ${count} skills without changing JSON summaries`, async () => {
  const { workspace, home } = await fixture();
  for (let index = 0; index < count; index++) {
    const path = join(workspace, ".agents", "skills", `copy-skill-${index}`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: copy-skill-${index}\ndescription: Check copy\n---\nCheck user copy.\n`);
  }
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(report, "skills")?.summary).toBe(`${count} skill(s) available.`);
  expect(formatDoctor(report).split("\n").find(line => line.includes(" skills: "))).toBe(`[Ok] skills: ${count === 1 ? "1 skill" : "2 skills"} available.`);
  expect(JSON.parse(JSON.stringify(report)).checks.find((item: { id: string }) => item.id === "skills").summary).toBe(`${count} skill(s) available.`);
});

test("independently diagnoses invalid configuration, storage and search availability", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(workspace, ".schway")); await writeFile(join(workspace, ".schway", "config.json"), "{ broken");
  await mkdir(join(home, ".schway")); await writeFile(join(home, ".schway", "sessions"), "not a directory");
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(report, "workspace")?.status).toBe("ok");
  expect(check(report, "sessions")?.status).toBe("error");
  expect(check(report, "config.project")?.status).toBe("error");
  expect(check(report, "auth")).toBeUndefined();
  expect(check(report, "search")).toBeDefined();
  expect(doctorExitCode(report)).toBe(1);
});

test("xAI doctor names XAI_API_KEY in the auth remedy", async () => {
  const { workspace, home } = await fixture();
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, provider: "xai" }, store: store(null) });
  expect(report.provider).toBe("xai");
  expect(check(report, "auth")?.remedy).toContain("XAI_API_KEY");
});

test("env-file HOME cannot replace the launch process HOME for storage or user config", async () => {
  const { workspace, home, root } = await fixture();
  const overlayHome = join(root, "overlay-home"); await mkdir(join(home, ".schway"), { recursive: true });
  await mkdir(join(overlayHome, ".schway"), { recursive: true });
  await writeFile(join(home, ".schway", "config.json"), JSON.stringify({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", auth: "none" }));
  await writeFile(join(overlayHome, ".schway", "config.json"), JSON.stringify({ provider: "openai" }));
  await writeFile(join(workspace, ".diagnose.env"), `HOME=${overlayHome}\nOPENAI_API_KEY=from-file\n`);
  const options = { ...args, envFiles: [".diagnose.env"] };
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: options, store: store(null) });
  expect(report.provider).toBe("openai-compatible");
  expect(report.authSource).toBe("none");
  expect(check(report, "config.user")?.status).toBe("ok");
  const missing = await diagnose({ cwd: workspace, env: {}, args: options, store: store(null) });
  expect(check(missing, "sessions")?.status).toBe("error");
  expect(missing.provider).toBe("openai");
  expect(missing.authSource).toBe("environment");
});

test("auth modes isolate selected credentials, locked store and subscription expiry", async () => {
  const { workspace, home } = await fixture();
  const run = (override: Record<string, string | undefined>, options: Parameters<typeof diagnose>[0]["args"], value: string | null | Error) =>
    diagnose({ cwd: workspace, env: { HOME: home, ...override }, args: options, store: store(value) });
  expect(check(await run({ OPENAI_API_KEY: "secret-do-not-print" }, args, null), "auth")?.status).toBe("ok");
  const optional = await run({}, { ...args, provider: "openai-compatible", baseUrl: "https://localhost/v1" }, null);
  expect(check(optional, "auth")?.status).toBe("warning"); expect(doctorExitCode(optional)).toBe(0);
  expect(check(await run({}, { ...args, provider: "openai-compatible", baseUrl: "https://localhost/v1", auth: "none" }, new Error("secret")), "auth")?.status).toBe("ok");
  expect(check(await run({}, { ...args, provider: "openai-compatible", baseUrl: "https://localhost/v1", auth: "required" }, new Error("secret")), "auth")?.status).toBe("error");
  const subscription = await run({}, { ...args, provider: "openai", openaiAuth: "codex" }, JSON.stringify({ accessToken: "secret-do-not-print", expiresAt: 1, refreshToken: "secret-refresh" }));
  expect(check(subscription, "auth")?.status).toBe("warning");
  expect(JSON.stringify(subscription)).not.toContain("secret-do-not-print");
  expect(JSON.stringify(subscription)).not.toContain("secret-refresh");
  expect(check(await run({}, { ...args, provider: "openai", openaiAuth: "codex" }, null), "auth")?.status).toBe("error");
  expect(check(await run({}, { ...args, profile: "unknown" }, null), "provider")?.status).toBe("error");
});

test("doctor rejects inherited non-compatible connection flags like the normal CLI", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(workspace, ".schway"));
  await writeFile(join(workspace, ".schway", "config.json"), JSON.stringify({ provider: "openai" }));
  let stdout = "";
  const status = await runCli(["doctor", "--json", "--base-url", "https://example.org/v1"], {
    cwd: workspace, env: { HOME: home, OPENAI_API_KEY: "secret" },
    credentialStore: store(null), stdout: { write(chunk) { stdout += chunk; } }, stderr: { write() {} },
  });
  expect(status).toBe(1);
  const report = JSON.parse(stdout);
  expect(check(report, "provider")?.status).toBe("error");
  expect(check(report, "runtime")?.status).toBe("ok");
  expect(JSON.stringify(report)).not.toContain("secret");
});

test("empty override rejects codex login without reading secure storage", async () => {
  const { workspace, home } = await fixture();
  let reads = 0;
  const login = JSON.stringify({ accessToken: "private-access" });
  const guarded: CredentialStore = { ...store(login), get: async identity => { if (identity.account !== "api-key:anthropic") reads++; return identity.account === "api-key:anthropic" ? null : login; } };
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, provider: "openai", openaiAuth: "codex", apiKey: "" }, store: guarded });
  expect(check(report, "auth")?.status).toBe("error");
  expect(report.authSource).toBe("runtime");
  expect(reads).toBe(0);
  expect(JSON.stringify(report)).not.toContain("private-access");
});

test("auto OpenAI reports a locked identity even if the other store identity has a credential", async () => {
  const { workspace, home } = await fixture();
  for (const failed of ["codex-subscription:chatgpt", "api-key:openai"]) {
    const storeWithOneFailure: CredentialStore = {
      ...store(null), get: async identity => {
        if (identity.account === failed) throw Error("private secure-store exception");
        return identity.account === "api-key:openai" ? "private-api-key" : JSON.stringify({ accessToken: "private-subscription" });
      },
    };
    const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, provider: "openai" }, store: storeWithOneFailure });
    expect(check(report, "auth")?.status).toBe("error");
    expect(report.authSource).toBe("unknown");
    expect(doctorExitCode(report)).toBe(1);
    expect(JSON.stringify(report)).not.toContain("private-api-key");
    expect(JSON.stringify(report)).not.toContain("private-subscription");
    expect(JSON.stringify(report)).not.toContain("private secure-store exception");
  }
});

test("whitespace-only stored subscription allows auto fallback to stored OpenAI API key", async () => {
  const { workspace, home } = await fixture();
  const inspected: string[] = [];
  const splitStore: CredentialStore = { ...store(null), get: async identity => {
    inspected.push(identity.account);
    return identity.account === "api-key:openai" ? "private-stored-api-key" : "  \n ";
  } };
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, provider: "openai" }, store: splitStore });
  expect(report.authSource).toBe("secure-store");
  expect(check(report, "auth")?.status).toBe("ok");
  expect(inspected).toEqual(["codex-subscription:chatgpt", "api-key:openai", "api-key:anthropic"]);
  expect(JSON.stringify(report)).not.toContain("private-stored-api-key");
});

test("profile identity selects only its configured credential source", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(workspace, ".schway"));
  await writeFile(join(workspace, ".schway", "config.json"), JSON.stringify({
    profile: "local", profiles: { local: { baseUrl: "http://localhost:11434/v1", auth: "required", credentialEnv: "LOCAL_KEY" } },
  }));
  const report = await diagnose({ cwd: workspace, env: { HOME: home, OPENAI_API_KEY: "unrelated", LOCAL_KEY: "selected-secret" }, args, store: store(new Error("locked-secret")) });
  expect(report.provider).toBe("openai-compatible");
  expect(report.profile).toBe("local");
  expect(report.authSource).toBe("environment");
  expect(check(report, "auth")?.status).toBe("ok");
  expect(JSON.stringify(report)).not.toContain("selected-secret");
  expect(JSON.stringify(report)).not.toContain("locked-secret");
});

test("skill duplicates, invalid metadata and attached roots are independently reported", async () => {
  const { workspace, home, root } = await fixture();
  const attach = join(root, "attach");
  for (const dir of [join(workspace, ".agents", "skills", "repeat"), join(workspace, ".agents", "skills", "invalid"), join(attach, ".agents", "skills", "repeat")]) await mkdir(dir, { recursive: true });
  await writeFile(join(workspace, ".agents", "skills", "repeat", "SKILL.md"), "---\nname: repeat\ndescription: first\n---\nFirst instruction.\n");
  await writeFile(join(attach, ".agents", "skills", "repeat", "SKILL.md"), "---\nname: repeat\ndescription: second\n---\nSecond instruction.\n");
  await writeFile(join(workspace, ".agents", "skills", "invalid", "SKILL.md"), "invalid frontmatter");
  const report = await diagnose({ cwd: workspace, env: { HOME: home, OPENAI_API_KEY: "key" }, args: { ...args, addDirs: [attach] }, store: store(null) });
  expect(check(report, "skill.duplicate.0")?.status).toBe("error");
  expect(check(report, "skill.invalid.0")?.status).toBe("error");
  expect(check(report, "skill.invalid.0")?.summary).toContain("invalid");
  expect(check(report, "attachments")?.status).toBe("ok");
});

test("cancellation aborts diagnostics before secure-store reads", async () => {
  const { workspace, home } = await fixture();
  const controller = new AbortController(); controller.abort();
  await expect(diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null), signal: controller.signal })).rejects.toThrow();
});

test("manifest errors are independent and extension code never executes", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(workspace, ".schway"));
  await writeFile(join(workspace, ".schway", "config.json"), JSON.stringify({ packages: ["bad-one", "bad-two", "valid"] }));
  for (const name of ["bad-one", "bad-two", "valid"]) await mkdir(join(workspace, "node_modules", name), { recursive: true });
  await writeFile(join(workspace, "node_modules", "bad-one", "package.json"), "{");
  await writeFile(join(workspace, "node_modules", "bad-two", "package.json"), JSON.stringify({ schway: { extensions: ["missing.ts"] } }));
  const marker = join(workspace, "marker");
  await writeFile(join(workspace, "node_modules", "valid", "extension.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  await writeFile(join(workspace, "node_modules", "valid", "package.json"), JSON.stringify({ schway: { extensions: ["extension.ts"] } }));
  const inspected = await inspectPackages({ workspaceRoot: workspace, home });
  expect(inspected.diagnostics).toHaveLength(2); expect(inspected.packages).toHaveLength(1);
  expect(inspected.issues).toEqual([
    { scope: "project", name: "bad-one", kind: "manifest" },
    { scope: "project", name: "bad-two", kind: "entry", entry: "missing.ts" },
  ]);
  const report = await diagnose({ cwd: workspace, env: { HOME: home, OPENAI_API_KEY: "key" }, args: { ...args, extensions: ["node_modules/valid/extension.ts"] }, store: store(null) });
  expect(report.checks.filter(c => c.id.startsWith("package.") && c.status === "error")).toHaveLength(2);
  expect(report.checks.some(c => c.summary.includes("Duplicate enabled extension"))).toBe(true);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("duplicate skill names never print credential values in check IDs or summaries", async () => {
  const { workspace, home, root } = await fixture();
  const secret = "private-secret-credential";
  const attach = join(root, "attached");
  for (const path of [workspace, attach]) {
    const skill = join(path, ".agents", "skills", secret);
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), `---\nname: ${secret}\ndescription: A duplicate skill.\n---\nRun safely.\n`);
  }
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, addDirs: [attach], apiKey: secret }, store: store(null) });
  expect(check(report, "skill.duplicate.0")?.status).toBe("error");
  expect(check(report, "skill.duplicate.0")?.summary).toContain("***");
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("missing manifest paths are distinct from missing installs and safely identify the entry", async () => {
  const { workspace, home } = await fixture();
  const secret = "private-secret-credential";
  await mkdir(join(workspace, ".schway"));
  await writeFile(join(workspace, ".schway", "config.json"), JSON.stringify({ packages: ["valid", "absent"] }));
  await mkdir(join(workspace, "node_modules", "valid"), { recursive: true });
  await writeFile(join(workspace, "node_modules", "valid", "package.json"), JSON.stringify({ schway: { extensions: ["existing.ts", `missing-${secret}.ts`] } }));
  await writeFile(join(workspace, "node_modules", "valid", "existing.ts"), "export default () => {};");
  const inspected = await inspectPackages({ workspaceRoot: workspace, home });
  expect(inspected.issues).toEqual([
    { scope: "project", name: "valid", kind: "entry", entry: `missing-${secret}.ts` },
    { scope: "project", name: "absent", kind: "missing" },
  ]);
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, apiKey: secret }, store: store(null) });
  expect(check(report, "package.0")?.summary).toContain("missing-***.ts");
  expect(check(report, "package.1")?.summary).toContain("installation");
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("doctor help lists diagnostic flags without implying model runs", async () => {
  const { workspace, home } = await fixture();
  let text = "";
  const exit = await runCli(["doctor", "--help"], {
    cwd: workspace, env: { HOME: home }, stdout: { write(chunk) { text += chunk; } }, stderr: { write() {} },
  });
  expect(exit).toBe(0);
  const doctor = text;
  for (const flag of ["--api-key", "--openai-auth", "--base-url", "--auth", "--header", "--body", "--env-file", "--add-dir", "--extension"]) {
    expect(doctor).toContain(flag);
  }
  expect(doctor).not.toContain("--model");
  expect(doctor).toContain("\nUsage\n  schway doctor [options]\n");
  expect(doctor).toContain("\nExamples\n");
});

test("doctor redacts credential sources but keeps ordinary env-number identifiers", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(workspace, ".schway"));
  await writeFile(join(workspace, ".schway", "config.json"), JSON.stringify({ profiles: { local: { baseUrl: "http://localhost:11434/v1", auth: "none", credentialEnv: "LOCAL_KEY" } } }));
  const report = await diagnose({
    cwd: workspace,
    env: { HOME: home, C: "1", LOCAL_KEY: "profile-secret", OPENAI_API_KEY: "openai-secret" },
    args: { ...args, profile: "local", apiKey: "runtime-secret", headers: { AUTHORIZATION: "Bearer header-secret", "X-API-KEY": "other-header-secret", "X-Other": "ordinary-identifier" },
      extensions: ["plugin-v1.ts", "plugin-profile-secret.ts", "plugin-runtime-secret.ts", "plugin-header-secret.ts", "plugin-other-header-secret.ts", "plugin-openai-secret.ts", "plugin-ordinary-identifier.ts"] },
    store: store(null),
  });
  expect(check(report, "extension.0")?.summary).toContain("plugin-v1.ts");
  expect(check(report, "extension.6")?.summary).toContain("plugin-ordinary-identifier.ts");
  const printed = JSON.stringify(report);
  for (const secret of ["profile-secret", "runtime-secret", "header-secret", "other-header-secret", "openai-secret"]) expect(printed).not.toContain(secret);
  expect(check(report, "extension.3")?.summary).toContain("plugin-***.ts");
});

test("missing extensions and malformed skills expose bounded, redacted source identifiers", async () => {
  const { workspace, home } = await fixture();
  const secret = "private-secret-credential";
  const skill = join(workspace, ".agents", "skills", secret);
  await mkdir(skill, { recursive: true }); await writeFile(join(skill, "SKILL.md"), "malformed frontmatter");
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, apiKey: secret, extensions: [`missing-${secret}.ts`, "missing-other.ts"] }, store: store(null) });
  const summary = JSON.stringify(report);
  expect(summary).not.toContain(secret);
  expect(check(report, "skill.invalid.0")?.remedy).toContain("SKILL.md");
  expect(check(report, "extension.0")?.summary).toContain("***");
  expect(check(report, "extension.1")?.summary).toContain("missing-other.ts");
  expect(summary.length).toBeLessThan(10000);
});

test("doctor reports Grok subscription states without contacting auth or consulting billing credentials", async () => {
  const { workspace, home } = await fixture();
  for (const state of ["present", "refresh", "expired", "invalid", "missing"] as const) {
    const report = await diagnose({ cwd: workspace, env: { HOME: home, XAI_API_KEY: "billing" }, args: { ...args, provider: "xai", xaiAuth: "grok" }, store: { ...store(null), get: async identity => {
      if (identity.account === "api-key:anthropic") return null;
      expect(identity.account).toBe("grok-subscription:xai");
      return state === "missing" ? null : state === "invalid" ? "malformed" : JSON.stringify({ accessToken: "private", obtainedAt: 0, ...(state !== "present" ? { expiresAt: Date.now() + 90_000 } : {}), ...(state === "refresh" ? { refreshToken: "refresh" } : {}) });
    } } });
    expect(report.authSource).toBe("subscription");
    expect(check(report, "auth")?.status).toBe(state === "present" ? "ok" : state === "refresh" ? "warning" : "error");
    expect(JSON.stringify(report)).not.toContain("private");
  }
});
