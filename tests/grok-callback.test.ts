import { beforeAll, afterAll, expect, test } from "bun:test";
import { startLoopbackCallback, loginWithBrowserFlow, GROK_SCOPE } from "../src/model/providers/grok-subscription.ts";

const origin = { Origin: "https://accounts.x.ai" };
test("Grok callback binds port zero and preserves waiting after stale state with origin-scoped CORS", async () => {
  const abort = new AbortController();
  const listener = startLoopbackCallback({ expectedState: "current", signal: abort.signal });
  const url = new URL(listener.redirectUri);
  try {
    expect(url.hostname).toBe("127.0.0.1"); expect(Number(url.port)).toBeGreaterThan(0); expect(url.pathname).toBe("/callback");
    const stale = await fetch(`${url}?state=stale&code=no`, { headers: origin });
    expect(stale.status).toBe(400); expect(stale.headers.get("Access-Control-Allow-Origin")).toBe(origin.Origin);
    await stale.text();
    const preflight = await fetch(url, { method: "OPTIONS", headers: origin });
    expect(preflight.status).toBe(204); expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET"); expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    const other = await fetch(`${url}?state=stale`, { headers: { Origin: "https://example.test" } });
    expect(other.headers.has("Access-Control-Allow-Origin")).toBe(false); await other.text();
    const approved = await fetch(`${url}?state=current&code=approved`, { headers: origin });
    expect(approved.status).toBe(200); expect(approved.headers.get("Access-Control-Allow-Origin")).toBe(origin.Origin); await approved.text();
    expect(await listener.code).toBe("approved");
  } finally { listener.close(); }
  const rebound = Bun.serve({ hostname: "127.0.0.1", port: Number(url.port), fetch: () => new Response("closed") });
  await rebound.stop(true);
});
test("Grok callback denial, timeout and Esc settle safely and release the port", async () => {
  for (const reason of ["denied", "timeout", "abort"] as const) {
    const abort = new AbortController();
    const listener = startLoopbackCallback({ expectedState: "state", signal: abort.signal, timeoutMs: reason === "timeout" ? 10 : 10_000 });
    const rejected = listener.code.catch(error => error);
    if (reason === "denied") await (await fetch(`${listener.redirectUri}?state=state&error=access_denied`)).text();
    if (reason === "abort") abort.abort();
    expect(String(await rejected)).toContain(reason === "denied" ? "denied" : reason === "timeout" ? "timed out" : "Aborted");
    const rebound = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(listener.redirectUri).port), fetch: () => new Response("closed") });
    await rebound.stop(true);
  }
});
test("browser opens only after binding, exchanges exact PKCE form, and saves approved tokens", async () => {
  const abort = new AbortController(); let saved = ""; let redirect = ""; let challenge = "";
  const tokens = await loginWithBrowserFlow({ signal: abort.signal, deps: {
    openBrowser: async value => {
      const url = new URL(value); redirect = url.searchParams.get("redirect_uri")!; challenge = url.searchParams.get("code_challenge")!;
      expect(url.searchParams.get("scope")).toBe(GROK_SCOPE); expect(url.searchParams.get("referrer")).toBe("schway");
      await (await fetch(`${redirect}?state=${url.searchParams.get("state")}&code=approval`)).text();
    },
    fetch: async (_url, init) => {
      const body = new URLSearchParams(String(init!.body));
      expect(body.get("redirect_uri")).toBe(redirect); expect(body.get("code")).toBe("approval");
      const hash = new Bun.CryptoHasher("sha256").update(body.get("code_verifier")!).digest("base64url"); expect(hash).toBe(challenge);
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
    }, saveTokens: async tokens => { saved = tokens.accessToken; },
  } });
  expect(saved).toBe("fixture-access"); expect(tokens.refreshToken).toBe("fixture-refresh");
});
test("browser cancellation and browser-launch failure do not save credentials", async () => {
  const abort = new AbortController(); const notices: string[] = []; let saves = 0;
  const task = loginWithBrowserFlow({ signal: abort.signal, deps: { openBrowser: () => { throw Error("launcher missing"); }, onProgress: message => { notices.push(message); abort.abort(); }, saveTokens: async () => { saves++; } } });
  await expect(task).rejects.toThrow("Aborted"); expect(saves).toBe(0); expect(notices[0]).toContain("https://auth.x.ai/oauth2/authorize");
});

const unguardedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Grok fixtures must not use external network");
    return unguardedFetch(input, init);
  }, { preconnect: unguardedFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedFetch; });
