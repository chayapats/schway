import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, doctorExitCode, formatDoctor } from "../src/doctor/doctor.ts";
import { runCli } from "../src/cli/main.ts";
import { inspectPackages } from "../src/packages/packages.ts";
import { loadResolvedSettings } from "../src/config/config.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { ANTHROPIC_REMOVED_MESSAGE } from "../src/config/removed-provider.ts";
import { readFile } from "node:fs/promises";
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

for (const profileScope of ["user", "project"] as const) test(`a credentialEnv reference in invalid ${profileScope} config protects both scopes across diagnostic consumers`, async () => {
  const { root } = await fixture();
  const secret = "private-cross-scope-credential", home = join(root, secret, "home"), workspace = join(root, secret, "work");
  await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(join(workspace, ".schway"), { recursive: true });
  const invalidProfile = JSON.stringify({ profiles: { constructor: { baseUrl: "https://example.test", credentialEnv: "CUSTOM_KEY" } }, approval: { mode: "readonly" } });
  await writeFile(join(home, ".schway/config.json"), profileScope === "user" ? invalidProfile : "{malformed");
  await writeFile(join(workspace, ".schway/config.json"), profileScope === "project" ? invalidProfile : "{malformed");
  const env = { HOME: home, CUSTOM_KEY: ` ${secret} ` };
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace, diagnosticContext: { env } });
  const editorError = await loadConfigEditor({ home, workspaceRoot: workspace, diagnosticContext: { env } }).catch(error => error as Error);
  const packages = await inspectPackages({ home, workspaceRoot: workspace, diagnosticContext: { env } });
  const report = await diagnose({ cwd: workspace, env, args, store: store(null) });
  expect(settings).toMatchObject({ diagnostics: [expect.any(Object), expect.any(Object)] });
  expect(packages.issues.filter(issue => issue.kind === "configuration")).toHaveLength(2);
  expect(packages.diagnostics).toHaveLength(2);
  expect(check(report, "config.user")?.status).toBe("error");
  expect(check(report, "config.project")?.status).toBe("error");
  expect(check(report, "packages")?.status).toBe("warning");
  for (const output of [JSON.stringify(settings), (editorError as Error).message, JSON.stringify(packages), JSON.stringify(report), formatDoctor(report)]) {
    expect(output).not.toContain(secret);
    expect(output).toContain("approval.mode");
    expect(output).toContain("malformed JSON");
  }
});

test("doctor masks a late-discovered profile credential before truncating the workspace label", async () => {
  const { root, home } = await fixture();
  const prefix = join(root, "a".repeat(180), "b".repeat(180));
  const secret = "private-cross-boundary-credential";
  const workspace = join(prefix, "c".repeat(502 - prefix.length), secret);
  await mkdir(join(workspace, ".schway"), { recursive: true });
  await mkdir(join(home, ".schway"));
  await writeFile(join(home, ".schway/config.json"), JSON.stringify({ profiles: { custom: { baseUrl: "https://example.test", credentialEnv: "CUSTOM_KEY" } } }));
  await writeFile(join(workspace, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const report = await diagnose({ cwd: workspace, env: { HOME: home, CUSTOM_KEY: secret }, args, store: store(null) });
  for (const output of [JSON.stringify(report), formatDoctor(report)]) expect(output).not.toContain("private-");
  expect(report.workspace).toBeDefined();
  expect(report.workspace!.length).toBeLessThanOrEqual(512);
  expect(check(report, "config.project")?.diagnostics?.[0]?.path).toBe("approval.mode");
});

for (const label of ["Bearer\nprivate-source-token", "Authorization:\r\nBearer private-source-token", "x-api-key=private-source-token", "x-api-key\u001b[31m=\u001b[0mprivate-source-token"]) test(`source credential form ${JSON.stringify(label)} is hidden across config outputs`, async () => {
  const { root, home } = await fixture();
  const workspace = join(root, label); await mkdir(join(workspace, ".schway"), { recursive: true });
  await writeFile(join(workspace, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace });
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  let stdout = "", stderr = "";
  const exit = await runCli(["-p", "test"], { cwd: workspace, env: { HOME: home }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  expect(exit).toBe(1); expect(stdout).toBe("");
  for (const output of [JSON.stringify(settings), JSON.stringify(report), formatDoctor(report), stderr]) {
    expect(output).not.toContain("private-source-token"); expect(output).not.toContain("\u001b"); expect(output).not.toContain("\\u001b");
  }
});

for (const source of ["environment", "runtime", "env-file", "header"] as const) test(`doctor removes known ${source} credentials from every source label and remedy`, async () => {
  const { root, home } = await fixture();
  const secret = "private-known-credential", workspace = join(root, secret);
  await mkdir(join(workspace, ".schway"), { recursive: true });
  await writeFile(join(workspace, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const envFile = join(root, "credentials.env"); await writeFile(envFile, `OPENAI_API_KEY=${secret}\n`);
  const env = { HOME: home, ...(source === "environment" ? { OPENAI_API_KEY: secret } : {}) };
  const options = { ...args, ...(source === "runtime" ? { apiKey: secret } : source === "env-file" ? { envFiles: [envFile] } : source === "header" ? { headers: { Authorization: `Bearer ${secret}` } } : {}) };
  const report = await diagnose({ cwd: workspace, env, args: options, store: store(null) });
  const flags = source === "runtime" ? ["--api-key", secret] : source === "env-file" ? ["--env-file", envFile] : source === "header" ? ["--header", `Authorization:Bearer ${secret}`] : [];
  let stdout = "", stderr = "";
  expect(await runCli(["doctor", "--json", ...flags], { cwd: workspace, env, credentialStore: store(null), stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } })).toBe(1);
  for (const output of [JSON.stringify(report), formatDoctor(report), stdout, stderr]) expect(output).not.toContain(secret);
  expect(check(report, "config.project")?.diagnostics?.[0]?.path).toBe("approval.mode");
});

for (const alias of [false, true]) test(`shared user/project config${alias ? " through a symlink" : ""} has one primary failure and incomplete dependent scopes`, async () => {
  const { root, home } = await fixture();
  const workspace = alias ? join(root, "home-alias") : home;
  if (alias) await symlink(home, workspace);
  await mkdir(join(home, ".schway")); await writeFile(join(home, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace });
  const editor = await loadConfigEditor({ home, workspaceRoot: workspace }).catch(error => error as Error);
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(settings).toMatchObject({ diagnostics: [expect.objectContaining({ source: join(home, ".schway/config.json"), path: "approval.mode" })] });
  expect((editor as Error).message.match(/Invalid approval.mode/g)).toHaveLength(1);
  expect(report.checks.filter(c => c.id.startsWith("config.") && c.status === "error")).toHaveLength(1);
  expect(check(report, "config.project")).toMatchObject({ status: "warning", remedy: expect.stringContaining("config.user") });
  expect(check(report, "packages")).toMatchObject({ status: "warning", remedy: expect.stringContaining("config.user") });
  expect(report.checks.flatMap(c => c.diagnostics ?? [])).toHaveLength(1);
  let stderr = "";
  expect(await runCli(["-p", "test"], { cwd: workspace, env: { HOME: home }, stdout: { write: () => { throw Error("stdout must stay empty"); } }, stderr: { write: text => { stderr += text; } } })).toBe(1);
  expect(stderr.match(/Invalid approval.mode/g)).toHaveLength(1);
});

for (const profile of ["constructor", "toString", "hasOwnProperty"]) test(`unconfigured inherited profile ${profile} is an actionable failure before runtime startup`, async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(home, ".schway")); await writeFile(join(home, ".schway/config.json"), JSON.stringify({ profile }));
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace });
  expect(settings).toMatchObject({ diagnostics: [{ source: join(home, ".schway/config.json"), path: "profile", category: "constraint", constraint: "Select a configured compatible profile" }] });
  await expect(loadConfigEditor({ home, workspaceRoot: workspace })).rejects.toThrow("Select a configured compatible profile");
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(report, "provider")?.status).toBe("error"); expect(doctorExitCode(report)).toBe(1);
});

for (const scope of ["user", "project", "both"] as const) test(`${scope} removed provider retains the exact migration notice and source metadata`, async () => {
  const { workspace, home } = await fixture();
  const scopes = scope === "both" ? ["user", "project"] : [scope];
  const paths = scopes.map(current => join(current === "user" ? home : workspace, ".schway/config.json"));
  for (const path of paths) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, '{"provider":"anthropic"}'); }
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace });
  expect(settings).toMatchObject({ error: scopes.map(() => ANTHROPIC_REMOVED_MESSAGE).join("\n"), diagnostics: paths.map(source => expect.objectContaining({ source, path: "provider", category: "removed-provider", constraint: ANTHROPIC_REMOVED_MESSAGE })) });
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  for (const current of scopes) expect(check(report, `config.${current}`)?.summary).toContain(ANTHROPIC_REMOVED_MESSAGE);
  expect(doctorExitCode(report)).toBe(1);
  expect(report.checks.filter(c => c.id.startsWith("package."))).toHaveLength(0);
});

for (const scope of ["user", "project", "cli"] as const) test(`${scope} unknown profile has safe source-aware startup and doctor diagnostics`, async () => {
  const { workspace, home } = await fixture();
  const path = join(scope === "user" ? home : workspace, ".schway/config.json");
  const profile = "private-selection";
  if (scope !== "cli") { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify({ profile, profiles: { "private-available": { baseUrl: "https://example.test" } } })); }
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace, ...(scope === "cli" ? { cli: { profile } } : {}) });
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, ...(scope === "cli" ? { profile } : {}) }, store: store(null) });
  const diagnostic = { source: scope === "cli" ? "CLI settings" : path, path: "profile", category: "constraint", constraint: "Select a configured compatible profile" };
  expect(settings).toMatchObject({ diagnostics: [diagnostic] });
  expect(check(report, "provider")).toMatchObject({ status: "error", summary: "Invalid profile · Select a configured compatible profile", diagnostics: [diagnostic] });
  expect(doctorExitCode(report)).toBe(1);
  expect(JSON.stringify(settings)).not.toContain("private-");
  expect(JSON.stringify(report)).not.toContain("private-");
  expect(formatDoctor(report)).not.toContain("private-");
});

for (const scope of ["user", "project", "both"] as const) test(`${scope} deprecations retain migration, warnings and original files`, async () => {
  const { workspace, home } = await fixture();
  const scopes = scope === "both" ? ["user", "project"] : [scope];
  const configDeprecations = [{ key: "oldModel", replacement: "model", since: "1.0", removeIn: "2.0" }];
  const bytes = JSON.stringify({ oldModel: "configured-model", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", auth: "none" });
  const paths = scopes.map(current => join(current === "user" ? home : workspace, ".schway/config.json"));
  for (const path of paths) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, bytes); }
  const notices: string[] = [];
  const settings = await loadResolvedSettings({ home, workspaceRoot: workspace, configDeprecations, onDeprecation: warning => notices.push(warning.message) });
  expect(settings).toMatchObject({ model: "configured-model" });
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null), configDeprecations });
  expect(doctorExitCode(report)).toBe(0);
  const warnings = report.checks.filter(c => c.id === "config.deprecated.oldModel");
  expect(warnings.map(c => c.summary)).toEqual(notices);
  expect(warnings.map(c => c.diagnostics?.[0]?.source)).toEqual(paths);
  expect(warnings.every(c => c.status === "warning" && c.diagnostics?.[0]?.category === "deprecated")).toBe(true);
  for (const path of paths) expect(await readFile(path, "utf8")).toBe(bytes);
});

test("doctor bounds source identifiers and strips secret-shaped text and terminal controls", async () => {
  const { root, home } = await fixture();
  const workspace = join(root, "sk-private-source\u001b[31m"); await mkdir(join(workspace, ".schway"), { recursive: true });
  await writeFile(join(workspace, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(JSON.stringify(report)).not.toContain("sk-private-source");
  expect(JSON.stringify(report)).not.toContain("\\u001b");
  expect(formatDoctor(report)).not.toContain("\u001b");
});

const configFailures = [
  { name: "malformed JSON", bytes: '{"private-secret', category: "json", path: "" },
  { name: "wrong root", bytes: '["private-secret"]', category: "root", path: "" },
  { name: "unknown root key", value: { "private-secret\u001b[31m\n": true }, category: "unknown-setting", path: "<unknown setting>" },
  { name: "unknown nested key", value: { ui: { "private-secret\u001b]8;;url\u0007": true } }, category: "unknown-setting", path: "ui.<unknown setting>" },
  { name: "enum", value: { approval: { mode: "private-secret" } }, category: "enum", path: "approval.mode" },
  { name: "type", value: { maxTurns: "private-secret" }, category: "type", path: "maxTurns" },
  { name: "range", value: { ui: { inlineDiffLines: -1 } }, category: "range", path: "ui.inlineDiffLines" },
  { name: "profile type", value: { profiles: { "private-secret\n": { baseUrl: "https://example.com", model: {} } } }, category: "type", path: "profiles.<unknown setting>.model" },
  { name: "profile URL", value: { profiles: { "private-secret": { baseUrl: "https://user:private-secret@example.com?token=private-secret" } } }, category: "constraint", path: "profiles.<unknown setting>.baseUrl" },
  { name: "profile credential", value: { profiles: { "private-secret": { baseUrl: "https://example.com", credentialEnv: "Bearer private-secret" } } }, category: "constraint", path: "profiles.<unknown setting>.credentialEnv" },
  { name: "forbidden secret", value: { token: "private-secret" }, category: "secret", path: "<unknown setting>" },
  { name: "secret header", value: { headers: { Authorization: "Bearer private-secret" } }, category: "secret", path: "headers.<unknown setting>" },
  { name: "unreadable", directory: true, category: "unreadable", path: "" },
] as const;

for (const scope of ["user", "project", "both"] as const) for (const sample of configFailures) {
  test(`${scope} ${sample.name} has the same sanitized doctor and startup cause`, async () => {
    const { workspace, home } = await fixture();
    const scopes = scope === "both" ? ["user", "project"] : [scope];
    for (const current of scopes) {
      const file = join(current === "user" ? home : workspace, ".schway/config.json");
      await mkdir(join(current === "user" ? home : workspace, ".schway"), { recursive: true });
      if ("directory" in sample) await mkdir(file);
      else await writeFile(file, "bytes" in sample ? sample.bytes : JSON.stringify(sample.value));
    }
    const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
    expect(report.schemaVersion).toBe(1); expect(doctorExitCode(report)).toBe(1);
    expect(report.checks.filter(c => c.id.startsWith("config.") && c.status === "error")).toHaveLength(scopes.length);
    expect(report.checks.filter(c => c.id.startsWith("package."))).toHaveLength(0);
    let stdout = "", stderr = "";
    const code = await runCli(["-p", "test"], { cwd: workspace, env: { HOME: home }, credentialStore: store(null), createModel: async () => { throw Error("model must not load"); }, fetch: async () => { throw Error("network must not run"); }, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    expect(code).toBe(1); expect(stdout).toBe("");
    for (const current of scopes) {
      const item = check(report, `config.${current}`)!;
      expect(item.diagnostics).toEqual([expect.objectContaining({ source: join(current === "user" ? home : workspace, ".schway/config.json"), path: sample.path, category: sample.category })]);
      expect(stderr).toContain(item.summary);
      expect(stderr).toContain(item.diagnostics![0]!.source);
    }
    for (const output of [JSON.stringify(report), formatDoctor(report), stderr]) {
      expect(output).not.toContain("private-secret"); expect(output).not.toContain("\u001b"); expect(output).not.toContain("\\u001b"); expect(output).not.toContain("Expected union value");
    }
  });
}

test("doctor reports one actionable config cause and retains independent package and extension failures", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(home, ".schway")); await mkdir(join(workspace, ".schway"));
  await writeFile(join(home, ".schway/config.json"), '{"approval":{"mode":"readonly"}}');
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(report, "config.user")).toMatchObject({ status: "error", summary: "Invalid approval.mode · Use auto, ask, or read-only", diagnostics: [{ path: "approval.mode", category: "enum", source: join(home, ".schway/config.json"), constraint: "Use auto, ask, or read-only", values: ["auto", "ask", "read-only"] }] });
  expect(report.checks.filter(c => c.id.startsWith("package."))).toEqual([]);
  expect(check(report, "packages")).toMatchObject({ status: "warning", remedy: expect.stringContaining("config.user") });
  expect(check(report, "approval-config")?.status).toBe("warning");
  expect(check(report, "extensions")?.status).toBe("warning");
  await writeFile(join(workspace, ".schway/config.json"), '{"packages":["missing-package"]}');
  await writeFile(join(home, ".schway/sessions"), "not a directory");
  const skill = join(workspace, ".agents/skills/broken/SKILL.md");
  await mkdir(join(skill, ".."), { recursive: true }); await writeFile(skill, "malformed frontmatter");
  const independent = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, extensions: ["missing-extension.ts"] }, store: store(null) });
  expect(independent.checks.filter(c => c.id.startsWith("package."))).toEqual([expect.objectContaining({ status: "error", summary: expect.stringContaining("missing-package has a missing installation") })]);
  expect(check(independent, "extension.0")?.status).toBe("error");
  expect(check(independent, "sessions")?.status).toBe("error");
  expect(independent.checks.some(c => c.id.startsWith("skill.") && c.status === "error")).toBe(true);
  expect(doctorExitCode(independent)).toBe(1);
});

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


test("undo-store diagnoses sizes without changing files and compares bytes before rounding", async () => {
  const { workspace, home } = await fixture();
  const missing = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(missing, "undo-store")).toMatchObject({ status: "ok", summary: "Undo store: 0.0 MB.", remedy: "None." });
  await mkdir(join(home, ".schway/undo/session/blobs"), { recursive: true });
  await writeFile(join(home, ".schway/config.json"), JSON.stringify({ undo: { maxSizeMB: 1 } }));
  const blob = join(home, ".schway/undo/session/blobs/content");
  await writeFile(blob, Buffer.alloc(1024 * 1024 + 1));
  const before = await stat(blob);
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: store(null) });
  expect(check(report, "undo-store")).toMatchObject({ status: "warning", summary: "Undo store: 1.0 MB.", remedy: "Lower undo.maxSizeMB or delete old sessions." });
  expect(JSON.parse(JSON.stringify(report)).checks.some((c: { id: string }) => c.id === "undo-store")).toBe(true);
  expect((await stat(blob)).mtimeMs).toBe(before.mtimeMs);
  expect((await readdir(join(home, ".schway"))).sort()).toEqual(["config.json", "undo"]);
});


test("approval-config diagnoses the file baseline without reading CLI approval", async () => {
  const { workspace, home } = await fixture();
  const initial = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, approval: "read-only" }, store: store(null) });
  expect(check(initial, "approval-config")).toEqual({ id: "approval-config", status: "ok", summary: "Approval mode: auto.", remedy: "None." });
  await mkdir(join(home, ".schway"), { recursive: true });
  await mkdir(join(workspace, ".schway"), { recursive: true });
  await writeFile(join(home, ".schway/config.json"), JSON.stringify({ approval: { mode: "read-only" } }));
  await writeFile(join(workspace, ".schway/config.json"), JSON.stringify({ approval: { mode: "auto" } }));
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { ...args, approval: "auto" }, store: store(null) });
  expect(check(report, "approval-config")).toEqual({ id: "approval-config", status: "warning", summary: 'Project approval.mode "auto" is looser than your "read-only" and is ignored.', remedy: `Remove approval.mode from ${join(workspace, ".schway/config.json")} or set a stricter mode.` });
});

test("doctor JSON carries the shared deprecation text and exits zero for warnings", async () => {
  const { workspace, home } = await fixture();
  await mkdir(join(home, ".schway"));
  const path = join(home, ".schway/config.json");
  await writeFile(path, JSON.stringify({ oldModel: "local", provider: "openai-compatible", baseUrl: "http://localhost:1234/v1", auth: "none" }));
  const configDeprecations = [{ key: "oldModel", replacement: "model", since: "1.1.0", removeIn: "2.0" }];
  let stdout = "", stderr = "";
  const code = await runCli(["doctor", "--json"], { cwd: workspace, env: { HOME: home }, credentialStore: store(null), configDeprecations,
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  expect(code, stdout + stderr).toBe(0); expect(stderr).toBe("");
  const report = JSON.parse(stdout);
  expect(report.checks.filter((entry: { id: string }) => entry.id.startsWith("config.deprecated."))).toEqual([{
    id: "config.deprecated.oldModel", status: "warning",
    diagnostics: [{ source: path, path: "oldModel", category: "deprecated", constraint: "Use model" }],
    summary: `Config: "oldModel" in ${path} is deprecated; use "model". It will be removed in 2.0.`,
    remedy: `Replace "oldModel" with "model" in ${path}.`,
  }]);
});
