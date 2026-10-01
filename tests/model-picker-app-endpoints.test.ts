import { expect, test } from "bun:test";
import { buildIsolatedCliEnv, withTempDir } from "./helpers.ts";

const script = String.raw`
  import { mock } from "bun:test";
  import { mkdir, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  import { createTestRenderer } from "@opentui/core/testing";
  const root = process.cwd(), home = process.env.HOME;
  const auth = process.env.PICKER_PRIMARY_AUTH;
  const headers = process.env.PICKER_PRIMARY_HEADERS === "yes" ? { "X-Endpoint": "primary" } : undefined;
  await mkdir(join(home, ".schway"));
  await writeFile(join(home, ".schway/config.json"), JSON.stringify({
    provider: "openai-compatible", profile: "remote", baseUrl: "https://primary.example/v1", auth, headers,
    profiles: { remote: { baseUrl: "https://profile.example/v1", model: "profile-model", auth: "required",
      credentialEnv: "PROFILE_KEY", credentialIdentity: "profile-identity", headers: { "X-Endpoint": "profile" } } },
  }));
  const terminal = await createTestRenderer({ width: 120, height: 32, kittyKeyboard: true });
  const fixture = join(root, "src/tui/credential-input.ts");
  const credentialInput = await import(pathToFileURL(fixture).href);
  const core = await credentialInput.loadCredentialSafeTui();
  mock.module(fixture, () => ({ ...credentialInput,
    loadCredentialSafeTui: async () => ({ ...core, createCliRenderer: async () => terminal.renderer }) }));
  const { runInteractiveTui } = await import(pathToFileURL(join(root, "src/tui/app.ts")).href);
  const { fakeCredentialStore } = await import(pathToFileURL(join(root, "tests/helpers/credential-store.ts")).href);
  const { credentialIdentity } = await import(pathToFileURL(join(root, "src/auth/store.ts")).href);
  const store = fakeCredentialStore();
  if (auth === "required") await store.set(credentialIdentity({ provider: "openai-compatible", baseUrl: "https://primary.example/v1" }), "primary-secret");
  await store.set(credentialIdentity({ provider: "openai-compatible", profile: "remote", baseUrl: "https://profile.example/v1", credentialIdentity: "profile-identity" }), "profile-stored-secret");
  const requests = [];
  let errors = "";
  const abort = new AbortController();
  const app = runInteractiveTui({ cwd: home, env: { HOME: home, SCHWAY_MOTION: "off", PROFILE_KEY: "profile-env-secret" },
    args: { json: false, help: false }, credentialStore: store, signal: abort.signal,
    model: { provider: "openai-compatible", id: "profile-model", async *stream() { throw Error("No model request expected"); } },
    fetch: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization"), endpoint: new Headers(init?.headers).get("X-Endpoint") });
      return Response.json({ data: [{ id: "primary-model" }] });
    }, stdout: { write() {} }, stderr: { write(text) { errors += text; } },
  });
  const wait = async predicate => {
    for (let n = 0; n < 500; n++) { await terminal.flush(); if (predicate()) return; await Bun.sleep(10); }
    throw Error("App did not reach expected picker state: " + terminal.captureCharFrame() + errors);
  };
  try {
    await wait(() => terminal.captureCharFrame().includes("Ready"));
    terminal.mockInput.pressKey("m", { meta: true });
    await wait(() => terminal.captureCharFrame().includes("primary-model"));
    const expected = [{ url: "https://primary.example/v1/models", authorization: auth === "required" ? "Bearer primary-secret" : null,
      endpoint: headers ? "primary" : null }];
    if (JSON.stringify(requests) !== JSON.stringify(expected)) throw Error("Primary request used the wrong connection metadata");
    if (!terminal.captureCharFrame().includes("remote · profile.example")) throw Error("Profile group was lost");
    console.log("PRIMARY_REQUEST_OK");
  } finally { abort.abort(); await app; }
`;

for (const [auth, headers] of [["required", "yes"], ["none", "yes"], ["optional", "yes"], ["none", "no"]] as const) {
  test(`actual picker listing uses standalone ${auth} auth and ${headers === "yes" ? "primary" : "no"} headers with an active profile`, async () => {
    await withTempDir(async home => {
      // Isolate renderer mocks from the rest of the deterministic suite.
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: import.meta.dir + "/..", env: buildIsolatedCliEnv(home, { PICKER_PRIMARY_AUTH: auth, PICKER_PRIMARY_HEADERS: headers }),
        stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 12_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
        expect(stdout).toContain("PRIMARY_REQUEST_OK");
      } finally { clearTimeout(timeout); }
    });
  }, 15_000);
}
