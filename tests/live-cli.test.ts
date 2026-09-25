import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseLiveArgs, runLiveCli } from "../src/live/cli.ts";
import { withTempDir } from "./helpers.ts";

test("CLI rejects implicit providers, invalid options and missing compatible URL before credentials", () => {
  expect(parseLiveArgs([])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "compatible"])).toHaveProperty("error");
  expect(parseLiveArgs(["--enable-live", "--provider", "anthropic", "--auth", "none"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "anthropic", "--timeout-ms", "999999"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "anthropic", "--model", "anthropic=bad\nsecret"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "compatible", "--enable-live", "--base-url", "https://user:password@example.org/v1"])).toHaveProperty("error");
  expect(parseLiveArgs(["--provider", "compatible", "--enable-live", "--base-url", "https://example.org/v1?token=secret"])).toHaveProperty("error");
});

test("disabled CLI emits redacted, dated incomplete report and no credential discovery", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runLiveCli(["--provider", "all"], {
    env: { ANTHROPIC_API_KEY: "PRIVATE_SECRET" }, revision: "0123456789012345678901234567890123456789",
    out: text => output.push(text), err: text => errors.push(text),
  });
  expect(code).toBe(2);
  expect(errors).toEqual([]);
  const report = JSON.parse(output.join(""));
  expect(report.aggregate).toBe("incomplete");
  expect(report.scenarios.map((s: { reason: string }) => s.reason)).toEqual(Array(4).fill("live_disabled"));
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
    providers: ["anthropic", "openai-api-key", "compatible", "codex"], enabled: true,
    compatible: { baseUrl: "http://localhost:1234/v1", auth: "none" }, models: { codex: "gpt-5.4" },
  } });
});
