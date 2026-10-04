import { expect, test } from "bun:test";
import { runCli } from "../src/cli/main.ts";
import type { AgentClock } from "../src/agent/retry.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

/** Capture writes so headless retry output can be asserted. */
function capture() {
  let text = "";
  return { write(chunk: string) { text += chunk; }, get text() { return text; } };
}

/** Record each backoff and return immediately, so no test waits on a real timer. */
function instantClock(): AgentClock & { delays: number[] } {
  const delays: number[] = [];
  return { delays, now: () => 0, async sleep(ms) { delays.push(ms); } };
}

async function runHeadless(responses: ScriptedTurn[], json = false) {
  const stdout = capture(), stderr = capture(), clock = instantClock();
  let exit: number | undefined;
  await withTempDir(async home => {
    exit = await runCli(["-p", "hello", ...(json ? ["--json"] : [])], {
      cwd: home, env: { HOME: home }, stdout, stderr, clock,
      model: createScriptedModel({ responses }),
    });
  });
  return { exit, stdout: stdout.text, stderr: stderr.text, delays: clock.delays };
}

test("headless stderr names a 5xx retry by cause and numbers the upcoming attempt", async () => {
  const result = await runHeadless([
    { error: "upstream 503 detail", status: 503, headers: { "Retry-After": "3" } },
    { error: "upstream 502 detail", status: 502 },
    { text: "done" },
  ]);
  expect(result.exit).toBe(0);
  expect(result.delays).toEqual([3000, 2000]);
  expect(result.stderr).toBe([
    "Provider unavailable · Attempt 2/3 in 3s · Ctrl+C stop",
    "upstream 503 detail",
    "Provider unavailable · Attempt 3/3 in 2s · Ctrl+C stop",
    "upstream 502 detail",
    "",
  ].join("\n"));
  expect(result.stderr.toLowerCase()).not.toContain("connection");
  expect(result.stdout).toBe("done\n");
});

test("headless stderr names rate limits and lost connections with the same retry form", async () => {
  const limited = await runHeadless([{ error: "slow down", status: 429, headers: { "Retry-After": "0" } }, { text: "ok" }]);
  expect(limited.stderr).toBe("Rate limited · Attempt 2/3 now · Ctrl+C stop\nslow down\n");
  expect(limited.stderr.toLowerCase()).not.toContain("connection");
  const offline = await runHeadless([{ error: "socket closed", code: "ECONNRESET" }, { text: "ok" }]);
  expect(offline.stderr).toBe("Connection lost · Attempt 2/3 in 1s · Ctrl+C stop\nsocket closed\n");
});

test("headless --json adds the retry cause beside the unchanged retry fields", async () => {
  const result = await runHeadless([
    { error: "slow down", status: 429, headers: { "Retry-After": "2" } },
    { error: "busy", status: 503 },
    { text: "ok" },
  ], true);
  expect(result.exit).toBe(0);
  const retries = result.stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).filter(event => event.type === "model.retry");
  expect(retries).toEqual([
    { type: "model.retry", attempt: 1, maxAttempts: 3, delayMs: 2000, message: "slow down", cause: "rate-limit" },
    { type: "model.retry", attempt: 2, maxAttempts: 3, delayMs: 2000, message: "busy", cause: "provider" },
  ]);
  expect(result.stderr).not.toContain("Attempt");
});
