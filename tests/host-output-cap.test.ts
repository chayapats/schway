import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHost, describeAuthRoute, hostCapabilities, HostError, isRouteControlRefused, listRouteModels,
  type HostDispatch, type HostOptions, type Model } from "schway/host";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { dispatchRouteModel } from "../src/host/dispatch.ts";
import { providerDispatch } from "../src/model/dispatch.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";

type Route = "codex" | "grok";
const MODEL: Record<Route, string> = { codex: "gpt-5.4", grok: "grok-4.7" };
const GROK_DEFAULT_CAP = 16_384;

async function options(dir: string, auth: HostOptions["auth"]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 }, auth };
}

async function seededStore(route: Route): Promise<CredentialStore> {
  const store = fakeCredentialStore();
  await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), JSON.stringify({
    accessToken: "cap-access", refreshToken: "cap-refresh", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
  return store;
}

function answer(route: Route, text = "Summary of the earlier retained work."): Response {
  if (route === "codex") {
    const events = [
      { type: "response.created", response: { id: "r", status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed" } },
    ];
    return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }
  return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
}

/** Fake transport recording inference bodies; catalog GETs list the route's model. */
function transport(route: Route, inference: Array<() => Response> = []) {
  const bodies: string[] = [];
  const queue = [...inference];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "GET") return route === "codex" ? Response.json({ models: [{ slug: MODEL.codex, visibility: "list" }] }) : Response.json({ data: [{ id: MODEL.grok }] });
    if (url.includes("auth.x.ai") || url.includes("/oauth/token")) return Response.json({ access_token: "cap-access-new", refresh_token: "cap-refresh", expires_in: 3600 });
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const next = queue.shift();
    return next ? next() : answer(route);
  }) as never;
  const caps = () => bodies.map(body => (JSON.parse(body) as { max_output_tokens?: number }).max_output_tokens ?? null);
  return { fetch, bodies, caps };
}

async function drain(model: Model): Promise<void> {
  for await (const _event of model.stream({ systemPrompt: "s", context: [], items: [{ type: "user", id: "u1", content: [{ type: "text", text: "hello" }] }] })) { /* drain */ }
}

test("capabilities advertise the output-cap contract", () => {
  expect(hostCapabilities().outputCapContract).toBe("schway.host.output-cap/v1");
});

test("output-cap support is readable without network or inference", async () => {
  // describeAuthRoute takes no store or fetch: the answer is static.
  expect(describeAuthRoute({ route: "codex", model: MODEL.codex }).outputCap).toEqual({ enforced: false, default: null, maximum: null });
  expect(describeAuthRoute({ route: "grok", model: MODEL.grok }).outputCap).toEqual({ enforced: true, default: GROK_DEFAULT_CAP, maximum: GROK_DEFAULT_CAP });
  for (const route of ["codex", "grok"] as const) {
    const store = await seededStore(route);
    const listing = await listRouteModels({ route, store, fetch: transport(route).fetch });
    if (listing.status !== "listed") throw new Error("expected listing");
    expect(listing.models[0]!.outputCap).toEqual(describeAuthRoute({ route, model: MODEL[route] }).outputCap);
  }
});

test("codex refuses a required or explicit cap at createModel before any request", async () => {
  await withTempDir(async dir => {
    const wire = transport("codex");
    const host = await createHost(await options(dir, { route: "codex", model: MODEL.codex, store: await seededStore("codex"), fetch: wire.fetch }));
    for (const bad of [{ requireOutputCap: true }, { maxOutputTokens: 1024 }, { maxOutputTokens: 1024, requireOutputCap: true }]) {
      const failure = await host.auth!.createModel(bad).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HostError);
      expect((failure as HostError).code).toBe("invalid-input");
    }
    // requireOutputCap: false asks for nothing, so it is accepted and sends no cap.
    await drain(await host.auth!.createModel({ requireOutputCap: false }));
    expect(wire.caps()).toEqual([null]);
    await host.close();
  });
});

test("grok rejects invalid caps at createModel", async () => {
  await withTempDir(async dir => {
    const wire = transport("grok");
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store: await seededStore("grok"), fetch: wire.fetch }));
    for (const bad of [{ maxOutputTokens: 0 }, { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: "100" }, { maxOutputTokens: Number.NaN },
      { maxOutputTokens: GROK_DEFAULT_CAP + 1 }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }, { requireOutputCap: "yes" }]) {
      const failure = await host.auth!.createModel(bad as never).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HostError);
      expect((failure as HostError).code).toBe("invalid-input");
    }
    expect(wire.bodies).toHaveLength(0);
    await host.close();
  });
});

test("grok sends exactly the requested cap on turns, compaction and auth-retry resends, and reports it", async () => {
  await withTempDir(async dir => {
    const wire = transport("grok", [() => new Response("expired", { status: 401 })]);
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store: await seededStore("grok"), fetch: wire.fetch }));
    const session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const seen: HostDispatch[] = [];
    const model = await host.auth!.createModel({ maxOutputTokens: 1234, requireOutputCap: true, authorizeDispatch: dispatch => { seen.push(dispatch); } });
    const compacted = await session.compact(model);
    expect(compacted.outcome).toBe("completed");
    const run = await session.submit({ text: "capped" }, model);
    expect(run.outcome).toBe("completed");
    // Compaction met a 401, renewed and resent; then one turn. Every body carries the exact cap.
    expect(wire.caps()).toEqual([1234, 1234, 1234]);
    expect(seen.map(dispatch => [dispatch.kind, dispatch.outputCap.sent])).toEqual([["initial", 1234], ["auth-retry", 1234], ["initial", 1234]]);
    expect(compacted.usage.attempts.map(attempt => attempt.outputCap)).toEqual([{ sent: 1234 }]);
    expect(run.usage.attempts.map(attempt => attempt.outputCap)).toEqual([{ sent: 1234 }]);
    await session.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} observation reports the cap in the body by default, and bytes are unchanged without options`, async () => {
    await withTempDir(async dir => {
      const wire = transport(route);
      const host = await createHost(await options(dir, { route, model: MODEL[route], store: await seededStore(route), fetch: wire.fetch }));
      const session = await host.createSession();
      const seen: HostDispatch[] = [];
      const run = await session.submitWithRoute({ text: "default cap" }, { authorizeDispatch: dispatch => { seen.push(dispatch); } });
      expect(run.outcome).toBe("completed");
      const expected = route === "codex" ? null : GROK_DEFAULT_CAP;
      expect(wire.caps()).toEqual([expected]);
      expect(seen.map(dispatch => dispatch.outputCap)).toEqual([{ sent: expected }]);
      expect(run.usage.attempts.map(attempt => attempt.outputCap)).toEqual([{ sent: expected }]);
      // The same request through createModel() with and without options that change nothing sends identical bytes.
      await drain(await host.auth!.createModel());
      await drain(await host.auth!.createModel(route === "grok" ? { requireOutputCap: true } : { requireOutputCap: false }));
      expect(wire.bodies[2]).toBe(wire.bodies[1]!);
      await session.close(); await host.close();
    });
  });
}

test("a body without the required cap is refused before the authorizer and never sent", async () => {
  // Defense in depth: an adapter stack whose body misses the cap is refused by identity before authorization.
  let authorizations = 0, sends = 0;
  const inner: Model = { provider: "xai", id: MODEL.grok, async *stream(_request, call) {
    providerDispatch(call)!.send("initial", "{}", { effort: null, outputCap: 999 });
    sends++;
  } };
  const model = dispatchRouteModel(inner, "grok", () => { authorizations++; }, { outputCap: { exact: 1234, required: true } });
  const failure = await drain(model).then(() => undefined, (error: unknown) => error);
  expect(isRouteControlRefused(failure)).toBe(true);
  expect((failure as Error).message).toBe("The required output cap could not be sent exactly, so the request was not sent. Retry with a cap this route supports.");
  expect(authorizations).toBe(0);
  expect(sends).toBe(0);
});
