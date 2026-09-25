import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli/main.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { diagnosticPath } from "../src/diagnostics/sink.ts";

async function withHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "schway-diag-cli-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("debug opt-in keeps runtime JSONL and durable semantic JSONL separate", async () => withHome(async home => {
  let stdout = "";
  const invoke = (flags: string[]) => runCli(["-p", "hello", "--json", ...flags], {
    cwd: home, env: { HOME: home, ANTHROPIC_API_KEY: "secret-sentinel" },
    stdout: { write(chunk) { stdout += chunk; } }, stderr: { write() {} },
    model: createScriptedModel({ text: "hello" }),
  });
  expect(await invoke([])).toBe(0);
  expect(await Bun.file(diagnosticPath(home)).exists()).toBe(false);
  stdout = "";
  expect(await invoke(["--debug"])).toBe(0);
  const events = stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string });
  expect(events.map(event => event.type)).toEqual(["agent.started", "model.started", "model.delta", "model.finished", "agent.finished"]);
  const lines = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { runId: string; sessionId: string; event: string });
  expect(lines.map(line => line.event)).toContain("agent.finished");
  expect(lines[0]?.runId).toBeTruthy();
  expect(lines.find(line => line.event === "agent.finished")?.sessionId).toBeTruthy();
  expect((await readdir(join(home, ".schway", "sessions"))).length).toBe(2);
  for (const file of await readdir(join(home, ".schway", "sessions"))) {
    expect(await readFile(join(home, ".schway", "sessions", file), "utf8")).not.toContain('"agent.started"');
  }
}));

test("retries and errors log sanitized metadata without streamed prompt or tool payload", async () => withHome(async home => {
  const key = "secret-sentinel";
  const code = await runCli(["-p", "private prompt", "--debug", "--api-key", key], {
    cwd: home, env: { HOME: home }, stdout: { write() {} }, stderr: { write() {} },
    model: createScriptedModel({ responses: [{ error: `Bearer ${key} unavailable`, status: 429, headers: { "retry-after": "0" } }, { error: `https://alice:pw@host.test/?access_token=${key} blocked`, status: 400 }] }),
  });
  expect(code).toBe(1);
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toMatch(/secret-sentinel|private prompt|alice|pw@/);
  expect(text).toContain('"event":"model.retry"');
  expect(text).toContain('"event":"error"');
}));

test("configuration and model-load failures log only safe categories", async () => withHome(async home => {
  const io = { cwd: home, env: { HOME: home, ANTHROPIC_API_KEY: "key" }, stdout: { write() {} }, stderr: { write() {} } };
  expect(await runCli(["-p", "hello", "--debug", "--provider", "openai-compatible"], io)).toBe(1);
  const sensitiveError = "unknown-provider-error-echoed-private-prompt";
  expect(await runCli(["-p", "hello", "--debug"], { ...io, createModel: async () => { throw new Error(sensitiveError); } })).toBe(1);
  const records = await readFile(diagnosticPath(home), "utf8");
  expect(records).not.toContain(sensitiveError);
  expect(records).toContain('"event":"invalid_configuration"');
  expect(records).toContain('"event":"load_failed"');
}));

test("CLI model identifier with websocket userinfo cannot expose URL credentials in diagnostic file", async () => withHome(async home => {
  const identifier = "wss://alice:websocket-secret@host.test/v1?X-Amz-Signature=signature-secret";
  const code = await runCli(["-p", "hello", "--debug", "--model", identifier], {
    cwd: home, env: { HOME: home }, stdout: { write() {} }, stderr: { write() {} },
    model: createScriptedModel({ text: "done" }),
  });
  expect(code).toBe(0);
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toMatch(/alice|websocket-secret|signature-secret/);
  expect(text).toContain("host.test");
}));

test("cancellation drains pending diagnostics without changing session semantics", async () => withHome(async home => {
  const controller = new AbortController();
  let started!: () => void;
  const wait = new Promise<void>(resolve => { started = resolve; });
  const run = runCli(["-p", "hello", "--json", "--debug"], {
    cwd: home, env: { HOME: home }, signal: controller.signal,
    stdout: { write() {} }, stderr: { write() {} },
    model: { provider: "scripted", id: "scripted", async *stream(request) {
      started();
      await new Promise<void>(resolve => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      const error = new Error("aborted"); error.name = "AbortError"; throw error;
    } },
  });
  await wait;
  controller.abort();
  expect(await run).toBe(1);
  const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; fields?: { reason?: string } });
  expect(records.find(record => record.event === "agent.finished")?.fields?.reason).toBe("cancelled");
}));

test("unwritable diagnostic destination cannot suppress tool settlement", async () => withHome(async home => {
  let stdout = "";
  const code = await runCli(["-p", "hello", "--json", "--debug", "--debug-file", home], {
    cwd: home, env: { HOME: home }, stdout: { write(chunk) { stdout += chunk; } }, stderr: { write() {} },
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "note.txt", content: "settled" } }] }, { text: "done" }] }),
  });
  expect(code).toBe(0);
  expect(stdout).toContain('"type":"tool.finished"');
  expect(await readFile(join(home, "note.txt"), "utf8")).toBe("settled");
  const session = (await readdir(join(home, ".schway", "sessions")))[0]!;
  expect(await readFile(join(home, ".schway", "sessions", session), "utf8")).toContain('"tool_result"');
}));

test("rotation rejection cannot suppress tool or session settlement", async () => withHome(async home => {
  const destination = join(home, "rotating.jsonl");
  const original = "#".repeat(1_048_575);
  await writeFile(destination, original);
  await mkdir(`${destination}.3`);
  await writeFile(join(`${destination}.3`, "keep"), "unchanged");
  let stdout = "";
  const code = await runCli(["-p", "write", "--json", "--debug-file", destination], {
    cwd: home, env: { HOME: home }, stdout: { write(chunk) { stdout += chunk; } }, stderr: { write() {} },
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "note.txt", content: "settled" } }] }, { text: "done" }] }),
  });
  expect(code).toBe(0);
  expect(stdout).toContain('"type":"tool.finished"');
  expect(await readFile(join(home, "note.txt"), "utf8")).toBe("settled");
  expect(await readFile(destination, "utf8")).toBe(original);
  expect(await readFile(join(`${destination}.3`, "keep"), "utf8")).toBe("unchanged");
  const session = (await readdir(join(home, ".schway", "sessions")))[0]!;
  expect(await readFile(join(home, ".schway", "sessions", session), "utf8")).toContain('"tool_result"');
}));

test("debug path targeting a resumed session, including symlink alias, cannot corrupt history", async () => withHome(async home => {
  const io = { cwd: home, env: { HOME: home }, stdout: { write() {} }, stderr: { write() {} }, model: createScriptedModel({ text: "ok" }) };
  expect(await runCli(["-p", "hello"], io)).toBe(0);
  const sessionName = (await readdir(join(home, ".schway", "sessions")))[0]!;
  const id = sessionName.slice(0, -".jsonl".length);
  const session = join(home, ".schway", "sessions", sessionName);
  const alias = join(home, "alias.jsonl");
  await symlink(session, alias);
  for (const path of [session, alias]) {
    const before = await readFile(session, "utf8");
    expect(await runCli(["-p", "continue", "--resume", id, "--debug-file", path], { ...io, model: createScriptedModel({ text: "ok" }) })).toBe(0);
    const after = await readFile(session, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).not.toContain('"component":"cli"');
    expect(after).not.toContain('"event":"agent.finished"');
  }
  expect((await readdir(join(home, ".schway", "sessions")))).toEqual([sessionName]);
}));
