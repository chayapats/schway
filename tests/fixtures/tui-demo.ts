import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInteractiveTui } from "../../src/tui/app.ts";
import { createScriptedModel } from "../helpers/scripted-model.ts";
import { fakeCredentialStore } from "../helpers/credential-store.ts";
import type { Model } from "../../src/model/model.ts";

const demoRoot = await mkdtemp(join(tmpdir(), "schway-tui-demo-"));
const scrollDemo = process.argv.includes("--scroll");
try {
  const workspace = join(demoRoot, "workspace");
  const demoHome = join(demoRoot, "home");
  await mkdir(workspace);
  await mkdir(demoHome);
  await writeFile(join(workspace, "status.txt"), "pending\n");
  const scripted = createScriptedModel({ responses: [
    { text: "I’ll inspect the status file and update it.", toolCalls: [{ id: "read", name: "read", arguments: { path: "status.txt" } }] },
    { toolCalls: [{ id: "edit", name: "edit", arguments: { path: "status.txt", edits: [{ oldText: "pending", newText: "ready" }] } }] },
    { toolCalls: [{ id: "checks", name: "bash", arguments: { command: "printf '2 checks passed\\n'" } }] },
    scrollDemo
      ? { chunks: Array.from({ length: 100 }, (_, i) => `## Section ${i + 1}\n\nScroll with the mouse or PageUp while this answer streams. **กำลังทดสอบข้อความภาษาไทย น้ำ** · 👩‍💻 · 中文\n\n- Check ${i + 1}: ready\n\n\`\`\`ts\nconst result${i + 1} = \"ready\";\n\`\`\`\n\n`) }
      : { text: "## Ready to review\n\nUpdated **status.txt** and completed the checks.\n\n- Status: `ready`\n- Tests: **2 passed**\n- รองรับข้อความภาษาไทย\n\n```ts\nconst status = \"ready\";\n```\n\nExpand the edit to inspect the diff." },
    { text: "Waiting so you can test cancellation. Press Esc.", waitForAbort: true },
  ] });
  const model: Model = { ...scripted, async *stream(request) {
    for await (const event of scripted.stream(request)) { await Bun.sleep(90); yield event; }
  } };
  process.exitCode = await runInteractiveTui({
    args: { json: false, help: false, provider: "openai", model: "offline-demo" },
    env: { HOME: demoHome, PATH: process.env.PATH, SCHWAY_THEME: process.env.SCHWAY_THEME, NO_COLOR: process.env.NO_COLOR, COLORFGBG: process.env.COLORFGBG, SCHWAY_MOTION: process.env.SCHWAY_MOTION },
    cwd: workspace, stdout: process.stdout, stderr: process.stderr, model,
    credentialStore: fakeCredentialStore(),
  });
} finally {
  await rm(demoRoot, { recursive: true, force: true });
}
