import { expect, test } from "bun:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHost, createImageContent, hostCapabilities, HostImageError, IMAGE_INPUT_CONTRACT, MAX_IMAGE_BYTES,
  type HostImageProbeRecord, type HostOptions, type ImageContent, type ModelRequest } from "schway/host";
import { estimateItemTokens } from "../src/context/tokens.ts";
import { formatItemForSummary } from "../src/context/compaction.ts";
import { inputImages, requestImages } from "../src/conversation/images.ts";
import { buildResponsesRequest } from "../src/model/providers/responses-stream.ts";
import { toCodexResponsesBody } from "../src/model/providers/codex-subscription.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

const png = new Uint8Array(await Bun.file(new URL("../src/live/fixtures/image-probe.png", import.meta.url)).arrayBuffer());
const jpeg = new Uint8Array(await Bun.file(new URL("../src/live/fixtures/image-probe.jpeg", import.meta.url)).arrayBuffer());
const image = createImageContent("attachment:fixture@1", "image/png", png);
const photo = createImageContent("attachment:photo@1", "image/jpeg", jpeg);
const probe = (route: "codex" | "grok" = "codex", model = "scripted"): HostImageProbeRecord => ({
  contract: IMAGE_INPUT_CONTRACT, route, model, testedAt: "2026-10-29T00:00:00.000Z", revision: "fixture", verdict: "pass",
});

async function options(dir: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted operator", sections: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 1, contextWindow: 200_000, maxInputChars: 4096, maxAttempts: 1 },
    images: { probes: [probe()], resolve: async part => part.sha256 === image.sha256 ? png : jpeg } };
}

function code(callback: () => unknown, expected: HostImageError["code"]) {
  try { callback(); throw new Error("Expected typed image failure"); }
  catch (error) { expect(error).toBeInstanceOf(HostImageError); expect((error as HostImageError).code).toBe(expected); }
}

test("reference creation enforces MIME, byte and header pixel bounds without decoding", () => {
  expect(image).toMatchObject({ type: "image", mediaType: "image/png", width: 240, height: 80, byteLength: png.length });
  expect(photo).toMatchObject({ mediaType: "image/jpeg", width: 240, height: 80 });
  code(() => createImageContent("image", "image/webp" as never, png), "invalid-image");
  code(() => createImageContent("image", "image/jpeg", png), "invalid-image");
  code(() => createImageContent("image", "image/png", new Uint8Array(MAX_IMAGE_BYTES + 1)), "image-byte-limit");
  code(() => createImageContent("image", "image/jpeg", jpeg.slice(0, 10)), "invalid-image");
  const wide = new Uint8Array(png); new DataView(wide.buffer).setUint32(16, 2049);
  code(() => createImageContent("image", "image/png", wide), "image-pixel-limit");
  code(() => inputImages(Array(6).fill(image)), "image-count-limit");
  code(() => inputImages([{ ...image, byteLength: MAX_IMAGE_BYTES + 1 }]), "image-byte-limit");
  code(() => inputImages([{ ...image, height: 2049 }]), "image-pixel-limit");
  code(() => inputImages([{ ...image, data: png }]), "invalid-image");
  code(() => inputImages([{ ...image, reference: "data:image/png;base64,anything" }]), "invalid-image");
  code(() => requestImages([{ type: "user", id: "u", content: Array(51).fill(image) }]), "image-count-limit");
  code(() => requestImages([{ type: "user", id: "u", content: Array(6).fill({ ...image, byteLength: MAX_IMAGE_BYTES }) }]), "image-byte-limit");
});

test("capability admission is route/model scoped, explicit, detached and fail closed", () => {
  expect(hostCapabilities().imageInputContract).toBe(IMAGE_INPUT_CONTRACT);
  expect(hostCapabilities().releaseContract).toBe("schway.host.release/v2");
  expect(hostCapabilities().imageInputRoutes.map(route => route.passedModels)).toEqual([[], []]);
  const records = [probe("grok", "grok-4.7")];
  const caps = hostCapabilities(records);
  records[0] = probe("codex");
  expect(caps.imageInputRoutes).toEqual([
    { route: "codex", source: "embedder-probe-record", passedModels: [] },
    { route: "grok", source: "embedder-probe-record", passedModels: ["grok-4.7"] },
  ]);
  expect(() => hostCapabilities([{ ...probe(), verdict: "guessed" } as never])).toThrow();
  expect(() => hostCapabilities([probe(), probe()])).toThrow();
});

test("unprobed or mismatched routes never accept input, resolve bytes or call a model", async () => {
  await withTempDir(async dir => {
    for (const probes of [[], [probe("grok")], [probe("codex", "other")], [{ ...probe(), verdict: "inconclusive" as const }]]) {
      const config = await options(dir);
      let calls = 0;
      config.images = { probes, resolve: async () => { calls++; return png; } };
      const host = await createHost(config), session = await host.createSession();
      const before = await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8");
      const result = await session.submit({ text: "see image", images: [image] }, createScriptedModel({ responses: [() => { calls++; return { text: "never" }; }] }), { imageRoute: "codex" });
      expect(result.outcome).toBe("images-unsupported"); expect(calls).toBe(0);
      expect("input" in result).toBe(false);
      expect(await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8")).toBe(before);
      await session.close(); await host.close();
    }
  });
});

test("typed image admission errors leave native history untouched", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    for (const [images, expected] of [[Array(6).fill(image), "image-count-limit"], [[{ ...image, byteLength: MAX_IMAGE_BYTES + 1 }], "image-byte-limit"],
      [[{ ...image, width: 2049 }], "image-pixel-limit"], [[{ ...image, data: png }], "invalid-image"]] as const) {
      try { await session.submit({ text: "invalid", images: images as readonly ImageContent[] }, createScriptedModel(), { imageRoute: "codex" }); throw new Error("Expected failure"); }
      catch (error) { expect(error).toBeInstanceOf(HostImageError); expect((error as HostImageError).code).toBe(expected); }
    }
    expect(await readFile(join(config.sessionDirectory, `${session.reference.id}.jsonl`), "utf8")).not.toContain('"type":"user"');
    await session.close(); await host.close();
  });
});

test("images contribute to native budgeting and summaries name missing visual evidence without bytes", () => {
  const user = { type: "user" as const, id: "u", content: [image] };
  expect(estimateItemTokens(user)).toBe(1024 + Math.ceil(image.width * image.height / 256));
  const summary = formatItemForSummary(user);
  expect(summary).toContain("image bytes are unavailable");
  expect(summary).not.toContain(image.reference); expect(summary).not.toContain(image.sha256);
});

test("Responses, Grok and Codex preserve ordered PNG/JPEG input parts and refuse unresolved data", () => {
  const request: ModelRequest = { systemPrompt: "operator", context: [], items: [{ type: "user", id: "u", content: [
    { type: "text", text: "first" }, image, { type: "text", text: "then" }, photo,
  ] }], imageData: new Map([[image.sha256, png], [photo.sha256, jpeg]]) };
  for (const namespace of ["openai", "xai"] as const) {
    const body = buildResponsesRequest({ request, namespace, model: "fixture", maxOutputTokens: 100 });
    expect(body.store).toBe(false);
    const content = (body.input[0] as { content: unknown }).content;
    expect(content).toEqual([
      { type: "input_text", text: "first" }, { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`, detail: "high" },
      { type: "input_text", text: "then" }, { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`, detail: "high" },
    ]);
    expect((toCodexResponsesBody(request, "gpt-5.4").input as unknown[])[0]).toEqual(body.input[0]);
  }
  code(() => toCodexResponsesBody({ ...request, imageData: undefined }, "gpt-5.4"), "images-unavailable");
});

test("each model boundary re-resolves images; deletion during a tool turn prevents another provider call", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    let live = true, resolves = 0, calls = 0;
    config.images = { probes: [probe()], resolve: async () => { resolves++; return live ? png : null; } };
    config.tools.definitions = [{ name: "delete", description: "Fixture deletion", execution: "exclusive", inputSchema: { type: "object" },
      execute: async () => { live = false; return { content: "deleted" }; } }];
    const host = await createHost(config), session = await host.createSession();
    const result = await session.submit({ text: "delete in turn", images: [image] }, createScriptedModel({ responses: [
      request => { calls++; expect(request.imageData?.get(image.sha256)).toEqual(png); return { toolCalls: [{ id: "delete-call", name: "delete", arguments: {} }] }; },
      () => { calls++; return { text: "must not happen" }; },
    ] }), { imageRoute: "codex" });
    expect(result.outcome).toBe("images-unavailable"); expect(result.input).toBeDefined();
    expect(result.usage.complete).toBe(false); expect(result.usage.attempts.length).toBeGreaterThan(0);
    expect(calls).toBe(1); expect(resolves).toBe(2);
    await session.close(); await host.close();
  });
});

test("reopen requires current route evidence and live bytes, including historical images on text-only turns", async () => {
  await withTempDir(async dir => {
    const config = await options(dir);
    let host = await createHost(config), session = await host.createSession();
    expect((await session.submit({ text: "first", images: [image] }, createScriptedModel({ text: "saved" }), { imageRoute: "codex" })).outcome).toBe("completed");
    const reference = session.reference; await session.close(); await host.close();
    let calls = 0;
    host = await createHost({ ...config, images: { probes: [], resolve: async () => { calls++; return png; } } });
    session = await host.openSession(reference);
    expect((await session.submit({ text: "continue" }, createScriptedModel(), { imageRoute: "codex" })).outcome).toBe("images-unsupported");
    expect(calls).toBe(0); await session.close(); await host.close();
    for (const bytes of [null, new Uint8Array(png).fill(0, png.length - 1)]) {
      host = await createHost({ ...config, images: { probes: [probe()], resolve: async () => bytes } });
      session = await host.openSession(reference);
      expect((await session.submit({ text: "still unavailable" }, createScriptedModel({ responses: [() => { calls++; return { text: "never" }; }] }), { imageRoute: "codex" })).outcome).toBe("images-unavailable");
      expect(calls).toBe(0); await session.close(); await host.close();
    }
  });
});

test("native history, compaction, snapshots and restored sessions never retain image bytes", async () => {
  await withTempDir(async dir => {
    const config = await options(dir), host = await createHost(config), session = await host.createSession();
    let calls = 0;
    for (let i = 0; i < 12; i++) {
      const run = await session.submit({ text: `turn ${i}`, images: i === 0 ? [image, photo] : [] }, createScriptedModel({
        responses: [request => { calls++; expect(request.imageData?.size).toBe(2); return { text: "saved" }; }],
      }), { imageRoute: "codex" });
      expect(run.outcome).toBe("completed");
    }
    const compacted = await session.compact(createScriptedModel({ responses: [request => {
      expect(request.imageData).toBeUndefined(); expect(JSON.stringify(request)).not.toContain(Buffer.from(png).toString("base64"));
      expect(JSON.stringify(request)).toContain("image bytes are unavailable");
      return { text: "Earlier images were attached; visual content was not summarized." };
    }] }));
    expect(compacted.outcome).toBe("completed"); expect(calls).toBe(12);
    const reference = session.reference; await session.close();
    const snapshot = await host.snapshotSessions([reference]);
    const persisted = await Promise.all((await readdir(config.sessionDirectory)).filter(name => !name.endsWith(".host-lease")).map(name => readFile(join(config.sessionDirectory, name))));
    const artifacts = snapshot.sessions.flatMap(session => session.artifacts.map(artifact => Buffer.from(artifact.dataBase64, "base64")));
    for (const bytes of [...persisted, ...artifacts]) {
      for (const data of [png, jpeg]) {
        expect(bytes.includes(data)).toBe(false); expect(bytes.toString()).not.toContain(Buffer.from(data).toString("base64"));
        expect(bytes.toString()).not.toContain(JSON.stringify([...data]));
      }
      expect(bytes.toString()).not.toContain("SCHWAY_IMAGE_BYTES_MUST_NEVER_PERSIST_436");
      for (const field of ['"data":', '"imageData":', '"image_url":']) expect(bytes.toString()).not.toContain(field);
    }
    const transcript = artifacts.find(bytes => bytes.toString().includes('"branch_append"'))!.toString();
    expect(transcript).toContain(image.reference); expect(transcript).toContain(photo.sha256);
    const fresh = await createHost({ ...config, sessionDirectory: join(dir, "restored"), images: { probes: [], resolve: async () => { throw new Error("must not resolve compacted images"); } } });
    expect((await fresh.restoreSessionSnapshot(snapshot)).status).toBe("restored");
    const restored = await fresh.openSession(reference);
    expect((await restored.submit({ text: "continue after deletion" }, createScriptedModel({ text: "continued" }))).outcome).toBe("completed");
    await restored.close(); await fresh.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) test(`${route} bound route passes images only with exact probe evidence`, async () => {
  await withTempDir(async dir => {
    const config = await options(dir), store = fakeCredentialStore();
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-image-token", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    let calls = 0;
    config.auth = { route, model, store, fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false); expect(body.input[0].content[1].type).toBe("input_image");
      expect(body.input[0].content[1].image_url).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
      return new Response('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}\n\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"seen"}\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    } };
    config.images = { probes: [], resolve: async () => png };
    let host = await createHost(config), session = await host.createSession();
    expect((await session.submitWithRoute({ text: "unsupported", images: [image] })).outcome).toBe("images-unsupported");
    expect(calls).toBe(0); await session.close(); await host.close();
    config.images = { probes: [probe(route, model)], resolve: async () => png };
    host = await createHost(config); session = await host.createSession();
    expect((await session.submitWithRoute({ text: "see it", images: [image] })).outcome).toBe("completed");
    expect(calls).toBe(1); await session.close(); await host.close();
  });
});
