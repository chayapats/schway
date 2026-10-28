import { stat } from "node:fs/promises";
import { coreToolDefinitions } from "../../src/host/index.ts";
import { memoryBackend } from "../helpers/memory-backend.ts";

/** Run every core tool over an in-memory backend while host filesystem and process APIs throw. */
const state = globalThis as unknown as { denyHostIo?: boolean; deniedCalls: string[] };
const ctx = { workspace: { root: "/workspace", launchCwd: "/workspace", extraRoots: [] } };
const memory = memoryBackend({
  files: { "src/a.ts": "export const needle = 1;\n", "notes.txt": "alpha\n" },
  spawn: async () => ({ stdout: "ภาษาไทย🙂 ".repeat(6000), stderr: "", exitCode: 2, timedOut: false }),
});
state.denyHostIo = true;
let probe = "allowed";
try { await stat("/"); } catch { probe = "denied"; }
state.deniedCalls.length = 0;
const outcomes: Record<string, { isError: boolean; content: string }> = {};
try {
  const tools = Object.fromEntries(coreToolDefinitions(memory.backend).map(tool => [tool.name, tool]));
  const run = async (key: string, name: string, input: unknown) => {
    const result = await tools[name]!.execute(input, ctx);
    outcomes[key] = { isError: result.isError === true, content: result.content.slice(0, 200) };
    return result;
  };
  const bash = await run("bash", "bash", { command: "produce" });
  await run("spill-read", "read", { path: (bash.details as { outputPath: string }).outputPath, limit: 1 });
  await run("read", "read", { path: "src/a.ts" });
  await run("write", "write", { path: "new/file.txt", content: "x" });
  await run("edit", "edit", { path: "notes.txt", edits: [{ oldText: "alpha", newText: "beta" }] });
  await run("grep", "grep", { pattern: "needle" });
  await run("find", "find", { pattern: "**/*.ts" });
  await run("ls", "ls", { depth: 2 });
} finally {
  state.denyHostIo = false;
}
console.log(JSON.stringify({ probe, denied: state.deniedCalls, outcomes }));
