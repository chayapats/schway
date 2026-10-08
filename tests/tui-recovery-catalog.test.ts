import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { credentialStoreError } from "../src/auth/store.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController, type TuiSnapshot } from "../src/tui/controller.ts";
import type { TuiRecovery } from "../src/tui/controller-types.ts";
import { RECOVERY_CATEGORIES, STARTUP_RECOVERY_CATEGORIES, recoveryMessage, startupRecoveryMessage } from "../src/tui/controller-support.ts";
import { RECOVERY_ACTION_LABELS, SESSION_BLOCKED_HINT, blockedSubmitHint } from "../src/tui/running-hints.ts";
import { parseScreen } from "./screen-catalog/format.ts";
import { RECOVERY_SCREENS, SCREENS, STARTUP_RECOVERY_SCREENS } from "./screen-catalog/screens.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

const goldens = join(import.meta.dir, "screen-catalog/goldens");
/** Golden text of one screen's dark 120-column variant, with every row trimmed and joined by spaces. */
async function goldenText(id: string): Promise<string> {
  return parseScreen(await readFile(join(goldens, id, "dark-120.golden"), "utf8")).text.map(line => line.replace(/^[\s▌]+/, "").trimEnd()).join(" ");
}

test("every reachable recovery category has a catalog screen that shows its message", async () => {
  const ids = new Set(SCREENS.map(screen => screen.id));
  // The category list is exhaustive over TuiRecovery["category"] at compile time; the screen map must cover each one.
  expect(Object.keys(RECOVERY_SCREENS).sort()).toEqual([...RECOVERY_CATEGORIES].sort());
  expect(Object.keys(STARTUP_RECOVERY_SCREENS).sort()).toEqual([...STARTUP_RECOVERY_CATEGORIES].sort());
  for (const category of RECOVERY_CATEGORIES) {
    expect(ids.has(RECOVERY_SCREENS[category]), category).toBe(true);
    expect(await goldenText(RECOVERY_SCREENS[category]), category).toContain(recoveryMessage(category));
  }
  for (const category of STARTUP_RECOVERY_CATEGORIES) {
    expect(ids.has(STARTUP_RECOVERY_SCREENS[category]), category).toBe(true);
    expect(await goldenText(STARTUP_RECOVERY_SCREENS[category]), category).toContain(startupRecoveryMessage(category));
  }
});

test("the unreachable tool category is gone from turn recovery", () => {
  expect(RECOVERY_CATEGORIES).not.toContain("tool" as TuiRecovery["category"]);
  expect(RECOVERY_CATEGORIES).toHaveLength(7);
});

/** Run one task against scripted runtime failures, then return the settled snapshot and the retry rows seen during backoff. */
async function failTurn(dir: string, responses: ScriptedTurn[], storage: Parameters<typeof createSession>[2] = {}) {
  const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
  const retryRows: string[] = [];
  let tui: TuiController | undefined;
  tui = new TuiController({ session: createSession([], [], storage), model: createScriptedModel({ responses }), contextManager: createContextManager(workspace), workspace,
    provider: "scripted", modelId: "scripted", sessionId: "recovery-catalog", secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
    // Each backoff runs while the retry row shows, so record it before the next attempt.
    agentClock: { now: () => 0, sleep: async () => { retryRows.push(...tui!.snapshot().transcript.filter(entry => entry.text.includes("Attempt")).map(entry => entry.text)); } } });
  await tui.submit("Summarize the changes");
  const snapshot = tui.snapshot();
  tui.dispose();
  return { snapshot, retryRows };
}
/** The error row the recovery added: its message line and its action line. */
const errorRow = (snapshot: TuiSnapshot) => snapshot.transcript.find(entry => entry.kind === "error")!.text.split("\n");

for (const [category, responses, actions, hint] of [
  ["auth", [{ error: "Incorrect API key secret-sentinel", status: 401 }], ["connect", "details", "keep-editing"], "Alt+L connect · F2 details"],
  ["credential-store", [{ error: credentialStoreError("read") }], ["retry-credentials", "details", "keep-editing"], "Ctrl+R retry credential access · F2 details"],
  ["model", [{ error: "The model secret-sentinel does not exist", status: 404, code: "model_not_found" }], ["choose-model", "details", "keep-editing"], "Alt+M choose model · F2 details"],
  ["offline", Array.from({ length: 3 }, () => ({ error: "fetch failed secret-sentinel", code: "ENETUNREACH" })), ["continue", "details", "keep-editing"], "Ctrl+R continue · F2 details"],
  ["rate-limit", Array.from({ length: 3 }, () => ({ error: "Rate limit exceeded secret-sentinel", status: 429, headers: { "Retry-After": "2" } })), ["continue", "details", "keep-editing"], "Ctrl+R continue · F2 details"],
  ["provider", Array.from({ length: 3 }, () => ({ error: "Service unavailable secret-sentinel", status: 503 })), ["continue", "details", "keep-editing"], "Ctrl+R continue · F2 details"],
] as const) test(`a scripted ${category} failure offers its own actions, error row and hint row`, async () => {
  await withTempDir(async dir => {
    const { snapshot } = await failTurn(dir, [...responses]);
    expect(snapshot.recovery).toMatchObject({ category, accepted: true, actions });
    expect(errorRow(snapshot)).toEqual([recoveryMessage(category), actions.map(action => RECOVERY_ACTION_LABELS[action]).join(" · ")]);
    expect(blockedSubmitHint(snapshot)).toBe(hint);
    // Repairs that need a new credential or model come first; continuation waits until the repair activates.
    if (category === "auth" || category === "model" || category === "credential-store") expect(blockedSubmitHint(snapshot)).not.toContain("Ctrl+R continue");
    expect(JSON.stringify(snapshot)).not.toContain("secret-sentinel");
  });
});

test("a refused session write blocks continuation and leads the hint row with a fresh or saved session", async () => {
  await withTempDir(async dir => {
    let writes = 0;
    const { snapshot } = await failTurn(dir, [{ text: "Ready." }], { writeOperation() { if (++writes > 1) throw new Error("EACCES secret-sentinel"); } });
    expect(snapshot.recovery).toMatchObject({ category: "session-write", accepted: true, actions: ["details", "keep-editing"] });
    expect(errorRow(snapshot)).toEqual([recoveryMessage("session-write"), "F2 details · Esc keep editing"]);
    expect(blockedSubmitHint(snapshot)).toBe(`${SESSION_BLOCKED_HINT} · F2 details`);
    expect(blockedSubmitHint(snapshot)).toStartWith("/new start fresh · /sessions browse");
    expect(blockedSubmitHint(snapshot)).not.toContain("Ctrl+R continue");
  });
});

test("a 429 retries as a rate limit, never as a connection problem, and ends in the rate-limit recovery", async () => {
  await withTempDir(async dir => {
    const { snapshot, retryRows } = await failTurn(dir, Array.from({ length: 3 }, () => ({ error: "Too many requests", status: 429, headers: { "Retry-After": "2" } })));
    expect(retryRows).toEqual(["Rate limited · Attempt 2/3 · Esc stop", "Rate limited · Attempt 3/3 · Esc stop"]);
    expect(retryRows.join(" ").toLowerCase()).not.toContain("connection");
    expect(snapshot.recovery?.category).toBe("rate-limit");
    expect(errorRow(snapshot)[0]).toBe("Usage limit reached · Wait before continuing");
    expect(snapshot.transcript.some(entry => entry.text.includes("Attempt"))).toBe(false);
  });
});
