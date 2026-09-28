import { runCli } from "../../src/cli/main.ts";
import { fakeCredentialStore } from "../helpers/credential-store.ts";
import { credentialIdentity } from "../../src/auth/store.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./openai.ts";

const store = fakeCredentialStore();
await store.set(credentialIdentity({ provider: "openai" }), "fixture-stored");
const requests: unknown[] = [];
let stdout = "", stderr = "";
const code = await runCli(["--provider", "openai", "--model", "gpt-4o", "--api-key", "fixture-runtime", "-p", "hello"], {
  cwd: process.argv[2]!, env: { HOME: process.env.HOME!, OPENAI_API_KEY: "fixture-env" }, credentialStore: store,
  stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  fetch: async (url, init) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(encodeSse(TEXT_STREAM_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  },
});
const modules = Object.keys(require.cache).filter(path => /(?:\/tui\/|@opentui|@anthropic-ai|\/providers\/)/.test(path));
console.log(JSON.stringify({ code, requests, stdout, stderr, modules }));
