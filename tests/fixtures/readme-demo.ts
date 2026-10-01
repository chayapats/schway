import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInteractiveTui } from "../../src/tui/app.ts";
import { fakeCredentialStore } from "../helpers/credential-store.ts";
import { createDemoModel, createDemoWorkspace } from "./readme-demo-scenario.ts";

const root = await mkdtemp(join(tmpdir(), "schway-readme-demo-"));
const inheritedEnv = process.env;
try {
  const { home, workspace } = await createDemoWorkspace(root);
  const env = { HOME: home, PATH: inheritedEnv.PATH, SCHWAY_THEME: "dark", SCHWAY_MOTION: "reduced" };
  // Real bash tools inherit process.env, so isolate them as well as TUI settings.
  process.env = env;
  process.exitCode = await runInteractiveTui({
    args: {
      json: false, help: false,
      // @ts-expect-error The injected offline model uses a fixture-only provider, never the CLI parser or provider loader.
      provider: "demo",
      model: "offline-model",
    },
    env, cwd: workspace, stdout: process.stdout, stderr: process.stderr,
    model: createDemoModel(), credentialStore: fakeCredentialStore(),
  });
} finally {
  process.env = inheritedEnv;
  await rm(root, { recursive: true, force: true });
}
