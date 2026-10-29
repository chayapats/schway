import { expect, test } from "bun:test";
import { containsNoSecrets, hostCapabilities, listRouteModels, RELEASE_CONTRACT, type HostAuthRoute, type HostAuthSelection } from "schway/host";
import { codexSubscriptionIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { GROK_ERROR_FIXTURES, grokErrorResponse } from "./fixtures/grok-errors.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

async function selection(route: HostAuthRoute, expired = false): Promise<Omit<HostAuthSelection, "model">> {
  const values = fakeCredentialStore();
  await values.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), JSON.stringify({
    accessToken: "catalog-access-sentinel", refreshToken: "catalog-refresh-sentinel", obtainedAt: 0,
    ...(expired ? { expiresAt: 1 } : {}),
  }));
  return { route, store: {
    get: async identity => {
      expect(identity.account).toBe(route === "codex" ? "codex-subscription:chatgpt" : "grok-subscription:xai");
      return values.get(identity);
    },
    set: async () => { throw new Error("catalog must not write"); },
    delete: async () => { throw new Error("catalog must not delete"); },
  }, env: { OPENAI_API_KEY: "billing-bait", XAI_API_KEY: "billing-bait" } };
}

test("model catalog discovery is additive to the unchanged release contract", () => {
  expect(hostCapabilities().modelCatalog).toBe("schway.host.model-catalog/v1");
  expect(hostCapabilities().releaseContract).toBe("schway.host.release/v2");
  expect(RELEASE_CONTRACT).toBe("schway.host.release/v2");
  expect(hostCapabilities().observedInference).toBe("not-checked");
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} catalog reads only its account and shares recommendation precedence`, async () => {
    const input = await selection(route);
    let requests = 0, guards = 0;
    input.credentialWriteGuard = () => { guards++; throw new Error("unused-guard-sentinel"); };
    input.fetch = async (url, init) => {
      requests++;
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer catalog-access-sentinel");
      expect(String(url)).toContain(route === "codex" ? "chatgpt.com/backend-api/codex/models?client_version=" : "api.x.ai/v1/models");
      return route === "codex"
        ? Response.json({ models: [{ slug: "gpt-6-astra", visibility: "list" }, { slug: "account-choice", context_window: 64000, is_default: true, visibility: "list" }] })
        : Response.json({ data: [{ id: "grok-4.7" }, { id: "grok-account-choice", context_length: 64000, default: true }] });
    };
    const result = await listRouteModels(input);
    expect(result).toEqual({ status: "listed", route, containsNoSecrets: true, models: [
      { id: route === "codex" ? "account-choice" : "grok-account-choice", recommended: true, contextWindow: 64000 },
      { id: route === "codex" ? "gpt-6-astra" : "grok-4.7", recommended: false },
    ] });
    expect(requests).toBe(1); expect(guards).toBe(0);
    expect(containsNoSecrets(result, ["catalog-access-sentinel", "catalog-refresh-sentinel", "billing-bait", "unused-guard-sentinel"])).toBe(true);
  });

  test(`${route} bounded catalog keeps the shared fallback recommendation and drops unsafe IDs`, async () => {
    const input = await selection(route);
    const fallback = route === "codex" ? "gpt-6-astra" : "grok-4.7";
    const models = Array.from({ length: 80 }, (_, index) => ({ id: `${route === "grok" ? "grok" : "account"}-${String(index).padStart(3, "0")}` }));
    models.push({ id: fallback }, { id: "grok-catalog-access-sentinel" }, { id: "grok-invalid/id" });
    input.fetch = async () => Response.json(route === "codex" ? { models: models.map(model => ({ slug: model.id, visibility: "list" })) } : { data: models });
    const result = await listRouteModels(input);
    expect(result.status).toBe("listed");
    if (result.status === "listed") {
      expect(result.models).toHaveLength(64);
      expect(result.models.filter(model => model.recommended)).toEqual([{ id: fallback, recommended: true }]);
    }
    expect(containsNoSecrets(result, ["catalog-access-sentinel"])).toBe(true);
    expect(JSON.stringify(result)).not.toContain("grok-invalid/id");
  });

  for (const guard of ["absent", "allows", "refuses"] as const) test(`${route} expired catalog never refreshes or writes when guard ${guard}`, async () => {
    const input = await selection(route, true);
    let guards = 0, requests = 0;
    if (guard !== "absent") input.credentialWriteGuard = () => { guards++; if (guard === "refuses") throw new Error("guard-secret-sentinel"); };
    input.fetch = async () => { requests++; throw new Error("must not send renewal"); };
    const result = await listRouteModels(input);
    expect(result).toMatchObject({ route, status: guard === "refuses" ? "store-unavailable" : "needs-login", containsNoSecrets: true });
    expect(requests).toBe(0); expect(guards).toBe(guard === "absent" ? 0 : 1);
    expect(containsNoSecrets(result, ["guard-secret-sentinel", "catalog-access-sentinel", "catalog-refresh-sentinel"])).toBe(true);
  });

  test(`${route} catalog distinguishes local failures before HTTP`, async () => {
    for (const state of ["missing", "locked", "invalid"] as const) {
      const store = fakeCredentialStore();
      if (state === "invalid") await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), "invalid-store-sentinel");
      if (state === "locked") store.get = async () => { throw new Error("native-store-sentinel"); };
      const result = await listRouteModels({ route, store, fetch: async () => { throw new Error("unexpected HTTP"); } });
      expect(result).toMatchObject({ route, status: state === "missing" ? "needs-login" : state === "locked" ? "store-unavailable" : "invalid-store", containsNoSecrets: true });
      expect(containsNoSecrets(result, ["invalid-store-sentinel", "native-store-sentinel"])).toBe(true);
    }
  });

  for (const status of [401, 403, 429, 500] as const) test(`${route} catalog HTTP ${status} is a safe non-listed result`, async () => {
    const input = await selection(route);
    input.fetch = async () => new Response("untrusted-body-sentinel", { status });
    const result = await listRouteModels(input);
    // Grok 401 requires renewal, which this read-only API refuses before HTTP.
    const expected = route === "grok" && status === 401 ? "needs-login" : status === 401 || status === 403 ? "rejected" : status === 429 ? "quota-exceeded" : "integration-unavailable";
    expect(result).toMatchObject({ route, status: expected, containsNoSecrets: true });
    expect(containsNoSecrets(result, ["untrusted-body-sentinel", "catalog-access-sentinel"])).toBe(true);
  });

  for (const payload of ["empty", "malformed"] as const) test(`${route} ${payload} catalog does not invent a model`, async () => {
    const input = await selection(route);
    input.fetch = async () => payload === "malformed" ? new Response("not-json") : Response.json({ models: [], data: [] });
    const result = await listRouteModels(input);
    expect(result.status).toBe(payload === "empty" ? "model-unavailable" : "integration-unavailable");
    expect("models" in result).toBe(false);
  });
}

for (const fixture of GROK_ERROR_FIXTURES) test(`Grok catalog carries ${fixture.name} through the host status contract`, async () => {
  const input = await selection("grok");
  input.fetch = async () => grokErrorResponse(fixture);
  const result = await listRouteModels(input);
  expect(result).toMatchObject({ route: "grok", status: fixture.expected, containsNoSecrets: true });
  if (fixture.expected === "quota-exceeded" && result.status !== "listed") expect(result.nextAction).toContain("https://grok.com/?_s=usage");
  expect(containsNoSecrets(result, ["untrusted-body-sentinel"])).toBe(true);
});

test("catalog selection rejects model IDs, raw credential fields and unsupported routes", async () => {
  for (const input of [{ route: "grok", model: "grok-4.7" }, { route: "grok", apiKey: "secret-sentinel" }, { route: "api-key" }, null]) {
    await expect(listRouteModels(input as never)).rejects.toThrow();
  }
});
