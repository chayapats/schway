import { expect, test } from "bun:test";
import { codexSubscriptionIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { parseImageInputProbeArgs, runImageInputProbe, type ImageInputProbeSelection } from "../src/live/image-input-probe.ts";
import { hostCapabilities } from "schway/host";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const selection = (route: "codex" | "grok"): ImageInputProbeSelection => ({ enabled: true, route,
  model: route === "codex" ? "gpt-5.4" : "grok-4.7", revision: "fixture-revision", timeoutMs: 1000 });

async function credentials(route: "codex" | "grok") {
  const store = fakeCredentialStore();
  await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), JSON.stringify({
    accessToken: "image-probe-fixture-token", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(),
  }));
  return store;
}

function sse(text: string, complete = true): Response {
  return new Response([
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    ...(complete ? [{ type: "response.completed", response: { id: "fixture", status: "completed" } }] : []),
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("probe parsing requires an exact route/model and finite timeout", () => {
  expect(parseImageInputProbeArgs([])).toBeNull();
  expect(parseImageInputProbeArgs(["--route", "other", "--model", "m"])).toBeNull();
  expect(parseImageInputProbeArgs(["--route", "codex", "--model", "m", "--timeout-ms", "999"])).toBeNull();
  expect(parseImageInputProbeArgs(["--route", "grok", "--model", "m"])).toMatchObject({ enabled: false, route: "grok", model: "m" });
  expect(parseImageInputProbeArgs(["--enable-live", "--route", "codex", "--model", "m"])).toMatchObject({ enabled: true });
});

test("disabled probe reads no store, constructs no adapter and calls no transport", async () => {
  const unexpected = () => { throw new Error("unexpected side effect"); };
  for (const route of ["codex", "grok"] as const) {
    const result = await runImageInputProbe({ ...selection(route), enabled: false }, { createStore: unexpected, createModel: unexpected, fetch: unexpected });
    expect(result.status).toBe("skipped"); expect(result.reason).toBe("live_disabled");
    expect(result.record.verdict).toBe("inconclusive"); expect(result.calls).toEqual([]);
  }
});

for (const route of ["codex", "grok"] as const) test(`${route} fixture probe checks both formats and replay using the selected production adapter`, async () => {
  const store = await credentials(route);
  const bodies: { input: Array<{ content?: { type: string; image_url?: string }[] }> }[] = [];
  const urls: string[] = [];
  const report = await runImageInputProbe(selection(route), { createStore: () => store, fetch: async (url, init) => {
    urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
    return sse(bodies.length === 1 ? "582731" : "914026");
  } });
  expect(report.status).toBe("complete"); expect(report.record.verdict).toBe("pass");
  expect(report.calls.map(call => call.mediaType)).toEqual(["image/png", "image/jpeg"]);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.input[0]!.content![1]!.image_url).toStartWith("data:image/png;base64,");
  const replay = bodies[1]!.input.flatMap(item => item.content ?? []).filter(part => part.type === "input_image");
  expect(replay).toHaveLength(2);
  expect(replay[0]!.image_url).toStartWith("data:image/png;base64,");
  expect(replay[1]!.image_url).toStartWith("data:image/jpeg;base64,");
  expect(urls.every(url => route === "codex" ? url.includes("chatgpt.com") : url.includes("api.x.ai"))).toBe(true);
  const caps = hostCapabilities([report.record]);
  expect(caps.imageInputRoutes.find(cap => cap.route === route)?.passedModels).toEqual([selection(route).model]);
  for (const forbidden of ["582731", "914026", "image-probe-fixture-token", "Bearer", "data:image", "chatgpt.com", "api.x.ai", "Read the six"]) expect(JSON.stringify(report)).not.toContain(forbidden);
});

test("incorrect text, truncation, HTTP refusal and transport errors never produce a passing record", async () => {
  const store = await credentials("codex");
  for (const response of [() => sse("I cannot see it"), () => sse("582731", false),
    () => new Response("sensitive transport detail", { status: 415 }), () => { throw new Error("image-probe-fixture-token"); }]) {
    const report = await runImageInputProbe(selection("codex"), { createStore: () => store, fetch: async () => response() });
    expect(report.status).toBe("failed"); expect(report.record.verdict).not.toBe("pass");
    expect(hostCapabilities([report.record]).imageInputRoutes.every(cap => !cap.passedModels.length)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("sensitive transport detail");
    expect(JSON.stringify(report)).not.toContain("image-probe-fixture-token");
  }
});

test("pre-aborted probe remains inconclusive without an HTTP request", async () => {
  const store = await credentials("grok"); let calls = 0;
  const report = await runImageInputProbe(selection("grok"), { createStore: () => store, signal: AbortSignal.abort(), fetch: async () => { calls++; return sse("never"); } });
  expect(calls).toBe(0); expect(report.record.verdict).toBe("inconclusive");
});
