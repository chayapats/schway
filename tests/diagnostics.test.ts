import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDiagnosticSink, diagnosticPath } from "../src/diagnostics/sink.ts";

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "schway-debug-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("disabled sink never creates files or inspects input", async () => temporary(async home => {
  const sink = createDiagnosticSink({ home, enabled: false });
  sink.record("test", "skipped", { get dangerous() { throw Error("inspected"); } });
  await sink.close();
  expect(await readdir(home)).toEqual([]);
}));

test("records are correlated, bounded and strip secrets from nested errors, headers and URLs", async () => temporary(async home => {
  const path = diagnosticPath(home);
  const sink = createDiagnosticSink({ home, enabled: true, runId: "run1", sessionId: () => "session1", secrets: ["my-extra-secret"] });
  sink.record("auth", "failed", {
    description: 'Authorization: "unlisted-header-secret" and {"api_key":"unlisted-json-secret"}',
    Authorization: "Bearer sensitive", nested: { api_key: "sensitive", error: Object.assign(new Error("unknown-sensitive-prompt-echo Bearer sensitive my-extra-secret https://alice:pw@host.test/v1?api_key=sensitive&ok=1"), { token: "sensitive" }) },
    url: "https://alice:pw@host.test/v1?access_token=sensitive&ok=1",
    prompt: "private source", content: "private output", count: 4, long: "a".repeat(10000),
  }, "error");
  await sink.close();
  const text = await readFile(path, "utf8");
  expect(text).not.toMatch(/sensitive|my-extra-secret|alice|pw@|private source|private output|unlisted-header-secret|unlisted-json-secret|unknown-sensitive-prompt-echo/);
  const record = JSON.parse(text.trim());
  expect(record).toMatchObject({ level: "error", runId: "run1", sessionId: "session1", component: "auth", event: "failed", fields: { count: 4 } });
  expect(text.length).toBeLessThan(4096);
  expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
}));

test("rotation retains finite files and pending writes are bounded, with nonfatal failure", async () => temporary(async home => {
  const path = join(home, "diag.jsonl");
  const sink = createDiagnosticSink({ home, enabled: true, destination: path, limits: { maxBytes: 400, archives: 2, pending: 3 } });
  for (let i = 0; i < 60; i++) sink.record("test", "step", { index: i });
  expect(sink.dropped).toBeGreaterThan(0);
  await sink.flush();
  for (let i = 60; i < 80; i++) {
    sink.record("test", "step", { index: i });
    await sink.flush();
  }
  await sink.close();
  expect((await readdir(home)).sort()).toEqual(["diag.jsonl", "diag.jsonl.1", "diag.jsonl.2"]);
  for (const name of await readdir(home)) expect((await readFile(join(home, name))).length).toBeLessThanOrEqual(400);
  const failed = createDiagnosticSink({ home, enabled: true, destination: home });
  failed.record("test", "failure", {});
  await failed.close();
  expect(failed.dropped).toBeGreaterThan(0);
}));

test("freeform runtime text is never serialized even when it echoes unknown prompts or credentials", async () => temporary(async home => {
  const sink = createDiagnosticSink({ home, enabled: true });
  const raw = "private-prompt-and-provider-token";
  sink.runtime({ type: "model.retry", attempt: 1, maxAttempts: 3, delayMs: 20, message: raw });
  sink.runtime({ type: "error", message: raw });
  sink.runtime({ type: "compaction.finished", reason: "overflow", status: "failed", message: raw });
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toContain(raw);
  expect(text).not.toContain('"message":');
  expect(text).toContain('"attempt":1');
  expect(text).toContain('"status":"failed"');
}));

test("canonical session targets and symlink aliases cannot be appended or rotated", async () => temporary(async home => {
  const sessions = join(home, ".schway", "sessions");
  await mkdir(sessions, { recursive: true });
  const session = join(sessions, "stored.jsonl");
  const original = '{"type":"session"}\n';
  await writeFile(session, original);
  await chmod(session, 0o600);
  const alias = join(home, "alias.jsonl");
  const hardlink = join(home, "hardlink.jsonl");
  await symlink(session, alias);
  await link(session, hardlink);
  for (const destination of [session, alias, hardlink, join(sessions, "future.jsonl")]) {
    const sink = createDiagnosticSink({ home, enabled: true, destination });
    sink.record("cli", "startup", {});
    await sink.close();
    expect(sink.dropped).toBeGreaterThan(0);
  }
  expect(await readFile(session, "utf8")).toBe(original);
  expect(await readdir(sessions)).toEqual(["stored.jsonl"]);
}));

test("insecure preexisting default directory and file are refused without permission changes", async () => temporary(async home => {
  const directory = join(home, ".schway", "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o755);
  let sink = createDiagnosticSink({ home, enabled: true });
  sink.record("test", "event");
  await sink.close();
  expect(sink.dropped).toBeGreaterThan(0);
  expect(await Bun.file(diagnosticPath(home)).exists()).toBe(false);
  await chmod(directory, 0o700);
  await writeFile(diagnosticPath(home), "original", { mode: 0o644 });
  await chmod(diagnosticPath(home), 0o644);
  sink = createDiagnosticSink({ home, enabled: true });
  sink.record("test", "event");
  await sink.close();
  expect(sink.dropped).toBeGreaterThan(0);
  expect(await readFile(diagnosticPath(home), "utf8")).toBe("original");
}));

test("oversized metadata and unsafe identifiers never enumerate deep getters or expose partial secrets", async () => temporary(async home => {
  const secret = "secret-long-" + "x".repeat(300);
  const sink = createDiagnosticSink({ home, enabled: true, runId: secret, sessionId: () => secret, secrets: [secret] });
  const fields: Record<string, unknown> = { tooBig: "A".repeat(4097) + secret, safe: 1 };
  for (let i = 0; i < 30; i++) Object.defineProperty(fields, `field${i}`, { enumerable: true, get() { throw new Error("enumerated-extra-secret"); } });
  sink.record("test", "event", fields);
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toMatch(/secret-long-|enumerated-extra-secret/);
  expect(text).toContain('"safe":1');
  expect(text.length).toBeLessThan(4096);
}));

test("userinfo with embedded @ and signed credential query are masked", async () => temporary(async home => {
  const sink = createDiagnosticSink({ home, enabled: true });
  sink.record("network", "url", { url: "https://alice:p@ss@host.test/v1?X-Amz-Signature=signature-secret&ok=1" });
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toMatch(/alice|p@ss|signature-secret/);
  expect(text).toContain("host.test");
}));
