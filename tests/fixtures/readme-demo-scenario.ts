import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "../../src/model/model.ts";
import { createScriptedModel } from "../helpers/scripted-model.ts";

/** Create an isolated home and committed clamp repository with a failing upper-bound test. */
export async function createDemoWorkspace(root: string): Promise<{ home: string; workspace: string }> {
  const home = join(root, "home");
  const workspace = join(home, "clamp-demo");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src/clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.max(lo, n);\n}\n");
  await writeFile(join(workspace, "src/clamp.test.ts"), [
    'import { expect, test } from "bun:test";',
    'import { clamp } from "./clamp.ts";',
    '',
    'test("clamp respects the upper bound", () => {',
    '  expect(clamp(5, 0, 3)).toBe(3);',
    '});',
    '',
  ].join("\n"));
  const env = {
    HOME: home, PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.invalid",
    GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.invalid",
    GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
  };
  for (const args of [["init", "-q", "-b", "main"], ["add", "src"], ["commit", "-qm", "Add clamp fixture"]]) {
    const command = Bun.spawn(["git", ...args], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited,
    ]);
    if (code !== 0) throw new Error(`Cannot prepare demo repository: ${stderr || stdout}`);
  }
  return { home, workspace };
}

/** Replay a network-free read, edit and real test run with visible streamed events. */
export function createDemoModel(): Model {
  const scripted = createScriptedModel({
    provider: "demo", id: "offline-model",
    responses: [
      { toolCalls: [{ id: "demo-read", name: "read", arguments: { path: "src/clamp.ts" } }] },
      { toolCalls: [{ id: "demo-edit", name: "edit", arguments: {
        path: "src/clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: "return Math.min(hi, Math.max(lo, n));" }],
      } }] },
      { toolCalls: [{ id: "demo-test", name: "bash", arguments: { command: "bun test src/clamp.test.ts" } }] },
      { text: "Fixed clamp so it respects the upper bound." },
    ],
  });
  return {
    ...scripted,
    async *stream(request) {
      for await (const event of scripted.stream(request)) {
        await Bun.sleep(90);
        request.signal?.throwIfAborted();
        yield event;
      }
    },
  };
}
