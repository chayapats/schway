import { expect, test } from "bun:test";
import { beginDeviceSignIn, checkAuthReadiness, containsNoSecrets, credentialReferenceForRoute, hostCapabilities,
  type HostAuthFetch, type HostAuthRoute, type HostClock, type HostCredentialStore, type HostDeviceSignIn, type HostDeviceSignInOptions } from "schway/host";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { manualClock } from "./helpers/manual-clock.ts";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";
import { join, resolve } from "node:path";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

function protocol(route: HostAuthRoute, clock: HostClock, input: {
  replies?: Array<{ error?: string; status?: number }>;
  lifetime?: number;
  onPoll?: (init?: RequestInit) => Promise<Response>;
  onExchange?: () => Promise<Response>;
} = {}) {
  const calls: Array<{ url: string; at: number; body: string }> = [];
  let poll = 0;
  const fetch: HostAuthFetch = async (url, init) => {
    calls.push({ url: String(url), at: clock.now(), body: String(init?.body) });
    if (String(url).endsWith("usercode") || String(url).endsWith("device/code")) return Response.json({
      device_auth_id: "fixture-private-device-id", device_code: "fixture-private-device-id", user_code: "ABCD-EFGH",
      verification_uri: route === "codex" ? "https://auth.openai.com/codex/device" : "https://accounts.x.ai/device",
      interval: 2, expires_in: input.lifetime ?? 60,
    });
    if (route === "codex" && String(url) === "https://auth.openai.com/oauth/token") {
      if (input.onExchange) return input.onExchange();
      return Response.json({ access_token: "fixture-access-sentinel", refresh_token: "fixture-refresh-sentinel", expires_in: 3600 });
    }
    if (input.onPoll) return input.onPoll(init);
    const reply = input.replies?.[poll++];
    if (reply?.error) return Response.json({ error: reply.error, error_description: "fixture-access-sentinel" }, { status: reply.status ?? 400 });
    return route === "codex"
      ? Response.json({ authorization_code: "fixture-private-auth-code", code_verifier: "fixture-private-verifier" })
      : Response.json({ access_token: "fixture-access-sentinel", refresh_token: "fixture-refresh-sentinel", expires_in: 3600 });
  };
  return { fetch, calls };
}
async function start(options: HostDeviceSignInOptions): Promise<HostDeviceSignIn> {
  const value = await beginDeviceSignIn(options);
  expect(value.kind).toBe("pending");
  if (value.kind !== "pending") throw new Error("Expected approval handle");
  return value;
}
const secrets = ["fixture-access-sentinel", "fixture-refresh-sentinel", "fixture-private-device-id", "fixture-private-auth-code", "fixture-private-verifier"];

for (const route of ["codex", "grok"] as const) {
  test(`${route} public flow commits only its identity, honors intervals and slow-down, and shares polling`, async () => {
    const clock = manualClock(), store = fakeCredentialStore();
    const fixture = protocol(route, clock, { replies: [{ error: "authorization_pending" }, { error: "slow_down" }] });
    const identities: string[] = [], guards: string[] = [];
    const flow = await start({ route, clock, store: { ...store, set: async (id, value) => { identities.push(id.account); await store.set(id, value); } },
      fetch: fixture.fetch, credentialWriteGuard: id => { guards.push(id.account); } });
    expect(flow).toMatchObject({ containsNoSecrets: true, route, userCode: "ABCD-EFGH", expiresAt: clock.now() + 60_000 });
    expect(containsNoSecrets(flow, secrets)).toBe(true);
    const work = flow.poll(new AbortController().signal);
    expect(flow.poll(new AbortController().signal)).toBe(work);
    await clock.advance(20_000);
    const outcome = await work;
    expect(outcome).toEqual({ kind: "ready", route, containsNoSecrets: true });
    expect(await flow.poll(new AbortController().signal)).toBe(outcome);
    expect(containsNoSecrets(outcome, secrets)).toBe(true);
    expect(identities).toEqual([credentialReferenceForRoute(route).account]);
    expect(guards).toEqual([identities[0]!, identities[0]!]);
    const times = fixture.calls.filter(call => /deviceauth\/token|oauth2\/token/.test(call.url)).map(call => call.at - (flow.expiresAt - 60_000));
    expect(times).toEqual(route === "codex" ? [0, 2000, 9000] : [2000, 4000, 11_000]);
    if (route === "codex") {
      const exchange = new URLSearchParams(fixture.calls.at(-1)!.body);
      expect(exchange.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    } else expect(new URLSearchParams(fixture.calls.at(-1)!.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(await checkAuthReadiness({ route, model: "fixture", store })).toMatchObject({ status: "configured-unverified", observedInference: "not-checked" });
    expect(clock.pending()).toBe(0);
  });

  for (const [providerError, kind] of [["access_denied", "denied"], ["expired_token", "expired"], ["unexpected-private-provider-detail", "provider-error"]] as const) {
    test(`${route} maps ${kind} without returning provider details or altering existing credentials`, async () => {
      const clock = manualClock(), store = fakeCredentialStore();
      const id = credentialReferenceForRoute(route);
      await store.set(id, "existing-store-value");
      const fixture = protocol(route, clock, { replies: [{ error: providerError }] });
      const flow = await start({ route, clock, store, fetch: fixture.fetch });
      const work = flow.poll(new AbortController().signal); await clock.advance(2000);
      expect(await work).toEqual({ kind, route, containsNoSecrets: true });
      expect(await store.get(id)).toBe("existing-store-value");
      expect(containsNoSecrets(await work, [...secrets, providerError])).toBe(true);
    });
  }

  test(`${route} expiry starts at issuance and releases an abandoned handle`, async () => {
    const clock = manualClock(), store = fakeCredentialStore(), fixture = protocol(route, clock, { lifetime: 4 });
    const flow = await start({ route, clock, store, fetch: fixture.fetch });
    expect(await beginDeviceSignIn({ route, store, clock, fetch: fixture.fetch })).toEqual({ kind: "busy", route, containsNoSecrets: true });
    await clock.advance(4000);
    expect(await flow.poll(new AbortController().signal)).toMatchObject({ kind: "expired" });
    expect(fixture.calls).toHaveLength(1);
    const next = await start({ route, store, clock, fetch: fixture.fetch }); next.cancel();
    expect(await store.get(credentialReferenceForRoute(route))).toBeNull();
  });

  test(`${route} cancellation interrupts an uncooperative fetch and ignores its late success`, async () => {
    const clock = manualClock(), store = fakeCredentialStore(), response = deferred<Response>();
    const fixture = protocol(route, clock, { onPoll: () => response.promise });
    const flow = await start({ route, clock, store, fetch: fixture.fetch });
    const cancel = new AbortController(), work = flow.poll(cancel.signal);
    await clock.advance(2000); cancel.abort();
    expect(await work).toEqual({ kind: "cancelled", route, containsNoSecrets: true });
    response.resolve(Response.json({ access_token: secrets[0], authorization_code: secrets[3], code_verifier: secrets[4] }));
    await flush();
    expect(await store.get(credentialReferenceForRoute(route))).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  test(`${route} total expiry bounds hung response bodies`, async () => {
    const clock = manualClock(), store = fakeCredentialStore();
    const fixture = protocol(route, clock, { lifetime: 5, onPoll: async () => new Response(new ReadableStream()) });
    const flow = await start({ route, store, clock, fetch: fixture.fetch });
    const work = flow.poll(new AbortController().signal); await clock.advance(5000);
    expect(await work).toEqual({ kind: "expired", route, containsNoSecrets: true });
    expect(await store.get(credentialReferenceForRoute(route))).toBeNull();
  });

  for (const reason of ["cancel", "expiry", "fence", "backend"] as const) {
    test(`${route} ${reason} during a store write cleans only this attempt and settles before release`, async () => {
      const clock = manualClock(), base = fakeCredentialStore(), entered = deferred<void>(), finish = deferred<void>();
      let comparisons = 0, refuse = false;
      const store: HostCredentialStore = { ...base,
        set: async (id, value) => { await base.set(id, value); entered.resolve(); await finish.promise; if (reason === "backend") throw new Error(secrets[0]); },
        compareAndDelete: async (id, value) => { comparisons++; if (await base.get(id) !== value) return false; return base.delete(id); },
      };
      const fixture = protocol(route, clock, { lifetime: 5 });
      const flow = await start({ route, store, clock, fetch: fixture.fetch, credentialWriteGuard: () => { if (refuse) throw new Error(secrets[0]); } });
      const work = flow.poll(new AbortController().signal);
      await clock.advance(2000); await entered.promise;
      if (reason === "cancel") flow.cancel();
      if (reason === "expiry") await clock.advance(3000);
      if (reason === "fence") refuse = true;
      expect((await beginDeviceSignIn({ route, store, clock, fetch: fixture.fetch })).kind).toBe("busy");
      finish.resolve();
      expect(await work).toMatchObject({ kind: reason === "cancel" ? "cancelled" : reason === "expiry" ? "expired" : "store-error", containsNoSecrets: true });
      expect(comparisons).toBe(1);
      expect(await base.get(credentialReferenceForRoute(route))).toBeNull();
      expect(containsNoSecrets(await work, secrets)).toBe(true);
    });
  }

  test(`${route} refused post-write cleanup preserves a newer credential`, async () => {
    const clock = manualClock(), base = fakeCredentialStore(); let flow!: HostDeviceSignIn;
    const store: HostCredentialStore = { ...base, set: async (id, value) => { await base.set(id, value); await base.set(id, "newer-writer"); flow.cancel(); } };
    const fixture = protocol(route, clock); flow = await start({ route, store, clock, fetch: fixture.fetch });
    const work = flow.poll(new AbortController().signal); await clock.advance(2000);
    expect(await work).toMatchObject({ kind: "cancelled" });
    expect(await base.get(credentialReferenceForRoute(route))).toBe("newer-writer");
  });

  test(`${route} failed cleanup reports uncertainty without native diagnostics`, async () => {
    const clock = manualClock(), base = fakeCredentialStore(); let flow!: HostDeviceSignIn;
    const store: HostCredentialStore = { ...base, set: async (id, value) => { await base.set(id, value); flow.cancel(); }, compareAndDelete: async () => { throw new Error(secrets[0]); } };
    const fixture = protocol(route, clock); flow = await start({ route, store, clock, fetch: fixture.fetch });
    const work = flow.poll(new AbortController().signal); await clock.advance(2000);
    expect(await work).toEqual({ kind: "store-error", route, containsNoSecrets: true, cleanupUncertain: true });
  });

  test(`${route} a locked store or pre-write fence refusal is a store error`, async () => {
    for (const failure of ["locked", "fence"]) {
      const clock = manualClock(), base = fakeCredentialStore(), fixture = protocol(route, clock); let writes = 0;
      const flow = await start({ route, clock, fetch: fixture.fetch, store: { ...base, set: async () => { writes++; throw new Error(secrets[0]); } },
        credentialWriteGuard: () => { if (failure === "fence") throw new Error(secrets[1]); } });
      const work = flow.poll(new AbortController().signal); await clock.advance(2000);
      expect(await work).toEqual({ kind: "store-error", route, containsNoSecrets: true, cleanupUncertain: false });
      expect(writes).toBe(failure === "locked" ? 1 : 0);
    }
  });
}

test("start is cancellable and bounded even before authorization responds", async () => {
  for (const mode of ["cancel", "expiry"] as const) {
    const clock = manualClock(), signal = new AbortController(), response = deferred<Response>();
    const work = beginDeviceSignIn({ route: "codex", clock, store: fakeCredentialStore(), signal: signal.signal, fetch: () => response.promise });
    await flush();
    expect((await beginDeviceSignIn({ route: "codex", store: fakeCredentialStore() })).kind).toBe("busy");
    if (mode === "cancel") signal.abort(); else await clock.advance(30_000);
    expect(await work).toMatchObject({ kind: mode === "cancel" ? "cancelled" : "expired", containsNoSecrets: true });
    response.resolve(Response.json({ device_auth_id: secrets[2], user_code: "ABCD-EFGH" })); await flush();
    expect(clock.pending()).toBe(0);
  }
});

test("independent routes can wait concurrently and startup rejects unsafe options and addresses", async () => {
  const clock = manualClock(), store = fakeCredentialStore();
  const flows = await Promise.all((["codex", "grok"] as const).map(route => start({ route, clock, store, fetch: protocol(route, clock).fetch })));
  for (const flow of flows) flow.cancel();
  for (const options of [{ route: "other" }, { route: "codex", tokens: secrets[0] }, { route: "codex", store: {} }, { route: "codex", clock: {} }, { route: "codex", signal: {} }]) {
    await expect(beginDeviceSignIn(options as HostDeviceSignInOptions)).rejects.toMatchObject({ code: "invalid-options" });
  }
  for (const route of ["codex", "grok"] as const) {
    const outcome = await beginDeviceSignIn({ route, store, clock, fetch: async () => Response.json({ device_auth_id: secrets[2], device_code: secrets[2], user_code: "ABCD-EFGH", verification_uri: "http://unsafe.example" }) });
    expect(outcome).toEqual({ kind: "provider-error", route, containsNoSecrets: true });
  }
  expect(hostCapabilities().deviceSignInContract).toBe("schway.host.device-sign-in/v1");
  expect(hostCapabilities().releaseContract).toBe("schway.host.release/v2");
});

test("host device sign-in loads only the selected provider and no TUI or CLI", async () => {
  await withTempDir(async directory => {
    for (const route of ["codex", "grok"] as const) {
      const guard = join(directory, "guard.ts"), script = join(directory, "consumer.ts");
      await Bun.write(guard, `await Bun.plugin({ name: "device-import-guard", setup(builder) {
        builder.onLoad({ filter: /(?:tui|cli)\\/|${route === "codex" ? "grok-subscription" : "codex-subscription"}\\.ts|@opentui|node_modules\\/openai\\// }, () => { throw Error("Forbidden initialization"); });
      }});`);
      await Bun.write(script, `import { beginDeviceSignIn } from ${JSON.stringify(resolve(import.meta.dir, "../src/host/index.ts"))};
        const store = { async get() { throw Error("No reads expected"); }, async set() { throw Error("No writes expected"); }, async delete() { throw Error("No deletes expected"); } };
        const flow = await beginDeviceSignIn({ route: ${JSON.stringify(route)}, store, fetch: async () => Response.json({ device_auth_id: "fixture", device_code: "fixture", user_code: "ABCD", verification_uri: "https://accounts.x.ai/device" }) });
        if (flow.kind !== "pending") throw Error("Expected approval"); flow.cancel(); console.log(JSON.stringify(await flow.poll(new AbortController().signal)));`);
      const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", guard, script], { cwd: directory, env: buildIsolatedCliEnv(directory), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toEqual({ kind: "cancelled", route, containsNoSecrets: true });
    }
  });
});

for (const route of ["codex", "grok"] as const) {
  for (const phase of ["fetch", "body"] as const) {
    test(`${route} shared provider expires a hung ${phase} on its injected clock`, async () => {
      const clock = manualClock(), cancel = new AbortController(), response = deferred<Response>();
      let requestSignal: AbortSignal | undefined, failure: unknown;
      const fixture = protocol(route, clock, { lifetime: 5, onPoll: async init => {
        requestSignal = init?.signal ?? undefined;
        return phase === "fetch" ? response.promise : new Response(new ReadableStream());
      } });
      const provider = route === "codex" ? await import("../src/model/providers/codex-subscription.ts")
        : await import("../src/model/providers/grok-subscription.ts");
      const authorization = await provider.beginDeviceAuthorization({ fetch: fixture.fetch, now: clock.now, sleep: clock.sleep });
      const work = authorization.poll(cancel.signal).catch(error => { failure = error; });
      try {
        await clock.advance(4999);
        expect(requestSignal).toBeDefined(); expect(requestSignal?.aborted).toBe(false);
        expect(failure).toBeUndefined();
        await clock.advance(1);
        expect(failure).toMatchObject({ kind: "expired", message: route === "codex"
          ? "Device sign-in timed out · /login chatgpt --device retry"
          : "Grok device sign-in timed out waiting for approval. Restart /login grok --device." });
        expect(requestSignal?.aborted).toBe(true);
        expect(clock.pending()).toBe(0);
      } finally {
        cancel.abort(); response.resolve(Response.json({})); await work;
      }
    });
  }

  test(`${route} CLI consumes the same issuance deadline before polling or saving`, async () => {
    let time = 1_800_000_000_000, saves = 0, polls = 0;
    const fetch: HostAuthFetch = async url => {
      if (!String(url).endsWith("usercode") && !String(url).endsWith("device/code")) { polls++; throw new Error("No poll after expiry"); }
      return Response.json({ device_auth_id: "fixture", device_code: "fixture", user_code: "ABCD", verification_uri: "https://accounts.x.ai/device", expires_in: 1 });
    };
    const work = route === "codex"
      ? (await import("../src/model/providers/codex-subscription.ts")).loginWithDeviceFlow({
          store: { ...fakeCredentialStore(), set: async () => { saves++; } },
          deps: { fetch, now: () => time, onProgress: () => { time += 2000; } },
        })
      : (await import("../src/model/providers/grok-subscription.ts")).loginWithDeviceFlow({
          signal: new AbortController().signal,
          deps: { fetch, now: () => time, saveTokens: async () => { saves++; }, onApproval: () => { time += 2000; } },
        });
    await expect(work).rejects.toMatchObject({ kind: "expired" });
    expect(polls).toBe(0); expect(saves).toBe(0);
  });

  test(`${route} zero-lifetime grants expire before returning approval`, async () => {
    const clock = manualClock(), store = fakeCredentialStore();
    expect(await beginDeviceSignIn({ route, clock, store, fetch: protocol(route, clock, { lifetime: 0 }).fetch }))
      .toEqual({ kind: "expired", route, containsNoSecrets: true });
  });
}

for (const expiry of ["ISO date", "Unix seconds", "Unix milliseconds", "relative seconds"] as const) {
  test(`Codex keeps ${expiry} expiry after a slow authorization request`, async () => {
    const clock = manualClock(), issuedAt = clock.now(), expiresAt = issuedAt + 30_000;
    const fixture = protocol("codex", clock);
    const fetch: HostAuthFetch = async (url, init) => {
      if (!String(url).endsWith("usercode")) return fixture.fetch(url, init);
      await clock.advance(20_000);
      return Response.json({ device_auth_id: "fixture", user_code: "ABCD", ...(expiry === "relative seconds"
        ? { expires_in: 30 } : { expires_at: expiry === "ISO date" ? new Date(expiresAt).toISOString()
          : expiry === "Unix seconds" ? expiresAt / 1000 : expiresAt }) });
    };
    const flow = await start({ route: "codex", clock, store: fakeCredentialStore(), fetch });
    expect(flow.expiresAt).toBe(expiresAt);
    expect(flow.expiresAt - clock.now()).toBe(10_000);
    expect(await flow.poll(new AbortController().signal)).toEqual({ kind: "ready", route: "codex", containsNoSecrets: true });
    expect(clock.pending()).toBe(0);
  });
}

test("Codex expiry and denial during PKCE exchange remain typed and secret-free", async () => {
  for (const [error, kind] of [["invalid_grant", "expired"], ["access_denied", "denied"]] as const) {
    const clock = manualClock(), store = fakeCredentialStore();
    const fixture = protocol("codex", clock, { onExchange: async () => Response.json({ error, error_description: secrets[0] }, { status: 400 }) });
    const flow = await start({ route: "codex", store, clock, fetch: fixture.fetch });
    const work = flow.poll(new AbortController().signal); await clock.advance(0);
    expect(await work).toEqual({ kind, route: "codex", containsNoSecrets: true });
    expect(await store.get(credentialReferenceForRoute("codex"))).toBeNull();
  }
});

test("Codex cancellation bounds an uncooperative PKCE exchange without saving its late tokens", async () => {
  const clock = manualClock(), store = fakeCredentialStore(), exchange = deferred<Response>();
  const fixture = protocol("codex", clock, { onExchange: () => exchange.promise });
  const flow = await start({ route: "codex", store, clock, fetch: fixture.fetch });
  const work = flow.poll(new AbortController().signal); await clock.advance(0); flow.cancel();
  expect(await work).toMatchObject({ kind: "cancelled" });
  exchange.resolve(Response.json({ access_token: secrets[0], refresh_token: secrets[1] })); await flush();
  expect(await store.get(credentialReferenceForRoute("codex"))).toBeNull();
});

test("pre-aborted startup and unpolled cancellation make no credential request or write", async () => {
  for (const route of ["codex", "grok"] as const) {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    expect(await beginDeviceSignIn({ route, signal: controller.signal, store: fakeCredentialStore(), fetch: async () => { calls++; throw new Error("No request expected"); } }))
      .toEqual({ kind: "cancelled", route, containsNoSecrets: true });
    expect(calls).toBe(0);
    const clock = manualClock(), fixture = protocol(route, clock), store = fakeCredentialStore();
    const flow = await start({ route, clock, store, fetch: fixture.fetch }); flow.cancel(); flow.cancel();
    expect(await flow.poll(new AbortController().signal)).toMatchObject({ kind: "cancelled" });
    expect(fixture.calls).toHaveLength(1); expect(clock.pending()).toBe(0);
    expect(await store.get(credentialReferenceForRoute(route))).toBeNull();
  }
});
