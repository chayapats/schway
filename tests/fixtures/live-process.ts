import { writeSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";

// A real OS process that deliberately ignores abort, and optionally leaves a child in its process group.
const path = process.env.SCHWAY_FIXTURE_PID_FILE;
if (process.argv.includes("grandchild")) {
  if (path) await writeFile(`${path}.descendant`, String(process.pid));
  setInterval(() => {}, 10_000);
} else {
  let raw = "";
  for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
  const instruction = JSON.parse(raw) as { provider: string; model: string; workspaceRoot: string };
  if (path) await writeFile(path, String(process.pid));
  const mode = process.env.SCHWAY_FIXTURE_MODE;
  if (mode === "hang-with-descendant") {
    Bun.spawn([process.execPath, import.meta.path, "grandchild"], { stdout: "ignore", stderr: "ignore" });
    setInterval(() => {}, 10_000);
  } else if (mode === "hang" || mode === "hang-stream") {
    if (mode === "hang-stream") await writeFile(`${instruction.workspaceRoot}/.model-started`, "");
    setInterval(() => {}, 10_000);
  } else if (mode === "oversized") {
    process.stdout.write("PRIVATE_SECRET".repeat(1000));
  } else if (mode === "orphan") {
    Bun.spawn([process.execPath, import.meta.path, "grandchild"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { await access(`${path}.descendant`); break; } catch { await Bun.sleep(5); }
    }
    writeSync(1, JSON.stringify({ provider: instruction.provider, model: instruction.model,
      authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
    process.exit(0);
  } else if (mode === "forged") {
    process.stdout.write(JSON.stringify({ provider: instruction.provider, model: "PRIVATE_SECRET",
      authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
  } else {
    process.stdout.write(JSON.stringify({ provider: instruction.provider, model: instruction.model,
      authSource: "env", status: "passed", reason: "verified", durationMs: 1, toolRoundTrip: true }));
  }
}
