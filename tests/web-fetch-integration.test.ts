import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_HEADLESS_DENIAL, READ_ONLY_DENIAL, READ_ONLY_HEADLESS_DENIAL, type ApprovalPolicy } from "../src/agent/approval.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { WEB_LOOKUP_GUIDANCE } from "../src/context/prompt.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ToolResult } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createSession } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
import { createToolRegistry, type ToolRegistry } from "../src/tools/registry.ts";
import { webFetchTool } from "../src/tools/web-fetch.ts";
import { TuiController } from "../src/tui/controller.ts";
import { toolPresentation, toolTarget } from "../src/tui/presentation.ts";
import { credentialValues, displayUrl, maskCredentialsInText } from "../src/tools/web-fetch-display.ts";
import { createWebFetchTool, type WebFetchDetails } from "../src/tools/web-fetch.ts";
import { buildTranscriptFromSession, formatToolFinishedText, summarizeToolResult, webFetchDisplayText } from "../src/tui/transcript-format.ts";
import { branchTreePreviewForRecord, buildBranchTreeSnapshot } from "../src/tui/branch-tree.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Loopback page fixture that records every request path. */
function pageServer() {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/secure") return new Response(`<h1>Unauthorized</h1><p>Token rejected for ${request.url}</p>`, { status: 401, headers: { "Content-Type": "text/html" } });
      return new Response("<h1>Forecast</h1><p>Rain after 3 pm.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
  cleanups.push(() => server.stop(true));
  return { hits, base: `http://127.0.0.1:${server.port}` };
}

/** Run one scripted round of tool calls through the real loop and scheduler. */
async function round(options: { tools: ToolRegistry; calls: Array<{ id: string; name: string; arguments: unknown }>; approval?: ApprovalPolicy; root?: string; extensions?: Parameters<typeof runAgentLoop>[0]["extensions"] }) {
  const workspace = options.root ? await resolveWorkspace(options.root) : { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "go" }] }]);
  const events: RuntimeEvent[] = [];
  for await (const event of runAgentLoop({
    session, workspace, tools: options.tools, approval: options.approval, extensions: options.extensions,
    model: createScriptedModel({ responses: [{ toolCalls: options.calls }, { text: "done" }] }),
    contextManager: createContextManager(workspace),
  })) events.push(event);
  const results = session.items.filter((item): item is ToolResult => item.type === "tool_result");
  return { results, events };
}

const neverAsk: ApprovalPolicy["ask"] = async request => { throw new Error(`Unexpected approval request for ${request.toolName}`); };

test("web_fetch runs without an approval request in auto, interactive ask and read-only while bash keeps its approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "schway-fetch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fixture = pageServer();
  const tools = createToolRegistry([bashTool, webFetchTool]);
  const asked: string[] = [];
  const modes: Array<{ label: string; approval: ApprovalPolicy; bash: string | undefined }> = [
    { label: "auto", approval: { interactive: true, mode: () => "auto", ask: neverAsk }, bash: undefined },
    { label: "ask", approval: { interactive: true, mode: () => "ask", ask: async request => { asked.push(request.toolName); return { kind: "deny", reason: "Not now." }; } }, bash: "Not now." },
    { label: "read-only", approval: { interactive: true, mode: () => "read-only", ask: neverAsk }, bash: READ_ONLY_DENIAL },
    { label: "headless read-only", approval: { interactive: false, mode: () => "read-only" }, bash: READ_ONLY_HEADLESS_DENIAL },
    { label: "headless ask", approval: { interactive: false, mode: () => "ask" }, bash: ASK_HEADLESS_DENIAL },
  ];
  for (const mode of modes) {
    const before = fixture.hits.length;
    const { results, events } = await round({ root, tools, approval: mode.approval, calls: [
      { id: "fetch", name: "web_fetch", arguments: { url: `${fixture.base}/${mode.label.replace(" ", "-")}` } },
      { id: "shell", name: "bash", arguments: { command: "printf ran" } },
    ] });
    expect(fixture.hits.length - before).toBe(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]!.content).toContain("# Forecast\n\nRain after 3 pm.");
    expect(events.some(event => event.type === "tool.denied" && event.name === "web_fetch")).toBe(false);
    if (mode.bash === undefined) expect(results[1]).toMatchObject({ isError: false, content: "Exit code: 0\n\nstdout:\nran" });
    else expect(results[1]).toMatchObject({ isError: true, content: mode.bash });
  }
  expect(asked).toEqual(["bash"]);
  // #317 telemetry: web_fetch results carry timing like any other tool.
  const { events, results } = await round({ root, tools, calls: [{ id: "timed", name: "web_fetch", arguments: { url: `${fixture.base}/timed` } }] });
  const finished = events.find(event => event.type === "tool.finished" && event.toolCallId === "timed");
  expect(finished).toMatchObject({ status: "success" });
  expect(typeof (finished as { durationMs?: unknown }).durationMs).toBe("number");
  expect(typeof (finished as { startedAt?: unknown }).startedAt).toBe("string");
  expect(results[0]).toMatchObject({ isError: false });
});

test("a beforeTool denial sends no request and afterTool sees the fetch outcome", async () => {
  await withTempDir(async dir => {
    const fixture = pageServer();
    const path = join(dir, "policy.ts");
    await Bun.write(path, `export const seen = [];
      export default ctx => {
        ctx.beforeTool(input => input.name === 'web_fetch' && input.arguments.url.includes('/blocked') ? { deny: 'Blocked by policy.' } : undefined);
        ctx.afterTool(input => { if (input.name === 'web_fetch') seen.push(input.outcome.status + ':' + input.outcome.details.status); });
      };`);
    const workspace = await resolveWorkspace(dir);
    const loaded = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry([webFetchTool]) });
    cleanups.push(() => loaded.runtime.dispose());
    const { results } = await round({ root: dir, tools: loaded.tools, extensions: loaded.runtime, calls: [
      { id: "blocked", name: "web_fetch", arguments: { url: `${fixture.base}/blocked` } },
      { id: "allowed", name: "web_fetch", arguments: { url: `${fixture.base}/allowed` } },
    ] });
    expect(fixture.hits).toEqual(["/allowed"]);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]!.content).toContain("Blocked by policy.");
    expect(results[1]).toMatchObject({ isError: false });
    const module = await import(await realpath(path));
    expect(module.seen).toEqual(["success:200"]);
  });
});

test("an extension tool named web_fetch fails to load with the collision error", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "fetcher.ts");
    await Bun.write(path, `export default ctx => ctx.registerTool({ name: 'web_fetch', description: 'Another fetcher', execution: 'parallel',
      inputSchema: { type: 'object' }, async execute() { return { content: 'mine' }; } });`);
    const tools = createToolRegistry([webFetchTool]);
    const loading = loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools });
    await expect(loading).rejects.toThrow("Tool already registered: web_fetch");
    await expect(loadExtensions({ modules: [path], workspace: await resolveWorkspace(dir), tools })).rejects.toThrow("fetcher.ts");
    expect(tools.definitions().map(tool => tool.name)).toEqual(["web_fetch"]);

    // The headless entry point registers web_fetch, so the same extension stops startup there too.
    const home = await mkdtemp(join(tmpdir(), "schway-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const stdout = capture(), stderr = capture();
    const exit = await runCli(["-p", "go", "--extension", path], { cwd: dir, env: { HOME: home, OPENAI_API_KEY: "sk-test" }, stdout, stderr,
      credentialStore: fakeCredentialStore(), model: createScriptedModel({ text: "unused" }) });
    expect(exit).toBe(1);
    expect(stderr.text).toContain("Tool already registered: web_fetch");
  });
});

test("headless runs offer web_fetch, run it in ask and read-only, deny bash, and redact JSON details", async () => {
  await withTempDir(async dir => {
    const fixture = pageServer();
    const secret = "sk-headless-secret-1234";
    for (const mode of ["auto", "ask", "read-only"] as const) {
      const requests: ModelRequest[] = [];
      const home = await mkdtemp(join(tmpdir(), "schway-home-"));
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const stdout = capture(), stderr = capture();
      const exit = await runCli(["-p", "Check the forecast", "--approval", mode, "--json"], {
        cwd: dir, env: { HOME: home, OPENAI_API_KEY: secret }, stdout, stderr, credentialStore: fakeCredentialStore(),
        model: createScriptedModel({ responses: [
          request => { requests.push(request); return { toolCalls: [
            { id: "fetch", name: "web_fetch", arguments: { url: `${fixture.base}/forecast?key=${secret}` } },
            { id: "shell", name: "bash", arguments: { command: "printf ran" } },
          ] }; },
          { text: "done" },
        ] }),
      });
      expect(exit, stderr.text).toBe(0);
      expect(requests[0]!.tools?.map(tool => tool.name)).toContain("web_fetch");
      // Registering web_fetch turns on #319's web-lookup steering line in the base prompt.
      expect(requests[0]!.systemPrompt.split("\n")).toContain(WEB_LOOKUP_GUIDANCE);
      expect(stdout.text).not.toContain(secret);
      const events = stdout.text.trim().split("\n").map(line => JSON.parse(line));
      const fetched = events.find(event => event.type === "tool.finished" && event.toolCallId === "fetch");
      expect(fetched).toMatchObject({ status: "success", details: { url: `${fixture.base}/forecast?key=…`, status: 200, contentType: "text/html", truncated: false } });
      expect(events.some(event => event.type === "tool.denied" && event.name === "web_fetch")).toBe(false);
      const shell = events.find(event => event.type === "tool.finished" && event.toolCallId === "shell");
      if (mode === "auto") expect(shell).toMatchObject({ status: "success" });
      else expect(shell).toMatchObject({ status: "error", content: mode === "ask" ? ASK_HEADLESS_DENIAL : READ_ONLY_HEADLESS_DENIAL });
    }
    expect(fixture.hits).toHaveLength(3);
  });
});

test("the TUI target masks token-like query values and known secrets; summaries show status, size and time", () => {
  expect(toolTarget("web_fetch", { url: "https://api.example.test/forecast?city=Bangkok&access_token=abc123&units=metric" }))
    .toBe("https://api.example.test/forecast?city=…&access_token=…&units=…");
  // Any `@` collapses the display to the scheme; otherwise no query or fragment value is ever shown.
  expect(displayUrl("https://user:pass@example.test/a?api_key=k1&apiKey=k2&sig=s&q=rain#id_token=t&state=ok")).toBe("https://…");
  expect(displayUrl("https://example.test/a?api_key=k1&apiKey=k2&sig=s&q=rain#id_token=t&state=ok"))
    .toBe("https://example.test/a?api_key=…&apiKey=…&sig=…&q=…#…");
  expect(displayUrl("https://example.test/search?q=token+bucket&page=2")).toBe("https://example.test/search?q=…&page=…");
  expect(displayUrl("https://user:p@ss@example.com/x")).toBe("https://…");
  expect(toolTarget("web_fetch", { url: "https://user:p@ss@example.com/x?a=1" })).toBe("https://…");
  expect(maskCredentialsInText("Signed https://s3.example.test/f?X-Amz-Signature=abc&X-Amz-Credential=def&v=1\nSee https://ok.example.test/?token=t1."))
    .toBe("Signed https://s3.example.test/f?X-Amz-Signature=***&X-Amz-Credential=***&v=1\nSee https://ok.example.test/?token=***");
  expect(toolTarget("web_fetch", { url: 42 })).toBeUndefined();
  expect(summarizeToolResult("web_fetch", "success", { status: 200, rawBytes: 48_213, durationMs: 420, truncated: false })).toBe("HTTP 200 · 47 KB · 0.4s");
  expect(summarizeToolResult("web_fetch", "success", { status: 200, rawBytes: 900, durationMs: 1_350, truncated: true })).toBe("HTTP 200 · 900 B · 1.4s · truncated");
  expect(summarizeToolResult("web_fetch", "success", { status: 200, rawBytes: 3 * 1024 * 1024, truncated: false }, 2_000)).toBe("HTTP 200 · 3.0 MB · 2.0s");
  expect(summarizeToolResult("web_fetch", "error", { status: 404, rawBytes: 10, durationMs: 5, truncated: false })).toBeUndefined();
  expect(summarizeToolResult("web_fetch", "success", { status: "200", rawBytes: 10, truncated: false })).toBeUndefined();
});

test("a TUI turn shows the fetched row with a masked target and redacts a known secret in the URL", async () => {
  const fixture = pageServer();
  const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  const secret = "sk-known-secret-5678";
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "test-session", secrets: [secret],
    tools: createToolRegistry([webFetchTool, bashTool]), contextManager: createContextManager(workspace),
    model: createScriptedModel({ responses: [{ toolCalls: [
      { id: "fetch-token", name: "web_fetch", arguments: { url: `${fixture.base}/forecast?access_token=abc123` } },
      { id: "fetch-secret", name: "web_fetch", arguments: { url: `${fixture.base}/forecast?q=${secret}` } },
    ] }, { text: "Rain after 3 pm." }] }),
  });
  cleanups.push(() => controller.dispose());
  controller.cycleApprovalMode();
  controller.cycleApprovalMode();
  expect(controller.snapshot().approvalMode).toBe("read-only");
  await controller.submit("Check the forecast");
  const rows = controller.snapshot().transcript.filter(entry => entry.kind === "tool");
  expect(controller.snapshot().toolApproval).toBeUndefined();
  expect(rows.map(row => [row.toolStatus, row.toolSummary])).toEqual([
    ["success", `${fixture.base}/forecast?access_token=…`],
    ["success", `${fixture.base}/forecast?q=…`],
  ]);
  expect(rows[0]!.resultSummary).toMatch(/^HTTP 200 · 40 B · \d+\.\ds$/);
  expect(JSON.stringify(controller.snapshot().transcript)).not.toContain(secret);
  expect(fixture.hits).toEqual(["/forecast?access_token=abc123", `/forecast?q=${secret}`]);
});

test("credential masking stays linear on hostile input", () => {
  for (const hostile of ["https://x/" + "?".repeat(32_600), "https://x/?" + "/?".repeat(16_300), "a.".repeat(16_300), "a://".repeat(8_000),
    "https://" + "@".repeat(32_000), "https://x/?" + "token=".repeat(5_000), ("x" + "-".repeat(40) + "://").repeat(700),
    "https://x/?" + "a".repeat(32_000) + "_token=s", "a".repeat(32_000) + "://h/?token=s", "https://x/?" + "&token=s!".repeat(3_000),
    "/".repeat(32_000) + "@", ":/".repeat(16_000), "//a@".repeat(8_000), "?=".repeat(16_000), ";token=;".repeat(4_000),
    "//x".repeat(10_000) + "@", "//a:b/".repeat(5_000) + "@", "#token=".repeat(4_000), "https://u:" + "#/?".repeat(10_000) + "@h"]) {
    for (const mask of [maskCredentialsInText, displayUrl]) {
      const started = performance.now();
      mask(hostile);
      expect(performance.now() - started).toBeLessThan(100);
    }
  }
});

/** Model-supplied URLs paired with credential text that no display surface may show. */
const LEAKS: Array<[url: string, secrets: string[]]> = [
  // Values that contain or start with punctuation, non-ASCII or a separator-like `;` or `?`.
  ["https://api.test/f?password=hunter2!LEAKA", ["hunter2", "LEAKA"]],
  ["https://h.test/?sig=abc:LEAKB@ghi", ["LEAKB"]],
  ["https://h.test/?password=p@LEAKC", ["LEAKC"]],
  ["https://h.test/?api_key=k,LEAKD", ["LEAKD"]],
  ["https://h.test/?token=ab$cd*LEAKE", ["LEAKE"]],
  ["https://h.test/?password=@dm1n!LEAKF", ["LEAKF"]],
  ["https://h.test/?token=$LEAKG", ["LEAKG"]],
  ["https://h.test/?token=ไทยLEAKH", ["LEAKH"]],
  ["https://h.test/?token=ab?LEAKI=ef&q=1", ["LEAKI"]],
  ["https://h.test/#access_token=abc!LEAKJ", ["LEAKJ"]],
  ["https://h.test/?password=abc;LEAKK", ["LEAKK"]],
  ["https://h.test/?token=;LEAKL", ["LEAKL"]],
  ["https://h.test/#access_token=abc;LEAKM", ["LEAKM"]],
  ["https://h.test/#access_token=hunter'LEAKN", ["LEAKN"]],
  ["https://h.test/?password=LEAKO!;", ["LEAKO"]],
  ["https://h.test/?next=https://u:LEAKP@h2/", ["LEAKP"]],
  ["https://h.test/#/callback?access_token=LEAKQ&state=1", ["LEAKQ"]],
  // A token after a Thai or other non-ASCII query segment, and long or encoded names.
  ["https://h.test/?q=ไทย&access_token=LEAKR", ["LEAKR"]],
  ["https://th.wikipedia.org/wiki/กรุงเทพ?access_token=LEAKS", ["LEAKS"]],
  ["https://a.test/{id}|x^y?token=LEAKT", ["LEAKT"]],
  ["https://h.test/?" + "a".repeat(60) + "_access_token=LEAKU", ["LEAKU"]],
  ["https://h.test/?" + "x".repeat(70) + "_token=LEAKV", ["LEAKV"]],
  ["https://h.test/?to%6Ben=LEAKW", ["LEAKW"]],
  ["https://h.test/x;jsessionid=LEAKX?q=1", ["LEAKX"]],
  // Userinfo in tolerated, protocol-relative, scheme-less and non-special forms.
  ["https://u:p@LEAKY,w0rd@h.test/x", ["LEAKY"]],
  ["\u0001https://u:LEAKZ@host.test/", ["LEAKZ"]],
  ["ht\ttps://u:LEAK1@host.test/x", ["LEAK1"]],
  ["https:/user:LEAK2@host.test/x", ["LEAK2"]],
  ["https:\\\\user:LEAK3@host.test/x", ["LEAK3"]],
  ["https:user:LEAK4@host.test/x", ["LEAK4"]],
  ["//user:LEAK5@h.test/x?token=LEAK6", ["LEAK5", "LEAK6"]],
  ["user:LEAK7@h.test/x", ["LEAK7"]],
  ["foo://u:pa\\LEAK8@h/", ["LEAK8"]],
  // Refused inputs: unsupported scheme, unparsable, scheme-less, whitespace, tab, newline and quotes.
  ["ftp://files.test/?q=日本&access_token=LEAK9", ["LEAK9"]],
  ["ftp://files.test/?f={a}&api_key=LEAK10", ["LEAK10"]],
  ["ftp://files.test/?q=new york&api_key=LEAK11", ["LEAK11"]],
  ["ftp://files.test/?to\tken=LEAK12", ["LEAK12"]],
  ["ftp://h.test/?token=abc LEAK13", ["LEAK13"]],
  ["ftp://h.test/?token=abc\nLEAK14", ["LEAK14"]],
  ["ftp://h.test/?token=ab\"LEAK15", ["LEAK15"]],
  ["ftp://h.test/?token=ab'LEAK16", ["LEAK16"]],
  ["ftp://h.test/?token=ab<LEAK17", ["LEAK17"]],
  ["https://[bad/?token=ab cd2LEAK18", ["LEAK18"]],
  ["http://[bad/é?token=LEAK19!x", ["LEAK19"]],
  ["https://[bad/?q=ไทย&access_token=LEAK20", ["LEAK20"]],
  ["h.test/x?token=LEAK21", ["LEAK21"]],
  ["api.test/x?access_token=LEAK22", ["LEAK22"]],
  ["www.api.test/x?api_key=LEAK23", ["LEAK23"]],
  ["ftp:/h/?token=LEAK24", ["LEAK24"]],
  ["https:[bad/?token=LEAK25", ["LEAK25"]],
  // Round 5: userinfo whose password holds `/`, `?`, `#`, `\`, a space or an invalid port, and opaque paths.
  ["https://admin:LEAKR5A/2x@h.test/x", ["LEAKR5A", "2x@"]],
  ["https://admin:hun#LEAKR5B@h.test/", ["hun", "LEAKR5B"]],
  ["https://admin:hun?LEAKR5C@h.test/", ["hun", "LEAKR5C"]],
  ["admin:pa/LEAKR5D@h.test/x", ["admin", "LEAKR5D"]],
  ["https://admin:LEAKR5E now@[bad/x", ["admin", "LEAKR5E"]],
  ["https://admin:LEAKR5F now@h:99999/", ["admin", "LEAKR5F"]],
  ["https://admin:LEAKR5G#x@[bad/", ["admin", "LEAKR5G"]],
  ["foo://u:pa\\LEAKR5H@h:99999999/", ["u:pa", "LEAKR5H"]],
  ["https://u:pa\\LEAKR5I@h:99999/", ["u:pa", "LEAKR5I"]],
  ["https://deploy:Xy7#LEAKR5J@registry.test/v2/", ["deploy", "Xy7", "LEAKR5J"]],
  ["https://deploy:Xy7/LEAKR5K@registry.test/v2/", ["deploy", "Xy7", "LEAKR5K"]],
  ["https://deploy:Xy7?LEAKR5L@registry.test/v2/", ["deploy", "Xy7", "LEAKR5L"]],
  ["https://admin:Xy7\\LEAKR5M@registry.test/", ["admin", "Xy7", "LEAKR5M"]],
  ["//admin:Xy7/LEAKR5N@registry.test/v2", ["admin", "Xy7", "LEAKR5N"]],
  ["admin:Xy7/LEAKR5O@registry.test/v2", ["admin", "Xy7", "LEAKR5O"]],
  ["https://deploy:123#LEAKR5P@registry.test/", ["deploy", "123", "LEAKR5P"]],
  ["https://admin:12/LEAKR5Q@h.test", ["admin", "LEAKR5Q"]],
  ["https://admin:12?LEAKR5R@h.test", ["admin", "LEAKR5R"]],
  // Round 6: a password holding `@` and then `/`, `?`, `#` or `\`, token-only userinfo, email-style user names,
  // broader credential names, and nested encoded credentials.
  ["https://deploy:P@LEAKR6A/word9@registry.test/v2/", ["deploy", "LEAKR6A", "word9"]],
  ["https://deploy:P@LEAKR6B#rd9@registry.test/", ["deploy", "LEAKR6B", "rd9"]],
  ["https://deploy:Xy@7?LEAKR6C@registry.test/", ["deploy", "LEAKR6C"]],
  ["https://deploy:Xy@7\\LEAKR6D@registry.test/", ["deploy", "LEAKR6D"]],
  ["https://admin:p@LEAKR6E/word@h.test/", ["admin", "LEAKR6E"]],
  ["https://admin:p@LEAKR6F#word@h.test/", ["admin", "LEAKR6F"]],
  ["https://admin:p@LEAKR6G?word@h.test/", ["admin", "LEAKR6G"]],
  ["https://admin:p@SECRETR6H/x@h.test/v2", ["admin", "SECRETR6H", "secretr6h"]],
  ["https://tok/LEAKR6I@github.com/x", ["tok/", "LEAKR6I"]],
  ["https://tok#LEAKR6J@github.com/x", ["tok", "LEAKR6J"]],
  ["https://tok?LEAKR6K@github.com/x", ["tok", "LEAKR6K"]],
  ["https://tok\\LEAKR6L@github.com/x", ["tok", "LEAKR6L"]],
  ["https://h.test/r?next=//TOKENR6M@evil/x@y", ["TOKENR6M"]],
  ["https://me@corp.com:/SECRETR6N@registry.test/", ["SECRETR6N", "secretr6n"]],
  ["https://me@corp.com:443/SECRETR6O@registry.test/", ["SECRETR6O", "secretr6o"]],
  ["https://me@corp.com:#SECRETR6P@registry.test/", ["SECRETR6P"]],
  ["https://me@corp.com:?SECRETR6Q@registry.test/", ["SECRETR6Q"]],
  ["https://api.openweathermap.org/data/2.5/weather?q=Bangkok&appid=SECRETR6R", ["SECRETR6R"]],
  ["http://api.weatherstack.com/current?access_key=SECRETR6S&query=Bangkok", ["SECRETR6S"]],
  ["https://api-free.deepl.com/v2/translate?auth_key=SECRETR6T&text=hi", ["SECRETR6T"]],
  ["https://h.test/?accessKey=SECRETR6U", ["SECRETR6U"]],
  ["https://h.test/?private_key=SECRETR6V", ["SECRETR6V"]],
  ["https://h.test/?jwt=SECRETR6W", ["SECRETR6W"]],
  ["https://h.test/?pass=SECRETR6X", ["SECRETR6X"]],
  ["https://app.test/sso?return=%2Fdash%3Fsession%3DSECRETR6Y", ["SECRETR6Y"]],
  // Round 7: percent-encoded nested userinfo.
  ["https://h.test/x?redirect=https%3A%2F%2Fu%3ASECRETR7A%40evil%2F", ["SECRETR7A"]],
  ["https://h.test/x?redirect=https://u:SECRETR7B%40evil/", ["SECRETR7B"]],
  ["https://archive.test/save?url=https%3A%2F%2Fdeploy%3ASECRETR7C%40registry.test%2F", ["SECRETR7C"]],
  // Round 8: double-encoded nested credentials.
  ["https://accounts.test/login?continue=https%3A%2F%2Faccounts.test%2Fauthorize%3Fredirect_uri%3Dhttps%253A%252F%252Fapp.test%252Fcb%253Fsession%253DSECRETR8A", ["SECRETR8A"]],
  ["https://h.test/x?next=https%253A%252F%252Fapp.test%252Fcb%253Ftoken%253DSECRETR8B", ["SECRETR8B"]],
  ["https://h.test/x?next=https%253A%252F%252Fu%253ASECRETR8C%2540app.test%252F", ["SECRETR8C"]],
  // Round 9: nested credentials in `=`-less query pairs, path segments and at the start of a value.
  ["https://h.test/redirect?https%253A%252F%252Fapp.test%252Fcb%253Ftoken%253DSECRETR9A", ["SECRETR9A"]],
  ["https://h.test/redirect?https%3A%2F%2Fapp.test%2Fcb%3Ftoken%3DSECRETR9B", ["SECRETR9B"]],
  ["https://h.test/go/https%253A%252F%252Fapp.test%252Fcb%253Ftoken%253DSECRETR9C", ["SECRETR9C"]],
  ["https://h.test/go/https%3A%2F%2Fapp.test%2Fcb%3Ftoken%3DSECRETR9D", ["SECRETR9D"]],
  ["https://app.test/cb?data=access_token=SECRETR9E", ["SECRETR9E"]],
  ["https://app.test/cb?data=access_token%3DSECRETR9F", ["SECRETR9F"]],
  ["https://app.test/cb#state=api_key%253DSECRETR9G", ["SECRETR9G"]],
  // Round 10: a credential in a pair's name, JSON-escaped equals, and opaque inputs.
  ["https://h.test/r?https%253A%252F%252Fapp.test%252Fcb%253Ftoken%253DSECRETR10A=1", ["SECRETR10A"]],
  ["https://h.test/x?data=access_token\\u003dSECRETR10B", ["SECRETR10B"]],
  ["https://h.test/x?data=access_token%255Cu003dSECRETR10C", ["SECRETR10C"]],
  ["https://h.test/x#data=api_key\\u003dSECRETR10D", ["SECRETR10D"]],
  ["foo:access_token=SECRETR10E", ["SECRETR10E"]],
  ["myapp:cb/access_token=SECRETR10F", ["SECRETR10F"]],
  // Round 11: names with punctuation before `=`, and raw or escaped `=`/`?` in a special-scheme path.
  ["https://h.test/x/token=SECRETR11A", ["SECRETR11A"]],
  ["https://h.test/cb\\u003ftoken\\u003dSECRETR11B", ["SECRETR11B"]],
  ["https://h.test/x?token%20=SECRETR11C&pass+word=SECRETR11D&token:x=SECRETR11E", ["SECRETR11C", "SECRETR11D", "SECRETR11E"]],
  ["https://h.test/x?Session+ID=SECRETR11F&x(token)=SECRETR11G&data%7Btoken%7D=SECRETR11H", ["SECRETR11F", "SECRETR11G", "SECRETR11H"]],
  // Round 12: credentials inside the authority.
  ["https://api.example.com&api_key=SECRETR12A/x", ["SECRETR12A", "secretr12a"]],
  ["https://host;jsessionid=SECRETR12B/x", ["SECRETR12B", "secretr12b"]],
  ["https://h.test%26token%3DSECRETR12C/x", ["SECRETR12C", "secretr12c"]],
];

/** Run web_fetch on one URL against a server that echoes the requested URL in a 404 body. */
async function leakRun(url: string) {
  const tool = createWebFetchTool({ fetch: async input => new Response(`Not found: ${input}\nTry ${input} again.`, { status: 404, headers: { "Content-Type": "text/plain" } }) });
  const result = await tool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
  return { result, details: result.details as WebFetchDetails };
}

test("the model-facing result keeps the real URL while details carry the display form", async () => {
  const { result, details } = await leakRun("https://h.test/?q=ไทย&access_token=REAL1");
  expect(result.content.split("\n")[0]).toContain("access_token=REAL1");
  expect(details.statusLine).toBe("HTTP 404 Not Found · text/plain · 151 bytes · https://h.test/?q=…&access_token=…");
  const refused = await leakRun("ftp://h.test/?token=abc\nREAL2");
  expect(refused.result.content.split("\n")[0]).toBe("No request sent · ftp://h.test/?token=abc%0AREAL2");
});

test("no part of a credential shows in the row target, status line, echoes, or collapsed, expanded and resumed rows", async () => {
  for (const [url, secrets] of LEAKS) {
    const { result, details } = await leakRun(url);
    const live = webFetchDisplayText(result.content, details, url);
    const session = createSession();
    session.append({ type: "assistant", id: "a", content: [{ type: "tool_call", id: "c", name: "web_fetch", arguments: { url } }] });
    session.append({ type: "tool_result", id: "r", toolCallId: "c", content: result.content, isError: result.isError === true });
    const resumed = buildTranscriptFromSession(session.items).find(entry => entry.kind === "tool")!;
    const liveEntry = { id: "t", kind: "tool" as const, toolName: "web_fetch", toolStatus: "error" as const, text: live, toolSummary: toolTarget("web_fetch", { url }) };
    const surfaces = {
      target: toolTarget("web_fetch", { url }), statusLine: details.statusLine, detailsUrl: details.url, detailsFinal: details.finalUrl,
      collapsed: toolPresentation(liveEntry, false).detail, expanded: toolPresentation(liveEntry, true).detail,
      resumed: toolPresentation(resumed, true).detail, resumedTarget: resumed.toolSummary,
    };
    for (const secret of secrets) {
      for (const [surface, shown] of Object.entries(surfaces)) {
        if (shown?.includes(secret)) throw new Error(`${JSON.stringify(url)} shows ${secret} in ${surface}: ${shown}`);
      }
    }
    // The display replaces the tool's own first line with the structured status line.
    expect(live.split("\n")[0]).toBe(details.statusLine);
  }
});

test("resumed rows with an unrecognized reason phrase and 404 bodies with a backtick never show a credential", async () => {
  for (const [reason, url, secret] of [
    ["OK.", "https://h.test/?token=ab`LEAKR5S", "LEAKR5S"],
    ["Custom 2", "https://h.test/#token=ab#LEAKR5T", "LEAKR5T"],
    ["OK!", "https://h.test/?token=ab`cd&access_token=LEAKR5U", "LEAKR5U"],
    ["Ok, cached", "https://h.test/x?token=abc`LEAKR5V", "LEAKR5V"],
    ["จบแล้ว", "https://h.test/x?token=abc`LEAKR5W", "LEAKR5W"],
  ]) {
    for (const status of [200, 404]) {
      const tool = createWebFetchTool({ fetch: async input => new Response(`Cannot GET ${new URL(input).pathname}${new URL(input).search}${new URL(input).hash}`, { status, statusText: reason, headers: { "Content-Type": "text/plain" } }) });
      const result = await tool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
      const session = createSession();
      session.append({ type: "assistant", id: "a", content: [{ type: "tool_call", id: "c", name: "web_fetch", arguments: { url } }] });
      session.append({ type: "tool_result", id: "r", toolCallId: "c", content: result.content, isError: result.isError === true });
      const resumed = buildTranscriptFromSession(session.items).find(entry => entry.kind === "tool")!;
      const live = webFetchDisplayText(result.content, result.details);
      const noDetails = formatToolFinishedText("web_fetch", result.content, undefined, status === 200 ? "success" : "error");
      expect(resumed.text.split("\n")[0]).toStartWith(`HTTP ${status}`);
      for (const shown of [resumed.text, live, noDetails, toolPresentation(resumed, true).detail]) expect(shown).not.toContain(secret);
    }
  }
});

test("branch tree previews of web_fetch results use the display-safe form", async () => {
  for (const [url, secret] of [
    ["https://h.test/x?token=abcLEAKR5X", "LEAKR5X"],
    ["https://deploy:Xy7#LEAKR5Y@registry.test/v2/", "LEAKR5Y"],
  ]) {
    const { result } = await leakRun(url);
    const session = createSession([{ type: "user", id: "u", content: [{ type: "text", text: "go" }] }]);
    session.append({ type: "assistant", id: "a", content: [{ type: "tool_call", id: "c", name: "web_fetch", arguments: { url } }] });
    session.append({ type: "tool_result", id: "r", toolCallId: "c", content: result.content, isError: result.isError === true });
    expect(result.content).toContain(secret);
    const snapshot = buildBranchTreeSnapshot(session);
    const previews = [...snapshot.nodes.map(node => node.preview), ...snapshot.branches.map(branch => branch.preview)];
    expect(previews.some(preview => preview.startsWith("HTTP 404") || preview.startsWith("No request sent"))).toBe(true);
    for (const preview of previews) expect(preview).not.toContain(secret);
    expect(branchTreePreviewForRecord(session.items.at(-1), 120, { name: "web_fetch", arguments: { url } })).not.toContain(secret);
  }
});

test("branch tree previews mask only the shown slice of a large web_fetch result", async () => {
  const url = "https://h.test/x?token=LEAKP1";
  const { result } = await leakRun(url);
  const big = `${result.content}\n\n${"ข้อมูลยาว https://u:LEAKP2@h/?api_key=LEAKP3 ".repeat(700)}`;
  expect(big.length).toBeGreaterThan(30_000);
  const record = { type: "tool_result" as const, id: "r", toolCallId: "c", content: big, isError: true };
  const call = { name: "web_fetch", arguments: { url } };
  const preview = branchTreePreviewForRecord(record, 120, call);
  expect(preview).toStartWith("HTTP 404 Not Found · text/plain ·");
  for (const secret of ["LEAKP1", "LEAKP2", "LEAKP3"]) expect(preview).not.toContain(secret);
  const started = performance.now();
  for (let move = 0; move < 200; move++) branchTreePreviewForRecord(record, 120, call);
  // 200 node previews of a 32 KiB result must stay cheap; masking the whole result took about 120 ms.
  expect(performance.now() - started).toBeLessThan(60);
});

test("value-only echoes of the requested credentials are masked in live, controller, resumed and /tree rows", async () => {
  for (const [url, body, secret, status] of [
    ["https://httpbin.org/get?access_token=SECRETHB1", '{"args":{"access_token":"SECRETHB1"},"url":"https://httpbin.org/get"}', "SECRETHB1", 200],
    ["https://api.test/v1/items?api_key=SECRETEX1", '{"error":"unauthorized","query":{"api_key":"SECRETEX1"}}', "SECRETEX1", 401],
    ["https://api.test/v1/items?key=SECRETVO1", '{"message":"Invalid API key: SECRETVO1"}', "SECRETVO1", 403],
    ["https://bucket.s3.test/o?X-Amz-Signature=SECRETS3SIG&X-Amz-Expires=60", "<Error><Code>SignatureDoesNotMatch</Code><SignatureProvided>SECRETS3SIG</SignatureProvided></Error>", "SECRETS3SIG", 403],
    ["https://u:SECRETUI1@h.test/x", "user SECRETUI1 rejected", "SECRETUI1", 200],
    ["https://h.test/x?token=SECRET%2BPLUS", "token SECRET+PLUS invalid", "SECRET+PLUS", 400],
    // Round 8: escaped, re-encoded and component echoes.
    ["https://h.test/x?token=ab%2FSECRETJS1", '{"error":"bad token ab\\/SECRETJS1"}', "SECRETJS1", 401],
    ["https://api.test/v?token=ab%2FSECRETJS2%2Bxy", '{"error":"Invalid token ab\\/SECRETJS2+xy"}', "SECRETJS2", 401],
    ["https://h.test/x?token=ab/SECRETRE1", "Invalid: ab%2FSECRETRE1", "SECRETRE1", 401],
    ["https://h.test/x?token=ab%2fSECRETHX1", "Invalid: ab%2FSECRETHX1", "SECRETHX1", 401],
    ["https://h.test/x?token=two%20words%20SECRETSP1", "Invalid: two+words+SECRETSP1", "SECRETSP1", 401],
    ["https://bucket.s3.test/o?X-Amz-Credential=AKIASECRETKEYID1%2F20261006%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef12",
      "<Error><Code>InvalidAccessKeyId</Code><AWSAccessKeyId>AKIASECRETKEYID1</AWSAccessKeyId></Error>", "AKIASECRETKEYID1", 403],
    ["https://app.test/sso?return=%2Fdash%3Fsession%3DSECRETNS1%26tab%3Dhome", '{"error":"session expired","session":"SECRETNS1"}', "SECRETNS1", 401],
    ["https://h.test/x?next=https%253A%252F%252Fapp.test%252Fcb%253Ftoken%253DSECRETDE3", '{"token":"SECRETDE3"}', "SECRETDE3", 401],
    // Round 9: short `:` halves of userinfo and composite values, and a value that opens with a credential name.
    ["https://h.test/x?auth=admin:s3cr3t", "bad password s3cr3t", "s3cr3t", 401],
    ["https://archive.test/save?url=https%3A%2F%2Fdeploy%3Ahunt3r%40registry.test%2F", "login failed: hunt3r", "hunt3r", 401],
    ["https://app.test/cb?data=access_token=SECRETST1", "unknown token SECRETST1", "SECRETST1", 401],
    // Round 10: every detector's values stand alone, and alphanumeric runs of 4+ characters are masked.
    ["https://h.test/x?auth=deploy:p4ss/w0rd", "bad password p4ss/w0rd", "p4ss", 401],
    ["https://h.test/x?auth=deploy:p4ss/w0rd", "bad password p4ss/w0rd", "w0rd", 401],
    ["https://h.test/x?auth=AKIAEXAMPLE1:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "invalid secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "K7MDENG", 401],
    ["https://h.test/x?auth=AKIAEXAMPLE1:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "invalid secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalr", 401],
    ["https://h.test/a;token=pathsecret1/b?code=7391", "code 7391 expired", "7391", 401],
    ["https://shop.test/cart;jsessionid=0123456789ABCDEF0123456789ABCDEF?item=5", "session 0123456789ABCDEF0123456789ABCDEF not found", "0123456789ABCDEF", 401],
    ["https://i.test/x?otp=482913&next=https://medium.com/@user", "otp 482913 invalid", "482913", 401],
    ["https://archive.test/save?url=https%3A%2F%2Fdeploy%3Ahu%252Fnt3r%40registry.test%2F", "login failed: hu/nt3r", "nt3r", 401],
    ["https://h.test/x?auth=deploy:Xy/9abcd", "invalid password Xy/9abcd", "9abcd", 401],
    // Round 11: names with punctuation, lenient decoding, punctuated and Unicode values, and the value cap.
    ["https://h.test/x?token%20=SECRETN11A", "bad SECRETN11A", "SECRETN11A", 401],
    ["https://h.test/x?pass+word=SECRETN11B", "bad SECRETN11B", "SECRETN11B", 401],
    ["https://h.test/x?Session+ID=SECRETN11C", "bad SECRETN11C", "SECRETN11C", 401],
    ["https://h.test/x?pass%20word=SECRETN11D", "bad SECRETN11D", "SECRETN11D", 401],
    ["https://h.test/x?token:v2=SECRETN11E", "bad SECRETN11E", "SECRETN11E", 401],
    ["https://h.test/x?pass%E2%80%8Bword=SECRETN11F", "bad SECRETN11F", "SECRETN11F", 401],
    ["https://h.test/x?token=%FFab12cd34", "token \ufffdab12cd34 invalid", "ab12cd34", 401],
    ["https://h.test/x?sig=%8F%A2Qx7pLm9Kd%FF", "bad signature \ufffd\ufffdQx7pLm9Kd\ufffd", "Qx7pLm9Kd", 401],
    ["https://shop.test/login;jsessionid=0123456789ABCDEF?code=123-456", "Verification code 123-456 has expired", "123-456", 401],
    ["https://h.test/x?pass=%D0%BF%D0%B0%D1%80%D0%BE%D0%BB%D1%8C#top", "wrong password пароль", "пароль", 401],
    ["https://h.test/x?auth=admin:пароль", "wrong password пароль", "пароль", 401],
    // Round 12: combining marks and punctuation-only pieces.
    ["https://h.test/x?auth=admin:สวัสดีครับ", "wrong password สวัสดีครับ", "สวัสดี", 401],
    ["https://h.test/x?auth=admin:नमस्ते1", "wrong password नमस्ते1", "नमस्ते", 401],
    ["https://h.test/x?auth=admin:" + encodeURIComponent("cafe\u0301s\u0301ecret"), "wrong password cafe\u0301s\u0301ecret", "cafe\u0301", 401],
    ["https://h.test/x?auth=admin:!*!*!*", "wrong password !*!*!*", "!*!*!*", 401],
    // Round 13: a middle value in a nested chain, and a later credential past a long value in every decode layer.
    ["https://h.test/cb?state=auth=AAAA!key=WXYZsecret!token=QQQQ", "invalid key WXYZsecret", "WXYZsecret", 401],
    ["https://h.test/cb?state=auth\\u003dAAAA!key\\u003dWXYZsecret!token\\u003dQQQQ", "invalid key WXYZsecret", "WXYZsecret", 401],
    [`https://h.test/x?token=${"A".repeat(11_000)}%25252541&x%25252526pwd%2525253DREALSECRET`, "bad password REALSECRET", "REALSECRET", 401],
    [`https://h.test/x?auth=admin:s3cr3t&${Array.from({ length: 12 }, (_, index) => `sig${index}=v${index}%2Fx%2By`).join("&")}`, "bad password s3cr3t", "s3cr3t", 401],
  ] as const) {
    const tool = createWebFetchTool({ fetch: async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }) });
    const result = await tool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
    const session = createSession();
    session.append({ type: "assistant", id: "a", content: [{ type: "tool_call", id: "c", name: "web_fetch", arguments: { url } }] });
    session.append({ type: "tool_result", id: "r", toolCallId: "c", content: result.content, isError: result.isError === true });
    const shown = [
      webFetchDisplayText(result.content, result.details, url),
      formatToolFinishedText("web_fetch", result.content, result.details, "error", undefined, url),
      buildTranscriptFromSession(session.items).find(entry => entry.kind === "tool")!.text,
      ...buildBranchTreeSnapshot(session).nodes.map(node => node.preview),
    ];
    for (const text of shown) expect(text).not.toContain(secret);
  }
  // Through the controller, which finds the requested URL from the session's tool call.
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ args: { access_token: "SECRETCTL1" } }) });
  cleanups.push(() => fixture.stop(true));
  const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "s",
    tools: createToolRegistry([webFetchTool]), contextManager: createContextManager(workspace),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "f", name: "web_fetch", arguments: { url: `http://127.0.0.1:${fixture.port}/get?access_token=SECRETCTL1` } }] }, { text: "done" }] }) });
  cleanups.push(() => controller.dispose());
  await controller.submit("go");
  const row = controller.snapshot().transcript.find(entry => entry.kind === "tool")!;
  expect(row.text).toContain('"access_token":"***"');
  expect(JSON.stringify(controller.snapshot().transcript)).not.toContain("SECRETCTL1");
});

test("a long presigned final URL after a redirect still masks a signature the 403 body echoes", async () => {
  const signature = `SECRETSIG${"f".repeat(55)}`;
  const finalUrl = `https://bucket.s3.test/releases/app.tar.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE%2F20261006%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261006T000000Z&X-Amz-Expires=300&X-Amz-Security-Token=${"T".repeat(800)}&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;
  expect(finalUrl.length).toBeGreaterThan(1_000);
  const url = "https://downloads.example.test/releases/latest/app.tar.gz";
  const tool = createWebFetchTool({ fetch: async input => input === url
    ? new Response(null, { status: 302, headers: { Location: finalUrl } })
    : new Response(`<Error><Code>SignatureDoesNotMatch</Code><SignatureProvided>${signature}</SignatureProvided></Error>`, { status: 403, headers: { "Content-Type": "application/xml" } }) });
  const result = await tool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
  expect(result.content.split("\n")[0]).toContain(signature);
  const session = createSession();
  session.append({ type: "assistant", id: "a", content: [{ type: "tool_call", id: "c", name: "web_fetch", arguments: { url } }] });
  session.append({ type: "tool_result", id: "r", toolCallId: "c", content: result.content, isError: true });
  for (const shown of [
    formatToolFinishedText("web_fetch", result.content, result.details, "error", undefined, url),
    buildTranscriptFromSession(session.items).find(entry => entry.kind === "tool")!.text,
    ...buildBranchTreeSnapshot(session).nodes.map(node => node.preview),
  ]) expect(shown).not.toContain("SECRETSIG");
});

test("a long first line is read whole, server text in the status line is bounded, and echoes never split a surrogate", async () => {
  // A stored first line longer than the old 9,000-character window still yields the final URL's values.
  const secret = "SECRETLONG1";
  const longUrl = `https://h.test/x?pad=${"p".repeat(20_000)}&token=${secret}`;
  const content = `HTTP 401 ${"R".repeat(30_000)} · text/plain · 9 bytes · ${longUrl}\n\nrejected ${secret}`;
  expect(webFetchDisplayText(content, undefined, undefined)).not.toContain(secret);
  // The tool bounds a long server reason phrase in its own status line.
  const url = "https://h.test/x?token=SECRETLONG2";
  const tool = createWebFetchTool({ fetch: async () => new Response("rejected SECRETLONG2", { status: 401, statusText: "Nope ".repeat(5_000), headers: { "Content-Type": "text/plain" } }) });
  const result = await tool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
  const first = result.content.split("\n")[0]!;
  expect(first.length).toBeLessThan(400);
  expect(first).toContain("token=SECRETLONG2");
  expect(webFetchDisplayText(result.content, result.details, url)).not.toContain("SECRETLONG2");
  // A clipped echo ends on a code-point boundary.
  for (const input of [`ftp://h.test/${"a".repeat(8_178)}${"😀".repeat(10)}`, `not a url ${"a".repeat(8_181)}${"😀".repeat(10)}`]) {
    const refused = await tool.execute({ url: input }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
    const line = refused.content.split("\n")[0]!;
    expect(line).toEndWith("…");
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  }
});

test("branch previews cut only at ASCII whitespace and keep minified bodies without splitting a masked span", async () => {
  const url = "https://h.test/x?token=LEAKSPLIT1234";
  const call = { name: "web_fetch", arguments: { url } };
  const status = "HTTP 200 OK · application/json · 100 bytes · https://h.test/x?token=LEAKSPLIT1234";
  const preview = (body: string, bound = 120) => branchTreePreviewForRecord({ type: "tool_result", id: "r", toolCallId: "c", content: `${status}\n\n${body}`, isError: false }, bound, call);
  // NBSP and U+3000 are not cut points, so userinfo spanning them stays masked.
  for (const space of ["\u00a0", "\u3000", "\u2028", "\ufeff"]) {
    const body = `${"\n".repeat(200)}git https://ci:LEAKAxx${space}LEAKB@h.test/r`;
    for (const bound of [60, 120, 200]) {
      const shown = preview(body, bound);
      expect(shown).not.toContain("LEAKA");
      expect(shown).not.toContain("LEAKB");
    }
  }
  // A minified body keeps its start instead of collapsing to the status line.
  const minified = preview(`{"data":"${"x".repeat(5_000)}"}`);
  expect(minified).toContain('{"data":"xxx');
  // A cut inside userinfo or inside an exact credential value never shows part of it.
  for (let offset = 0; offset < 40; offset++) {
    const userinfo = preview(`{"u":"https://ci:${"y".repeat(200 + offset)}LEAKM@h"}`);
    expect(userinfo).not.toContain("yyyy");
    const value = preview(`${"z".repeat(220 + offset)}LEAKSPLIT1234${"z".repeat(400)}`);
    expect(value).not.toMatch(/LEAKS|SPLIT|1234/);
  }
});

test("property: displayUrl never shows any 4+ character piece of a query or fragment value", () => {
  // mulberry32: a full-period 32-bit generator, so every choice below is exercised.
  let state = 318;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const coverage = new Map<string, number>();
  const pick = <T,>(kind: string, items: readonly T[]) => {
    const index = Math.floor(random() * items.length);
    coverage.set(`${kind}:${index}`, (coverage.get(`${kind}:${index}`) ?? 0) + 1);
    return items[index]!;
  };
  const names = ["token", "q", "city", "api_key", "next", "pass+word", "token%20", "x(token)", "a.b-c_d", "Session+ID", "%E0%B8%A3", "data%7Bk%7D", "n".repeat(40), ""];
  const encoders = [(v: string) => v, (v: string) => encodeURIComponent(v), (v: string) => encodeURIComponent(encodeURIComponent(v)),
    (v: string) => v.split("").join("+"), (v: string) => `https://in.test/cb?token=${v}`, (v: string) => encodeURIComponent(`https://in.test/cb?code=${v}`)];
  const paths = ["x", "a=b", "k%3Dv", "y;z"];
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789/+:;!$@é";
  const value = () => Array.from({ length: 6 + Math.floor(random() * 10) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  for (let index = 0; index < 200; index++) {
    const values: string[] = [];
    const pairs = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
      const raw = value();
      values.push(raw);
      return `${pick("name", names)}${pick("equals", ["=", ""])}${pick("encoder", encoders)(raw)}`;
    });
    const fragmentValue = value();
    values.push(fragmentValue);
    const url = `https://host${Math.floor(random() * 9)}.test/p/${pick("path", paths)}?${pairs.join(pick("separator", ["&", "&&"]))}#${pick("fragment", ["", "s="])}${pick("encoder", encoders)(fragmentValue)}`;
    const shown = displayUrl(url);
    for (const raw of values) {
      for (let at = 0; at + 4 <= raw.length; at++) {
        if (shown.includes(raw.slice(at, at + 4))) throw new Error(`${url} shows ${raw.slice(at, at + 4)} in ${shown}`);
      }
    }
  }
  const expected = [["name", names.length], ["equals", 2], ["encoder", encoders.length], ["path", paths.length], ["separator", 2], ["fragment", 2]] as const;
  for (const [kind, count] of expected) for (let index = 0; index < count; index++) expect(coverage.get(`${kind}:${index}`) ?? 0).toBeGreaterThan(0);
});

test("long nested credential chains stay linear in value collection and masking", () => {
  for (const url of [`https://h.test/x?a=${"token=".repeat(2_731)}`, `https://h.test/x?a=${"token%3D".repeat(2_048)}`,
    `https://h.test/x?a=${"token=".repeat(10_923)}`, `https://h.test/x?a=${"token%3D".repeat(8_192)}`]) {
    const started = performance.now();
    const values = credentialValues(url);
    maskCredentialsInText(url, values);
    displayUrl(url);
    expect(performance.now() - started).toBeLessThan(100);
    expect(values.length).toBeLessThanOrEqual(256);
  }
});

test("display forms keep structure for parsed URLs and elide everything after the host for unparsable ones", () => {
  expect(displayUrl("https://h.test/?password=abc;LEAK&q=1#frag")).toBe("https://h.test/?password=…&q=…#…");
  expect(displayUrl("ftp://files.test/?q=new york&api_key=s")).toBe("ftp://files.test/?q=…&api_key=…");
  // Names show only when plain; paths with special characters or non-ASCII become `…`.
  expect(displayUrl("https://h.test/a/b%20c/x=1/d?%E0%B8%A3=1&ok_name=2&flag&" + "n".repeat(33) + "=3")).toBe("https://h.test/a/…/…/d?…&ok_name=…&…&…");
  expect(displayUrl("https://h.test/cb\\u003ftoken\\u003dSECRET")).toBe("https://h.test/…");
  // Unparsable input shows only its scheme.
  expect(displayUrl("https://[bad/?token=s")).toBe("https://…");
  expect(displayUrl("https://[bad/?q=1")).toBe("https://…");
  expect(displayUrl("//user:pw@h.test/x?token=s")).toBe("the requested URL");
  expect(displayUrl("https://admin:hunter/2x@h.test/x")).toBe("https://…");
  expect(displayUrl("foo://u:pa\\ss@h:99999999/")).toBe("foo://…");
  expect(displayUrl("https://admin:hunter/2x")).toBe("https://…");
  // Over-masking: any `@` collapses the display, even where it is not userinfo.
  expect(displayUrl("https://medium.com/@user/post")).toBe("https://…");
  expect(displayUrl("https://h.test/?email=a@b.com")).toBe("https://…");
  expect(displayUrl("api.test/x?access_token=s")).toBe("the requested URL");
  expect(displayUrl("api.test/x?q=1")).toBe("the requested URL");
  expect(displayUrl("foo:access_token=s")).toBe("foo:…");
  expect(displayUrl("myapp:cb/x")).toBe("myapp:…");
  expect(displayUrl("?token=s")).toBe("the requested URL");
  expect(displayUrl("https://archive.test/save?url=https%3A%2F%2Fdeploy%3Apw%40registry.test%2F")).toBe("https://…");
  expect(displayUrl("h t\u0000tp ://x?token=s")).toBe("the requested URL");
  expect(displayUrl("user:pw@h.test/x")).toBe("the requested URL");
  expect(displayUrl(" \u0001ht\ttps://u:p@h.test/?q=1")).toBe("https://…");
});

test("best-effort body masking covers slash-run userinfo forms, nested URLs and fragment apostrophes", () => {
  for (const [text, secret] of [
    ["Login failed for https:///admin:LEAKB1@h.test/", "LEAKB1"],
    ["See https://\\u:LEAKB2@h.test/x now", "LEAKB2"],
    ["https:/\\/u:LEAKB3@h.test/x", "LEAKB3"],
    ["https://a/x,https://u:LEAKB4@b/", "LEAKB4"],
    ["https://h/#access_token=ab'LEAKB5", "LEAKB5"],
    ["https://h/?token=abc!?;LEAKB6", "LEAKB6"],
    ["https://h.test/?password=abc;LEAKB7 more", "LEAKB7"],
    ["protocol-relative //user:LEAKB8@h.test/x", "LEAKB8"],
    ["https://api.test/f?city=a&access_token=abc123,LEAKB9", "LEAKB9"],
    ["Cannot GET /x?token=abc`LEAKB10", "LEAKB10"],
    ["https://u:pa`LEAKB11@h/", "LEAKB11"],
    ["https://u:pa\"LEAKB12@h/", "LEAKB12"],
    ["pip install git+https://LEAKB13@github.com/org/repo.git@v1.0#egg=pkg", "LEAKB13"],
    ["see https://LEAKB14@github.com/u/x@y.git ok", "LEAKB14"],
    ["https://LEAKB15@h/@user", "LEAKB15"],
    ["x https://tok/LEAKB16@h/ y", "LEAKB16"],
    ['{"path":"/v1/items?page=2\\u0026access_token=LEAKB17"}', "LEAKB17"],
    ["Sign in at /login?next=%2Fv1%2Fitems%3Fpage%3D2%26access_token%3DLEAKB18", "LEAKB18"],
    ["a=1&amp;access_token=LEAKB19 x", "LEAKB19"],
    ["x?token\\u003dLEAKB20 y", "LEAKB20"],
    ["Not found: https://h.test/?password=p@LEAKB21", "LEAKB21"],
    ["https://u:pa?token=x@LEAKB22h/", "LEAKB22"],
    ["https%3A%2F%2Fuser%3ALEAKB23%40h.test%2F", "LEAKB23"],
    ["see url=https%3A%2F%2Fdeploy%3ALEAKB24%40registry.test%2F now", "LEAKB24"],
  ]) expect(maskCredentialsInText(text!)).not.toContain(secret);
  // Over-masking prose glued to a value is accepted; ordinary text and URLs stay intact.
  expect(maskCredentialsInText("Read https://a.test/docs/page. Then (https://b.test/?q=1).")).toBe("Read https://a.test/docs/page. Then (https://b.test/?q=1).");
  expect(maskCredentialsInText("(see https://a.test/?code=1)")).toBe("(see https://a.test/?code=***");
});

test("refused URLs echoed in the result never show their tokens in the TUI", async () => {
  for (const [url, secret] of [
    ["ftp://files.test/?q=日本&access_token=SECRET1", "SECRET1"],
    ["https://[bad/?q=é&token=SECRET3", "SECRET3"],
    ["h.test/x?token=SECRET7", "SECRET7"],
  ]) {
    const result = await webFetchTool.execute({ url }, { workspace: { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] } });
    expect(result.content).toStartWith("No request sent · ");
    expect(result.content).toContain(secret);
    const shown = formatToolFinishedText("web_fetch", result.content, result.details, "error");
    expect(shown).toStartWith("No request sent · ");
    expect(shown).not.toContain(secret);
    expect(toolTarget("web_fetch", { url })).not.toContain(secret);
  }
});

test("a 401 row with a token URL never shows the token collapsed, expanded or after resume", async () => {
  const fixture = pageServer();
  const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] };
  const token = "tok-live-9f8e7d6c5b";
  const session = createSession();
  const controller = new TuiController({
    session, workspace, provider: "scripted", modelId: "test-model", sessionId: "test-session",
    tools: createToolRegistry([webFetchTool]), contextManager: createContextManager(workspace),
    model: createScriptedModel({ responses: [{ toolCalls: [
      { id: "fetch-secure", name: "web_fetch", arguments: { url: `${fixture.base}/secure?city=Bangkok&access_token=${token}` } },
    ] }, { text: "The token was rejected." }] }),
  });
  cleanups.push(() => controller.dispose());
  await controller.submit("Check the forecast");
  const row = controller.snapshot().transcript.find(entry => entry.kind === "tool")!;
  expect(row.toolStatus).toBe("error");
  const collapsed = toolPresentation(row, false);
  expect(collapsed.detail).toContain(`HTTP 401 Unauthorized · text/html ·`);
  expect(collapsed.detail).toContain(`${fixture.base}/secure?city=…&access_token=…`);
  expect(toolPresentation(row, true).detail).toContain("Token rejected for");
  for (const shown of [row.toolSummary, collapsed.detail, toolPresentation(row, true).detail]) expect(shown).not.toContain(token);
  // The model still receives the real URL; only the display masks it.
  const result = session.items.find(item => item.type === "tool_result")!;
  expect(result.type === "tool_result" && result.content).toContain(token);
  const resumed = buildTranscriptFromSession(session.items).find(entry => entry.kind === "tool")!;
  expect(JSON.stringify([resumed, toolPresentation(resumed, true)])).not.toContain(token);
  expect(resumed.text).toContain("access_token=…");
});

test("the interactive app registers web_fetch and runs it in ask mode without a prompt", async () => {
  await withTempDir(async home => {
    const fixture = pageServer();
    const script = String.raw`
      import { mock } from "bun:test";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import { createTestRenderer } from "@opentui/core/testing";
      const root = process.cwd(), home = process.env.HOME;
      const terminal = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true });
      const fixture = join(root, "src/tui/credential-input.ts");
      const credentialInput = await import(pathToFileURL(fixture).href);
      const core = await credentialInput.loadCredentialSafeTui();
      mock.module(fixture, () => ({ ...credentialInput, loadCredentialSafeTui: async () => ({ ...core, createCliRenderer: async () => terminal.renderer }) }));
      const { runInteractiveTui } = await import(pathToFileURL(join(root, "src/tui/app.ts")).href);
      const { fakeCredentialStore } = await import(pathToFileURL(join(root, "tests/helpers/credential-store.ts")).href);
      const { createScriptedModel } = await import(pathToFileURL(join(root, "tests/helpers/scripted-model.ts")).href);
      let offered = [];
      let steered = false;
      const model = createScriptedModel({ provider: "openai", id: "fixture", responses: [
        request => { offered = (request.tools ?? []).map(tool => tool.name); steered = request.systemPrompt.split("\n").includes(process.env.STEERING_LINE); return { toolCalls: [{ id: "fetch", name: "web_fetch", arguments: { url: process.env.FETCH_URL } }] }; },
        { text: "Rain after 3 pm." },
      ] });
      let errors = "";
      const abort = new AbortController();
      const app = runInteractiveTui({ cwd: home, env: { HOME: home, SCHWAY_MOTION: "off", OPENAI_API_KEY: "sk-test" },
        args: { json: false, help: false, approval: "ask", model: "fixture" }, credentialStore: fakeCredentialStore(), signal: abort.signal, model,
        stdout: { write() {} }, stderr: { write(text) { errors += text; } } });
      const wait = async predicate => {
        for (let n = 0; n < 500; n++) { await terminal.flush(); if (predicate()) return; await Bun.sleep(10); }
        throw Error("App did not reach the expected state: " + terminal.captureCharFrame() + errors);
      };
      try {
        await wait(() => terminal.captureCharFrame().includes("Ask"));
        await terminal.mockInput.pasteBracketedText("Check the forecast"); terminal.mockInput.pressEnter();
        await wait(() => terminal.captureCharFrame().includes("Rain after 3 pm."));
        const frame = terminal.captureCharFrame();
        if (!offered.includes("web_fetch") || !offered.includes("bash")) throw Error("Registry lacks web_fetch: " + offered.join(","));
        if (!steered) throw Error("Base prompt lacks the web-lookup steering line");
        if (!frame.includes("WEB_FETCH") || !frame.includes("access_token=…") || frame.includes("abc123")) throw Error("Row missing or unmasked: " + frame);
        if (frame.includes("Allow web_fetch")) throw Error("web_fetch asked for approval: " + frame);
        console.log("TUI_WEB_FETCH_OK");
      } finally { abort.abort(); await app; }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
      env: buildIsolatedCliEnv(home, { FETCH_URL: `${fixture.base}/forecast?access_token=abc123`, STEERING_LINE: WEB_LOOKUP_GUIDANCE }),
    });
    const timeout = setTimeout(() => child.kill(), 12_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("TUI_WEB_FETCH_OK");
      expect(fixture.hits).toEqual(["/forecast?access_token=abc123"]);
    } finally { clearTimeout(timeout); }
  });
}, 15_000);

test("web_fetch modules stay headless-safe without TUI or provider imports", async () => {
  for (const file of ["src/tools/web-fetch.ts", "src/tools/html-text.ts", "src/tools/web-fetch-display.ts"]) {
    const source = await Bun.file(join(import.meta.dir, "..", file)).text();
    expect(source).not.toMatch(/@opentui|\.\.\/tui\/|from "openai"|model\/providers/);
  }
});

/** Capture CLI writes for assertions. */
function capture() {
  let text = "";
  return { write(chunk: string) { text += chunk; }, get text() { return text; } };
}
