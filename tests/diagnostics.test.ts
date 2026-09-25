import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
    Authorization: "Bearer sensitive", nested: { api_key: "sensitive", error: Object.assign(new Error("Bearer sensitive my-extra-secret https://alice:pw@host.test/v1?api_key=sensitive&ok=1"), { token: "sensitive" }) },
    url: "https://alice:pw@host.test/v1?access_token=sensitive&ok=1",
    prompt: "private source", content: "private output", count: 4, long: "a".repeat(10000),
  }, "error");
  await sink.close();
  const text = await readFile(path, "utf8");
  expect(text).not.toMatch(/sensitive|my-extra-secret|alice|pw@|private source|private output|unlisted-header-secret|unlisted-json-secret/);
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
