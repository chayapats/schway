import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { parseArgs } from "../src/cli/args.ts";
import { parseConfigObject } from "../src/config/config.ts";
import { ANTHROPIC_REMOVED_MESSAGE } from "../src/config/removed-provider.ts";
import { diagnose, doctorExitCode } from "../src/doctor/doctor.ts";
import { LEGACY_ANTHROPIC_ACCOUNT, type CredentialIdentity, type CredentialStore } from "../src/auth/store.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { listCatalog } from "../src/model/catalog.ts";
import { collect } from "./helpers/scripted-model.ts";
import { encodeSse, sampleRequest, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "schway-anthropic-removed-")); dirs.push(root);
  const workspace = join(root, "work"); const home = join(root, "home");
  await mkdir(join(workspace, ".git"), { recursive: true }); await mkdir(join(home, ".schway"), { recursive: true });
  return { workspace, home };
}
async function run(argv: string[], home: string, cwd: string) {
  let stdout = "", stderr = "";
  const exitCode = await runCli(argv, {
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } } as never,
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } } as never,
    env: { HOME: home, ANTHROPIC_API_KEY: "sk-ant-ignored" },
    cwd,
    credentialStore: { get: async () => null, set: async () => {}, delete: async () => false },
  });
  return { exitCode, stdout, stderr };
}

test("the removal notice names the supported replacement and the docs", () => {
  expect(ANTHROPIC_REMOVED_MESSAGE).toBe([
    "Anthropic support ended in 0.4",
    "Use Claude through a compatible endpoint:",
    "  schway --provider openai-compatible --base-url <url> --model <id>",
    "See docs/configuration.md",
  ].join("\n"));
});

test("naming the Anthropic provider in arguments or configuration is rejected with the notice", () => {
  expect(parseArgs(["--provider", "anthropic"])).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  expect(parseArgs(["--provider=anthropic"])).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  expect(parseConfigObject({ provider: "anthropic" }, "user config")).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  expect(parseArgs(["--provider", "bogus"])).toEqual({ error: "Unknown provider: bogus" });
});

test("headless and interactive launches fail before any model or terminal work", async () => {
  const { workspace, home } = await fixture();
  for (const argv of [["-p", "hello", "--provider", "anthropic"], ["--provider", "anthropic"], ["doctor", "--provider", "anthropic"]]) {
    const result = await run(argv, home, workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(`${ANTHROPIC_REMOVED_MESSAGE}\n`);
    expect(result.stdout).toBe("");
  }
  await writeFile(join(home, ".schway", "config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }));
  for (const argv of [["-p", "hello"], []]) {
    const result = await run(argv, home, workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(ANTHROPIC_REMOVED_MESSAGE);
    expect(result.stdout).toBe("");
  }
});

test("the catalog and package no longer offer the Anthropic route", async () => {
  expect(listCatalog().some(model => model.provider === "anthropic" || model.id.startsWith("claude"))).toBe(false);
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json() as { dependencies?: Record<string, string> };
  expect(Object.keys(pkg.dependencies ?? {}).some(name => name.includes("anthropic"))).toBe(false);
});

const legacyStore = (present: boolean, reads: string[] = []): CredentialStore => ({
  get: async (identity: CredentialIdentity) => { reads.push(identity.account); return present && identity.account === LEGACY_ANTHROPIC_ACCOUNT ? "sk-ant-secret" : null; },
  set: async () => { throw Error("unexpected mutation"); },
  delete: async () => { throw Error("unexpected mutation"); },
});

test("doctor reports a stored Anthropic credential as unused with removal steps and never shows it", async () => {
  const { workspace, home } = await fixture();
  const args = { json: true, help: false, provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:1/v1", auth: "none" as const };
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: legacyStore(true) });
  const found = report.checks.find(item => item.id === "credentials.anthropic");
  expect(found?.status).toBe("warning");
  expect(found?.summary).toContain("unused");
  expect(found?.remedy).toContain("Bun.secrets.delete");
  expect(found?.remedy).toContain(LEGACY_ANTHROPIC_ACCOUNT);
  expect(JSON.stringify(report)).not.toContain("sk-ant-secret");
  expect(doctorExitCode(report)).toBe(report.checks.some(item => item.status === "error") ? 1 : 0);
  const clean = await diagnose({ cwd: workspace, env: { HOME: home }, args, store: legacyStore(false) });
  expect(clean.checks.some(item => item.id === "credentials.anthropic")).toBe(false);
});

test("a session recorded with Anthropic continues on OpenAI without Anthropic reasoning data", async () => {
  let body = "";
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: async (_input, init) => {
      body = String(init?.body);
      return new Response(encodeSse(TEXT_STREAM_EVENTS), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const request = sampleRequest();
  await collect(model.stream({
    ...request,
    items: [
      ...request.items,
      {
        type: "assistant", id: "a1",
        content: [
          { type: "thinking", text: "plan", providerMetadata: { anthropic: { signature: "ANTHROPIC-SIGNATURE" } } },
          { type: "tool_call", id: "toolu_1", name: "read", arguments: { path: "a.txt" }, providerMetadata: { anthropic: { id: "ANTHROPIC-BLOCK" } } },
        ],
        providerMetadata: { anthropic: { message_id: "msg_ANTHROPIC", stop_reason: "tool_use" } },
      },
      { type: "tool_result", id: "r1", toolCallId: "toolu_1", content: "contents", isError: false },
      { type: "user", id: "u2", content: [{ type: "text", text: "continue" }] },
    ],
  }));
  expect(body).toContain("toolu_1");
  expect(body).not.toMatch(/anthropic|signature|msg_/i);
});

test("case variants and in-session model selection also get the notice", async () => {
  expect(parseArgs(["--provider", "Anthropic"])).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  expect(parseConfigObject({ provider: "Anthropic" }, "user config")).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  const { parseModelArgs } = await import("../src/tui/commands.ts");
  expect(parseModelArgs("anthropic/claude-sonnet-4-6", "openai")).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
});

test("the space-separated /model form and an invalid config still get the notice and the doctor warning", async () => {
  const { parseModelArgs } = await import("../src/tui/commands.ts");
  expect(parseModelArgs("anthropic claude-sonnet-4-6", "openai")).toEqual({ error: ANTHROPIC_REMOVED_MESSAGE });
  const { workspace, home } = await fixture();
  await writeFile(join(home, ".schway", "config.json"), JSON.stringify({ provider: "anthropic" }));
  const report = await diagnose({ cwd: workspace, env: { HOME: home }, args: { json: true, help: false }, store: legacyStore(true) });
  expect(report.checks.find(item => item.id === "config.user")?.status).toBe("error");
  expect(report.checks.find(item => item.id === "credentials.anthropic")?.status).toBe("warning");
});
