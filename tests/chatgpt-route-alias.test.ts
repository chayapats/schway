import { expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalOpenAIAuth } from "../src/auth/chatgpt-route.ts";
import { codexSubscriptionIdentity, credentialIdentity } from "../src/auth/store.ts";
import { resolveSubscriptionRoute } from "../src/auth/subscription-route.ts";
import { formatDoctorHelp, formatHelp } from "../src/cli/help.ts";
import { MODELS_HELP } from "../src/cli/models.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { diagnose } from "../src/doctor/doctor.ts";
import { createSubscriptionTokenRefresher, exchangeCodeForTokens, extractCodeFromCallbackUrl, loginWithBrowserFlow, pollDeviceAuthorization, saveSubscriptionTokens } from "../src/model/providers/codex-subscription.ts";
import { createSession } from "../src/session/session.ts";
import { LOGIN_USAGE, helpText, parseLoginTarget } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import type { CodexLoginRunner } from "../src/tui/controller-types.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

test("the chatgpt alias maps to codex case-insensitively and leaves other values alone", () => {
  for (const value of ["chatgpt", "ChatGPT", " CHATGPT "]) expect(canonicalOpenAIAuth(value)).toBe("codex");
  for (const value of ["codex", "auto", "api-key", "chat-gpt", 3, undefined]) expect(canonicalOpenAIAuth(value)).toBe(value);
});

test("/login chatgpt and /login codex parse to the same subscription target, including flag errors", () => {
  const forms = ["", " --device", " --code https://localhost/cb?code=a&state=b", " --code=https://localhost/cb?code=a&state=b"];
  for (const form of forms) {
    const chatgpt = parseLoginTarget(`chatgpt${form}`);
    expect(chatgpt).not.toHaveProperty("error");
    expect(chatgpt).toEqual(parseLoginTarget(`codex${form}`));
    expect(parseLoginTarget(`ChatGPT${form}`)).toEqual(chatgpt);
  }
  expect(parseLoginTarget("chatgpt --device")).toEqual({ kind: "codex", device: true });
  expect(parseLoginTarget("chatgpt --code=x")).toEqual({ kind: "codex", device: false, code: "x" });
  for (const name of ["chatgpt", "codex"]) {
    const conflict = parseLoginTarget(`${name} --device --code x`);
    expect(conflict).toEqual({ error: "Usage: /login chatgpt [--device] or /login chatgpt --code <callback-url-or-code>. Device and pasted-code flows are separate attempts." });
    expect(parseLoginTarget(`${name} --bogus`)).toEqual({ error: LOGIN_USAGE });
  }
  expect(LOGIN_USAGE).toContain("/login chatgpt [--device] [--code <callback-url-or-code>]");
  expect(LOGIN_USAGE).not.toContain("codex");
  const help = helpText();
  expect(help).toContain("/login chatgpt [--device] [--code <callback-url-or-code>] - sign in with a ChatGPT Plus/Pro subscription");
  expect(help).toContain("/logout <openai|xai|openai-compatible|chatgpt|grok>");
  expect(help).not.toMatch(/\bcodex\b/);
});

/** Build a signed-out OpenAI controller whose ChatGPT runner records each attempt's target. */
function loginController(calls: Array<{ device: boolean; code?: string }>, store = fakeCredentialStore()) {
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const codexLogin: CodexLoginRunner = async input => { calls.push({ device: input.device, ...(input.code !== undefined ? { code: input.code } : {}) }); return { ok: false, message: "Denied" }; };
  return new TuiController({ session: createSession(), sessionId: "chatgpt-alias", workspace, provider: "openai", modelId: "",
    contextManager: createContextManager(workspace), credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin } });
}

test("/login chatgpt and /login codex call the same runner with the same device and code target", async () => {
  for (const form of ["", " --device", " --code pasted-callback"]) {
    const calls: Array<{ device: boolean; code?: string }> = [];
    const controller = loginController(calls);
    try {
      await controller.login(`chatgpt${form}`);
      await controller.login(`codex${form}`);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(calls[1]!);
      expect(calls[0]).toEqual(form === " --device" ? { device: true } : form ? { device: false, code: "pasted-callback" } : { device: false });
    } finally { controller.dispose(); }
  }
});

test("/logout chatgpt removes only the subscription identity, like /logout codex, and rejects flags naming chatgpt", async () => {
  for (const name of ["chatgpt", "codex"]) {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-access", expiresAt: Date.now() + 600_000 }));
    await store.set(credentialIdentity({ provider: "openai" }), "stored-openai-key");
    await store.set(credentialIdentity({ provider: "xai" }), "stored-xai-key");
    const controller = loginController([], store);
    try {
      expect(await controller.logout(`${name} --device`)).toBe(false);
      expect(controller.snapshot().transcript.at(-1)?.text).toContain("Usage: /logout chatgpt takes no flags.");
      expect(await store.get(codexSubscriptionIdentity())).not.toBeNull();
      await controller.logout(name);
      expect(await store.get(codexSubscriptionIdentity())).toBeNull();
      expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("stored-openai-key");
      expect(await store.get(credentialIdentity({ provider: "xai" }))).toBe("stored-xai-key");
    } finally { controller.dispose(); }
  }
});

test("/login and /logout argument completions offer chatgpt instead of codex", () => {
  const controller = loginController([]);
  try {
    for (const command of ["login", "logout"]) {
      const values = controller.commandChoices(`/${command} `).map(entry => entry.insertion);
      expect(values).toContain(`/${command} chatgpt`);
      expect(values).not.toContain(`/${command} codex`);
      expect(controller.commandChoices(`/${command} ch`).map(entry => entry.insertion)).toEqual([`/${command} chatgpt`]);
    }
  } finally { controller.dispose(); }
});

test("a session whose openaiAuth was set as chatgpt takes the same subscription branch as codex", async () => {
  const outcomes: unknown[] = [];
  for (const spelling of ["chatgpt", "ChatGPT", "codex"]) {
    await withTempDir(async root => {
      const workspace = { root, launchCwd: root, extraRoots: [] };
      await mkdir(join(root, "home"), { recursive: true });
      const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai" } });
      const store = fakeCredentialStore();
      await store.set(codexSubscriptionIdentity(), "saved-account");
      const staged: unknown[] = [];
      let discovered = 0;
      const controller = new TuiController({
        session: createSession(), sessionId: `alias-${spelling}`, workspace, configEditor,
        provider: "openai", modelId: "", contextManager: createContextManager(workspace),
        credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => { discovered++; return ["account-model"]; } },
        stageSettings: async settings => { staged.push(settings.openaiAuth); return { contextManager: createContextManager(workspace) }; },
      });
      try {
        expect(await controller.configCommand(`set openaiAuth ${spelling}`)).toBe(true);
        expect(configEditor.settings.openaiAuth).toBe("codex");
        controller.openModelPicker();
        await Bun.sleep(0);
        outcomes.push({ staged, activeRoute: controller.snapshot().activeRoute, discovered,
          models: controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId) });
      } finally { controller.dispose(); }
    });
  }
  expect(outcomes[0]).toEqual({ staged: ["codex"], activeRoute: expect.stringContaining("ChatGPT subscription"), discovered: 1, models: ["account-model"] });
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[2]).toEqual(outcomes[0]);
});

test("doctor names /login chatgpt when the selected subscription login is missing", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work/.git"), { recursive: true }); await mkdir(join(root, "home"));
    const report = await diagnose({ cwd: join(root, "work"), env: { HOME: join(root, "home") }, store: fakeCredentialStore(),
      args: { json: true, help: false, provider: "openai", openaiAuth: "codex" } });
    const auth = report.checks.find(check => check.id === "auth")!;
    expect(auth.status).toBe("error");
    expect(auth.remedy).toContain("sign in interactively with /login chatgpt;");
    expect(JSON.stringify(report)).not.toContain("/login codex");
  });
});

test("a missing ChatGPT login is still classified as missing_subscription", async () => {
  expect(await resolveSubscriptionRoute({ provider: "codex", model: "m", maxTokens: 1, store: fakeCredentialStore(), env: {} })).toEqual({ reason: "missing_subscription" });
});

/** Collect every TypeScript source file below a directory. */
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name))
    : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []))).flat();
}

test("no source string tells users to run /login codex or /logout codex, and CLI help never lists codex", async () => {
  const root = join(import.meta.dir, "../src");
  const offenders: string[] = [];
  for (const file of await sourceFiles(root)) {
    const text = await Bun.file(file).text();
    for (const [index, line] of text.split("\n").entries()) if (/\/log(?:in|out) codex\b/i.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`);
  }
  expect(offenders).toEqual([]);
  for (const help of [formatHelp(), formatDoctorHelp(), MODELS_HELP]) {
    expect(help).not.toMatch(/\bcodex\b/);
    expect(help).toMatch(/auto, chatgpt,? (?:or )?api-key/);
  }
});

test("ChatGPT sign-in and session recovery messages name /login chatgpt with the same flags", async () => {
  const empty = fakeCredentialStore();
  const expired = fakeCredentialStore();
  await saveSubscriptionTokens(expired, { accessToken: "expired-access", expiresAt: Date.now() - 1000 });
  const revoked = fakeCredentialStore();
  await saveSubscriptionTokens(revoked, { accessToken: "revoked-access", refreshToken: "revoked-refresh", expiresAt: Date.now() - 1000 });
  const rejected = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  const tokenless = async () => Response.json({ refresh_token: "r" });
  const messages = {
    missing: await createSubscriptionTokenRefresher({ store: empty }).getValidAccessToken().catch((error: Error) => error.message),
    expired: await createSubscriptionTokenRefresher({ store: expired }).getValidAccessToken().catch((error: Error) => error.message),
    revoked: await createSubscriptionTokenRefresher({ store: revoked, fetch: rejected }).getValidAccessToken().catch((error: Error) => error.message),
    callbackState: (extractCodeFromCallbackUrl("http://localhost:1455/auth/callback?code=c&state=other", "expected") as { error: string }).error,
    noAccessToken: await exchangeCodeForTokens({ code: "c", verifier: "v", fetch: tokenless }).catch((error: Error) => error.message),
    timeout: await loginWithBrowserFlow({ store: fakeCredentialStore(), timeoutMs: 20, deps: { openBrowser: () => {},
      waitForCallbackCode: ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) } }).catch((error: Error) => error.message),
    device: await pollDeviceAuthorization({ deviceAuthId: "d", userCode: "u", pollIntervalMs: 1, fetch: rejected }).catch((error: Error) => error.message),
  };
  expect(messages.missing).toContain("with /login chatgpt (or /login chatgpt --device on headless machines)");
  expect(messages.expired).toContain("Sign in again in interactive mode with /login chatgpt.");
  expect(messages.revoked).toContain("Sign in again in interactive mode with /login chatgpt;");
  expect(messages.callbackState).toBe("The callback state does not match this login attempt. Restart /login chatgpt and paste the newest redirect URL.");
  expect(messages.noAccessToken).toBe("The sign-in response has no access token. Restart /login chatgpt for a fresh attempt.");
  expect(messages.timeout).toContain("paste the redirect with /login chatgpt --code <callback-url-or-code>; otherwise retry /login chatgpt, or use /login chatgpt --device on headless machines.");
  expect(messages.device).toMatch(/\/login chatgpt --device/);
  for (const message of Object.values(messages)) expect(message).not.toContain("codex");
});
