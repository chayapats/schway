import { expect, test } from "bun:test";
import { clearPendingBrowserAttempt, CODEX_REDIRECT_URI, loadSubscriptionTokens, loginWithBrowserFlow, waitForLocalhostCallback } from "../src/model/providers/codex-subscription.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createCodexLoginRunner } from "../src/tui/app.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import { createContextManager } from "../src/context/manager.ts";

test("browser redirect reaches a ready listener and saves a reusable subscription", async () => {
  const store = fakeCredentialStore();
  const abort = new AbortController();
  let browserResult = "not opened";
  const browserDone = Promise.withResolvers<void>();
  try {
    const tokens = await loginWithBrowserFlow({
      store, signal: abort.signal, timeoutMs: 500,
      deps: {
        waitForCallbackCode: waitForLocalhostCallback,
        openBrowser: async (authorizeUrl) => {
          const state = new URL(authorizeUrl).searchParams.get("state")!;
          try {
            const response = await fetch(`${CODEX_REDIRECT_URI}?code=fixture-code&state=${state}`);
            browserResult = `${response.status} ${await response.text()}`;
          } catch { browserResult = "callback connection failed"; }
          finally { browserDone.resolve(); }
        },
        fetch: async () => Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 }),
      },
    }).catch(() => null);
    await browserDone.promise;
    expect(browserResult).toContain("200");
    expect(tokens?.refreshToken).toBe("fixture-refresh");
    expect((await loadSubscriptionTokens(store))?.accessToken).toBe("fixture-access");
  } finally {
    abort.abort();
    clearPendingBrowserAttempt();
  }
});

test("localhost delivers the callback page before shutting down its listener", async () => {
  const abort = new AbortController();
  const code = waitForLocalhostCallback({ expectedState: "fixture-state", signal: abort.signal, timeoutMs: 1000 });
  try {
    const response = await fetch(`${CODEX_REDIRECT_URI}?code=fixture-code&state=fixture-state`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Return to the terminal");
    expect(await code).toBe("fixture-code");
  } finally {
    abort.abort();
    await code.catch(() => {});
  }
});

test("a stale callback returns an error without cancelling the current sign-in", async () => {
  const abort = new AbortController();
  const code = waitForLocalhostCallback({ expectedState: "current-state", signal: abort.signal, timeoutMs: 1000 });
  const outcome = code.then(value => ({ value }), () => ({ value: "rejected" }));
  try {
    for (const query of ["code=old-code&state=old-state", "error=access_denied&state=old-state", "state=current-state"]) {
      const response = await fetch(`${CODEX_REDIRECT_URI}?${query}`);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("Schway signed in");
    }
    const response = await fetch(`${CODEX_REDIRECT_URI}?code=current-code&state=current-state`);
    expect(response.status).toBe(200);
    await response.text();
    expect(await outcome).toEqual({ value: "current-code" });
  } finally {
    abort.abort();
    await outcome;
  }
});

test("provider denial renders a failure page and rejects the matching attempt", async () => {
  const abort = new AbortController();
  const code = waitForLocalhostCallback({ expectedState: "current-state", signal: abort.signal, timeoutMs: 1000 });
  const outcome = code.catch(error => error);
  try {
    const response = await fetch(`${CODEX_REDIRECT_URI}?error=access_denied&state=current-state`);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Schway signed in");
    expect(String(await outcome)).toContain("denied");
  } finally {
    abort.abort();
    await outcome;
  }
});

test("a browser launcher that stays open does not block login or cancellation", async () => {
  const store = fakeCredentialStore();
  const launcher = Promise.withResolvers<void>();
  try {
    const tokens = await loginWithBrowserFlow({ store, timeoutMs: 500, deps: {
      openBrowser: () => launcher.promise,
      waitForCallbackCode: async () => "fixture-code",
      fetch: async () => Response.json({ access_token: "fixture-access" }),
    } });
    expect(tokens.accessToken).toBe("fixture-access");

    const abort = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const attempt = loginWithBrowserFlow({ store, signal: abort.signal, timeoutMs: 500, deps: {
      openBrowser: () => launcher.promise,
      waitForCallbackCode: ({ signal }) => { started.resolve(signal); return new Promise(() => {}); },
    } });
    const listenerSignal = await started.promise;
    abort.abort();
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
    expect(listenerSignal.aborted).toBe(true);
  } finally {
    launcher.resolve();
    clearPendingBrowserAttempt();
  }
});

test("occupied callback port leaves a device fallback reachable through the controller chooser", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response("occupied") });
  const store = fakeCredentialStore();
  const workspace = { root: "/fixture", launchCwd: "/fixture", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), sessionId: "occupied-callback", workspace,
    provider: "openai", modelId: "test", contextManager: createContextManager(workspace),
    credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
      codexLogin: createCodexLoginRunner({ store, secrets: [], openBrowser: () => {} }) },
  });
  try {
    expect(await controller.login("codex")).toBe(false);
    const snapshot = controller.snapshot();
    expect(JSON.stringify(snapshot)).toContain("callback port is unavailable");
    expect(snapshot.loginChooser?.choices[snapshot.loginChooser.selectedIndex]).toContain("Device");
    expect(JSON.stringify(snapshot)).not.toContain("EADDRINUSE");
  } finally {
    controller.dispose();
    occupied.stop();
    clearPendingBrowserAttempt();
  }
});
