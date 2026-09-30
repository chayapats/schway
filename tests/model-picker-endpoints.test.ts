import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigEditor } from "../src/config/editing.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { loadModelPickerAccess } from "../src/tui/model-access.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";

const paths = { user: "/unused-user/config.json", project: "/unused-project/config.json" };
const primary = "http://localhost:8787/v1";
const profile = {
  baseUrl: "https://profile.example/v1", model: "profile-model", auth: "required" as const,
  credentialEnv: "PROFILE_KEY", credentialIdentity: "profile-identity",
};

test("standalone endpoint metadata excludes the active profile and returns no mutable editor state", () => {
  const editor = new ConfigEditor({ user: { baseUrl: ` ${primary} `, auth: "none", profiles: { remote: profile }, profile: "remote" } }, paths);
  expect(editor.settings).toMatchObject({ baseUrl: profile.baseUrl, auth: "required", credentialEnv: "PROFILE_KEY", credentialIdentity: "profile-identity" });
  expect(editor.standaloneEndpoint).toEqual({ baseUrl: primary, auth: "none" });
  const connection = editor.standaloneEndpoint;
  connection.baseUrl = "https://changed.example/v1";
  expect(editor.standaloneEndpoint.baseUrl).toBe(primary);
});

test("an active profile does not invent a standalone endpoint", async () => {
  const editor = new ConfigEditor({ user: { profiles: { remote: profile }, profile: "remote" } }, paths);
  expect(editor.standaloneEndpoint).toEqual({});
  const access = await loadModelPickerAccess({ store: fakeCredentialStore(), env: { PROFILE_KEY: "profile-secret" },
    baseUrl: editor.settings.baseUrl, auth: "none", activeProfile: "remote", profiles: editor.profiles,
    standaloneEndpoint: editor.standaloneEndpoint });
  expect(access.providers["openai-compatible"]).toBe("Login required");
  expect(access.profiles.remote).toBe("API key");
});

test("standalone endpoints follow user, project, CLI and committed session overrides", async () => {
  await withTempDir(async root => {
    const user = { baseUrl: "https://user.example/v1", auth: "none" as const, profiles: { remote: profile }, profile: "remote" };
    const project = { baseUrl: "https://project.example/v1", auth: "required" as const };
    const cli = { baseUrl: "https://cli.example/v1", auth: "optional" as const };
    expect(new ConfigEditor({ user }, paths).standaloneEndpoint).toEqual({ baseUrl: user.baseUrl, auth: user.auth });
    expect(new ConfigEditor({ user, project }, paths).standaloneEndpoint).toEqual({ baseUrl: project.baseUrl, auth: project.auth });
    const editor = new ConfigEditor({ user, project, cli }, { user: join(root, "user.json"), project: join(root, "project.json") });
    expect(editor.standaloneEndpoint).toEqual({ baseUrl: cli.baseUrl, auth: cli.auth });
    const staged = await editor.prepare({ scope: "session", key: "baseUrl", value: primary });
    expect(editor.standaloneEndpoint.baseUrl).toBe(cli.baseUrl);
    await staged.commit();
    await (await editor.prepare({ scope: "session", key: "auth", value: "required" })).commit();
    expect(editor.standaloneEndpoint).toEqual({ baseUrl: primary, auth: "required" });
    await (await editor.prepare({ scope: "session", key: "baseUrl" })).commit();
    await (await editor.prepare({ scope: "session", key: "auth" })).commit();
    expect(editor.standaloneEndpoint).toEqual({ baseUrl: cli.baseUrl, auth: cli.auth });
  });
});

test("standalone and active profile credentials are resolved against independent endpoint identities", async () => {
  const editor = new ConfigEditor({ user: { baseUrl: primary, auth: "required", profiles: { remote: profile }, profile: "remote" } }, paths);
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai-compatible", profile: "remote", baseUrl: profile.baseUrl, credentialIdentity: profile.credentialIdentity }), "profile-stored-secret");
  const input = { store, env: { PROFILE_KEY: "profile-env-secret" }, ...editor.settings,
    activeProfile: "remote", profiles: editor.profiles, standaloneEndpoint: editor.standaloneEndpoint };
  const disconnected = await loadModelPickerAccess(input);
  expect(disconnected.providers["openai-compatible"]).toBe("Login required");
  expect(disconnected.profiles.remote).toBe("API key");
  await store.set(credentialIdentity({ provider: "openai-compatible", baseUrl: primary }), "primary-stored-secret");
  const connected = await loadModelPickerAccess(input);
  expect(connected.providers["openai-compatible"]).toBe("API key");
  expect(connected.profiles.remote).toBe("API key");
  expect(JSON.stringify(connected)).not.toContain("secret");
});

test("explicit primary auth none and optional policies do not inherit required profile auth", async () => {
  for (const auth of ["none", "optional", "required"] as const) {
    const access = await loadModelPickerAccess({ store: fakeCredentialStore(), env: { PROFILE_KEY: "profile-secret" },
      baseUrl: profile.baseUrl, auth: "required", activeProfile: "remote", profiles: { remote: profile },
      standaloneEndpoint: { baseUrl: primary, auth } });
    expect(access.providers["openai-compatible"]).toBe(auth === "required" ? "Login required" : "No key required");
    expect(access.profiles.remote).toBe("API key");
  }
});

test("explicit primary credential references preserve environment and secure-store precedence", async () => {
  const store = fakeCredentialStore();
  const identity = credentialIdentity({ provider: "openai-compatible", baseUrl: primary, credentialIdentity: "primary-identity" });
  const ordinary = credentialIdentity({ provider: "openai-compatible", baseUrl: primary });
  await store.set(ordinary, "ordinary-secret");
  const readAccounts: string[] = [];
  const tracked = { ...store, get: async (target: typeof identity) => { readAccounts.push(target.account); return store.get(target); } };
  const input = { store: tracked, env: { OPENAI_COMPATIBLE_API_KEY: "ordinary-env-secret", PROFILE_KEY: "profile-secret" },
    activeProfile: "remote", profiles: { remote: profile },
    standaloneEndpoint: { baseUrl: primary, auth: "required" as const, credentialEnv: "PRIMARY_KEY", credentialIdentity: "primary-identity" } };
  expect((await loadModelPickerAccess(input)).providers["openai-compatible"]).toBe("Login required");
  expect(readAccounts).toContain(identity.account);
  expect(readAccounts).not.toContain(ordinary.account);
  await store.set(identity, "primary-stored-secret");
  expect((await loadModelPickerAccess(input)).providers["openai-compatible"]).toBe("API key");
  readAccounts.length = 0;
  expect((await loadModelPickerAccess({ ...input, env: { ...input.env, PRIMARY_KEY: "primary-env-secret" } })).providers["openai-compatible"]).toBe("API key");
  expect(readAccounts).not.toContain(identity.account);
});

test("primary access honors provider-scoped runtime credentials before endpoint auth policy", async () => {
  const input = { store: fakeCredentialStore(), env: {}, activeProfile: "remote", profiles: { remote: profile },
    standaloneEndpoint: { baseUrl: primary, auth: "none" as const } };
  const compatible = await loadModelPickerAccess({ ...input, runtimeApiKey: "runtime-secret", runtimeProvider: "openai-compatible" });
  expect(compatible.providers["openai-compatible"]).toBe("API key");
  expect(JSON.stringify(compatible)).not.toContain("runtime-secret");
  expect((await loadModelPickerAccess({ ...input, runtimeApiKey: "runtime-secret", runtimeProvider: "openai" })).providers["openai-compatible"]).toBe("No key required");
});

test("omitting primary metadata preserves legacy picker access while an explicit empty connection suppresses fallback", async () => {
  const input = { store: fakeCredentialStore(), env: {}, baseUrl: primary, auth: "none" as const };
  expect((await loadModelPickerAccess(input)).providers["openai-compatible"]).toBe("No key required");
  expect((await loadModelPickerAccess({ ...input, activeProfile: "remote" })).providers["openai-compatible"]).toBe("Login required");
  expect((await loadModelPickerAccess({ ...input, standaloneEndpoint: {} })).providers["openai-compatible"]).toBe("Login required");
});
