import { expect, test } from "bun:test";
import { classifyAuthError, containsNoSecrets } from "schway/host";
import { discoverModels } from "../src/model/catalog-discovery.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { fetchSubscriptionModels, saveSubscriptionTokens } from "../src/model/providers/grok-subscription.ts";
import { GROK_ERROR_FIXTURES, grokErrorResponse } from "./fixtures/grok-errors.ts";
import { sampleRequest } from "./fixtures/openai.ts";
import { collect } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

for (const fixture of GROK_ERROR_FIXTURES) for (const path of ["model list", "discovery", "inference"] as const) {
  test(`Grok ${fixture.name} agrees across ${path} and auth status`, async () => {
    const store = fakeCredentialStore();
    await saveSubscriptionTokens(store, { accessToken: "fixture-access-sentinel", refreshToken: "fixture-refresh-sentinel", obtainedAt: 0 });
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => { calls.push(String(url)); return grokErrorResponse(fixture); };
    let error: unknown;
    if (path === "discovery") {
      const result = await discoverModels({ provider: "xai", xaiAuth: "grok", env: { XAI_API_KEY: "billing-bait" } }, { store, fetch });
      expect(result.catalog.models).toEqual([]);
      if (fixture.expected === "quota-exceeded") expect(result.error).toContain("https://grok.com/?_s=usage");
      error = new Error(result.error);
    } else {
      try {
        if (path === "model list") await fetchSubscriptionModels({ store, fetch });
        else {
          const model = await loadProviderModel({ provider: "xai", xaiAuth: "grok", grokStore: store, model: "grok-4.7", apiKey: "billing-bait" }, fetch);
          await collect(model.stream(sampleRequest()));
        }
      } catch (caught) { error = caught; }
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(fixture.message);
    const status = classifyAuthError(error, { route: "grok", model: "grok-4.7" });
    expect(status.status).toBe(fixture.expected);
    if (fixture.expected === "quota-exceeded") expect(status.nextAction).toContain("https://grok.com/?_s=usage");
    expect(containsNoSecrets([String(error), status], ["untrusted-body-sentinel", "fixture-access-sentinel", "fixture-refresh-sentinel", "billing-bait"])).toBe(true);
    expect(calls).toEqual([path === "inference" ? "https://api.x.ai/v1/responses" : "https://api.x.ai/v1/models"]);
  });
}
