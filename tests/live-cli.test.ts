import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { parseLiveArgs, runLiveCli } from "../src/live/cli.ts";
import { withTempDir } from "./helpers.ts";

test("CLI rejects implicit providers, invalid options and missing compatible URL before credentials", () => {
  expect(parseLiveArgs([])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "openai-api-key", "--auth", "none"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "openai-api-key", "--timeout-ms", "999999"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "openai-api-key", "--model", "openai-api-key=bad\nsecret"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "compatible", "--enable-live", "--base-url", "https://user:password@example.org/v1"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "compatible", "--enable-live", "--base-url", "https://example.org/v1?token=secret"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible", "--base-url", "http://127.0.0.1:1234/v1"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "all", "--base-url", "http://localhost:1234/v1", "--auth", "required"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible", "--base-url", "http://example.org/v1", "--auth", "none"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible", "--base-url", "https://example.org/v1"])).toHaveProperty("selection");
  expect(parseLiveArgs(["--provider", "xai-api-key", "--model", "xai-api-key=grok-4"])).toMatchObject({ selection: { models: { "xai-api-key": "grok-4" } } });
  expect(parseLiveArgs([])).toMatchObject({ error: "Select --provider openai-api-key|xai-api-key|compatible|codex|grok|all (or a comma-separated list)." });
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible", "--base-url", "http://[::1]:1234/v1", "--auth", "none"])).toHaveProperty("selection");
});

test("compatible profile and credential identity reject control chars and >200 chars before any worker", async () => {
  for (const flag of ["--profile", "--credential-identity"]) {
    for (const value of ["bad\nvalue", "bad\tvalue", "bad\x7fvalue", "x".repeat(201)]) {
      expect(parseLiveArgs(["--provider", "compatible", "--base-url", "https://example.org/v1", flag, value])).toHaveProperty("error");
    }
  }
  const accepted = parseLiveArgs(["--enable-live", "--provider", "compatible", "--base-url", "https://example.org/v1",
    "--profile", "p".repeat(200), "--credential-identity", "with spaces " + "i".repeat(188)]);
  expect(accepted).toMatchObject({ selection: { compatible: {
    profile: "p".repeat(200), credentialIdentity: "with spaces " + "i".repeat(188),
  } } });
  const spawned = spyOn(Bun, "spawn");
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const code = await runLiveCli(["--provider", "compatible", "--base-url", "https://example.org/v1", "--credential-identity", "bad\nvalue"], {
      env: { OPENAI_COMPATIBLE_API_KEY: "fixture-key-not-real" }, revision: "fixture-revision",
      out: text => output.push(text), err: text => errors.push(text),
    });
    expect(code).toBe(1);
    expect(spawned).not.toHaveBeenCalled();
  } finally { spawned.mockRestore(); }
  expect(output).toEqual([]);
  expect(errors.join("")).not.toContain("fixture-key-not-real");
});

test("disabled CLI emits redacted, dated incomplete report and no credential discovery", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runLiveCli(["--provider", "all"], {
    env: { OPENAI_API_KEY: "PRIVATE_SECRET" }, revision: "0123456789012345678901234567890123456789",
    out: text => output.push(text), err: text => errors.push(text),
  });
  expect(code).toBe(2);
  expect(errors).toEqual([]);
  const report = JSON.parse(output.join(""));
  expect(report.aggregate).toBe("incomplete");
  expect(report.scenarios.map((s: { provider: string; reason: string }) => `${s.provider}:${s.reason}`)).toEqual([
    "openai-api-key:live_disabled", "xai-api-key:live_disabled", "compatible:live_disabled", "codex:live_disabled", "grok:live_disabled",
  ]);
  expect(output.join("")).not.toContain("PRIVATE_SECRET");
  expect(report.revision).toBe("0123456789012345678901234567890123456789");
  expect(report.testedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
});

test("installed package includes the runnable live command and its documentation", async () => {
  await withTempDir(async dir => {
    const root = join(import.meta.dir, "..");
    const manifest = (await Bun.file(join(root, "package.json")).json()) as { files: string[] };
    expect(manifest.files).toContain("docs/live-providers.md");
    expect(manifest.files).toContain("docs/doctor.md"); // Added by #54 after branch integration.
    const packed = Bun.spawn(["npm", "pack", "--offline", "--ignore-scripts", "--pack-destination", dir, "--silent"],
      { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [filename, stderr, code] = await Promise.all([
      new Response(packed.stdout).text(), new Response(packed.stderr).text(), packed.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const archive = Bun.spawn(["tar", "-tzf", join(dir, filename.trim())], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [listing, archiveCode] = await Promise.all([new Response(archive.stdout).text(), archive.exited]);
    expect(archiveCode).toBe(0);
    const entries = listing.trim().split("\n");
    expect(entries).toContain("package/src/live/cli.ts");
    expect(entries).toContain("package/docs/live-providers.md");
    if (await Bun.file(join(root, "docs/doctor.md")).exists()) expect(entries).toContain("package/docs/doctor.md");
  });
}, 30_000);

test("all lane parsing supports per-provider models and isolated compatible settings", () => {
  const result = parseLiveArgs(["--provider", "all", "--enable-live", "--base-url", "http://localhost:1234/v1", "--auth", "none", "--model", "codex=gpt-5.4"]);
  expect(result).toMatchObject({ selection: {
    providers: ["openai-api-key", "xai-api-key", "compatible", "codex", "grok"], enabled: true,
    compatible: { baseUrl: "http://localhost:1234/v1", auth: "none" }, models: { codex: "gpt-5.4" },
  } });
});

test("Grok live model override parses independently", () => {
  expect(parseLiveArgs(["--provider", "grok", "--model", "grok=grok-fixture"])).toMatchObject({ selection: { providers: ["grok"], models: { grok: "grok-fixture" } } });
});
