import { expect, test } from "bun:test";
import { resolveSubscriptionRoute } from "../src/auth/subscription-route.ts";
import { resolvePrice, estimateSpendUsd } from "../src/eval/spend.ts";

for (const provider of ["codex", "grok"] as const) {
  test(`${provider} refresh persists renewed credentials using only its store identity`, async () => {
    let raw = JSON.stringify({ accessToken: "old", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 });
    const identities: string[] = [];
    let fetches = 0, writes = 0;
    const store = { get: async (identity: { account: string }) => { identities.push(identity.account); return raw; },
      set: async (identity: { account: string }, value: string) => { identities.push(identity.account); writes++; raw = value; }, delete: async () => false };
    const result = await resolveSubscriptionRoute({ provider, model: "fixture", maxTokens: 100, store, refresh: true,
      fetch: async () => { fetches++; return Response.json({ access_token: "new-fixture-token", expires_in: 3600, token_type: "Bearer" }); } });
    expect(result).toHaveProperty("input");
    expect(JSON.parse(raw)).toMatchObject({ accessToken: "new-fixture-token", refreshToken: "fixture-refresh" });
    expect(fetches).toBe(1); expect(writes).toBe(1);
    expect(new Set(identities)).toEqual(new Set([provider === "codex" ? "codex-subscription:chatgpt" : "grok-subscription:xai"]));
  });
  test(`${provider} failed refresh and inaccessible stores return safe readiness reasons`, async () => {
    const raw = JSON.stringify({ accessToken: "old", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 });
    for (const inaccessible of [false, true]) {
      const result = await resolveSubscriptionRoute({ provider, model: "fixture", maxTokens: 100, refresh: true,
        store: { get: async () => { if (inaccessible) throw Error("private"); return raw; }, set: async () => { throw Error("unexpected write"); }, delete: async () => false },
        fetch: async () => Response.json({ error: "invalid_grant" }, { status: 401 }) });
      expect(result).toEqual({ reason: inaccessible ? "credential_store_unavailable" : "subscription_requires_login" });
    }
  });
  test(`${provider} always has flat-rate pricing even with overrides and incomplete usage`, () => {
    const price = resolvePrice(provider, "unknown", { inputPerMillion: 999, outputPerMillion: 999 })!;
    expect(price.billing).toBe("subscription");
    expect(estimateSpendUsd({ inputTokens: null, outputTokens: null, unknownInputAttempts: 1, unknownOutputAttempts: 1, incompleteAttempts: 1 }, price)).toEqual({ usd: 0, exact: true });
  });
}
